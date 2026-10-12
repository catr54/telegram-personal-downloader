const $ = selector => document.querySelector(selector);
const panelParams = new URLSearchParams(location.search);
function sizePanel() {
  const expanded = panelParams.get("expanded") === "1";
  document.body.classList.toggle("expanded", expanded);
  if (expanded) { $("#expandPanel").hidden = true; return; }
  const height = Math.min(600, Math.max(280, screen.availHeight - 150));
  const width = Math.min(500, Math.max(280, screen.availWidth - 40));
  document.body.style.setProperty("--panel-height", `${height}px`);
  document.body.style.setProperty("--panel-width", `${width}px`);
}
sizePanel();
window.addEventListener("resize", sizePanel);
let tabId = null, media = [], total = 0, page = 0;
let savedSettings = { ...TPDModel.defaults };
let settingsLoaded = false;
let refreshTimer = null, renderVersion = 0, stateChat = "";
const expandedGroups = new Set();
const labels = { queued: "排队中", resolving: "定位媒体", downloading: "读取文件", saving: "正在保存",
  success: "保存完成", failed: "失败", skipped: "已跳过" };
function message(text) { $("#message").textContent = text; }
async function runtime(payload) {
  const result = await chrome.runtime.sendMessage(payload);
  if (!result?.ok) throw new Error(result?.error || "操作失败");
  return result;
}
async function telegram(payload) {
  if (!tabId) throw new Error("请先打开 Telegram Web 标签页");
  const result = await chrome.tabs.sendMessage(tabId, payload);
  if (!result?.ok) throw new Error(result?.error || "页面操作失败，请刷新 Telegram");
  return result;
}
function action(button, callback) {
  button.addEventListener("click", () => Promise.resolve().then(callback).catch(error => message(error.message)));
}
function button(parent, text, callback, secondary = true) {
  const node = document.createElement("button"); node.textContent = text;
  if (secondary) node.className = "secondary";
  action(node, callback); parent.append(node); return node;
}
function note(parent, text, className = "muted") {
  const node = document.createElement("div"); node.className = className; node.textContent = text;
  parent.append(node); return node;
}
function readSettings() {
  const value = { ...savedSettings };
  for (const key of ["dedupe", "filterAds", "skipDownloaded"]) value[key] = $(`#${key}`).checked;
  for (const key of ["baseFolder", "folderTemplate", "fileTemplate", "timeFormat", "sort"]) value[key] = $(`#${key}`).value;
  return value;
}
function namingPreview() {
  const example = { id: "12345", groupId: "12345", slot: 0, groupSize: 3, mediaType: "image",
    text: "示例说明", originalName: "photo.jpg", timestamp: new Date(2026, 9, 12, 13, 30, 0).getTime() };
  try { $("#preview").textContent = TPDModel.filePath(example, TPDModel.validate(readSettings()), "image/jpeg"); }
  catch (error) { $("#preview").textContent = error.message; }
}
async function saveSettings() {
  const result = await runtime({ type: "save_settings", settings: readSettings() });
  savedSettings = result.settings; page = 0; message("设置已保存，媒体列表会重新过滤和排序。");
  await state();
}
async function download(items) {
  const result = await telegram({ type: "download", items: items.map(item => ({ key: item.key, force: item.force })) });
  message(`已加入队列 ${result.count} 个${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`);
}

async function state() {
  const version = ++renderVersion;
  const result = await runtime({ type: "state", tabId });
  if (version !== renderVersion) return;
  if (result.chat !== stateChat) { stateChat = result.chat; page = 0; }
  total = result.count || 0;
  if (page * 200 >= total) page = 0;
  const entries = page === 0 ? result.media : (await telegram({ type: "media_page", offset: page * 200 })).media;
  if (version !== renderVersion) return;
  media = entries;
  savedSettings = result.settings;
  if (!settingsLoaded) {
    for (const key of ["dedupe", "filterAds", "skipDownloaded"]) $(`#${key}`).checked = savedSettings[key];
    for (const key of ["baseFolder", "folderTemplate", "fileTemplate", "timeFormat", "sort"]) $(`#${key}`).value = savedSettings[key];
    settingsLoaded = true; namingPreview();
  }
  $("#count").textContent = `可下载 ${total} 个 · 勾选 ${result.selectedCount || 0} 个`;
  $("#selectAll").classList.toggle("is-selected", total > 0 && result.selectedCount === total);
  $("#selectAll").classList.toggle("is-partial", result.selectedCount > 0 && result.selectedCount < total);
  $("#selectAll").setAttribute("aria-pressed", total > 0 && result.selectedCount === total ? "true" : "false");
  $("#selectNone").classList.toggle("is-selected", total > 0 && !result.selectedCount);
  $("#selectNone").setAttribute("aria-pressed", total > 0 && !result.selectedCount ? "true" : "false");
  $("#downloadAll").disabled = !result.selectedCount || !tabId;
  const stats = result.stats || {};
  $("#filters").textContent = `扫描 ${stats.scanned || 0} 个 · 重复 ${stats.duplicates || 0} · 广告 ${stats.ads || 0} · 已下载 ${stats.downloaded || 0}`;
  $("#scanStatus").textContent = result.scan?.stage === "scanning"
    ? `正在扫描历史：可下载 ${total} 个，已翻阅 ${result.scan.steps} 步`
    : result.scan?.stage === "complete" ? "已扫描到聊天历史顶部。" : result.scan?.stage === "cancelled"
      ? "扫描已停止，已收集结果仍可使用。" : result.scan?.error || "扫描会自动滚动聊天历史，查找视频和图片。";
  $("#cacheStatus").textContent = result.cacheStatus || "";
  $("#cancelScan").disabled = result.scan?.stage !== "scanning";
  $("#media").replaceChildren();
  const groups = new Map();
  for (const item of media) { if (!groups.has(item.groupId)) groups.set(item.groupId, []); groups.get(item.groupId).push(item); }
  for (const [id, items] of groups) {
    const first = items[0];
    const group = document.createElement("section"); group.className = "group";
    const allSelected = first.groupEligible > 0 && first.groupSelected === first.groupEligible;
    const partial = first.groupSelected > 0 && !allSelected;
    const header = document.createElement("button"); header.type = "button";
    header.className = `group-title secondary${allSelected ? " is-selected" : partial ? " is-partial" : ""}`;
    header.textContent = `${allSelected ? "✓ 取消本条全选" : partial ? "− 本条全选" : "本条全选"} · ${first.groupSelected || 0}/${first.groupEligible || items.length} 已选`;
    header.setAttribute("aria-pressed", partial ? "mixed" : String(allSelected));
    action(header, async () => { await telegram({ type: "select_group", groupId: id, selected: !allSelected }); await state(); });
    group.append(header);
    note(group, first.timestamp ? new Date(first.timestamp).toLocaleString() : "消息时间未提供，按消息序号排列");
    note(group, first.groupName, "group-caption");
    const files = document.createElement("details"); files.className = "group-files";
    const expansionKey = `${stateChat}:${id}`;
    files.open = expandedGroups.has(expansionKey);
    const summary = document.createElement("summary");
    summary.textContent = `查看文件 · ${first.groupEligible || items.length} 个媒体`;
    files.append(summary);
    files.addEventListener("toggle", () => {
      // Replaced nodes may emit their final toggle event; ignore those.
      if (!files.isConnected) return;
      if (files.open) expandedGroups.add(expansionKey); else expandedGroups.delete(expansionKey);
    });
    group.append(files);
    for (const item of items) {
      const row = document.createElement("div"); row.className = item.selected ? "item is-selected" : "item";
      const label = document.createElement("label"); label.className = "media-label"; const select = document.createElement("input");
      select.type = "checkbox"; select.checked = item.selected;
      select.addEventListener("change", () => telegram({ type: "set_selected", key: item.key, selected: select.checked })
        .then(state).catch(error => message(error.message)));
      label.append(select, ` ${item.mediaType === "image" ? "图片" : "视频"} · ${item.name}`); row.append(label);
      const actions = document.createElement("div"); actions.className = "actions";
      button(actions, "下载", () => download([item]), false);
      button(actions, "强制下载", () => download([{ ...item, force: true }]));
      if (item.mediaType === "image") button(actions, "标为广告", async () => {
        await runtime({ type: "mark_ad", item });
        message(item.visual ? "广告规则已保存，将过滤匹配的重复图片。" : "已按文件标识标记广告；此图片暂无可用视觉指纹。");
        await state();
      });
      row.append(actions); files.append(row);
    }
    $("#media").append(group);
  }
  if (!media.length) note($("#media"), stats.scanned ? "当前媒体已被过滤，可在筛选设置中调整。" : "尚未发现媒体，请打开聊天并扫描。");
  $("#page").textContent = total ? `${page + 1} / ${Math.ceil(total / 200)}` : "";
  $("#previous").disabled = page === 0;
  $("#next").disabled = (page + 1) * 200 >= total;
  $("#ads").replaceChildren();
  result.ads.forEach((rule, index) => {
    const row = document.createElement("div"); row.className = "ad-rule";
    note(row, `广告规则 ${index + 1} · ${new Date(rule.createdAt).toLocaleString()} · ${rule.visual ? "文件与相似图匹配" : "文件标识匹配"}`);
    button(row, "删除此规则", async () => { await runtime({ type: "remove_ad", id: rule.id }); await state(); });
    $("#ads").append(row);
  });
  if (!result.ads.length) note($("#ads"), "暂无广告规则。请在媒体列表中选择“标为广告”。");
  $("#history").replaceChildren();
  for (const item of result.history.slice(0, 30)) {
    const row = document.createElement("div"); row.className = "item";
    note(row, item.path || item.name || "媒体", "history-name");
    const status = item.status === "success" && !item.downloadId ? "旧版已提交保存" : labels[item.status] || item.status;
    note(row, `${status} · ${Math.round(item.progress || 0)}% · ${new Date(item.updatedAt).toLocaleString()}${item.error ? ` · ${item.error}` : ""}`);
    $("#history").append(row);
  }
  if (!result.history.length) note($("#history"), "暂无记录");
}

action($("#expandPanel"), async () => {
  if (!tabId) throw new Error("请先打开 Telegram Web 标签页");
  await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?expanded=1&tabId=${tabId}`),
    type: "popup", width: Math.min(620, screen.availWidth), height: Math.min(1000, screen.availHeight), focused: true });
});
action($("#downloadAll"), async () => {
  const result = await telegram({ type: "download_all" });
  message(`已加入队列 ${result.count} 个${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`);
});
for (const [selector, selected] of [["#selectAll", true], ["#selectNone", false]])
  action($(selector), async () => { await telegram({ type: "select_all", selected }); await state(); });
action($("#scanAll"), async () => { await telegram({ type: "scan_all" }); message("已开始扫描聊天历史。"); await state(); });
action($("#cancelScan"), async () => { await telegram({ type: "cancel_scan" }); await state(); });
action($("#refresh"), async () => { await telegram({ type: "refresh" }); await state(); });
action($("#clear"), async () => { await runtime({ type: "clear_history" }); message("日志已清除，已下载查重记录和广告规则仍保留。"); await state(); });
action($("#previous"), async () => { page--; await state(); });
action($("#next"), async () => { page++; await state(); });
action($("#saveSettings"), saveSettings);
$("#sort").addEventListener("change", () => saveSettings().catch(error => message(error.message)));
for (const key of ["baseFolder", "folderTemplate", "fileTemplate", "timeFormat"])
  $(`#${key}`).addEventListener("input", namingPreview);
chrome.storage.onChanged.addListener(changes => {
  if (changes.downloadHistory || changes.adRules || changes.settings || Object.keys(changes).some(key => key.startsWith("scan:") || key.startsWith("media:"))) {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => state().catch(error => message(error.message)), 150);
  }
});
(async () => {
  const sourceTabId = Number(panelParams.get("tabId"));
  const tab = sourceTabId > 0 ? await chrome.tabs.get(sourceTabId)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab?.url?.startsWith("https://web.telegram.org/")) {
    tabId = tab.id;
    await telegram({ type: "refresh" });
    message("广告、重复媒体与已下载文件分别过滤。");
  } else message("请先打开 Telegram Web 标签页。");
  await state();
})().catch(error => message(error.message));
