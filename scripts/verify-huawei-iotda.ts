import { getIoTProvider } from "../app/lib/iot/provider-factory.server";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const provider = getIoTProvider();
const slots = await provider.readTelemetrySlots({
  traceId: crypto.randomUUID(),
  signal: AbortSignal.timeout(20_000),
});

console.log(JSON.stringify({
  provider: provider.kind,
  slots: Object.values(slots).map(({
    slotId,
    label,
    value,
    unit,
    state,
    observedAt,
  }) => ({ slotId, label, value, unit, state, observedAt })),
}, null, 2));

if (process.argv.includes("--api")) {
  const authConfig = JSON.parse(await readFile(
    new URL("../data/local-auth.json", import.meta.url),
    "utf8",
  )) as {
    username: string;
    displayName: string;
    sessionVersion: number;
    sessionSecret: string;
  };
  const payload = Buffer.from(JSON.stringify({
    username: authConfig.username,
    displayName: authConfig.displayName,
    expiresAtMs: Date.now() + 60_000,
    sessionVersion: authConfig.sessionVersion,
  })).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(authConfig.sessionSecret, "base64url"))
    .update(payload)
    .digest("base64url");
  const baseUrl = process.env.IOT_WEB_BASE_URL || "http://localhost:3000";
  const response = await fetch(new URL("/api/iot/snapshot", baseUrl), {
    headers: {
      cookie: `xingxun_local_session=${encodeURIComponent(`${payload}.${signature}`)}`,
    },
  });
  if (!response.ok) throw new Error(`本地 Snapshot API 验证失败（HTTP ${response.status}）`);
  const snapshot = await response.json() as {
    provider: string;
    partialErrors: Array<{ scope: string; message: string }>;
    slots: Record<string, { label: string; value: number | null; unit: string; state: string }>;
  };
  console.log(JSON.stringify({
    api: new URL("/api/iot/snapshot", baseUrl).toString(),
    provider: snapshot.provider,
    partialErrors: snapshot.partialErrors,
    slots: Object.values(snapshot.slots),
  }, null, 2));
}
