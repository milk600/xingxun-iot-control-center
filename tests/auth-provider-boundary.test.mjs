import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

test("auth context identity stays outside the hot-reloaded provider module", async () => {
  const [provider, stateContext] = await Promise.all([
    source("app/features/auth/AuthContext.tsx"),
    source("app/features/auth/AuthStateContext.ts"),
  ]);

  assert.match(provider, /import \{ AuthContext, useAuth, type AuthContextValue \} from "\.\/AuthStateContext"/);
  assert.match(provider, /export \{ useAuth \} from "\.\/AuthStateContext"/);
  assert.doesNotMatch(provider, /createContext\s*\(/);
  assert.match(stateContext, /export const AuthContext = createContext<AuthContextValue \| null>\(null\)/);
  assert.match(stateContext, /export function useAuth\(\)/);
});

test("root layout keeps the auth gate inside the matching provider", async () => {
  const layout = await source("app/layout.tsx");
  const providerStart = layout.indexOf("<AuthProvider>");
  const gateStart = layout.indexOf("<AuthenticatedApplication>");
  const gateEnd = layout.indexOf("</AuthenticatedApplication>");
  const providerEnd = layout.indexOf("</AuthProvider>");

  assert.ok(providerStart >= 0);
  assert.ok(providerStart < gateStart);
  assert.ok(gateStart < gateEnd);
  assert.ok(gateEnd < providerEnd);
});
