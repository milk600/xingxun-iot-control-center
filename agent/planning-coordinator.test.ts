import assert from "node:assert/strict";
import test from "node:test";
import { PlanningCoordinator } from "./planning-coordinator";

test("a newer request from the same client invalidates the older plan", () => {
  const coordinator = new PlanningCoordinator();
  const first = coordinator.begin("display", ["display"], "request-1");
  const next = coordinator.begin("display", ["display"], "request-2");

  assert.deepEqual(next.superseded.map((item) => item.requestId), ["request-1"]);
  assert.equal(coordinator.isCurrent(first.lease.leaseId), false);
  assert.equal(coordinator.isCurrent(next.lease.leaseId), true);
});

test("remote and local plans cannot interleave on the same display", () => {
  const coordinator = new PlanningCoordinator();
  const remote = coordinator.begin("remote", ["display"], "remote-request");
  const local = coordinator.begin("display", ["display"], "local-request");

  assert.deepEqual(local.superseded.map(({ requestId, sourceId, targetIds }) => ({
    requestId,
    sourceId,
    targetIds,
  })), [{
    requestId: "remote-request",
    sourceId: "remote",
    targetIds: ["display"],
  }]);
  assert.equal(coordinator.isCurrent(remote.lease.leaseId), false);
  assert.equal(coordinator.isCurrent(local.lease.leaseId), true);
});

test("a request that targets multiple displays is invalidated as one lease", () => {
  const coordinator = new PlanningCoordinator();
  const shared = coordinator.begin("remote-a", ["display-a", "display-b"], "shared-request");
  const next = coordinator.begin("remote-b", ["display-b"], "new-request");

  assert.equal(coordinator.isCurrent(shared.lease.leaseId), false);
  assert.equal(coordinator.isCurrent(next.lease.leaseId), true);
});

test("disconnecting a source or target invalidates its active plan", () => {
  const coordinator = new PlanningCoordinator();
  const first = coordinator.begin("remote", ["display"], "request-1");
  coordinator.clearClient("display");
  assert.equal(coordinator.isCurrent(first.lease.leaseId), false);

  const second = coordinator.begin("remote", ["display"], "request-2");
  coordinator.clearClient("remote");
  assert.equal(coordinator.isCurrent(second.lease.leaseId), false);
});

test("different clients may reuse the same public request id without colliding", () => {
  const coordinator = new PlanningCoordinator();
  const first = coordinator.begin("remote-a", ["display-a"], "request-1");
  const second = coordinator.begin("remote-b", ["display-b"], "request-1");

  assert.equal(coordinator.isCurrent(first.lease.leaseId), true);
  assert.equal(coordinator.isCurrent(second.lease.leaseId), true);
  assert.notEqual(first.lease.leaseId, second.lease.leaseId);
});

test("a completed request is released and is not falsely cancelled by the next request", () => {
  const coordinator = new PlanningCoordinator();
  const first = coordinator.begin("display", ["display"], "request-1");
  assert.equal(coordinator.complete(first.lease.leaseId), true);
  assert.equal(coordinator.isCurrent(first.lease.leaseId), false);

  const next = coordinator.begin("display", ["display"], "request-2");
  assert.deepEqual(next.superseded, []);
  assert.equal(coordinator.isCurrent(next.lease.leaseId), true);
  assert.equal(coordinator.complete(first.lease.leaseId), false);
});
