(function attachKickAdapter(globalScope) {
  "use strict";

  function getVodInfo(locationLike) {
    const hostname = String(locationLike?.hostname || "").toLowerCase();
    const pathname = String(locationLike?.pathname || "");
    if (hostname === "www.twitch.tv" || hostname === "twitch.tv") {
      const match = pathname.match(/^\/videos\/(\d+)/);
      return match ? { platform: "twitch", id: match[1], key: `twitch:${match[1]}` } : null;
    }
    if (hostname === "kick.com" || hostname === "www.kick.com") {
      const match = pathname.match(/^\/([^/]+)\/videos\/([a-z0-9-]+)/i);
      return match ? { platform: "kick", channelSlug: match[1], id: match[2], key: `kick:${match[2]}` } : null;
    }
    return null;
  }

  function getVisibleVideo(documentLike) {
    return [...documentLike.querySelectorAll("video")]
      .filter((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 80 && rect.height > 80;
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
      })[0] || null;
  }

  function scoreKickSlider(element, videoRect) {
    if (!(element instanceof HTMLElement)) return -1;
    const rect = element.getBoundingClientRect();
    if (rect.width < Math.max(120, videoRect.width * 0.25) || rect.height <= 0 || rect.height > 44) return -1;
    if (rect.right < videoRect.left - 16 || rect.left > videoRect.right + 16) return -1;
    if (rect.bottom < videoRect.bottom - 130 || rect.top > videoRect.bottom + 28) return -1;
    let score = 0;
    if (element.getAttribute("role") === "slider") score += 10;
    if (element instanceof HTMLInputElement && element.type === "range") score += 12;
    if (element.hasAttribute("aria-valuenow") && element.hasAttribute("aria-valuemax")) score += 6;
    const label = `${element.getAttribute("aria-label") || ""} ${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
    if (/seek|scrub|progress|timeline|track/i.test(label)) score += 6;
    if (rect.top >= videoRect.bottom - 72) score += 3;
    return score;
  }

  function findKickSeekbar(documentLike, video) {
    if (!video) return null;
    const videoRect = video.getBoundingClientRect();
    const candidates = [...documentLike.querySelectorAll('[role="slider"], input[type="range"], [role="progressbar"]')];
    return candidates
      .map((element) => ({ element, score: scoreKickSlider(element, videoRect) }))
      .filter((candidate) => candidate.score >= 6)
      .sort((left, right) => right.score - left.score)[0]?.element || null;
  }

  function findKickPlayer(video, seekbar) {
    let candidate = video?.parentElement || seekbar?.parentElement || null;
    let best = candidate;
    const videoRect = video?.getBoundingClientRect();
    for (let depth = 0; candidate && candidate !== document.body && depth < 8; depth += 1) {
      const rect = candidate.getBoundingClientRect();
      if (videoRect && rect.width >= videoRect.width * 0.9 && rect.height >= videoRect.height && rect.height <= videoRect.height + 260) best = candidate;
      candidate = candidate.parentElement;
    }
    return best;
  }

  function decodeNextFragments(scriptTexts) {
    const fragments = [];
    const pattern = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
    for (const scriptText of scriptTexts || []) {
      let match;
      while ((match = pattern.exec(scriptText)) !== null) {
        try { fragments.push(JSON.parse(`"${match[1]}"`)); } catch (_) {}
      }
    }
    return fragments;
  }

  function findMatchingBrace(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) return index;
    }
    return -1;
  }

  function findVodObject(fragment, vodId) {
    const markerIndex = fragment.indexOf(`"uuid":"${vodId}"`);
    if (markerIndex < 0) return null;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < markerIndex; index += 1) {
      const char = fragment[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") stack.push(index);
      else if (char === "}") stack.pop();
    }
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const start = stack[index];
      const end = findMatchingBrace(fragment, start);
      if (end < 0) continue;
      try {
        const value = JSON.parse(fragment.slice(start, end + 1));
        if (value?.uuid === vodId && value?.livestream) return value;
      } catch (_) {}
    }
    return null;
  }

  function metadataFromKickApiPayloads(videoPayload, channelPayload) {
    const video = videoPayload?.data || videoPayload;
    const channel = channelPayload?.data || channelPayload;
    const channelId = Number(channel?.id);
    const startTime = video?.created_at;
    const duration = Number(video?.video?.duration ?? video?.duration) || 0;
    if (Number.isInteger(channelId) && channelId > 0 && Number.isFinite(Date.parse(startTime))) {
      return { channelId, startTime, duration };
    }
    return null;
  }
  function metadataFromVodPayload(payload, vodId) {
    const queue = [payload];
    const visited = new Set();
    while (queue.length) {
      const value = queue.shift();
      if (!value || typeof value !== "object" || visited.has(value)) continue;
      visited.add(value);
      const livestream = value.livestream;
      const channelId = Number(livestream?.channel?.id ?? livestream?.channel_id ?? value.channel_id);
      const startTime = livestream?.start_time ?? value.start_time;
      const uuidMatches = !vodId || !value.uuid || String(value.uuid) === String(vodId);
      if (uuidMatches && Number.isInteger(channelId) && channelId > 0 && Number.isFinite(Date.parse(startTime))) {
        return { channelId, startTime, duration: Number(livestream?.duration ?? value.duration) || 0 };
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") {
          if (Array.isArray(child)) queue.push(...child);
          else queue.push(child);
        }
      }
    }
    return null;
  }
  function extractVodMetadata(scriptTexts, vodId) {
    for (const fragment of decodeNextFragments(scriptTexts)) {
      const vod = findVodObject(fragment, vodId);
      const channelId = Number(vod?.livestream?.channel?.id);
      const startTime = vod?.livestream?.start_time;
      if (vod && Number.isInteger(channelId) && channelId > 0 && Number.isFinite(Date.parse(startTime))) {
        return { channelId, startTime, duration: Number(vod.livestream.duration) || 0 };
      }
    }
    return null;
  }

  function extractMetadataFromDocument(documentLike, vodId) {
    return extractVodMetadata([...documentLike.scripts].map((script) => script.textContent || ""), vodId);
  }

  const api = { extractMetadataFromDocument, extractVodMetadata, findKickPlayer, findKickSeekbar, getVisibleVideo, getVodInfo, metadataFromKickApiPayloads, metadataFromVodPayload };
  globalScope.TwitchKickHeatmapSites = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);



