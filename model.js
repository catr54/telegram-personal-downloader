(() => {
  const defaults = Object.freeze({
    dedupe: true, filterAds: true, skipDownloaded: true, sort: "asc",
    baseFolder: "Telegram", folderTemplate: "{text}_{messageId}",
    fileTemplate: "{text}_{index}", timeFormat: "YYYY-MM-DD_HH-mm-ss"
  });
  function clean(value, limit = 100) {
    let name = String(value ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ").trim().slice(0, limit).replace(/[. ]+$/g, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return name && name !== "." && name !== ".." ? name : "media";
  }
  function formatTime(timestamp, rule) {
    const date = new Date(timestamp || Date.now());
    const pad = number => String(number).padStart(2, "0");
    const values = { YYYY: date.getFullYear(), MM: pad(date.getMonth() + 1), DD: pad(date.getDate()),
      HH: pad(date.getHours()), mm: pad(date.getMinutes()), ss: pad(date.getSeconds()) };
    return String(rule || defaults.timeFormat).replace(/YYYY|MM|DD|HH|mm|ss/g, token => values[token]);
  }
  function extension(item, mime = "") {
    const types = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
      "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
    return types[mime.split(";")[0]] || String(item.originalName || item.name || "").match(/\.(jpg|jpeg|png|webp|gif|avif|mp4|webm|mov)$/i)?.[1]?.toLowerCase() ||
      (item.mediaType === "image" ? "jpg" : "mp4");
  }
  function tokens(item, settings, mime) {
    const timestamp = item.timestamp || item.discoveredAt || Date.now();
    const original = String(item.originalName || (item.mediaType === "image" ? "photo" : "video")).replace(/\.[^.]+$/, "");
    return { text: clean(item.text || formatTime(timestamp, settings.timeFormat)),
      timestamp: formatTime(timestamp, settings.timeFormat), date: formatTime(timestamp, "YYYY-MM-DD"),
      time: formatTime(timestamp, "HH-mm-ss"), messageId: clean(item.groupId || item.id),
      index: String((item.slot || 0) + 1).padStart(2, "0"), type: item.mediaType === "image" ? "图片" : "视频",
      original: clean(original), ext: extension(item, mime) };
  }
  function render(template, values) {
    return String(template).replace(/\{([a-zA-Z]+)\}/g, (_, token) => values[token] ?? "");
  }
  function filePath(item, settings = defaults, mime = "") {
    const config = { ...defaults, ...settings };
    const values = tokens(item, config, mime);
    let file = clean(render(config.fileTemplate, values), 150);
    if (!/\{ext\}/.test(config.fileTemplate)) file += `.${values.ext}`;
    const folders = String(config.baseFolder || "").split(/[\\/]/).filter(Boolean).map(value => clean(value, 60));
    if (item.groupSize > 1) {
      const sharedValues = tokens(item.folderContext || item, config, "");
      folders.push(clean(render(config.folderTemplate, sharedValues), 90));
    }
    return [...folders, file].join("/");
  }
  function validate(settings) {
    const allowed = new Set(["text", "timestamp", "date", "time", "messageId", "index", "type", "original", "ext"]);
    for (const field of ["folderTemplate", "fileTemplate"]) {
      if (!String(settings[field] || "").trim()) throw new Error("文件名和文件夹名格式不能为空");
      for (const token of String(settings[field]).matchAll(/\{([^{}]+)\}/g))
        if (!allowed.has(token[1])) throw new Error(`不支持的命名标记：{${token[1]}}`);
    }
    if (!String(settings.timeFormat || "").trim()) throw new Error("时间格式不能为空");
    const root = String(settings.baseFolder || "");
    if (/^(?:[a-z]:|[\\/])/i.test(root) || root.split(/[\\/]/).some(part => part === ".."))
      throw new Error("下载子目录须使用相对路径，不能填写磁盘绝对路径或 ..");
    return { ...defaults, ...settings, sort: settings.sort === "desc" ? "desc" : "asc" };
  }
  function visualMatch(left, right, limit = 6) {
    if (!left?.hash || !right?.hash || left.hash.length !== 32 || right.hash.length !== 32) return false;
    if (![left.aspect, right.aspect].every(value => Number.isFinite(value) && value > 0)) return false;
    if (Math.abs(Math.log(left.aspect / right.aspect)) > 0.04) return false;
    if (left.contrast < 12 || right.contrast < 12) return false;
    let distance = 0;
    const bits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
    for (let i = 0; i < 32; i++) {
      distance += bits[parseInt(left.hash[i], 16) ^ parseInt(right.hash[i], 16)];
      if (distance > limit) return false;
    }
    return true;
  }
  function visualKeys(visual, parts, nearby = false) {
    if (!visual?.hash || visual.hash.length !== 32 || !Number.isFinite(visual.aspect) || visual.aspect <= 0 || visual.contrast < 12) return [];
    const band = Math.round(Math.log(visual.aspect) / 0.04);
    const keys = [];
    for (let bucket = band - (nearby ? 2 : 0); bucket <= band + (nearby ? 2 : 0); bucket++)
      for (let part = 0; part < parts; part++) {
        const segment = visual.hash.slice(Math.floor(part * 32 / parts), Math.floor((part + 1) * 32 / parts));
        keys.push(`${bucket}:${part}:${segment}`);
      }
    return keys;
  }
  function indexVisual(index, visual, parts) {
    for (const key of visualKeys(visual, parts)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(visual);
    }
  }
  function matchingVisual(index, visual, limit) {
    const seen = new Set();
    for (const key of visualKeys(visual, limit + 1, true))
      for (const other of index.get(key) || []) {
        if (seen.has(other)) continue;
        seen.add(other);
        if (visualMatch(other, visual, limit)) return true;
      }
    return false;
  }
  globalThis.TPDModel = { defaults, clean, formatTime, filePath, validate, visualMatch, indexVisual, matchingVisual };
})();
