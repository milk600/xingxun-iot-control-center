import { abortSignalAfter } from "./abort-signal";

const RETRY_DELAYS_MS = [400, 800, 1_600, 2_400, 3_200] as const;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export async function fetchDeepSeekWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const maximumAttempts = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (init.signal?.aborted) throw init.signal.reason;
    try {
      const timeoutSignal = abortSignalAfter(timeoutMs);
      const response = await fetch(url, {
        ...init,
        signal: init.signal
          ? combineAbortSignals(init.signal, timeoutSignal)
          : timeoutSignal,
      });
      if (!RETRYABLE_HTTP_STATUSES.has(response.status) || attempt === maximumAttempts) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      await retryDelay(response.headers.get("retry-after"), RETRY_DELAYS_MS[attempt - 1], init.signal);
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      if (isRequestTimeout(error) || !isTransientNetworkFailure(error)) throw error;
      if (attempt === maximumAttempts) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `DeepSeek 网络连接中断，连续 ${maximumAttempts} 次请求均失败：${detail}`,
          { cause: error },
        );
      }
      await delay(RETRY_DELAYS_MS[attempt - 1], init.signal);
    }
  }
  throw new Error("DeepSeek 网络请求未完成");
}

function isRequestTimeout(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError"
    || error.name === "TimeoutError"
    || /timed?\s*out|timeout/i.test(error.message);
}

function isTransientNetworkFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  const cause = error.cause instanceof Error
    ? `${error.cause.name} ${error.cause.message} ${String((error.cause as Error & { code?: unknown }).code ?? "")}`
    : "";
  return error instanceof TypeError
    || /fetch failed|network|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up/i.test(
      `${error.name} ${error.message} ${cause}`,
    );
}

async function retryDelay(retryAfter: string | null, fallbackMs: number, signal?: AbortSignal | null) {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 && seconds <= 5
    ? seconds * 1_000
    : 0;
  await delay(Math.max(fallbackMs, retryAfterMs), signal);
}

function delay(milliseconds: number, signal?: AbortSignal | null) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combineAbortSignals(first: AbortSignal, second: AbortSignal) {
  const any = (AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof any === "function") return any([first, second]);
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (first.aborted) abort(first);
  else first.addEventListener("abort", () => abort(first), { once: true });
  if (second.aborted) abort(second);
  else second.addEventListener("abort", () => abort(second), { once: true });
  return controller.signal;
}
