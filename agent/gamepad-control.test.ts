import assert from "node:assert/strict";
import test from "node:test";
import {
  GAMEPAD_STICK_DEADZONE,
  gamepadControlIntent,
} from "../app/lib/iot/gamepad-control";

test("模拟摇杆推动行程按死区后的完整范围映射为 0–100% 油门", () => {
  assert.equal(gamepadControlIntent({ x: 0, y: 0 }, 55), null);
  assert.equal(gamepadControlIntent({ x: 0, y: GAMEPAD_STICK_DEADZONE }, 55), null);

  const halfTravel = gamepadControlIntent({
    x: 0,
    y: -(GAMEPAD_STICK_DEADZONE + (1 - GAMEPAD_STICK_DEADZONE) / 2),
  }, 55);
  assert.deepEqual(halfTravel, {
    motion: "forward",
    speedPercent: 50,
    source: "stick",
  });

  assert.deepEqual(gamepadControlIntent({ x: 1, y: 0 }, 55), {
    motion: "right",
    speedPercent: 100,
    source: "stick",
  });
  assert.deepEqual(gamepadControlIntent({ x: -1, y: 0 }, 55), {
    motion: "left",
    speedPercent: 100,
    source: "stick",
  });
  assert.deepEqual(gamepadControlIntent({ x: 0, y: 1 }, 55), {
    motion: "backward",
    speedPercent: 100,
    source: "stick",
  });
});

test("手柄十字键沿用页面速度并优先于摇杆", () => {
  assert.deepEqual(gamepadControlIntent({
    x: 1,
    y: 0,
    dpadY: -1,
  }, 37), {
    motion: "forward",
    speedPercent: 37,
    source: "dpad",
  });
  assert.deepEqual(gamepadControlIntent({
    x: 0,
    y: 0,
    dpadX: -1,
  }, 150), {
    motion: "left",
    speedPercent: 100,
    source: "dpad",
  });
});

test("摇杆接近方向分界线时保留当前方向避免抖动切换", () => {
  assert.equal(gamepadControlIntent({ x: 0.7, y: -0.72 }, 55, "right")?.motion, "right");
  assert.equal(gamepadControlIntent({ x: 0.7, y: -0.9 }, 55, "right")?.motion, "forward");
});
