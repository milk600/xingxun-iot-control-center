import type { AuthRecoverySetup } from "@/app/lib/auth/contracts";
import {
  BROWSER_SESSION_MS,
  LocalAuthRegistrationError,
  createLocalSessionToken,
  readLocalSession,
  sessionCookie,
  setupLocalRecovery,
  unauthorizedResponse,
} from "@/app/lib/auth/local-auth.server";

function validInput(value: unknown): value is AuthRecoverySetup {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<AuthRecoverySetup>;
  return typeof input.recoveryQuestionId === "string"
    && typeof input.recoveryAnswer === "string"
    && input.recoveryAnswer.length <= 64
    && (input.enrollment === undefined || (typeof input.enrollment === "string" && input.enrollment.length <= 4096));
}

export async function POST(request: Request) {
  const session = await readLocalSession(request);
  if (!session) return unauthorizedResponse();
  const input = await request.json().catch(() => null);
  if (!validInput(input)) return Response.json({ error: "请完整填写安全问题" }, { status: 400 });
  try {
    const result = await setupLocalRecovery(session.user.username, input);
    const remember = Date.parse(session.expiresAt) - Date.now() > BROWSER_SESSION_MS;
    const refreshed = await createLocalSessionToken(result.user, remember, true);
    return Response.json({ ...result, session: refreshed.session }, {
      headers: {
        "cache-control": "no-store",
        "set-cookie": sessionCookie(refreshed.token, request, remember, refreshed.expiresAtMs),
      },
    });
  } catch (error) {
    const status = error instanceof LocalAuthRegistrationError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : "安全问题保存失败" }, {
      status,
      headers: { "cache-control": "no-store" },
    });
  }
}
