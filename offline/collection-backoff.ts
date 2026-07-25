export const ANDROID_COLLECTION_RETRY_BASE_MS = 1_000;
export const ANDROID_COLLECTION_RETRY_MAX_MS = 30_000;

export function androidCollectionRetryDelayMs(consecutiveFailures: number) {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return 0;
  const exponent = Math.min(30, Math.max(0, Math.floor(consecutiveFailures) - 1));
  return Math.min(
    ANDROID_COLLECTION_RETRY_MAX_MS,
    ANDROID_COLLECTION_RETRY_BASE_MS * 2 ** exponent,
  );
}
