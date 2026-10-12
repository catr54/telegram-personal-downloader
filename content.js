(() => {
  const channel = `tpd-${crypto.randomUUID()}`;
  const REQUEST = "tpd:request";
  const STATUS = "tpd:status";
  let media = [];
  let currentChat = "";
  let collected = new Map();
  let selected = new Map();
  let groupNames = new Map();
  let scanJob = null;
  let scanTimer = null;
  let lastSnapshot = "";
  let settings = { ...TPDModel.defaults };
  let ads = [];
  let filterStats = {};
  let bridgeReady = false;
  let metadataAttempts = new Map();
  let downloadedKeys = new Set();
  let downloadedIdentities = new Set();
  let checkedRecords = new Set();
  let metadataCache = new Map();
  const queuedTasks = new Map();

  let cacheReady = false, cacheStatus = "", cacheSignature = "", cacheTimer = null, activeCacheKey = "", cacheRetryAt = 0;
  const CACHE_FIELDS = ["key", "id", "chat", "mediaType", "identity", "visual", "text", "originalName",
    "timestamp", "discoveredAt", "album", "groupId", "groupName", "slot", "name", "version"];
  function cacheKey(chat) { return `${location.origin}${location.pathname}${location.search}|${chat}`; }
  function cacheItems() {
    return [...collected.values()].filter(item => !String(item.id).startsWith("visible-")).map(item =>
      Object.fromEntries(CACHE_FIELDS.filter(key => item[key] !== undefined).map(key => [key, item[key]])));
  }
  function persistCache(immediate = false) {
    if (!cacheReady || !currentChat || Date.now() < cacheRetryAt) return;
    const items = cacheItems(), signature = JSON.stringify(items);
    if (signature === cacheSignature) return;
    clearTimeout(cacheTimer);
    const payload = { type: "save_chat_cache", key: activeCacheKey, items, updatedAt: Date.now() };
    const write = () => {
      cacheSignature = signature;
      chrome.runtime.sendMessage(payload).then(result => {
        if (!result.ok) throw new Error(result.error);
      }).catch(() => {
        if (payload.key !== activeCacheKey) return;
        cacheSignature = ""; cacheRetryAt = Date.now() + 30000; cacheStatus = "本地缓存保存失败，当前列表仍可使用";
        rebuild();
      });
    };
    if (immediate) write(); else cacheTimer = setTimeout(write, 800);
  }
  async function restoreCache(chat) {
    const restoringKey = activeCacheKey;
    try {
      const result = await chrome.runtime.sendMessage({ type: "load_chat_cache", key: restoringKey });
      if (!result.ok) throw new Error(result.error);
      if (chat !== currentChat || restoringKey !== activeCacheKey) return;
      let restored = 0;
      for (const cached of result.record?.items || []) {
        if (cached.chat !== chat || !cached.key || collected.has(cached.key)) continue;
        collected.set(cached.key, { ...cached, url: "", marker: "", targetMarker: "", force: true, selected: true });
        selected.set(cached.key, true); restored++;
      }
      cacheStatus = result.record ? `已恢复本地媒体列表（${restored} 项），自动更新当前可见消息` : "自动更新列表，扫描结果将保存在本地";
    } catch {
      if (chat !== currentChat || restoringKey !== activeCacheKey) return;
      cacheStatus = "本地缓存读取失败，当前列表仍可使用";
      rebuild(); return; // Preserve existing stored records if reading failed.
    }
    if (chat !== currentChat || restoringKey !== activeCacheKey) return;
    cacheReady = true;
    scan();
    lookupDownloaded([...collected.values()]);
  }
  window.addEventListener("pagehide", () => persistCache(true));
  const cardObserver = new ResizeObserver(entries => {
    for (const entry of entries) entry.target.classList.toggle("tpd-compact", entry.contentRect.width < 240);
  });
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("bridge.js");
  script.dataset.channel = channel;
  script.onload = () => { bridgeReady = true; script.remove(); scan(); };
  (document.head || document.documentElement).append(script);

  const style = document.createElement("style");
  style.textContent = `
.tpd-button,.tpd-select,.tpd-group{box-sizing:border-box!important;border:1px solid #c1cedb!important;border-radius:8px!important;padding:6px 10px!important;font:600 13px/1.4 system-ui,sans-serif!important;box-shadow:0 2px 8px #0007!important;text-shadow:none!important;cursor:pointer!important;opacity:1!important}
.tpd-button{position:static;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#1269b3!important;color:#fff!important;border-color:#0b5697!important}
.tpd-select{position:static;flex:none;display:inline-flex!important;align-items:center!important;gap:5px!important;background:#fff!important;color:#172b40!important}
.tpd-select input{width:15px!important;height:15px!important;margin:0!important;accent-color:#167348}
.tpd-group{position:relative;z-index:21;display:block;margin:6px 8px;max-width:calc(100% - 16px);background:#fff!important;color:#172b40!important}
.tpd-select.is-selected,.tpd-group.is-selected{background:#167348!important;color:#fff!important;border-color:#9cddb9!important}
.tpd-group.is-partial{background:#fff0ce!important;color:#704300!important;border-color:#b88428!important}
.tpd-select.is-filtered{background:#e4e9ef!important;color:#526273!important;cursor:default!important}
.tpd-button:hover,.tpd-group:hover,.tpd-select:hover{filter:brightness(.94)}
.tpd-button:focus-visible,.tpd-group:focus-visible,.tpd-select:focus-within{outline:3px solid #80bbff!important;outline-offset:2px!important}
.tpd-toolbar{position:absolute;z-index:20;left:6px;right:6px;bottom:6px;display:flex;align-items:stretch;gap:6px;min-width:0}
.tpd-compact .tpd-select span{display:none!important}
.tpd-compact .tpd-select{padding:6px!important}
.tpd-compact .tpd-button{padding:6px 5px!important;font-size:12px!important}
@media(max-width:700px){.tpd-button,.tpd-select,.tpd-group{padding:5px 7px!important;font-size:12px!important}}
`;

  (document.head || document.documentElement).append(style);

  function chatKey() {
    const peer = document.querySelector("#MiddleColumn .chat-info [data-peer-id], #column-center .chat-info [data-peer-id], #MiddleColumn .topbar [data-peer-id], #column-center .topbar [data-peer-id]")?.getAttribute("data-peer-id");
    return peer || `${location.pathname}${location.hash}`;
  }

  function mainArea() {
    return document.querySelector("#MiddleColumn, #column-center, #main-columns, #Main") || document.body;
  }

  const MESSAGE = ".bubble[data-mid], .bubble[data-message-id], .Message[data-message-id], .message[data-mid], .message[data-message-id], .bubble, .Message";
  const EXCLUDED = ".avatar, .Avatar, .avatar-container, .user-avatar, .reply, .reply-preview, .reply-wrapper, .reply-content, .reply-message, .message-reply, .MessageReply, .embedded-message, .quoted-message, .quote, .emoji, .custom-emoji, .animated-emoji, .emoji-big, .sticker, .sticker-wrapper, .media-sticker, .sticker-video, .is-sticker, .is-emoji, .webpage, .web-page-preview, .webpage-preview, .tpd-button, .tpd-select, .tpd-toolbar, .tpd-group";
  const MEDIA = 'video, a[href*="/stream/"], a[href*="/progressive/"], a[href$=".mp4"], .video-time, .video-duration, .media-video, .message-media-duration, .album-item.video, img.media-photo, img.full-media, img.thumbnail, canvas.media-photo, canvas.full-media';

  function eligible(node) {
    if (node.closest(EXCLUDED)) return false;
    const message = node.closest(MESSAGE);
    for (let parent = node; parent && parent !== message; parent = parent.parentElement) {
      if ([...parent.classList].some(name => /^(avatar|reply|quote|emoji|custom-emoji|animated-emoji|sticker|webpage)(-|$)/i.test(name))) return false;
    }
    return true;
  }

  function mediaNodes(card, selector) {
    return [...card.querySelectorAll(selector)].filter(eligible);
  }

  function cardFor(node, root) {
    const album = node.closest(".album-item, .album-item-select-wrapper");
    const message = node.closest(MESSAGE);
    if (!message || !root.contains(message) || !eligible(node)) return null;
    const container = node.closest(".attachment, .media-container, .media-inner, .photo, .video-container, .video-wrapper");
    const card = album && message.contains(album) ? album :
      container && message.contains(container) ? container : message;
    return { card, message, album: Boolean(album) };
  }

  function sourceFor(card, node, mediaType) {
    if (mediaType === "video") {
      const video = node.matches("video") ? node : mediaNodes(card, "video")[0];
      const source = video?.currentSrc || video?.src || video?.querySelector("source")?.src;
      return source || mediaNodes(card, 'a[href*="/stream/"], a[href*="/progressive/"], a[href$=".mp4"]')[0]?.href || "";
    }
    const image = node.matches("img") ? node : mediaNodes(card, "img.media-photo, img.full-media, img.thumbnail")[0];
    return image?.currentSrc || image?.src || "";
  }

  function safeName(value) {
    const cleaned = String(value || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 80);
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `_${cleaned}` : cleaned;
  }

  function messageText(message) {
    return [...message.querySelectorAll(".text-content, .message-text, .translatable-message, .message-text-content, .caption")]
      .find(eligible)?.textContent?.trim() || "";
  }
  function messageTime(message) {
    const nodes = [message, ...message.querySelectorAll("time[datetime], [data-timestamp], [data-date], .time[title], .message-time[title]")];
    for (const node of nodes) {
      if (!eligible(node)) continue;
      const raw = node.getAttribute("datetime") || node.getAttribute("data-timestamp") || node.getAttribute("data-date") || node.getAttribute("title");
      if (!raw) continue;
      const number = Number(raw);
      const value = /^\d+$/.test(raw) ? number < 1e12 ? number * 1000 : number : Date.parse(raw);
      if (Number.isFinite(value) && value > 946684800000 && value < Date.now() + 86400000) return value;
    }
    return 0;
  }
  function groupName(message) {
    const text = messageText(message);
    if (safeName(text)) return safeName(text);
    const raw = message.querySelector("time[datetime], [data-timestamp], [data-date]");
    const value = raw?.getAttribute("datetime") || raw?.getAttribute("data-timestamp") || raw?.getAttribute("data-date");
    const numeric = Number(value);
    const date = value ? (/^\d+$/.test(value) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value)) : new Date();
    const parts = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")];
    return Number.isNaN(date.getTime()) ? `media-${Date.now()}` :
      `${parts.join("-")}_${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}-${String(date.getSeconds()).padStart(2, "0")}`;
  }

  function filename(card, id, mediaType, title, slot) {
    const named = card.querySelector("[download]")?.getAttribute("download") ||
      card.querySelector("[data-file-name]")?.getAttribute("data-file-name") || "";
    const extension = mediaType === "image" ? "jpg" : "mp4";
    const base = safeName(named) || `${title}${slot ? `-${slot + 1}` : ""}`;
    return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${extension}`;
  }

  function send(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  function scrollContainer() {
    const root = mainArea();
    for (const selector of ["div.bubbles .scrollable.scrollable-y", ".scrollable.scrollable-y", ".bubbles-inner", ".messages-container"]) {
      for (const candidate of root.querySelectorAll(selector)) {
        if (candidate.scrollHeight > candidate.clientHeight + 20 &&
            (/auto|scroll/.test(getComputedStyle(candidate).overflowY) || candidate.classList.contains("scrollable-y")))
          return candidate;
      }
    }
    const first = root.querySelector(".bubble[data-mid], .Message[data-message-id], [data-message-id]");
    for (let node = first?.parentElement; node && node !== root; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
    }
    return null;
  }

  function progress(stage, steps = 0, error = "") {
    send({ type: "scan_progress", stage, count: media.length, steps, error });
  }

  function scan() {
    const root = mainArea();
    const chat = chatKey();
    if (chat !== currentChat || cacheKey(chat) !== activeCacheKey) {
      persistCache(true);
      clearTimeout(cacheTimer);
      cacheReady = false; cacheSignature = ""; cacheStatus = "正在恢复本地媒体列表…";
      const wasChat = Boolean(currentChat);
      currentChat = chat; activeCacheKey = cacheKey(chat); cacheRetryAt = 0;
      collected = new Map();
      selected = new Map();
      groupNames = new Map();
      metadataAttempts = new Map();
      metadataCache = new Map();
      downloadedKeys = new Set();
      downloadedIdentities = new Set();
      checkedRecords = new Set();
      lastSnapshot = "";
      if (scanJob) scanJob.cancelled = true;
      if (wasChat) progress("idle", 0);
      restoreCache(chat);
    }
    const candidates = root.querySelectorAll(MEDIA);
    const found = new Map();
    let sequence = 0;
    for (const node of candidates) {
      const match = cardFor(node, root);
      if (!match) continue;
      const { card, message, album } = match;
      const groupCard = message;
      const isVideo = node.matches('video, a[href*="/stream/"], a[href*="/progressive/"], a[href$=".mp4"], .video-time, .video-duration, .media-video, .message-media-duration, .album-item.video') ||
        mediaNodes(card, "video, .video-time, .video-duration, .media-video, .message-media-duration").length > 0;
      const mediaType = isVideo ? "video" : "image";
      const url = sourceFor(card, node, mediaType);
      const marker = card.dataset.tpdMarker || (card.dataset.tpdMarker = crypto.randomUUID());
      const target = mediaNodes(card, mediaType === "video"
        ? "video, .album-item-media, .media-video, .video-time, img.media-photo, img.full-media"
        : "img.media-photo, img.full-media, canvas.media-photo, canvas.full-media, img.thumbnail")[0] || node;
      const targetMarker = target.dataset.tpdTarget || (target.dataset.tpdTarget = crypto.randomUUID());
      const id = card.getAttribute("data-mid") || card.getAttribute("data-message-id") ||
        message.getAttribute("data-mid") || message.getAttribute("data-message-id") ||
        card.querySelector("[data-mid], [data-message-id]")?.getAttribute("data-mid") ||
        card.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
        `visible-${++sequence}-${marker}`;
      const siblings = album ? [...message.querySelectorAll(".album-item, .album-item-select-wrapper")]
        .filter(element => !element.parentElement?.closest(".album-item, .album-item-select-wrapper")) : [];
      const slot = album ? Math.max(0, siblings.indexOf(card)) : 0;
      const key = `${chat}:${id}:${album ? `album-${slot}` : "single"}:${mediaType}`;
      if (found.has(key)) continue;
      const groupId = groupCard.getAttribute("data-mid") || groupCard.getAttribute("data-message-id") || id;
      const title = groupNames.get(groupId) || groupName(groupCard);
      groupNames.set(groupId, title);
      const isSelected = selected.get(key) ?? true;
      selected.set(key, isSelected);
      const old = collected.get(key) || metadataCache.get(key) || {};
      const fileId = card.getAttribute("data-document-id") || card.getAttribute("data-doc-id") || card.getAttribute("data-photo-id");
      const originalName = old.originalName || card.querySelector("[download]")?.getAttribute("download") || card.querySelector("[data-file-name]")?.getAttribute("data-file-name") || "";
      const item = { ...old, key, id, chat, url, marker, targetMarker, mediaType,
        identity: old.identity || (fileId ? `${card.hasAttribute("data-photo-id") ? "photo" : "document"}:${fileId}` : ""),
        visual: old.visual || null, text: messageText(groupCard), originalName,
        timestamp: old.timestamp || messageTime(groupCard), discoveredAt: old.discoveredAt || Date.now(), force: album || !url || mediaType === "image",
        slot, album, groupId, groupName: title, selected: isSelected,
        name: filename(card, id, mediaType, title, slot), version: location.pathname.startsWith("/k") ? "k" : "a" };
      found.set(key, item);
      let toolbar = card.querySelector(":scope > .tpd-toolbar");
      if (!toolbar) {
        toolbar = document.createElement("div"); toolbar.className = "tpd-toolbar";
        toolbar.addEventListener("click", event => event.stopPropagation());
        card.append(toolbar); cardObserver.observe(card);
      }
      if (!toolbar.querySelector(".tpd-select")) {
        const label = document.createElement("label");
        label.className = "tpd-select";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.setAttribute("aria-label", "选择此媒体");
        checkbox.checked = isSelected;
        checkbox.addEventListener("click", event => event.stopPropagation());
        checkbox.addEventListener("change", () => setSelected(checkbox.dataset.key, checkbox.checked));
        const caption = document.createElement("span"); caption.textContent = "勾选";
        label.append(checkbox, caption);
        label.addEventListener("click", event => event.stopPropagation());
        if (getComputedStyle(card).position === "static") card.style.position = "relative";
        toolbar.append(label);
      }
      const checkbox = toolbar.querySelector(".tpd-select input");
      checkbox.dataset.key = key;
      checkbox.checked = isSelected;
      if (!toolbar.querySelector(".tpd-button")) {
        const button = document.createElement("button");
        button.className = "tpd-button";
        button.type = "button";
        button.textContent = item.force ? "强制下载" : "下载视频";
        button.title = item.force ? "强制下载此媒体" : "下载此视频";
        button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          const current = media.find(entry => entry.key === button.dataset.key);
          if (!current) return;
          queue([{ ...current, force: current.force || button.dataset.force === "true" }]).catch(error => { button.textContent = error.message; });
        });
        if (getComputedStyle(card).position === "static") card.style.position = "relative";
        toolbar.append(button);
      }
      toolbar.querySelector(".tpd-button").dataset.key = key;
    }
    let changed = lastSnapshot !== chat;
    // Discard obsolete detections only for messages currently rendered on the page.
    const visibleIds = new Set([...root.querySelectorAll(MESSAGE)].map(element =>
      element.getAttribute("data-mid") || element.getAttribute("data-message-id")).filter(Boolean));
    for (const [key, item] of collected) {
      if (visibleIds.has(item.groupId) && !found.has(key)) { collected.delete(key); changed = true; }
    }
    const markers = new Set([...found.values()].map(item => item.marker));
    for (const overlay of root.querySelectorAll(".tpd-toolbar")) {
      if (!markers.has(overlay.parentElement?.dataset.tpdMarker)) { cardObserver.unobserve(overlay.parentElement); overlay.remove(); }
    }
    for (const [key, item] of found) {
      const previous = collected.get(key);
      if (!previous || previous.url !== item.url || previous.marker !== item.marker ||
          previous.name !== item.name || previous.force !== item.force) changed = true;
      collected.set(key, { ...previous, ...item });
    }
    rebuild();
    requestMetadata(found);
    lookupDownloaded([...found.values()]);
  }

  function compare(left, right) {
    let result = 0;
    if (left.timestamp && right.timestamp) result = left.timestamp - right.timestamp;
    else if (left.timestamp || right.timestamp) return left.timestamp ? -1 : 1;
    if (!result) result = String(left.groupId || left.id).localeCompare(String(right.groupId || right.id), undefined, { numeric: true });
    if (!result) result = (left.slot || 0) - (right.slot || 0);
    return settings.sort === "desc" ? -result : result;
  }

  function rebuild() {
    const all = [...collected.values()].sort(compare);
    const groups = new Map();
    const anchors = new Map();
    for (const item of all) {
      groups.set(item.groupId, (groups.get(item.groupId) || 0) + 1);
      const anchor = anchors.get(item.groupId);
      if (!anchor || (item.slot || 0) < (anchor.slot || 0)) anchors.set(item.groupId, item);
    }
    const kept = [], identities = new Set(), visualBuckets = new Map();
    const adIds = new Set(ads.map(ad => ad.identity).filter(Boolean));
    const adVisuals = new Map();
    if (settings.filterAds) for (const ad of ads) TPDModel.indexVisual(adVisuals, ad.visual, 7);
    filterStats = { scanned: all.length, duplicates: 0, ads: 0, downloaded: 0 };
    for (const item of all) {
      item.groupSize = groups.get(item.groupId);
      const anchor = anchors.get(item.groupId);
      item.folderContext = { id: anchor.id, groupId: anchor.groupId, text: anchor.text, timestamp: anchor.timestamp,
        discoveredAt: anchor.discoveredAt, originalName: anchor.originalName, mediaType: anchor.mediaType, slot: 0 };
      item.groupName = item.text || TPDModel.formatTime(item.timestamp || item.discoveredAt, settings.timeFormat);
      item.name = TPDModel.filePath(item, settings).split("/").at(-1);
      item.selected = selected.get(item.key) ?? true;
      item.filterReason = "";
      if (settings.filterAds && item.mediaType === "image" &&
        (adIds.has(item.identity) || TPDModel.matchingVisual(adVisuals, item.visual, 6))) {
        item.filterReason = "广告"; filterStats.ads++;
      } else if (settings.skipDownloaded && (downloadedKeys.has(item.key) ||
        (item.identity && downloadedIdentities.has(item.identity)))) {
        item.filterReason = "已下载"; filterStats.downloaded++;
      } else {
        let duplicate = Boolean(item.identity && identities.has(item.identity));
        if (!duplicate && item.visual) {
          duplicate = TPDModel.matchingVisual(visualBuckets, item.visual, 2);
          if (!duplicate) TPDModel.indexVisual(visualBuckets, item.visual, 3);
        }
        if (settings.dedupe && duplicate) { item.filterReason = "重复"; filterStats.duplicates++; }
        else { kept.push(item); if (item.identity) identities.add(item.identity); }
      }
    }
    media = kept;
    const groupCounts = new Map();
    for (const item of media) {
      const counts = groupCounts.get(item.groupId) || { total: 0, selected: 0 };
      counts.total++; counts.selected += item.selected ? 1 : 0; groupCounts.set(item.groupId, counts);
    }
    for (const item of media) { const counts = groupCounts.get(item.groupId); item.groupEligible = counts.total; item.groupSelected = counts.selected; }
    for (const checkbox of document.querySelectorAll(".tpd-select input")) {
      const item = collected.get(checkbox.dataset.key);
      if (!item) continue;
      checkbox.checked = item.selected;
      checkbox.disabled = Boolean(item.filterReason);
      checkbox.parentElement.classList.toggle("is-selected", item.selected && !item.filterReason);
      checkbox.parentElement.classList.toggle("is-filtered", Boolean(item.filterReason));
      const caption = checkbox.parentElement.querySelector("span");
      const captionText = item.filterReason ? "已过滤" : item.selected ? "已勾选" : "勾选";
      if (caption && caption.textContent !== captionText) caption.textContent = captionText;
      checkbox.parentElement.title = item.filterReason ? `已过滤：${item.filterReason}` : "勾选此媒体";
    }
    for (const message of mainArea().querySelectorAll(MESSAGE)) {
      const id = message.getAttribute("data-mid") || message.getAttribute("data-message-id");
      const count = groupCounts.get(id);
      let button = message.querySelector(":scope > .tpd-group");
      if (!count || count.total < 2) { button?.remove(); continue; }
      if (!button) {
        button = document.createElement("button"); button.className = "tpd-group"; button.type = "button";
        button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation();
          const group = media.filter(item => item.groupId === button.dataset.groupId);
          selectGroup(button.dataset.groupId, !group.every(item => item.selected));
        });
        if (getComputedStyle(message).position === "static") message.style.position = "relative";
        message.prepend(button);
      }
      button.dataset.groupId = id;
      const allSelected = count.selected === count.total;
      const partial = count.selected > 0 && !allSelected;
      button.classList.toggle("is-selected", allSelected);
      button.classList.toggle("is-partial", partial);
      const pressed = partial ? "mixed" : String(allSelected);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
      const text = `${allSelected ? "✓ 取消本条全选" : partial ? "− 本条全选" : "本条全选"} · ${count.selected}/${count.total}`;
      if (button.textContent !== text) button.textContent = text;
    }
    const snapshot = { type: "snapshot", chat: currentChat, cacheStatus, count: media.length, selectedCount: media.filter(item => item.selected).length,
      stats: filterStats, media: media.slice(0, 200) };
    const signature = JSON.stringify(snapshot);
    if (signature !== lastSnapshot) { lastSnapshot = signature; send(snapshot); }
    persistCache();
  }

  function setSelected(key, value) { selected.set(key, value); rebuild(); }
  function selectGroup(id, value) {
    for (const item of media) if (item.groupId === id) selected.set(item.key, value);
    rebuild();
  }

  function requestMetadata(found) {
    if (!bridgeReady) return;
    const batch = [];
    for (const item of found.values()) {
      if (item.identity && item.timestamp && (item.mediaType !== "image" || item.visual)) continue;
      const attempt = metadataAttempts.get(item.key) || { tries: 0, at: 0 };
      if (attempt.tries >= 10 || Date.now() - attempt.at < 3000) continue;
      metadataAttempts.set(item.key, { tries: attempt.tries + 1, at: Date.now() });
      batch.push({ key: item.key, id: item.id, chat: item.chat, groupId: item.groupId,
        marker: item.marker, targetMarker: item.targetMarker, mediaType: item.mediaType, album: item.album, slot: item.slot });
      if (batch.length >= 32) break;
    }
    if (batch.length) document.dispatchEvent(new CustomEvent(REQUEST, { detail: { channel, type: "metadata", items: batch } }));
  }

  async function lookupDownloaded(items) {
    const pending = items.filter(item => !checkedRecords.has(`${item.key}:${item.identity || ""}`));
    for (let offset = 0; offset < pending.length; offset += 500) {
      const batch = pending.slice(offset, offset + 500);
      for (const item of batch) checkedRecords.add(`${item.key}:${item.identity || ""}`);
      try {
        const result = await chrome.runtime.sendMessage({ type: "lookup_downloads", items: batch.map(item => ({ key: item.key, identity: item.identity })) });
        if (!result.ok) throw new Error(result.error);
        for (const key of result.keys) {
          downloadedKeys.add(key);
          const item = collected.get(key);
          if (item?.identity) downloadedIdentities.add(item.identity);
        }
        rebuild();
      } catch { for (const item of batch) checkedRecords.delete(`${item.key}:${item.identity || ""}`); }
    }
  }

  document.addEventListener("tpd:metadata-result", event => {
    const detail = event.detail;
    if (detail?.channel !== channel) return;
    const enriched = [];
    for (const result of detail.results || []) {
      if (result.chat !== currentChat) continue;
      const item = collected.get(result.key);
      if (item) {
        if (result.identity) item.identity = result.identity;
        if (result.timestamp) item.timestamp = result.timestamp;
        if (result.visual) item.visual = result.visual;
        if (result.originalName) item.originalName = result.originalName;
        metadataCache.set(item.key, { identity: item.identity, timestamp: item.timestamp, visual: item.visual, discoveredAt: item.discoveredAt, originalName: item.originalName });
        enriched.push(item);
      }
    }
    rebuild();
    lookupDownloaded(enriched);
  });

  document.addEventListener("tpd:save", async event => {
    const detail = event.detail;
    if (detail?.channel !== channel) return;
    let result;
    try { result = await chrome.runtime.sendMessage({ type: "save_media", url: detail.url, mime: detail.mime, item: detail.item }); }
    catch (error) { result = { ok: false, error: error.message }; }
    document.dispatchEvent(new CustomEvent("tpd:save-result", { detail: { channel, requestId: detail.requestId, result } }));
  });

  async function scanAll() {
    if (scanJob) return;
    scan();
    const job = { cancelled: false };
    scanJob = job;
    const chat = chatKey();
    const scroll = scrollContainer();
    if (!scroll) {
      progress("complete", 0);
      scanJob = null;
      return;
    }
    const originalTop = scroll.scrollTop;
    const originallyAtBottom = scroll.scrollHeight - scroll.clientHeight - originalTop < 30;
    let steps = 0;
    let complete = true;
    progress("scanning", steps);
    try {
      for (const direction of [1, -1]) {
        let stable = 0;
        while (!job.cancelled && chatKey() === chat && steps < 20000 && stable < 8) {
          const before = `${Math.round(scroll.scrollTop)}:${scroll.scrollHeight}:${media.length}`;
          const stride = Math.max(160, Math.round(scroll.clientHeight * 0.55));
          scroll.scrollTop += direction * stride;
          const atEdge = direction > 0
            ? scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 3
            : scroll.scrollTop < 3;
          await new Promise(resolve => setTimeout(resolve, atEdge ? 800 : 350));
          scan();
          steps++;
          const after = `${Math.round(scroll.scrollTop)}:${scroll.scrollHeight}:${media.length}`;
          stable = atEdge && before === after ? stable + 1 : 0;
          if (steps % 5 === 0) progress("scanning", steps);
        }
        if (job.cancelled || chatKey() !== chat || steps >= 20000) { complete = false; break; }
      }
      if (chatKey() === chat) progress(job.cancelled ? "cancelled" : complete ? "complete" : "partial", steps,
        complete ? "" : "扫描已停止，现有结果仍可使用");
    } catch (error) {
      if (chatKey() === chat) progress("failed", steps, String(error?.message || error));
    } finally {
      if (chatKey() === chat) {
        scroll.scrollTop = originallyAtBottom ? scroll.scrollHeight : originalTop;
        setTimeout(scan, 400);
      }
      scanJob = null;
    }
  }

  async function queue(items) {
    const chat = currentChat;
    if (scanJob) { scanJob.cancelled = true; while (scanJob) await new Promise(resolve => setTimeout(resolve, 100)); }
    await lookupDownloaded(items);
    if (chat !== currentChat) throw new Error("聊天已切换，请重新选择媒体");
    const available = new Map(media.map(item => [item.key, item]));
    const chosen = items.filter(item => available.has(item.key) && !queuedTasks.has(item.key));
    const groups = new Map();
    for (const requested of chosen) {
      const current = available.get(requested.key);
      const item = { ...current, force: requested.force || current.force, naming: { ...settings }, skipDownloaded: settings.skipDownloaded };
      const group = `${item.chat}:${item.groupId || item.id}`;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(item);
      queuedTasks.set(item.key, item);
      await chrome.runtime.sendMessage({ type: "task", task: { ...item, status: "queued", progress: 0, error: "" } });
    }
    for (const group of groups.values()) document.dispatchEvent(new CustomEvent(REQUEST, { detail: { channel, items: group } }));
    return { ok: true, count: chosen.length, skipped: items.length - chosen.length };
  }

  document.addEventListener(STATUS, event => {
    const detail = event.detail;
    if (!detail || detail.channel !== channel) return;
    const item = queuedTasks.get(detail.key) || collected.get(detail.key) || { key: detail.key };
    if (["failed", "skipped"].includes(detail.status)) queuedTasks.delete(detail.key);
    if (detail.status === "skipped") {
      downloadedKeys.add(item.key);
      if (item.identity) downloadedIdentities.add(item.identity);
      rebuild();
    }
    const button = [...document.querySelectorAll(".tpd-button")].find(node =>
      node.parentElement?.dataset.tpdMarker === item.marker);
    if (button) {
      if (detail.status === "failed") {
        button.dataset.force = "true";
        button.textContent = "强制下载";
      } else if (detail.status === "downloading") button.textContent = `${Math.round(detail.progress || 0)}%`;
      else if (detail.status === "saving") button.textContent = "正在保存";
      else if (detail.status === "skipped") button.textContent = "已跳过";
    }
    send({ type: "task", task: {
      ...item,
      status: detail.status,
      progress: detail.progress,
      error: detail.error || ""
    } });
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "download_finished") {
      const item = message.task;
      queuedTasks.delete(item.key);
      if (item.status === "success") { downloadedKeys.add(item.key); if (item.identity) downloadedIdentities.add(item.identity); }
      document.dispatchEvent(new CustomEvent("tpd:release", { detail: { channel, url: message.objectUrl } }));
      const button = [...document.querySelectorAll(".tpd-button")].find(node => node.dataset.key === item.key);
      if (button) button.textContent = item.status === "success" ? "保存完成" : "保存失败";
      rebuild(); respond({ ok: true });
    } else if (message?.type === "refresh") {
      scan();
      respond({ ok: true, count: media.length });
    } else if (message?.type === "scan_all") {
      if (queuedTasks.size) { respond({ ok: false, error: "下载队列正在使用聊天页面，请等待当前队列完成后扫描" }); return; }
      if (!scanJob) scanAll();
      respond({ ok: true, started: Boolean(scanJob), count: media.length });
    } else if (message?.type === "cancel_scan") {
      if (scanJob) scanJob.cancelled = true;
      respond({ ok: true });
    } else if (message?.type === "media_page") {
      const offset = Math.max(0, Number(message.offset) || 0);
      respond({ ok: true, count: media.length, media: media.slice(offset, offset + 200) });
    } else if (message?.type === "set_selected") {
      const item = collected.get(message.key);
      if (!item) respond({ ok: false, error: "未找到媒体" });
      else { setSelected(message.key, Boolean(message.selected)); respond({ ok: true }); }
    } else if (message?.type === "select_group") {
      selectGroup(message.groupId, Boolean(message.selected)); respond({ ok: true });
    } else if (message?.type === "select_all") {
      for (const item of media) selected.set(item.key, Boolean(message.selected));
      rebuild(); respond({ ok: true });
    } else if (message?.type === "download_all") {
      const items = media.filter(item => item.selected);
      if (!items.length) respond({ ok: false, error: "尚未勾选媒体" });
      else { queue(items).then(respond).catch(error => respond({ ok: false, error: error.message })); return true; }
    } else if (message?.type === "download") {
      const requested = Array.isArray(message.items) ? message.items : [];
      const current = new Set(media.map(item => item.key));
      const items = requested.filter(item => current.has(item.key));
      if (!items.length) respond({ ok: false, error: "当前聊天没有匹配的视频或图片。请刷新列表。" });
      else { queue(items).then(respond).catch(error => respond({ ok: false, error: error.message })); return true; }
    }
  });

  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  }).observe(document.documentElement, { childList: true, subtree: true });
  async function loadConfig() {
    const result = await chrome.runtime.sendMessage({ type: "get_config" });
    if (result.ok) { settings = result.settings; ads = result.ads; rebuild(); }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.settings || changes.adRules)) loadConfig().catch(() => {});
  });
  window.addEventListener("hashchange", scan);
  window.addEventListener("popstate", scan);
  scan();
  loadConfig().catch(() => {});
  setInterval(() => {
    if (document.visibilityState === "visible") scan();
  }, 3000);
})();
