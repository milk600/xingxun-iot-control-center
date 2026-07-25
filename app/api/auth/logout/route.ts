import { clearedSessionCookie } from "@/app/lib/auth/local-auth.server";

export async function POST(request: Request) {
  return Response.json({ ok: true }, {
    headers: {
      "cache-control": "no-store",
      "set-cookie": clearedSessionCookie(request),
    },
  });
}
