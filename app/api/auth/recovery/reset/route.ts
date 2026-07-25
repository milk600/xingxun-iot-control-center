import type { AuthPasswordReset } from "@/app/lib/auth/contracts";
import { LocalAuthRegistrationError, resetLocalPassword } from "@/app/lib/auth/local-auth.server";

const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;
const failures = new Map<string, { count: number; lockedUntilMs: number }>();

function keyFor(request: Request, username: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${forwarded ?? "local"}:${username.trim().toLowerCase()}`;
}

function validInput(value: unknown): value is AuthPasswordReset {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<AuthPasswordReset>;
  return typeof input.username === "string"
    && typeof input.recoveryAnswer === "string"
    && input.recoveryAnswer.length <= 64
    && typeof input.newPassword === "string"
    && input.newPassword.length <= 32
    && typeof input.enrollment === "string"
    && input.enrollment.length <= 4096;
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  if (!validInput(input)) return Response.json({ error: "请完整填写验证信息" }, { status: 400 });
  const key = keyFor(request, input.username);
  const record = failures.get(key);
  if (record?.lockedUntilMs && record.lockedUntilMs > Date.now()) {
    return Response.json({
      error: "验证次数过多，请稍后再试",
      lockedUntil: new Date(record.lockedUntilMs).toISOString(),
    }, { status: 429, headers: { "cache-control": "no-store" } });
  }
  try {
    const result = await resetLocalPassword(input);
    failures.delete(key);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof LocalAuthRegistrationError ? error.status : 503;
    if (status === 401) {
      const count = (record?.count ?? 0) + 1;
      const lockedUntilMs = count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0;
      failures.set(key, { count: lockedUntilMs ? 0 : count, lockedUntilMs });
      return Response.json({
        error: lockedUntilMs ? "验证次数过多，请稍后再试" : error instanceof Error ? error.message : "验证失败",
        ...(lockedUntilMs ? { lockedUntil: new Date(lockedUntilMs).toISOString() } : {}),
      }, { status: lockedUntilMs ? 429 : 401, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ error: error instanceof Error ? error.message : "密码重置失败" }, {
      status,
      headers: { "cache-control": "no-store" },
    });
  }
}
