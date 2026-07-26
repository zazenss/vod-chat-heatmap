"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function createBridge(fetchImpl) {
  const listeners = [];
  const documentListeners = new Map();
  const documentLike = {
    addEventListener(type, listener) {
      const group = documentListeners.get(type) || [];
      group.push(listener);
      documentListeners.set(type, group);
    },
    dispatchEvent(event) {
      for (const listener of documentListeners.get(event.type) || []) listener(event);
    }
  };
  class CustomEventLike {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  const windowLike = {
    setTimeout,
    addEventListener(type, listener) { if (type === "message") listeners.push(listener); },
    postMessage(data) {
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener({ source: windowLike, data });
      });
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../kick-page-bridge.js"), "utf8"), {
    window: windowLike, document: documentLike, CustomEvent: CustomEventLike,
    fetch: fetchImpl, console, queueMicrotask, Date, Number, Promise, Error, Set
  });
  return windowLike;
}

function request(windowLike, message, responseType) {
  return new Promise((resolve) => {
    windowLike.addEventListener("message", (event) => {
      if (event.data?.source === "tch-kick-page" && event.data.type === responseType && event.data.requestId === message.requestId) resolve(event.data);
    });
    windowLike.postMessage({ source: "tch-kick-content", ...message });
  });
}

test("Kick page bridge combines authenticated video and channel responses", async () => {
  const windowLike = createBridge(async (url) => {
    if (url.startsWith("/api/v1/video/")) {
      return { ok: true, status: 200, json: async () => ({ created_at: "2026-07-26T15:00:00Z", video: { duration: 7200 } }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 19559873, slug: "boneclinks" }) };
  });
  const response = await request(windowLike, {
    type: "KICK_METADATA_REQUEST",
    requestId: "metadata-test",
    vodId: "019f99a6-17f8-7acc-bced-23208794ca4e",
    channelSlug: "boneclinks"
  }, "KICK_METADATA_RESPONSE");
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.metadata)), {
    channelId: 19559873,
    startTime: "2026-07-26T15:00:00Z",
    duration: 7200
  });
});

test("Kick page bridge handles the Boneclinks UUIDv7 VOD when the legacy video route is 404", async () => {
  const vodId = "019f99a6-17f8-7acc-bced-23208794ca4e";
  const windowLike = createBridge(async (url) => {
    if (url.startsWith("/api/v1/video/")) return { ok: false, status: 404 };
    if (url.includes("/videos?")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ uuid: vodId, created_at: "2026-07-25T14:20:27Z", video: { duration: 28100 } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 19559873, slug: "boneclinks" }) };
  });
  const response = await request(windowLike, {
    type: "KICK_METADATA_REQUEST",
    requestId: "boneclinks-test",
    vodId,
    channelSlug: "boneclinks"
  }, "KICK_METADATA_RESPONSE");
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.metadata)), {
    channelId: 19559873,
    startTime: "2026-07-25T14:20:27Z",
    duration: 28100
  });
});
test("Kick page bridge decodes the dashed UUIDv7 when both video lookups are unavailable", async () => {
  const vodId = "019f99a6-17f8-7acc-bced-23208794ca4e";
  const windowLike = createBridge(async (url) => {
    if (url.includes("/api/v2/channels/boneclinks") && !url.includes("/videos?")) {
      return { ok: true, status: 200, json: async () => ({ id: 19559873, slug: "boneclinks" }) };
    }
    return { ok: false, status: 404 };
  });
  const response = await request(windowLike, {
    type: "KICK_METADATA_REQUEST",
    requestId: "uuid-fallback-test",
    vodId,
    channelSlug: "boneclinks"
  }, "KICK_METADATA_RESPONSE");
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.metadata)), {
    channelId: 19559873,
    startTime: "2026-07-25T14:20:27.000Z",
    duration: 0
  });
});
test("Kick page bridge limits chat requests to three concurrent workers and preserves order", async () => {
  let active = 0;
  let maximumActive = 0;
  const windowLike = createBridge(async (url) => {
    assert.match(url, /web\.kick\.com\/api\/v1\/chat/);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    active -= 1;
    return { ok: true, status: 200, json: async () => ({ data: { messages: [] } }) };
  });
  const offsets = [0, 10, 20, 30, 40, 50];
  const response = await request(windowLike, {
    type: "KICK_CHAT_REQUEST",
    requestId: "concurrency-test",
    channelId: 19559873,
    startTime: "2026-07-26T15:00:00Z",
    offsets
  }, "KICK_CHAT_RESPONSE");
  assert.equal(response.ok, true);
  assert.equal(maximumActive, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(response.samples.map((sample) => sample.offset))), offsets);
});
test("Kick page bridge converts authenticated chat history to VOD timestamps", async () => {
  const windowLike = createBridge(async (url) => {
    assert.match(url, /web\.kick\.com\/api\/v1\/chat\/19559873\/history/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { messages: [
        { created_at: "2026-07-26T15:01:41Z" },
        { created_at: "2026-07-26T15:01:44Z" }
      ] } })
    };
  });
  const response = await request(windowLike, {
    type: "KICK_CHAT_REQUEST",
    requestId: "chat-test",
    channelId: 19559873,
    startTime: "2026-07-26T15:00:00Z",
    offsets: [100]
  }, "KICK_CHAT_RESPONSE");
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.samples)), [{ offset: 100, timestamps: [101, 104] }]);
});






