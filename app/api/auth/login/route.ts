import type { AuthCredentials } from "@/app/lib/auth/contracts";
import {
  authenticateLocalAccount,
  createLocalSessionToken,
  sessionCookie,
} from "@/app/lib/auth/local-auth.server";

const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;
const failures = new Map<string, { count: number; lockedUntilMs: number }>();

function clientKey(request: Request, username: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${forwarded ?? "local"}:${username.trim().toLowerCase()}`;
}

function isCredentials(value: unknown): value is AuthCredentials {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<AuthCredentials>;
  return typeof input.username === "string"
    && input.username.length <= 80
    && typeof input.password === "string"
    && input.password.length <= 256
    && (input.enrollment === undefined || (typeof input.enrollment === "string" && input.enrollment.length <= 4096))
    && typeof input.remember === "boolean";
}

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "登录信息格式无效" }, { status: 400 });
  }
  if (!isCredentials(input)) {
    return Response.json({ error: "请输入管理员账号和密码" }, { status: 400 });
  }

  const key = clientKey(request, input.username);
  const record = failures.get(key);
  if (record?.lockedUntilMs && record.lockedUntilMs > Date.now()) {
    return Response.json({
      error: "尝试次数过多，请稍后再试",
      lockedUntil: new Date(record.lockedUntilMs).toISOString(),
    }, {
      status: 429,
      headers: { "cache-control": "no-store", "retry-after": String(Math.ceil((record.lockedUntilMs - Date.now()) / 1_000)) },
    });
  }

  try {
    const account = await authenticateLocalAccount(input.username, input.password, input.enrollment);
    if (!account) {
      const count = (record?.count ?? 0) + 1;
      const lockedUntilMs = count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0;
      failures.set(key, { count: lockedUntilMs ? 0 : count, lockedUntilMs });
      return Response.json({
        error: lockedUntilMs ? "尝试次数过多，请稍后再试" : "账号或密码不正确",
        ...(lockedUntilMs ? { lockedUntil: new Date(lockedUntilMs).toISOString() } : {}),
      }, {
        status: lockedUntilMs ? 429 : 401,
        headers: { "cache-control": "no-store" },
      });
    }

    failures.delete(key);
    const { token, session, expiresAtMs } = await createLocalSessionToken(
      account.user,
      input.remember,
      account.recoveryConfigured,
    );
    return Response.json({
      session,
      biometricAvailable: false,
      biometricEnrolled: false,
    }, {
      headers: {
        "cache-control": "no-store",
        "set-cookie": sessionCookie(token, request, input.remember, expiresAtMs),
      },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "本地登录暂不可用",
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
