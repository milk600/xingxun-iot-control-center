import type { AgentNavigationContext } from "@/app/lib/ai/contracts";
import {
  TELEMETRY_SLOT_IDS,
  type DashboardSnapshot,
  type TelemetrySlotId,
} from "@/app/lib/iot/contracts";

export interface FreshTelemetryWaitOptions {
  completedAtMs: number;
  slotIds?: readonly TelemetrySlotId[];
  readSnapshot: () => Promise<DashboardSnapshot>;
  settleMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export class AndroidCheckpointInspectionError extends Error {
  constructor(
    message: string,
    readonly lastSnapshot: DashboardSnapshot | null,
  ) {
    super(message);
    this.name = "AndroidCheckpointInspectionError";
  }
}

export function parseAndroidNavigationContext(
  value: unknown,
): AgentNavigationContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.checkpoints)) return null;
  const checkpoints = raw.checkpoints.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const checkpoint = item as Record<string, unknown>;
    if (
      typeof checkpoint.id !== "string"
      || !checkpoint.id.trim()
      || typeof checkpoint.name !== "string"
      || !checkpoint.name.trim()
      || !normalizedCoordinate(checkpoint.x)
      || !normalizedCoordinate(checkpoint.y)
      || typeof checkpoint.updatedAt !== "string"
      || !Number.isFinite(Date.parse(checkpoint.updatedAt))
    ) {
      return [];
    }
    return [{
      id: checkpoint.id.trim().slice(0, 120),
      name: checkpoint.name.normalize("NFKC").replace(/\s+/g, " ").trim()
        .slice(0, 20),
      x: checkpoint.x as number,
      y: checkpoint.y as number,
      updatedAt: new Date(checkpoint.updatedAt).toISOString(),
    }];
  });
  if (checkpoints.length !== raw.checkpoints.length) return null;

  let pose: AgentNavigationContext["pose"] = null;
  if (raw.pose !== null && raw.pose !== undefined) {
    if (!raw.pose || typeof raw.pose !== "object" || Array.isArray(raw.pose)) {
      return null;
    }
    const candidate = raw.pose as Record<string, unknown>;
    if (
      !normalizedCoordinate(candidate.x)
      || !normalizedCoordinate(candidate.y)
      || typeof candidate.headingDeg !== "number"
      || !Number.isFinite(candidate.headingDeg)
      || (
        candidate.observedAt !== null
        && (
          typeof candidate.observedAt !== "string"
          || !Number.isFinite(Date.parse(candidate.observedAt))
        )
      )
    ) {
      return null;
    }
    pose = {
      x: candidate.x as number,
      y: candidate.y as number,
      headingDeg: normalizeHeading(candidate.headingDeg),
      observedAt: candidate.observedAt === null
        ? null
        : new Date(candidate.observedAt as string).toISOString(),
    };
  }

  if (
    typeof raw.calibrationConfirmed !== "boolean"
    || (
      raw.mapRevision !== null
      && (
        !Number.isInteger(raw.mapRevision)
        || Number(raw.mapRevision) < 0
      )
    )
    || typeof raw.updatedAt !== "string"
    || !Number.isFinite(Date.parse(raw.updatedAt))
  ) {
    return null;
  }
  const controlLink = optionalEnum(
    raw.controlLink,
    ["disabled", "connecting", "connected", "error"] as const,
  );
  const vehicleConnection = optionalEnum(
    raw.vehicleConnection,
    ["online", "offline"] as const,
  );
  const imuState = raw.imuState === null
    ? null
    : optionalEnum(
        raw.imuState,
        ["live", "stale", "offline", "error"] as const,
      );
  const mapObservedAt = optionalIsoTime(raw.mapObservedAt);
  const poseObservedAt = optionalIsoTime(raw.poseObservedAt);
  if (
    controlLink === false
    || vehicleConnection === false
    || imuState === false
    || mapObservedAt === false
    || poseObservedAt === false
  ) {
    return null;
  }
  return {
    checkpoints,
    pose,
    calibrationConfirmed: raw.calibrationConfirmed,
    mapRevision: raw.mapRevision === null ? null : Number(raw.mapRevision),
    ...(controlLink === undefined ? {} : { controlLink }),
    ...(vehicleConnection === undefined ? {} : { vehicleConnection }),
    ...(imuState === undefined ? {} : { imuState }),
    ...(mapObservedAt === undefined ? {} : { mapObservedAt }),
    ...(poseObservedAt === undefined ? {} : { poseObservedAt }),
    updatedAt: new Date(raw.updatedAt).toISOString(),
  };
}

export function findAndroidCheckpoint(
  context: AgentNavigationContext,
  requestedName: string,
) {
  const normalizedName = normalizeCheckpointName(requestedName);
  return context.checkpoints.find(
    (checkpoint) => normalizeCheckpointName(checkpoint.name) === normalizedName,
  ) ?? null;
}

export async function waitForFreshLiveTelemetry(
  options: FreshTelemetryWaitOptions,
) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const settleMs = options.settleMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const selected = options.slotIds?.length
    ? [...new Set(options.slotIds)]
    : [...TELEMETRY_SLOT_IDS];
  if (!selected.length) {
    throw new AndroidCheckpointInspectionError(
      "现场检测没有指定任何数据位",
      null,
    );
  }

  await wait(Math.max(0, settleMs));
  const deadline = now() + Math.max(0, timeoutMs);
  let snapshot: DashboardSnapshot | null = null;
  let issues: string[] = [];
  do {
    try {
      snapshot = await options.readSnapshot();
      issues = freshTelemetryIssues(
        snapshot,
        selected,
        options.completedAtMs,
      );
      if (!issues.length) return snapshot;
    } catch (error) {
      issues = [
        `遥测读取失败：${
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : String(error)
        }`,
      ];
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(Math.max(10, pollIntervalMs), remaining));
  } while (now() <= deadline);

  throw new AndroidCheckpointInspectionError(
    `到点后未取得新的实时传感器样本：${issues.join("；")}。`
      + "本次没有据此判断现场正常或异常，请检查华为云上报状态后重试。",
    snapshot,
  );
}

function freshTelemetryIssues(
  snapshot: DashboardSnapshot,
  slotIds: readonly TelemetrySlotId[],
  completedAtMs: number,
) {
  return slotIds.flatMap((slotId) => {
    const slot = snapshot.slots[slotId];
    if (!slot) return [`${slotId}不存在`];
    if (slot.state !== "live") return [`${slot.label}状态为${slot.state}`];
    if (typeof slot.value !== "number" || !Number.isFinite(slot.value)) {
      return [`${slot.label}没有有效数值`];
    }
    const observedAtMs = Date.parse(slot.observedAt ?? "");
    if (!Number.isFinite(observedAtMs)) return [`${slot.label}缺少有效采样时间`];
    if (observedAtMs < completedAtMs) {
      return [`${slot.label}仍是到点前样本（${slot.observedAt}）`];
    }
    return [];
  });
}

function normalizedCoordinate(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= 1;
}

function normalizeHeading(value: number) {
  return ((value % 360) + 360) % 360;
}

function normalizeCheckpointName(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim()
    .toLocaleLowerCase("zh-CN");
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | undefined | false {
  if (value === undefined) return undefined;
  return typeof value === "string" && values.includes(value)
    ? value
    : false;
}

function optionalIsoTime(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return false;
  }
  return new Date(value).toISOString();
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
