import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTelemetryAnalysisRequest,
  parseTelemetryEventsRequest,
  parseTelemetryHistoryRequest,
} from "./telemetry-protocol";

const now = new Date();
const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

test("遥测协议接受六路去重查询与合法粒度", () => {
  const request = parseTelemetryHistoryRequest({
    requestId: "history-1",
    from: oneHourAgo.toISOString(),
    to: now.toISOString(),
    slotIds: ["slot-1", "slot-6", "slot-1"],
    resolution: "1m",
  });
  assert.deepEqual(request.slotIds, ["slot-1", "slot-6"]);
  assert.equal(request.resolution, "1m");
});
test("遥测协议拒绝未知数据位、未来时间与超过三十天的查询", () => {
  assert.throws(() => parseTelemetryAnalysisRequest({
    requestId: "analysis-1",
    from: oneHourAgo.toISOString(),
    to: now.toISOString(),
    slotIds: ["slot-9"],
  }), /数据位/);
  assert.throws(() => parseTelemetryEventsRequest({
    requestId: "events-1",
    from: oneHourAgo.toISOString(),
    to: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  }), /未来/);
  assert.throws(() => parseTelemetryHistoryRequest({
    requestId: "history-long",
    from: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
    slotIds: ["slot-1"],
  }), /30 天/);
});
