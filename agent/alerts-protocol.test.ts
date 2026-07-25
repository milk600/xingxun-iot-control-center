import assert from "node:assert/strict";
import test from "node:test";
import { TELEMETRY_SLOT_IDS } from "../app/lib/iot/contracts";
import {
  parseAlertClearRequest,
  parseAlertCompleteRequest,
  parseAlertListRequest,
  parseAlertRulesSaveRequest,
} from "./alerts-protocol";

test("alert clearing requires an identified local operator", () => {
  assert.deepEqual(parseAlertClearRequest({ requestId: "clear-1", actor: "测试员" }), {
    requestId: "clear-1",
    actor: "测试员",
  });
  assert.throws(() => parseAlertClearRequest({ requestId: "clear-2", actor: "" }), /处理人|名称/);
});

test("alert list protocol accepts bounded filters and rejects unknown slots", () => {
  const parsed = parseAlertListRequest({
    requestId: "request-1",
    statuses: ["pending", "processing"],
    severities: ["critical"],
    slotIds: ["slot-1"],
    limit: 100,
  });
  assert.deepEqual(parsed.statuses, ["pending", "processing"]);
  assert.throws(() => parseAlertListRequest({ requestId: "request-2", slotIds: ["slot-7"] }), /无效|筛选/);
});

test("alert completion requires a version, a supported action, and a meaningful note", () => {
  const parsed = parseAlertCompleteRequest({
    requestId: "request-3",
    alertId: "alert-1",
    expectedVersion: 2,
    actor: "测试员",
    action: "site-inspection",
    note: "已完成现场检查",
  });
  assert.equal(parsed.action, "site-inspection");
  assert.throws(() => parseAlertCompleteRequest({ ...parsed, action: "start-fan" }), /无效/);
  assert.throws(() => parseAlertCompleteRequest({ ...parsed, note: "a" }), /2/);
});

test("rule saves require all six unique rules and valid thresholds", () => {
  const rules = TELEMETRY_SLOT_IDS.map((slotId) => ({
    slotId,
    enabled: slotId === "slot-1",
    lowerLimit: null,
    upperLimit: slotId === "slot-1" ? 30 : null,
    version: 1,
    updatedAt: null,
  }));
  assert.equal(parseAlertRulesSaveRequest({ requestId: "request-4", actor: "测试员", rules }).rules.length, 6);
  assert.throws(() => parseAlertRulesSaveRequest({ requestId: "request-5", actor: "测试员", rules: rules.slice(0, 5) }), /六路|完整/);
  assert.throws(() => parseAlertRulesSaveRequest({
    requestId: "request-6",
    actor: "测试员",
    rules: rules.map((rule) => rule.slotId === "slot-1" ? { ...rule, lowerLimit: 40 } : rule),
  }), /下限|上限/);
});
