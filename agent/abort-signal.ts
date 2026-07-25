/** AbortSignal.timeout is unavailable in older Android System WebView builds. */
export function abortSignalAfter(milliseconds: number): AbortSignal {
  const timeout = (AbortSignal as typeof AbortSignal & { timeout?: (value: number) => AbortSignal }).timeout;
  if (typeof timeout === "function") return timeout(milliseconds);
  const controller = new AbortController();
  globalThis.setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), milliseconds);
  return controller.signal;
}
