export interface PlanningLease {
  leaseId: string;
  requestId: string;
  sourceId: string;
  targetIds: string[];
}

/**
 * Serializes plans that affect the same display. A request owns both its source
 * client and every selected action target, so a newer local or remote request
 * invalidates the whole older plan instead of letting their UI actions mix.
 */
export class PlanningCoordinator {
  private readonly leases = new Map<string, PlanningLease>();
  private readonly latestBySource = new Map<string, string>();
  private readonly latestByTarget = new Map<string, string>();
  private sequence = 0;

  begin(sourceId: string, targetIds: readonly string[], requestId: string) {
    const normalizedTargets = [...new Set(targetIds.length ? targetIds : [sourceId])];
    const supersededIds = new Set<string>();
    const previousSourceRequest = this.latestBySource.get(sourceId);
    if (previousSourceRequest && previousSourceRequest !== requestId) supersededIds.add(previousSourceRequest);
    for (const targetId of normalizedTargets) {
      const previousTargetRequest = this.latestByTarget.get(targetId);
      if (previousTargetRequest && previousTargetRequest !== requestId) supersededIds.add(previousTargetRequest);
    }

    const superseded = [...supersededIds].flatMap((id) => {
      const lease = this.leases.get(id);
      this.release(id);
      return lease ? [lease] : [];
    });
    const leaseId = `${sourceId}:${requestId}:${++this.sequence}`;
    const lease: PlanningLease = { leaseId, requestId, sourceId, targetIds: normalizedTargets };
    this.leases.set(leaseId, lease);
    this.latestBySource.set(sourceId, leaseId);
    for (const targetId of normalizedTargets) this.latestByTarget.set(targetId, leaseId);
    return { lease, superseded };
  }

  isCurrent(leaseId: string) {
    const lease = this.leases.get(leaseId);
    if (!lease || this.latestBySource.get(lease.sourceId) !== leaseId) return false;
    return lease.targetIds.every((targetId) => this.latestByTarget.get(targetId) === leaseId);
  }

  clearClient(clientId: string) {
    const affected = [...this.leases.values()]
      .filter((lease) => lease.sourceId === clientId || lease.targetIds.includes(clientId));
    for (const lease of affected) this.release(lease.leaseId);
    return affected;
  }

  complete(leaseId: string) {
    const existed = this.leases.has(leaseId);
    this.release(leaseId);
    return existed;
  }

  private release(leaseId: string) {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    if (this.latestBySource.get(lease.sourceId) === leaseId) this.latestBySource.delete(lease.sourceId);
    for (const targetId of lease.targetIds) {
      if (this.latestByTarget.get(targetId) === leaseId) this.latestByTarget.delete(targetId);
    }
    this.leases.delete(leaseId);
  }
}
