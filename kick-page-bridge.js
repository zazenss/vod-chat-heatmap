(function installKickPageBridge() {
  "use strict";

  const REQUEST_SOURCE = "tch-kick-content";
  const RESPONSE_SOURCE = "tch-kick-page";
  const activeRequests = new Set();

  function findVodInPayload(payload, vodId) {
    const queue = [payload];
    const visited = new Set();
    while (queue.length) {
      const value = queue.shift();
      if (!value || typeof value !== "object" || visited.has(value)) continue;
      visited.add(value);
      if (String(value.uuid || "") === vodId) return value;
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") {
          if (Array.isArray(child)) queue.push(...child);
          else queue.push(child);
        }
      }
    }
    return null;
  }

  function startTimeFromUuidV7(vodId) {
    const compact = String(vodId || "").replaceAll("-", "");
    if (!/^[0-9a-f]{32}$/i.test(compact) || compact[12].toLowerCase() !== "7") return null;
    const milliseconds = Number.parseInt(compact.slice(0, 12), 16);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }

  function normalizeMetadata(videoPayload, channelPayload, vodId) {
    const video = videoPayload?.data || videoPayload;
    const channel = channelPayload?.data || channelPayload;
    const channelId = Number(channel?.id);
    const startTime = video?.created_at ?? video?.livestream?.start_time ?? startTimeFromUuidV7(vodId);
    const duration = Number(video?.video?.duration ?? video?.livestream?.duration ?? video?.duration) || 0;
    if (!Number.isInteger(channelId) || channelId <= 0 || !Number.isFinite(Date.parse(startTime))) return null;
    return { channelId, startTime, duration };
  }

  function respond(type, requestId, result) {
    const payload = { source: RESPONSE_SOURCE, type, requestId, ...result };
    window.postMessage(payload, "*");
    document.dispatchEvent(new CustomEvent("tch-kick-response", { detail: JSON.stringify(payload) }));
  }

  async function fetchMetadata(message) {
    const vodId = String(message.vodId || "");
    const channelSlug = String(message.channelSlug || "");
    if (!/^[a-z0-9-]+$/i.test(vodId) || !/^[a-z0-9_-]+$/i.test(channelSlug)) throw new Error("Invalid Kick VOD identifiers");
    const options = { credentials: "include", headers: { "Accept": "application/json" } };
    const [videoResponse, channelResponse] = await Promise.all([
      fetch(`/api/v1/video/${encodeURIComponent(vodId)}`, options),
      fetch(`/api/v2/channels/${encodeURIComponent(channelSlug)}`, options)
    ]);
    if (!channelResponse.ok) throw new Error(`Kick channel API returned HTTP ${channelResponse.status}`);
    const channelPayload = await channelResponse.json();
    let videoPayload = videoResponse.ok ? await videoResponse.json() : null;

    if (!videoPayload) {
      const listResponse = await fetch(`/api/v2/channels/${encodeURIComponent(channelSlug)}/videos?cursor=0&sort=date&time=all`, options);
      if (listResponse.ok) videoPayload = findVodInPayload(await listResponse.json(), vodId);
    }

    const metadata = normalizeMetadata(videoPayload || { uuid: vodId }, channelPayload, vodId);
    if (!metadata) throw new Error(`Kick metadata unavailable (video ${videoResponse.status})`);
    return metadata;
  }

  function wait(milliseconds) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

  async function fetchChatSamples(message) {
    const channelId = Number(message.channelId);
    const startMilliseconds = Date.parse(message.startTime);
    const offsets = Array.isArray(message.offsets) ? message.offsets.map(Number) : [];
    if (!Number.isInteger(channelId) || channelId <= 0 || !Number.isFinite(startMilliseconds)) throw new Error("Invalid Kick chat metadata");
    if (!offsets.length || offsets.length > 20 || offsets.some((offset) => !Number.isFinite(offset) || offset < 0)) throw new Error("Invalid Kick chat offsets");

    const samples = new Array(offsets.length);
    let nextIndex = 0;
    async function worker(workerIndex) {
      if (workerIndex > 0) await wait(workerIndex * 45);
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= offsets.length) return;
        const offset = offsets[index];
        const requestTime = new Date(startMilliseconds + offset * 1000).toISOString();
        const url = `https://web.kick.com/api/v1/chat/${channelId}/history?start_time=${encodeURIComponent(requestTime)}`;
        let payload = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await fetch(url, { credentials: "include", headers: { "Accept": "application/json" } });
          if (response.ok) { payload = await response.json(); break; }
          if (response.status !== 429 && response.status < 500) throw new Error(`Kick chat returned HTTP ${response.status}`);
          await wait(350 * (attempt + 1));
        }
        if (!payload) throw new Error("Kick chat request failed after retries");
        const timestamps = (payload?.data?.messages || [])
          .map((chatMessage) => (Date.parse(chatMessage?.created_at) - startMilliseconds) / 1000)
          .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= 0);
        samples[index] = { offset, timestamps };
        await wait(125);
      }
    }

    await Promise.all([worker(0), worker(1), worker(2)]);
    return samples;
  }
  async function handleRequest(message) {
    if (message?.source !== REQUEST_SOURCE) return;
    const requestId = String(message.requestId || "");
    if (!requestId || activeRequests.has(requestId)) return;
    activeRequests.add(requestId);
    let responseType;
    try {
      if (message.type === "KICK_METADATA_REQUEST") {
        responseType = "KICK_METADATA_RESPONSE";
        const metadata = await fetchMetadata(message);
        respond(responseType, requestId, { ok: true, metadata });
      } else if (message.type === "KICK_CHAT_REQUEST") {
        responseType = "KICK_CHAT_RESPONSE";
        const samples = await fetchChatSamples(message);
        respond(responseType, requestId, { ok: true, samples });
      }
    } catch (error) {
      if (responseType) respond(responseType, requestId, { ok: false, error: error instanceof Error ? error.message : "Kick page request failed" });
    } finally {
      window.setTimeout(() => activeRequests.delete(requestId), 1000);
    }
  }

  window.addEventListener("message", (event) => handleRequest(event.data));
  document.addEventListener("tch-kick-request", (event) => {
    try { handleRequest(JSON.parse(event.detail)); } catch (_) {}
  });})();





