import { readLocalSession } from "@/app/lib/auth/local-auth.server";

export async function GET(request: Request) {
  try {
    const session = await readLocalSession(request);
    return Response.json({
      session,
      biometricAvailable: false,
      biometricEnrolled: false,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({
      session: null,
      biometricAvailable: false,
      biometricEnrolled: false,
      error: error instanceof Error ? error.message : "本地登录暂不可用",
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
