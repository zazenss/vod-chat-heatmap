"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const adapter = require("../kick-adapter.js");

test("recognizes Twitch and Kick VOD URLs", () => {
  assert.deepEqual(
    adapter.getVodInfo({ hostname: "www.twitch.tv", pathname: "/videos/2805774434" }),
    { platform: "twitch", id: "2805774434", key: "twitch:2805774434" }
  );
  assert.deepEqual(
    adapter.getVodInfo({ hostname: "kick.com", pathname: "/example/videos/7e730db4-0ef8-4f21-a89c-615abbb45c81" }),
    {
      platform: "kick",
      channelSlug: "example",
      id: "7e730db4-0ef8-4f21-a89c-615abbb45c81",
      key: "kick:7e730db4-0ef8-4f21-a89c-615abbb45c81"
    }
  );
  assert.equal(adapter.getVodInfo({ hostname: "kick.com", pathname: "/example" }), null);
});

test("extracts Kick VOD timing and channel metadata from Next.js fragments", () => {
  const vodId = "7e730db4-0ef8-4f21-a89c-615abbb45c81";
  const vod = {
    uuid: vodId,
    livestream: {
      start_time: "2026-07-25T20:30:00.000000Z",
      duration: 7321,
      channel: { id: 987654, slug: "example" }
    }
  };
  const fragment = `3:${JSON.stringify({ unrelated: true })}\n4:${JSON.stringify(vod)}`;
  const script = `self.__next_f.push([1,${JSON.stringify(fragment)}])`;
  assert.deepEqual(adapter.extractVodMetadata([script], vodId), {
    channelId: 987654,
    startTime: "2026-07-25T20:30:00.000000Z",
    duration: 7321
  });
});

test("ignores malformed or unrelated Kick metadata", () => {
  assert.equal(adapter.extractVodMetadata(["self.__next_f.push([1,\"bad\"])", ""], "missing"), null);
});
test("extracts metadata from the direct Kick video API payload", () => {
  const vodId = "f3a1b260-776f-4aa2-9496-1026df410cdf";
  const payload = {
    data: {
      uuid: vodId,
      livestream: {
        start_time: "2026-07-26T01:02:03.000000Z",
        duration: 9123000,
        channel: { id: 456789 }
      }
    }
  };
  assert.deepEqual(adapter.metadataFromVodPayload(payload, vodId), {
    channelId: 456789,
    startTime: "2026-07-26T01:02:03.000000Z",
    duration: 9123000
  });
});
test("combines the actual Kick video and channel API shapes", () => {
  const videoPayload = {
    id: 123,
    uuid: "f3a1b260-776f-4aa2-9496-1026df410cdf",
    created_at: "2026-07-26T01:02:03.000000Z",
    video: { duration: 9123 }
  };
  const channelPayload = { id: 456789, slug: "example" };
  assert.deepEqual(adapter.metadataFromKickApiPayloads(videoPayload, channelPayload), {
    channelId: 456789,
    startTime: "2026-07-26T01:02:03.000000Z",
    duration: 9123
  });
});

