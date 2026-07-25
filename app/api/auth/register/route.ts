import type { AuthRegistration } from "@/app/lib/auth/contracts";
import {
  LocalAuthRegistrationError,
  registerLocalAccount,
} from "@/app/lib/auth/local-auth.server";

const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;
const failures = new Map<string, { count: number; lockedUntilMs: number }>();

function clientKey(request: Request, username: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${forwarded ?? "local"}:${username.trim().toLowerCase()}`;
}

function isRegistration(value: unknown): value is AuthRegistration {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<AuthRegistration>;
  return typeof input.username === "string"
    && input.username.length <= 32
    && typeof input.password === "string"
    && input.password.length <= 32
    && typeof input.recoveryQuestionId === "string"
    && typeof input.recoveryAnswer === "string"
    && input.recoveryAnswer.length <= 64
    && typeof input.agreementVersion === "string"
    && typeof input.administratorUsername === "string"
    && input.administratorUsername.length <= 80
    && typeof input.administratorPassword === "string"
    && input.administratorPassword.length <= 256;
}

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "注册信息格式无效" }, { status: 400 });
  }
  if (!isRegistration(input)) {
    return Response.json({ error: "请完整填写注册信息" }, { status: 400 });
  }

  const key = clientKey(request, input.administratorUsername);
  const record = failures.get(key);
  if (record?.lockedUntilMs && record.lockedUntilMs > Date.now()) {
    return Response.json({
      error: "管理员验证次数过多，请稍后再试",
      lockedUntil: new Date(record.lockedUntilMs).toISOString(),
    }, {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(Math.ceil((record.lockedUntilMs - Date.now()) / 1_000)),
      },
    });
  }

  try {
    const registration = await registerLocalAccount(input);
    failures.delete(key);
    return Response.json(registration, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof LocalAuthRegistrationError) {
      if (error.status === 401) {
        const count = (record?.count ?? 0) + 1;
        const lockedUntilMs = count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0;
        failures.set(key, { count: lockedUntilMs ? 0 : count, lockedUntilMs });
        return Response.json({
          error: lockedUntilMs ? "管理员验证次数过多，请稍后再试" : error.message,
          ...(lockedUntilMs ? { lockedUntil: new Date(lockedUntilMs).toISOString() } : {}),
        }, {
          status: lockedUntilMs ? 429 : 401,
          headers: { "cache-control": "no-store" },
        });
      }
      return Response.json({ error: error.message }, {
        status: error.status,
        headers: { "cache-control": "no-store" },
      });
    }
    return Response.json({
      error: error instanceof Error ? error.message : "本地注册暂不可用",
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
