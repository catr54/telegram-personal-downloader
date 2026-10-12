importScripts("model.js");
const HISTORY_KEY = "downloadHistory";
const MAX_HISTORY = 250;
let writeChain = Promise.resolve();
const serial = operation => {
  const result = writeChain.then(operation);
  writeChain = result.catch(() => {});
  return result;
};
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open("tpd-completed-downloads", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("completed", { keyPath: "key" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
// Persistent media metadata is separate from ad rules and download completion records.
const chatDatabase = new Promise((resolve, reject) => {
  const request = indexedDB.open("tpd-chat-media-cache", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("chats", { keyPath: "key" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function chatCache(key, record) {
  const db = await chatDatabase;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("chats", record ? "readwrite" : "readonly");
    const store = transaction.objectStore("chats");
    const request = record ? store.put({ ...record, key }) : store.get(key);
    let value;
    request.onsuccess = () => { value = request.result; };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("本地缓存写入中断"));
  });
}
async function completed(item) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("completed", "readonly");
    const store = transaction.objectStore("completed");
    let found = false;
    for (const key of [`msg:${item.key}`, ...(item.identity ? [`file:${item.identity}`] : [])]) {
      const request = store.get(key);
      request.onsuccess = () => { found ||= Boolean(request.result); };
    }
    transaction.oncomplete = () => resolve(found);
    transaction.onerror = () => reject(transaction.error);
  });
}
async function recordCompleted(item, downloadId) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("completed", "readwrite");
    const store = transaction.objectStore("completed");
    const record = { downloadId, completedAt: Date.now() };
    store.put({ ...record, key: `msg:${item.key}` });
    if (item.identity) store.put({ ...record, key: `file:${item.identity}` });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}
async function config() {
  const saved = await chrome.storage.local.get(["settings", "adRules"]);
  return { settings: { ...TPDModel.defaults, ...saved.settings }, ads: saved.adRules || [] };
}
async function getHistory() {
  const saved = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(saved[HISTORY_KEY]) ? saved[HISTORY_KEY] : [];
}
async function updateTask(task) {
  const history = await getHistory();
  const key = task.key;
  const previous = history.find(item => item.key === key);
  const next = { ...previous, ...task, key, updatedAt: Date.now(), createdAt: previous?.createdAt || Date.now() };
  await chrome.storage.local.set({ [HISTORY_KEY]: [next, ...history.filter(item => item.key !== key)].slice(0, MAX_HISTORY) });
  return next;
}
async function notify(tabId, message) {
  if (Number.isInteger(tabId)) await chrome.tabs.sendMessage(tabId, message).catch(() => {});
}
async function finishDownload(id) {
  const key = `pendingDownload:${id}`;
  const saved = (await chrome.storage.local.get(key))[key];
  if (!saved) return;
  const [download] = await chrome.downloads.search({ id });
  if (!download || !["complete", "interrupted"].includes(download.state)) return;
  const success = download.state === "complete";
  if (success) await recordCompleted(saved.item, id);
  const task = { ...saved.item, downloadId: id, path: saved.path, status: success ? "success" : "failed",
    progress: success ? 100 : 0, error: success ? "" : download.error || "浏览器下载已中断" };
  await updateTask(task);
  await chrome.storage.local.remove(key);
  await notify(saved.tabId, { type: "download_finished", task, objectUrl: saved.url });
}
chrome.downloads.onChanged.addListener(change => {
  if (change.state?.current === "complete" || change.state?.current === "interrupted")
    serial(() => finishDownload(change.id)).catch(() => {});
});
// Reconcile only downloads previously started by this extension, after a worker restart.
serial(async () => {
  const saved = await chrome.storage.local.get(null);
  for (const key of Object.keys(saved).filter(key => key.startsWith("pendingDownload:")))
    await finishDownload(Number(key.split(":")[1]));
}).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (["load_chat_cache", "save_chat_cache"].includes(message?.type)) {
      if (!sender.tab?.url?.startsWith("https://web.telegram.org/") || typeof message.key !== "string")
        throw new Error("仅接受 Telegram 页面的聊天缓存请求");
      if (message.type === "load_chat_cache") return serial(async () => ({ ok: true, record: await chatCache(message.key) || null }));
      return serial(async () => {
        const previous = await chatCache(message.key);
        if (!previous || previous.updatedAt <= message.updatedAt)
          await chatCache(message.key, { items: message.items || [], updatedAt: message.updatedAt, version: 1 });
        return { ok: true };
      });
    }
    if (message?.type === "snapshot") {
      if (!sender.tab?.id) throw new Error("Missing Telegram tab");
      const snapshot = { media: (message.media || []).slice(0, 200), count: message.count || 0,
        selectedCount: message.selectedCount || 0, stats: message.stats || {}, chat: message.chat || "", cacheStatus: message.cacheStatus || "" };
      await chrome.storage.session.set({ [`media:${sender.tab.id}`]: snapshot });
      await chrome.action.setBadgeText({ tabId: sender.tab.id, text: snapshot.count ? String(snapshot.count) : "" });
      return { ok: true };
    }
    if (message?.type === "scan_progress") {
      if (!sender.tab?.id) throw new Error("Missing Telegram tab");
      await chrome.storage.session.set({ [`scan:${sender.tab.id}`]: {
        stage: message.stage, count: message.count, steps: message.steps, error: message.error || "", updatedAt: Date.now()
      } });
      return { ok: true };
    }
    if (message?.type === "get_config") return { ok: true, ...await config() };
    if (message?.type === "save_settings") {
      const settings = TPDModel.validate(message.settings || {});
      await chrome.storage.local.set({ settings });
      return { ok: true, settings };
    }
    if (message?.type === "mark_ad") return serial(async () => {
      const { ads } = await config();
      const item = message.item;
      if (!item?.key || item.mediaType !== "image") throw new Error("只能将已识别的图片标记为广告");
      if (!item.identity && !item.visual) throw new Error("此图片尚未取得文件标识或图片指纹，请等待图片加载后重试");
      const rule = { id: crypto.randomUUID(), identity: item.identity || "", visual: item.visual || null, createdAt: Date.now() };
      if (!ads.some(ad => ad.identity && ad.identity === rule.identity)) ads.push(rule);
      await chrome.storage.local.set({ adRules: ads });
      return { ok: true };
    });
    if (message?.type === "remove_ad") return serial(async () => {
      const { ads } = await config();
      await chrome.storage.local.set({ adRules: ads.filter(ad => ad.id !== message.id) });
      return { ok: true };
    });
    if (message?.type === "lookup_downloads") {
      const items = (message.items || []).slice(0, 1000);
      const flags = await Promise.all(items.map(completed));
      return { ok: true, keys: items.filter((_, index) => flags[index]).map(item => item.key) };
    }
    if (message?.type === "save_media") return serial(async () => {
      if (!sender.tab?.id || !sender.tab.url?.startsWith("https://web.telegram.org/")) throw new Error("仅接受 Telegram 页面的下载任务");
      const item = message.item;
      if (!item?.key || !/^blob:https:\/\/web\.telegram\.org\//.test(message.url || ""))
        throw new Error("下载必须使用 Telegram 页面已取得的完整文件");
      if (item.skipDownloaded && await completed(item)) return { ok: true, skipped: true };
      const settings = item.naming || (await config()).settings;
      const path = TPDModel.filePath(item, settings, message.mime);
      const id = await chrome.downloads.download({ url: message.url, filename: path, saveAs: false, conflictAction: "uniquify" });
      await chrome.storage.local.set({ [`pendingDownload:${id}`]: { item, url: message.url, path, tabId: sender.tab.id } });
      await updateTask({ ...item, status: "saving", progress: 99, downloadId: id, path, error: "" });
      await finishDownload(id);
      return { ok: true, downloadId: id, path };
    });
    if (message?.type === "task") return { ok: true, task: await serial(() => updateTask(message.task || {})) };
    if (message?.type === "clear_history") {
      await serial(() => chrome.storage.local.set({ [HISTORY_KEY]: [] }));
      return { ok: true };
    }
    if (message?.type === "state") {
      const tabId = Number(message.tabId);
      const stored = await chrome.storage.session.get([`media:${tabId}`, `scan:${tabId}`]);
      return { ok: true, ...{ media: [], count: 0, selectedCount: 0 }, ...stored[`media:${tabId}`],
        scan: stored[`scan:${tabId}`] || null, history: await getHistory(), ...await config() };
    }
    return { ok: false, error: "Unknown message" };
  })().then(respond).catch(error => respond({ ok: false, error: String(error?.message || error) }));
  return true;
});
