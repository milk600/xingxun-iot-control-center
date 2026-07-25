import assert from "node:assert/strict";
import test from "node:test";
import {
  canEditCollectorSettings,
  parseCollectorSettingsRequest,
  parseCollectorSettingsUpdateRequest,
} from "./collector-settings-protocol";

test("collector settings protocol accepts request IDs and supported intervals", () => {
  assert.deepEqual(parseCollectorSettingsRequest({ requestId: "collector-request-1" }), {
    requestId: "collector-request-1",
  });
  assert.deepEqual(parseCollectorSettingsUpdateRequest({
    requestId: "collector-update-1",
    pollIntervalMs: 1_000,
  }), {
    requestId: "collector-update-1",
    pollIntervalMs: 1_000,
  });
  assert.equal(parseCollectorSettingsUpdateRequest({
    requestId: "collector-update-2",
    pollIntervalMs: 3_500,
  }).pollIntervalMs, 3_500);
});

test("collector settings protocol rejects malformed requests and unsupported intervals", () => {
  assert.throws(() => parseCollectorSettingsRequest({ requestId: "short" }), /请求 ID 无效/);
  assert.throws(() => parseCollectorSettingsUpdateRequest({
    requestId: "collector-update-3",
    pollIntervalMs: 2_000,
  }), /仅支持 1、3.5、5 或 10 秒/);
});

test("only the authenticated display role is eligible to update collector settings", () => {
  assert.equal(canEditCollectorSettings("display"), true);
  assert.equal(canEditCollectorSettings("remote"), false);
  assert.equal(canEditCollectorSettings("standalone"), false);
});
