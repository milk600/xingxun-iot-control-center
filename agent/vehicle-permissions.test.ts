import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmedVehicleMoveAuthorization,
  vehicleMoveAuthorization,
} from "./vehicle-permissions";

test("AI vehicle movement bypasses confirmation only after both permissions are enabled", () => {
  assert.equal(vehicleMoveAuthorization(false, false), "confirmation");
  assert.equal(vehicleMoveAuthorization(false, true), "confirmation");
  assert.equal(vehicleMoveAuthorization(true, false), "confirmation");
  assert.equal(vehicleMoveAuthorization(true, true), "direct");
});

test("an explicit one-time confirmation does not require autonomous client permission", () => {
  assert.equal(confirmedVehicleMoveAuthorization(false), "disabled");
  assert.equal(confirmedVehicleMoveAuthorization(true), "execute");
});
