(function runTwitchChatHeatmap() {
  "use strict";

  const ROOT_ID = "tch-heatmap-root";
  const CACHE_PREFIX = "chat_heatmap_v8_";
  const CACHE_VERSION = 9;
  const CACHE_LIMIT = 20;
  const BATCH_SIZE = 20;
  const TWITCH_SEEK_SELECTORS = ['[data-a-target="player-seekbar"]', '[data-a-target="player-seekbar-container"]', '[role="slider"][aria-label*="Seek"]'];
  const TWITCH_PLAYER_SELECTORS = ['[data-a-target="video-player"]', ".video-player", '[data-test-selector="video-player__video-container"]'];
  const DEFAULT_SETTINGS = { enabled: true, height: 34, opacity: 0.9 };

  let currentVodKey = null;
  let loadedVodKey = null;
  let currentPlatform = "twitch";
  let lastKickPageError = "";
  let loadGeneration = 0;
  let dataState = "idle";
  let statusText = "Loading chat activity";
  let currentSettings = { ...DEFAULT_SETTINGS };
  let currentSeries = [];
  let currentPeaks = [];
  let currentDuration = 0;
  let seekElement = null;
  let playerElement = null;
  let rootElement = null;
  let canvasElement = null;
  let statusElement = null;
  let peaksElement = null;
  let peakButtonsSignature = null;
  let animationFrame = 0;
  let peakHoverKeepalive = 0;
  let kickHoveredPeakButton = null;

  function getVodInfo() { return window.TwitchKickHeatmapSites.getVodInfo(window.location); }
  function findFirst(selectors, scope) {
    for (const selector of selectors) {
      const match = (scope || document).querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  function findTwitchPlayer(seekbar) {
    const directPlayer = findFirst(TWITCH_PLAYER_SELECTORS);
    if (directPlayer?.contains(seekbar)) return directPlayer;
    let candidate = seekbar.parentElement;
    while (candidate && candidate !== document.body) {
      if (candidate.querySelector("video")) return candidate;
      candidate = candidate.parentElement;
    }
    return directPlayer;
  }
  function findPlayerParts(vod) {
    if (vod.platform === "kick") {
      const video = window.TwitchKickHeatmapSites.getVisibleVideo(document);
      const seekbar = window.TwitchKickHeatmapSites.findKickSeekbar(document, video);
      const player = window.TwitchKickHeatmapSites.findKickPlayer(video, seekbar);
      return { seekbar, player };
    }
    const seekbar = findFirst(TWITCH_SEEK_SELECTORS);
    return { seekbar, player: seekbar ? findTwitchPlayer(seekbar) : null };
  }
  function updateStatus(text, state) {
    statusText = text;
    dataState = state || dataState;
    if (!statusElement) return;
    statusElement.textContent = statusText;
    statusElement.className = `tch-status tch-status-${dataState}`;
  }
  function ensureRoot() {
    const vod = getVodInfo();
    const vodKey = vod?.key || null;
    if (!vod || !currentSettings.enabled) {
      if (!vod && loadedVodKey) {
        loadedVodKey = null;
        currentSeries = [];
        currentPeaks = [];
        currentDuration = 0;
        loadGeneration += 1;
      }
      currentVodKey = vodKey;
      removeRoot();
      return false;
    }
    const parts = findPlayerParts(vod);
    if (!parts.seekbar || !parts.player) { removeRoot(); return false; }
    if (rootElement?.isConnected && seekElement === parts.seekbar && playerElement === parts.player && currentVodKey === vodKey) return true;

    removeRoot();
    currentVodKey = vodKey;
    currentPlatform = vod.platform;
    seekElement = parts.seekbar;
    playerElement = parts.player;
    rootElement = document.createElement("div");
    rootElement.id = ROOT_ID;
    rootElement.classList.add(`tch-platform-${vod.platform}`);
    rootElement.setAttribute("aria-hidden", "true");
    rootElement.innerHTML = '<canvas></canvas><div class="tch-peak-buttons"></div><span class="tch-status"></span>';
    canvasElement = rootElement.querySelector("canvas");
    statusElement = rootElement.querySelector(".tch-status");
    peaksElement = rootElement.querySelector(".tch-peak-buttons");
    peakButtonsSignature = null;
    updateStatus(statusText, dataState);
    if (window.getComputedStyle(playerElement).position === "static") {
      playerElement.dataset.tchPreviousPosition = playerElement.style.position || "";
      playerElement.style.position = "relative";
    }
    playerElement.appendChild(rootElement);

    if (loadedVodKey !== vodKey) {
      loadedVodKey = vodKey;
      currentSeries = [];
      currentPeaks = [];
      currentDuration = 0;
      const generation = ++loadGeneration;
      updateStatus(`Waiting for ${vod.platform === "kick" ? "Kick" : "Twitch"} VOD metadata`, "loading");
      loadHeatmap(vod, generation);
    }
    return true;
  }
  function removeRoot() {
    stopPeakHoverKeepalive();
    rootElement?.remove();
    if (playerElement?.dataset.tchPreviousPosition !== undefined) {
      playerElement.style.position = playerElement.dataset.tchPreviousPosition;
      delete playerElement.dataset.tchPreviousPosition;
    }
    rootElement = null;
    canvasElement = null;
    statusElement = null;
    peaksElement = null;
    peakButtonsSignature = null;
    kickHoveredPeakButton = null;
    seekElement = null;
    playerElement = null;
  }
  function positionRoot() {
    if (!rootElement?.isConnected || !seekElement?.isConnected || !playerElement?.isConnected) return false;
    const seekRect = seekElement.getBoundingClientRect();
    const playerRect = playerElement.getBoundingClientRect();
    if (seekRect.width < 80 || playerRect.width < 80) { rootElement.hidden = true; return false; }
    const height = Math.max(20, Math.min(52, Number(currentSettings.height) || 34));
    rootElement.hidden = false;
    rootElement.style.height = `${height}px`;
    rootElement.style.left = `${seekRect.left - playerRect.left}px`;
    rootElement.style.top = `${seekRect.top - playerRect.top - height + 2}px`;
    rootElement.style.width = `${seekRect.width}px`;
    rootElement.style.opacity = String(currentSettings.opacity);
    return true;
  }
  function clampCanvasX(x, width) { return Math.min(width - 7, Math.max(7, x)); }
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }
  function seekToPeak(peak) {
    const video = window.TwitchKickHeatmapSites.getVisibleVideo(document) || playerElement?.querySelector("video") || document.querySelector("video");
    if (!video) return;
    const fallbackTime = (peak.index / Math.max(1, currentSeries.length - 1)) * (Number(video.duration) || 0);
    const peakTime = Number.isFinite(peak.timeSeconds) ? peak.timeSeconds : fallbackTime;
    const targetTime = Math.max(0, peakTime - 5);
    video.currentTime = targetTime;
    video.play().catch(() => {});
  }
  function stopPeakHoverKeepalive() {
    if (peakHoverKeepalive) window.clearInterval(peakHoverKeepalive);
    peakHoverKeepalive = 0;
  }
  function signalKickPlayerActivity() {
    if (currentPlatform !== "kick" || !playerElement?.isConnected) return;
    const rect = playerElement.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: false,
      clientX: rect.left + Math.min(24, Math.max(1, rect.width - 1)),
      clientY: rect.bottom - Math.min(24, Math.max(1, rect.height - 1))
    };
    playerElement.dispatchEvent(new MouseEvent("mousemove", eventOptions));
    if (typeof PointerEvent === "function") playerElement.dispatchEvent(new PointerEvent("pointermove", eventOptions));
  }
  function startPeakHoverKeepalive() {
    if (currentPlatform !== "kick") return;
    stopPeakHoverKeepalive();
    signalKickPlayerActivity();
    peakHoverKeepalive = window.setInterval(signalKickPlayerActivity, 500);
  }
  function renderPeakButtons() {
    if (!peaksElement) return;
    const signature = currentPeaks.map((peak) => `${peak.rank}:${peak.index}:${peak.timeSeconds}`).join("|");
    if (signature === peakButtonsSignature) return;
    peakButtonsSignature = signature;
    peaksElement.replaceChildren();
    for (const peak of currentPeaks) {
      const button = document.createElement("button");
      const timelineRatio = currentDuration > 0 && Number.isFinite(peak.timeSeconds) ? peak.timeSeconds / currentDuration : peak.index / Math.max(1, currentSeries.length - 1);
      const percent = Math.min(98.5, Math.max(1.5, timelineRatio * 100));
      button.type = "button";
      button.className = "tch-peak-button";
      button.textContent = String(peak.rank);
      button.style.left = `${percent}%`;
      button.title = `Play 5 seconds before #${peak.rank} peak at ${formatTime(peak.timeSeconds)}`;
      button.setAttribute("aria-label", button.title);
      button.addEventListener("pointerenter", startPeakHoverKeepalive);
      button.addEventListener("pointerleave", stopPeakHoverKeepalive);
      button.addEventListener("focus", startPeakHoverKeepalive);
      button.addEventListener("blur", stopPeakHoverKeepalive);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        stopPeakHoverKeepalive();
        seekToPeak(peak);
      });
      peaksElement.appendChild(button);
    }
  }
  function findKickPeakHit(clientX, clientY) {
    if (currentPlatform !== "kick" || !peaksElement?.isConnected || rootElement?.hidden) return null;
    const buttons = [...peaksElement.querySelectorAll(".tch-peak-button")];
    for (let index = 0; index < buttons.length; index += 1) {
      const rect = buttons[index].getBoundingClientRect();
      if (clientX >= rect.left - 2 && clientX <= rect.right + 2 && clientY >= rect.top - 2 && clientY <= rect.bottom + 2) {
        return { button: buttons[index], peak: currentPeaks[index] };
      }
    }
    return null;
  }
  function handleKickPeakPointerMove(event) {
    const hit = findKickPeakHit(event.clientX, event.clientY);
    if (kickHoveredPeakButton === hit?.button) return;
    kickHoveredPeakButton?.classList.remove("tch-hit-hover");
    kickHoveredPeakButton = hit?.button || null;
    kickHoveredPeakButton?.classList.add("tch-hit-hover");
  }
  function handleKickPeakPointerDown(event) {
    if (event.button !== 0) return;
    const hit = findKickPeakHit(event.clientX, event.clientY);
    if (!hit?.peak) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    kickHoveredPeakButton?.classList.remove("tch-hit-hover");
    kickHoveredPeakButton = null;
    seekToPeak(hit.peak);
  }
  function blockUnderlyingKickPeakClick(event) {
    if (!findKickPeakHit(event.clientX, event.clientY)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function drawSeries() {
    if (!canvasElement || !positionRoot()) return;
    const bounds = rootElement.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * pixelRatio));
    const height = Math.max(1, Math.round(bounds.height * pixelRatio));
    if (canvasElement.width !== width || canvasElement.height !== height) {
      canvasElement.width = width;
      canvasElement.height = height;
    }
    const context = canvasElement.getContext("2d");
    context.clearRect(0, 0, width, height);
    renderPeakButtons();
    if (!currentSeries.length) return;
    context.save();
    context.scale(pixelRatio, pixelRatio);
    const cssWidth = width / pixelRatio;
    const cssHeight = height / pixelRatio;
    const baseline = cssHeight - 2;
    const topPadding = 15;
    context.beginPath();
    context.moveTo(0, baseline);
    currentSeries.forEach((value, index) => {
      const x = (index / Math.max(1, currentSeries.length - 1)) * cssWidth;
      const y = baseline - value * (baseline - topPadding);
      context.lineTo(x, y);
    });
    context.lineTo(cssWidth, baseline);
    context.closePath();
    const gradient = context.createLinearGradient(0, topPadding, 0, baseline);
    const isKick = currentPlatform === "kick";
    gradient.addColorStop(0, isKick ? "rgba(83, 252, 24, 0.58)" : "rgba(191, 148, 255, 0.58)");
    gradient.addColorStop(1, isKick ? "rgba(83, 252, 24, 0.08)" : "rgba(145, 71, 255, 0.08)");
    context.fillStyle = gradient;
    context.fill();
    context.beginPath();
    currentSeries.forEach((value, index) => {
      const x = (index / Math.max(1, currentSeries.length - 1)) * cssWidth;
      const y = baseline - value * (baseline - topPadding);
      index === 0 ? context.moveTo(x, y) : context.lineTo(x, y);
    });
    context.lineWidth = 1.35;
    context.strokeStyle = isKick ? "#8dff66" : "#d5b8ff";
    context.stroke();

    for (const peak of currentPeaks) {
      const timelineRatio = currentDuration > 0 && Number.isFinite(peak.timeSeconds) ? peak.timeSeconds / currentDuration : peak.index / Math.max(1, currentSeries.length - 1);
      const markerX = clampCanvasX(timelineRatio * cssWidth, cssWidth);
      const waveY = baseline - currentSeries[peak.index] * (baseline - topPadding);
      context.beginPath();
      context.moveTo(markerX, 13);
      context.lineTo(markerX, Math.max(13, waveY - 1));
      context.lineWidth = 1;
      context.strokeStyle = "rgba(239, 239, 241, 0.8)";
      context.stroke();
    }    context.restore();
  }
  function scheduleRender() {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = window.requestAnimationFrame(() => { if (ensureRoot()) drawSeries(); });
  }
  function waitForDuration(generation) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        if (generation !== loadGeneration) { reject(new Error("cancelled")); return; }
        const duration = Number((window.TwitchKickHeatmapSites.getVisibleVideo(document) || document.querySelector("video"))?.duration);
        if (Number.isFinite(duration) && duration > 1) { resolve(duration); return; }
        attempts += 1;
        if (attempts >= 40) { reject(new Error("Could not read the VOD duration")); return; }
        window.setTimeout(check, 500);
      };
      check();
    });
  }
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve(response);
      });
    });
  }
  function sendKickPageRequest(type, responseType, payload, timeoutMilliseconds) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = window.setTimeout(() => { cleanup(); resolve(null); }, timeoutMilliseconds);
      function cleanup() {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onWindowMessage);
        document.removeEventListener("tch-kick-response", onDocumentMessage);
      }
      function accept(message) {
        if (message?.source !== "tch-kick-page" || message?.type !== responseType || message.requestId !== requestId) return;
        cleanup();
        resolve(message);
      }
      function onWindowMessage(event) { accept(event.data); }
      function onDocumentMessage(event) {
        try { accept(JSON.parse(event.detail)); } catch (_) {}
      }
      const message = { source: "tch-kick-content", type, requestId, ...payload };
      window.addEventListener("message", onWindowMessage);
      document.addEventListener("tch-kick-response", onDocumentMessage);
      window.postMessage(message, "*");
      document.dispatchEvent(new CustomEvent("tch-kick-request", { detail: JSON.stringify(message) }));
    });
  }

  async function fetchKickMetadataFromPage(vod) {
    const response = await sendKickPageRequest("KICK_METADATA_REQUEST", "KICK_METADATA_RESPONSE", {
      vodId: vod.id,
      channelSlug: vod.channelSlug
    }, 12000);
    if (response?.ok) {
      lastKickPageError = "";
      return response.metadata;
    }
    lastKickPageError = response?.error || "Kick page bridge timed out";
    return null;
  }

  function fetchKickChatFromPage(metadata, offsets) {
    return sendKickPageRequest("KICK_CHAT_REQUEST", "KICK_CHAT_RESPONSE", {
      channelId: metadata.channelId,
      startTime: metadata.startTime,
      offsets
    }, 45000);
  }
  async function getCachedHeatmap(vodId) {
    const key = `${CACHE_PREFIX}${vodId}`;
    const result = await chrome.storage.local.get(key);
    const cached = result[key];
    if (!cached || cached.version !== CACHE_VERSION || !Array.isArray(cached.series) || !Array.isArray(cached.peaks)) return null;
    return cached;
  }
  async function saveCachedHeatmap(vodId, duration, series, peaks) {
    const key = `${CACHE_PREFIX}${vodId}`;
    await chrome.storage.local.set({ [key]: { version: CACHE_VERSION, cachedAt: Date.now(), duration, series, peaks } });
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all)
      .filter(([entryKey, value]) => entryKey.startsWith(CACHE_PREFIX) && value?.cachedAt)
      .sort((left, right) => right[1].cachedAt - left[1].cachedAt);
    if (entries.length > CACHE_LIMIT) await chrome.storage.local.remove(entries.slice(CACHE_LIMIT).map(([entryKey]) => entryKey));
  }
  async function loadHeatmap(vod, generation) {
    try {
      const cached = await getCachedHeatmap(vod.key);
      if (generation !== loadGeneration) return;
      if (cached) {
        currentSeries = cached.series;
        currentPeaks = cached.peaks;
        currentDuration = Number(cached.duration) || 0;
        updateStatus("Cached chat activity", "ready");
        scheduleRender();
        return;
      }

      const duration = await waitForDuration(generation);
      currentDuration = duration;
      let kickMetadata = vod.platform === "kick"
        ? window.TwitchKickHeatmapSites.extractMetadataFromDocument(document, vod.id)
        : null;
      if (vod.platform === "kick" && !kickMetadata) {
        updateStatus("Fetching Kick VOD metadata", "loading");
        kickMetadata = await fetchKickMetadataFromPage(vod);
      }
      if (vod.platform === "kick" && !kickMetadata) {
        const metadataResponse = await sendMessage({
          type: "KICK_FETCH_VOD_METADATA",
          url: window.location.href,
          vodId: vod.id
        });
        if (!metadataResponse?.ok) throw new Error(`Page: ${lastKickPageError || "metadata unavailable"}; fallback: ${metadataResponse?.error || "metadata unavailable"}`);
        kickMetadata = metadataResponse.metadata;
      }
      if (vod.platform === "kick" && !kickMetadata) throw new Error("Could not read Kick VOD metadata");
      const offsets = window.TwitchChatHeatmapModel.createSampleOffsets(
        duration,
        vod.platform === "kick" ? 240 : 480,
        vod.platform === "kick" ? 15 : 10
      );
      const samples = [];
      for (let index = 0; index < offsets.length; index += BATCH_SIZE) {
        if (generation !== loadGeneration) return;
        const batch = offsets.slice(index, index + BATCH_SIZE);
        let response;
        if (vod.platform === "kick") {
          response = await fetchKickChatFromPage(kickMetadata, batch);
          if (!response) {
            response = await sendMessage({
              type: "KICK_FETCH_CHAT_SAMPLES",
              channelId: kickMetadata.channelId,
              startTime: kickMetadata.startTime,
              offsets: batch
            });
          }
        } else {
          response = await sendMessage({ type: "TCH_FETCH_CHAT_SAMPLES", vodId: vod.id, offsets: batch });
        }
        if (!response?.ok) throw new Error(response?.error || "Chat replay request failed");
        samples.push(...response.samples);
        const percent = Math.min(100, Math.round((samples.length / offsets.length) * 100));
        updateStatus(`Analyzing ${vod.platform === "kick" ? "Kick" : "Twitch"} chat ${percent}%`, "loading");
      }
      if (generation !== loadGeneration) return;
      if (!samples.some((sample) => sample.timestamps?.length >= 2)) throw new Error("No replayed chat was returned");
      const heatmap = window.TwitchChatHeatmapModel.rateSamplesToHeatmap(samples);
      currentSeries = heatmap.series;
      currentPeaks = heatmap.peaks;
      await saveCachedHeatmap(vod.key, duration, currentSeries, currentPeaks);
      updateStatus(`${vod.platform === "kick" ? "Kick" : "Twitch"} chat activity`, "ready");
      scheduleRender();
    } catch (error) {
      if (generation !== loadGeneration || error?.message === "cancelled") return;
      currentSeries = [];
      currentPeaks = [];
      updateStatus(error instanceof Error ? error.message : "Chat replay unavailable", "error");
      scheduleRender();
    }
  }
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => { currentSettings = settings; scheduleRender(); });
  new MutationObserver(scheduleRender).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    currentSettings = { ...currentSettings, ...Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue])) };
    scheduleRender();
  });
  document.addEventListener("pointermove", handleKickPeakPointerMove, true);
  document.addEventListener("pointerdown", handleKickPeakPointerDown, true);
  document.addEventListener("click", blockUnderlyingKickPeakClick, true);
  window.addEventListener("resize", scheduleRender, { passive: true });
  document.addEventListener("fullscreenchange", scheduleRender);
  window.setInterval(() => {
    if (getVodInfo()?.key !== currentVodKey || !rootElement?.isConnected || !seekElement?.isConnected) scheduleRender();
    else positionRoot();
  }, 1500);
})();



























