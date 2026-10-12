(() => {
  const channel = document.currentScript?.dataset.channel;
  if (!channel) return;
  const REQUEST = "tpd:request";
  const STATUS = "tpd:status";
  const queue = [];
  const active = new Set();
  let running = 0;
  const saveRequests = new Map();
  const objectUrls = new Set();

  function status(item, state, progress = 0, error = "") {
    document.dispatchEvent(new CustomEvent(STATUS, {
      detail: { channel, key: item.key, status: state, progress, error }
    }));
  }

  async function save(blob, item) {
    if (!(blob instanceof Blob)) throw new Error("未取得完整文件，无法按文件夹保存");
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const requestId = crypto.randomUUID();
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          saveRequests.delete(requestId);
          reject(new Error("浏览器保存请求超时"));
        }, 20000);
        saveRequests.set(requestId, { resolve, reject, timer });
        document.dispatchEvent(new CustomEvent("tpd:save", { detail: { channel, requestId, url, mime: blob.type, item } }));
      });
      if (!result.ok) throw new Error(result.error || "浏览器未接受保存请求");
      if (result.skipped) {
        URL.revokeObjectURL(url);
        objectUrls.delete(url);
        status(item, "skipped", 100, "此媒体已成功下载，已跳过");
      }
    } catch (error) {
      URL.revokeObjectURL(url);
      objectUrls.delete(url);
      throw error;
    }
  }

  document.addEventListener("tpd:save-result", event => {
    const data = event.detail;
    if (data?.channel !== channel) return;
    const pending = saveRequests.get(data.requestId);
    if (pending) { clearTimeout(pending.timer); saveRequests.delete(data.requestId); pending.resolve(data.result); }
  });
  document.addEventListener("tpd:release", event => {
    const data = event.detail;
    if (data?.channel === channel && objectUrls.has(data.url)) {
      URL.revokeObjectURL(data.url);
      objectUrls.delete(data.url);
    }
  });

  function peerId(item) {
    const header = document.querySelector("#MiddleColumn .chat-info [data-peer-id], #column-center .chat-info [data-peer-id], #MiddleColumn .topbar [data-peer-id]");
    return header?.getAttribute("data-peer-id") || (/^-?\d+$/.test(item.chat) ? item.chat : "");
  }

  function sameChat(item) {
    const header = document.querySelector("#MiddleColumn .chat-info [data-peer-id], #column-center .chat-info [data-peer-id], #MiddleColumn .topbar [data-peer-id], #column-center .topbar [data-peer-id]");
    const current = header?.getAttribute("data-peer-id") || `${location.pathname}${location.hash}`;
    return current === item.chat;
  }

  const EXCLUDED = ".avatar, .Avatar, .avatar-container, .user-avatar, .reply, .reply-preview, .reply-wrapper, .reply-content, .reply-message, .message-reply, .MessageReply, .embedded-message, .quoted-message, .quote, .emoji, .custom-emoji, .animated-emoji, .emoji-big, .sticker, .sticker-wrapper, .media-sticker, .sticker-video, .is-sticker, .is-emoji, .webpage, .web-page-preview, .webpage-preview, .tpd-button, .tpd-select";

  function visible(element) {
    if (!element || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.visibility === "hidden" || parentStyle.opacity === "0" || parent.getAttribute("aria-hidden") === "true") return false;
    }
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0" &&
      box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 &&
      box.left < innerWidth && box.top < innerHeight;
  }

  function activeViewer() {
    return [...document.querySelectorAll(".MediaViewerSlide--active, .media-viewer-movers, #MediaViewer, .media-viewer-whole")]
      .find(visible) || null;
  }

  function viewerElement(mediaType) {
    const viewer = activeViewer();
    if (!viewer) return null;
    // Never use an arbitrary img: the viewer header also contains the sender avatar.
    const selector = mediaType === "image"
      ? "img.media-photo, img.full-media, .MediaViewerSlide--active img, .media-viewer-mover img, .media-viewer-aspecter img"
      : "video.media-video, video.full-media, .MediaViewerSlide--active video, .media-viewer-mover video, .media-viewer-aspecter video";
    let nodes = [...viewer.querySelectorAll(selector)].filter(element => visible(element) &&
      !element.closest(`${EXCLUDED}, .media-viewer-topbar, .MediaViewerHeader, .media-viewer-thumbnails, .MediaViewerFooter, .thumbnail-strip`) &&
      !element.matches(".thumbnail-avatar") &&
      // Web K uses class="thumbnail" for loaded large photos too. Accept it only
      // inside the media canvas, never in the viewer header or navigation strip.
      (!element.matches(".thumbnail") || Boolean(element.closest(".media-viewer-aspecter, .media-viewer-mover, .MediaViewerContent, .MediaViewerSlide--active"))));
    const active = nodes.filter(element => element.closest(".media-viewer-mover.active, .MediaViewerSlide--active"));
    if (active.length) nodes = active;
    // Adjacent slides may remain in the DOM. Prefer the element centred in the viewport.
    nodes.sort((left, right) => {
      const distance = element => {
        const box = element.getBoundingClientRect();
        return Math.abs(box.left + box.width / 2 - innerWidth / 2);
      };
      return distance(left) - distance(right);
    });
    return nodes[0] || null;
  }

  function mediaInViewer(mediaType) {
    const element = viewerElement(mediaType);
    if (!element) return "";
    if (mediaType === "image") {
      if (!element.complete || !element.naturalWidth) return "";
      return element.currentSrc || element.src || "";
    }
    return element.currentSrc || element.src || element.querySelector("source")?.src || "";
  }

  async function closeViewer() {
    if (!activeViewer()) return;
    const button = [...document.querySelectorAll("#MediaViewer button.media-viewer-close, button.media-viewer-close, .media-viewer-topbar-left button, #MediaViewer .close-button, #MediaViewer button[aria-label='Close'], .media-viewer-whole .btn-icon.tgico-close")].find(visible);
    if (button) button.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    for (let attempt = 0; attempt < 12 && activeViewer(); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    if (activeViewer()) throw new Error("上一个媒体查看器未关闭，已停止切换文件，避免下载错误内容");
  }

  function findCard(item) {
    const root = document.querySelector("#MiddleColumn, #column-center, #main-columns, #Main") || document.body;
    const messageSelector = ".bubble[data-mid], .bubble[data-message-id], .Message[data-message-id], .message[data-mid], .message[data-message-id], .bubble, .Message";
    const marked = [...root.querySelectorAll("[data-tpd-marker]")].find(element =>
      element.dataset.tpdMarker === item.marker);
    if (marked) {
      const message = marked.closest(messageSelector);
      const id = message?.getAttribute("data-mid") || message?.getAttribute("data-message-id");
      if (!id || id === String(item.groupId) || id === String(item.id)) return marked;
    }
    const matching = [...root.querySelectorAll("[data-mid], [data-message-id]")].filter(element =>
      !element.closest(EXCLUDED) && element.matches(`${messageSelector}, .album-item, .album-item-select-wrapper`) &&
      (element.getAttribute("data-mid") === String(item.id) ||
      element.getAttribute("data-message-id") === String(item.id)));
    for (const element of matching) {
      if (!item.album) return element;
      if (element.matches(".album-item, .album-item-select-wrapper")) return element;
      const albums = [...element.querySelectorAll(".album-item, .album-item-select-wrapper")]
        .filter(child => !child.parentElement?.closest(".album-item, .album-item-select-wrapper"));
      if (albums[item.slot]) return albums[item.slot];
    }
    return null;
  }

  function fingerprint(item) {
    if (item.mediaType !== "image") return null;
    const card = findCard(item);
    const image = card && [...card.querySelectorAll("img.media-photo, img.full-media, img.thumbnail")]
      .find(node => !node.closest(EXCLUDED) && node.complete && node.naturalWidth >= 64 && node.naturalHeight > 0 &&
        !String(node.currentSrc || node.src).startsWith("data:"));
    if (!image) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 9;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, 9, 9);
      const pixels = context.getImageData(0, 0, 9, 9).data;
      const grey = Array.from({ length: 81 }, (_, index) =>
        pixels[index * 4] * 0.299 + pixels[index * 4 + 1] * 0.587 + pixels[index * 4 + 2] * 0.114);
      const average = grey.reduce((sum, value) => sum + value, 0) / grey.length;
      const contrast = Math.sqrt(grey.reduce((sum, value) => sum + (value - average) ** 2, 0) / grey.length);
      let horizontal = "", vertical = "";
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        horizontal += grey[y * 9 + x] > grey[y * 9 + x + 1] ? "1" : "0";
        vertical += grey[y * 9 + x] > grey[(y + 1) * 9 + x] ? "1" : "0";
      }
      const hex = bits => BigInt(`0b${bits}`).toString(16).padStart(16, "0");
      return { hash: hex(horizontal) + hex(vertical), aspect: image.naturalWidth / image.naturalHeight, contrast };
    } catch { return null; } // Cross-origin/undecoded images remain eligible; never guess a fingerprint.
  }

  async function metadata(items) {
    const results = [];
    const visuals = new Map(items.map(item => [item.key, fingerprint(item)]));
    for (const item of items) {
      if (!sameChat(item)) break;
      const result = { key: item.key, chat: item.chat, visual: visuals.get(item.key) };
      const managers = window.rootScope?.managers;
      const peer = peerId(item);
      const mid = String(item.id || "").split("_").pop();
      try {
        if (managers?.appMessagesManager && peer && mid && !mid.startsWith("visible-")) {
          const record = await managers.appMessagesManager.getMessageByPeer(peer, mid);
          const media = record?.media?.document || record?.media?.photo;
          if (media?.id) result.identity = `${record.media.photo ? "photo" : "document"}:${media.id}`;
          if (record?.date) result.timestamp = Number(record.date) * 1000;
          if (media?.file_name) result.originalName = media.file_name;
        }
      } catch { /* Keep DOM metadata when the internal API is unavailable. */ }
      results.push(result);
    }
    document.dispatchEvent(new CustomEvent("tpd:metadata-result", { detail: { channel, results } }));
  }

  async function findCardInHistory(item) {
    if (!sameChat(item)) throw new Error("聊天已切换，请返回原聊天后重试");
    const present = findCard(item);
    if (present) return { card: present, restore: () => {} };
    const root = document.querySelector("#MiddleColumn, #column-center, #main-columns, #Main") || document.body;
    let scroll = null;
    for (const selector of ["div.bubbles .scrollable.scrollable-y", ".scrollable.scrollable-y", ".bubbles-inner", ".messages-container"]) {
      scroll = [...root.querySelectorAll(selector)].find(candidate =>
        candidate.scrollHeight > candidate.clientHeight + 20 &&
        (/auto|scroll/.test(getComputedStyle(candidate).overflowY) || candidate.classList.contains("scrollable-y")));
      if (scroll) break;
    }
    if (!scroll) throw new Error("旧消息已离开页面，且无法定位聊天历史滚动区域");
    const oldTop = scroll.scrollTop;
    const atBottom = scroll.scrollHeight - scroll.clientHeight - oldTop < 30;
    const restore = () => { scroll.scrollTop = atBottom ? scroll.scrollHeight : oldTop; };
    for (const direction of [-1, 1]) {
      let stable = 0;
      for (let step = 0; step < 20000 && stable < 5; step++) {
        if (!sameChat(item)) { restore(); throw new Error("聊天已切换，已停止定位媒体"); }
        const before = `${Math.round(scroll.scrollTop)}:${scroll.scrollHeight}`;
        scroll.scrollTop += direction * Math.max(240, Math.round(scroll.clientHeight * .75));
        const atEdge = direction < 0 ? scroll.scrollTop < 3 :
          scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 3;
        await new Promise(resolve => setTimeout(resolve, atEdge ? 650 : 180));
        const card = findCard(item);
        if (card) return { card, restore };
        const after = `${Math.round(scroll.scrollTop)}:${scroll.scrollHeight}`;
        stable = atEdge && before === after ? stable + 1 : 0;
      }
    }
    restore();
    throw new Error("已扫描的媒体未能在聊天历史中重新定位");
  }

  async function resolveViaViewer(item) {
    await closeViewer();
    const { card, restore } = await findCardInHistory(item);
    const started = performance.now();
    const marked = item.targetMarker && (card.dataset.tpdTarget === item.targetMarker ? card :
      [...card.querySelectorAll("[data-tpd-target]")].find(element => element.dataset.tpdTarget === item.targetMarker));
    const targets = marked ? [marked] : [...card.querySelectorAll("video.full-media, video.media-video, video, img.media-photo, img.full-media, canvas.media-photo, .album-item-media, .media-inner, .video-time")]
      .filter(element => !element.closest(EXCLUDED));
    if (!targets.length) { restore(); throw new Error("未找到此文件的媒体元素（头像、引用、表情和贴纸已排除）"); }
    for (const target of targets) {
      target.click();
      await new Promise(resolve => setTimeout(resolve, 350));
      if (activeViewer()) break;
    }
    let url = "";
    const deadline = Date.now() + (item.mediaType === "image" ? 30000 : 12000);
    let playAttempted = false;
    let imageSource = "";
    let imageSourceSince = 0;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (!sameChat(item)) { await closeViewer().catch(() => {}); throw new Error("聊天已切换，已停止当前媒体取源"); }
      url = mediaInViewer(item.mediaType);
      if (url && item.mediaType === "image") {
        // Opening animations use a stripped data thumbnail. Wait for a decoded
        // file URL and for replacement by the larger loaded photo to settle.
        if (url.startsWith("data:")) { url = ""; continue; }
        if (url !== imageSource) { imageSource = url; imageSourceSince = Date.now(); }
        const viewer = activeViewer();
        const loading = viewer && [...viewer.querySelectorAll(".preloader, .preloader-container")].some(visible);
        if (!loading && Date.now() - imageSourceSince >= 1000) break;
        url = "";
        continue;
      }
      if (url) break;
      const viewer = activeViewer();
      if (item.mediaType !== "image" && viewer && !playAttempted) {
        const playButton = viewer.querySelector(".video-play-icon, .video-play-button, .play-button, .media-viewer-play, button[class*='video-play'], button[aria-label*='play' i], button[title*='play' i]");
        const video = viewerElement("video");
        if (playButton) { playButton.click(); playAttempted = true; }
        else if (video?.paused) { video.click(); video.play().catch(() => {}); playAttempted = true; }
        else {
          const preview = [...viewer.querySelectorAll(".video-preview, .video-time, img.media-photo")]
            .find(element => visible(element) && !element.closest(EXCLUDED));
          if (preview) { preview.click(); playAttempted = true; }
        }
      }
      const stream = item.mediaType === "video" && performance.getEntriesByType("resource").filter(entry =>
        entry.startTime >= started && /\/hls\//.test(entry.name) && !/hls_quality_file/.test(entry.name)).at(-1);
      if (stream && activeViewer()) {
        url = stream.name.replace("/hls/", "/stream/");
        break;
      }
    }
    if (!url) {
      const opened = Boolean(activeViewer());
      const viewer = activeViewer();
      const image = item.mediaType === "image" ? viewerElement("image") : null;
      const diagnostics = item.mediaType === "image" && viewer
        ? `（图片元素=${viewer.querySelectorAll("img").length}，展示候选=${image ? 1 : 0}，已解码=${image?.complete && image?.naturalWidth ? 1 : 0}，仍加载=${[...viewer.querySelectorAll(".preloader, .preloader-container")].some(visible) ? 1 : 0}）` : "";
      await closeViewer().catch(() => {});
      restore();
      throw new Error(!opened ? "点击媒体元素后未打开媒体查看器" : item.mediaType === "image"
        ? `查看器已打开，但未取得加载完成的图片地址${diagnostics}`
        : "查看器已打开，但媒体展示区域没有可用视频地址");
    }
    return {
      url,
      async close() {
        try { await closeViewer(); } finally { restore(); }
      }
    };
  }

  async function fetchWithRetry(url, options) {
    let error;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { credentials: "include", ...options });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
      } catch (caught) {
        error = caught;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
    throw error;
  }

  async function readStream(response, item, total = 0) {
    if (!response.body) return response.blob();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (total) status(item, "downloading", Math.min(99, Math.round(size / total * 100)));
    }
    return new Blob(chunks, { type: response.headers.get("Content-Type") ||
      (item.mediaType === "image" ? "image/jpeg" : "video/mp4") });
  }

  function contentRange(response) {
    const value = response.headers.get("Content-Range") || "";
    const match = value.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (!match) return null;
    const [start, end, total] = match.slice(1).map(Number);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
      Number.isSafeInteger(total) && start <= end && end < total
      ? { start, end, total } : null;
  }

  function checkMediaType(response, item) {
    const type = response.headers.get("Content-Type") || "";
    if (item.mediaType === "video" && type.startsWith("image/")) throw new Error("取得的是预览图，不是视频");
    if (item.mediaType === "image" && type.startsWith("video/")) throw new Error("取得的是视频，不是图片");
  }

  function finishDownload(blob, item, asBlob) {
    if (asBlob) return blob;
    return save(blob, item);
  }

  async function withoutRanges(url, item, asBlob = false) {
    const response = await fetchWithRetry(url);
    checkMediaType(response, item);
    if (response.status === 206) {
      const range = contentRange(response);
      if (!range || range.start !== 0 || range.end !== range.total - 1) {
        await response.body?.cancel();
        throw new Error("未取得完整文件数据，无法按文件夹保存；请尝试强制下载");
      }
    }
    const length = Number(response.headers.get("Content-Length")) || 0;
    return finishDownload(await readStream(response, item, length), item, asBlob);
  }

  async function downloadUrl(item, asBlob = false) {
    const url = item.url;
    if (!url || !/^(https?:|blob:|data:|\/)/.test(url)) throw new Error("没有可用的媒体地址");
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      const response = await fetchWithRetry(url);
      return finishDownload(await readStream(response, item), item, asBlob);
    }
    // Telegram's service worker may answer a range request with a larger
    // segment than requested. Ask for the open range and use its actual bounds.
    const first = await fetchWithRetry(url, { headers: { Range: "bytes=0-" } });
    checkMediaType(first, item);
    if (first.status === 200) {
      const length = Number(first.headers.get("Content-Length")) || 0;
      return finishDownload(await readStream(first, item, length), item, asBlob);
    }
    const initial = contentRange(first);
    if (!initial || initial.start !== 0) {
      await first.body?.cancel();
      return withoutRanges(url, item, asBlob);
    }
    const firstChunk = await first.arrayBuffer();
    if (firstChunk.byteLength !== initial.end + 1) throw new Error("首段视频长度与响应标头不符");
    const chunks = [firstChunk];
    const chunkSize = 4 * 1024 * 1024;
    let received = firstChunk.byteLength;
    status(item, "downloading", Math.min(99, Math.round(received / initial.total * 100)));
    while (received < initial.total) {
      const end = Math.min(initial.total - 1, received + chunkSize - 1);
      const response = await fetchWithRetry(url, { headers: { Range: `bytes=${received}-${end}` } });
      checkMediaType(response, item);
      if (response.status === 200) {
        return finishDownload(await readStream(response, item, initial.total), item, asBlob);
      }
      const range = contentRange(response);
      if (!range || range.start !== received || range.total !== initial.total) {
        await response.body?.cancel();
        return withoutRanges(url, item, asBlob);
      }
      const chunk = await response.arrayBuffer();
      if (chunk.byteLength !== range.end - range.start + 1) throw new Error("视频分段长度与响应标头不符");
      chunks.push(chunk);
      received += chunk.byteLength;
      status(item, "downloading", Math.min(99, Math.round(received / initial.total * 100)));
    }
    return finishDownload(new Blob(chunks, { type: first.headers.get("Content-Type") ||
      (item.mediaType === "image" ? "image/jpeg" : "video/mp4") }), item, asBlob);
  }

  async function process(item) {
    status(item, "resolving", 0);
    let viewer;
    try {
      if (!sameChat(item)) throw new Error("聊天已切换，请返回原聊天后重试");
      if (item.force || !item.url) viewer = await resolveViaViewer(item);
      status(item, "downloading", 1);
      let blob;
      try {
        blob = await downloadUrl({ ...item, url: viewer?.url || item.url }, true);
      } catch (error) {
        if (viewer) throw error;
        viewer = await resolveViaViewer(item);
        blob = await downloadUrl({ ...item, url: viewer.url }, true);
      }
      status(item, "saving", 99);
      await save(blob, item);
      // The background download service owns the final complete/interrupted status.
    } catch (error) {
      status(item, "failed", 0, String(error?.message || error));
    } finally {
      await viewer?.close().catch(() => {});
    }
  }

  async function processGroup(items) {
    for (const item of items) await process(item);
  }

  function pump() {
    // Viewer navigation and chat scrolling are shared page state.
    while (running < 1 && queue.length) {
      const items = queue.shift();
      running++;
      (items.length === 1 ? process(items[0]) : processGroup(items)).finally(() => {
        running--;
        for (const item of items) active.delete(item.key);
        pump();
      });
    }
  }

  document.addEventListener(REQUEST, event => {
    const detail = event.detail;
    if (detail?.channel !== channel) return;
    if (detail.type === "metadata") { metadata(detail.items || []).catch(() => {}); return; }
    const items = (Array.isArray(detail.items) ? detail.items : [detail.item])
      .filter(item => item?.key && !active.has(item.key));
    if (!items.length) return;
    for (const item of items) active.add(item.key);
    queue.push(items);
    pump();
  });
})();
