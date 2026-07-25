import type { AuthPasswordChange } from "@/app/lib/auth/contracts";
import {
  LocalAuthRegistrationError,
  changeLocalPassword,
  clearedSessionCookie,
  readLocalSession,
  unauthorizedResponse,
} from "@/app/lib/auth/local-auth.server";

function validInput(value: unknown): value is AuthPasswordChange {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<AuthPasswordChange>;
  return typeof input.username === "string"
    && typeof input.currentPassword === "string"
    && input.currentPassword.length <= 256
    && typeof input.newPassword === "string"
    && input.newPassword.length <= 32
    && (input.enrollment === undefined || (typeof input.enrollment === "string" && input.enrollment.length <= 4096));
}

export async function POST(request: Request) {
  const session = await readLocalSession(request);
  if (!session) return unauthorizedResponse();
  const input = await request.json().catch(() => null);
  if (!validInput(input) || input.username.trim().toLowerCase() !== session.user.username.trim().toLowerCase()) {
    return Response.json({ error: "密码修改信息无效" }, { status: 400 });
  }
  try {
    const result = await changeLocalPassword(input);
    return Response.json(result, {
      headers: {
        "cache-control": "no-store",
        "set-cookie": clearedSessionCookie(request),
      },
    });
  } catch (error) {
    const status = error instanceof LocalAuthRegistrationError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : "密码修改失败" }, {
      status,
      headers: { "cache-control": "no-store" },
    });
  }
}
