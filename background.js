"use strict";

importScripts("kick-adapter.js");

const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const COMMENTS_QUERY_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";
const KICK_HISTORY_BASE = "https://web.kick.com/api/v1/chat";
const MAX_BATCH_SIZE = 20;

function validateOffsets(offsets) {
  if (!Array.isArray(offsets) || offsets.length === 0 || offsets.length > MAX_BATCH_SIZE) throw new Error("Invalid sample batch");
  const clean = offsets.map(Number);
  if (clean.some((offset) => !Number.isFinite(offset) || offset < 0)) throw new Error("Invalid sample offset");
  return clean;
}

function makeTwitchOperation(vodId, offset) {
  return {
    operationName: "VideoCommentsByOffsetOrCursor",
    variables: { videoID: vodId, contentOffsetSeconds: Math.max(0, Math.floor(offset)) },
    extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_QUERY_HASH } }
  };
}

async function fetchTwitchChatSamples(vodId, offsets) {
  if (!/^\d{1,20}$/.test(vodId)) throw new Error("Invalid Twitch VOD ID");
  const cleanOffsets = validateOffsets(offsets);
  const response = await fetch(TWITCH_GQL_URL, {
    method: "POST",
    credentials: "omit",
    headers: { "Client-ID": TWITCH_WEB_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify(cleanOffsets.map((offset) => makeTwitchOperation(vodId, offset)))
  });
  if (!response.ok) throw new Error(`Twitch returned HTTP ${response.status}`);
  const payload = await response.json();
  const results = Array.isArray(payload) ? payload : [payload];
  if (results.length !== cleanOffsets.length) throw new Error("Unexpected Twitch response");
  return results.map((result, index) => {
    if (result.errors?.length) return { offset: cleanOffsets[index], timestamps: [], error: result.errors[0].message || "Chat replay unavailable" };
    const timestamps = (result.data?.video?.comments?.edges || [])
      .map((edge) => Number(edge?.node?.contentOffsetSeconds))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= 0);
    return { offset: cleanOffsets[index], timestamps };
  });
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function fetchKickHistory(channelId, startMilliseconds, offset) {
  const requestTime = new Date(startMilliseconds + offset * 1000).toISOString();
  const url = `${KICK_HISTORY_BASE}/${channelId}/history?start_time=${encodeURIComponent(requestTime)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { credentials: "omit", headers: { "Accept": "application/json" } });
    if (response.ok) return response.json();
    if (response.status !== 429 && response.status < 500) throw new Error(`Kick returned HTTP ${response.status}`);
    await wait(300 * (attempt + 1));
  }
  throw new Error("Kick chat history request failed after retries");
}

async function fetchKickChatSamples(channelIdValue, startTime, offsets) {
  const channelId = Number(channelIdValue);
  const startMilliseconds = Date.parse(startTime);
  if (!Number.isInteger(channelId) || channelId <= 0) throw new Error("Invalid Kick channel ID");
  if (!Number.isFinite(startMilliseconds)) throw new Error("Invalid Kick VOD start time");
  const cleanOffsets = validateOffsets(offsets);
  const samples = [];
  for (const offset of cleanOffsets) {
    const payload = await fetchKickHistory(channelId, startMilliseconds, offset);
    const timestamps = (payload?.data?.messages || [])
      .map((message) => (Date.parse(message?.created_at) - startMilliseconds) / 1000)
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= 0);
    samples.push({ offset, timestamps });
    await wait(110);
  }
  return samples;
}

async function fetchKickVodMetadata(urlValue, vodIdValue) {
  const pageUrl = new URL(String(urlValue || ""));
  const vodId = String(vodIdValue || "");
  if (!["kick.com", "www.kick.com"].includes(pageUrl.hostname)) throw new Error("Invalid Kick VOD URL");
  if (!/^\/[^/]+\/videos\/[a-z0-9-]+/i.test(pageUrl.pathname) || !/^[a-z0-9-]+$/i.test(vodId)) throw new Error("Invalid Kick VOD URL");

  try {
    const channelSlug = decodeURIComponent(pageUrl.pathname.split("/").filter(Boolean)[0]);
    const requestOptions = { credentials: "include", headers: { "Accept": "application/json" } };
    const [videoResponse, channelResponse] = await Promise.all([
      fetch(`https://kick.com/api/v1/video/${encodeURIComponent(vodId)}`, requestOptions),
      fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channelSlug)}`, requestOptions)
    ]);
    if (videoResponse.ok && channelResponse.ok) {
      const [videoPayload, channelPayload] = await Promise.all([videoResponse.json(), channelResponse.json()]);
      const metadata = globalThis.TwitchKickHeatmapSites.metadataFromKickApiPayloads(videoPayload, channelPayload)
        || globalThis.TwitchKickHeatmapSites.metadataFromVodPayload(videoPayload, vodId);
      if (metadata) return metadata;
    }
  } catch (_) {}

  const pageResponse = await fetch(pageUrl.href, { credentials: "include", headers: { "Accept": "text/html" } });
  if (!pageResponse.ok) throw new Error(`Kick metadata returned HTTP ${pageResponse.status}`);
  const html = await pageResponse.text();
  const metadata = globalThis.TwitchKickHeatmapSites.extractVodMetadata([html], vodId);
  if (!metadata) throw new Error("Kick VOD metadata was not found in either metadata source");
  return metadata;
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let request;
  let responseKey = "samples";
  if (message?.type === "TCH_FETCH_CHAT_SAMPLES") {
    request = fetchTwitchChatSamples(String(message.vodId || ""), message.offsets);
  } else if (message?.type === "KICK_FETCH_CHAT_SAMPLES") {
    request = fetchKickChatSamples(message.channelId, message.startTime, message.offsets);
  } else if (message?.type === "KICK_FETCH_VOD_METADATA") {
    responseKey = "metadata";
    request = fetchKickVodMetadata(message.url, message.vodId);
  } else {
    return false;
  }
  request
    .then((result) => sendResponse({ ok: true, [responseKey]: result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Request failed" }));
  return true;
});






