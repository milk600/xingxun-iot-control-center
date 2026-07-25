import assert from "node:assert/strict";
import test from "node:test";
import {
  ANDROID_COLLECTION_RETRY_MAX_MS,
  androidCollectionRetryDelayMs,
} from "../offline/collection-backoff";

test("Android 华为云失败使用 1、2、4、8、16、30 秒有界指数退避", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 100].map(androidCollectionRetryDelayMs),
    [0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
  );
  assert.equal(androidCollectionRetryDelayMs(Number.NaN), 0);
  assert.equal(ANDROID_COLLECTION_RETRY_MAX_MS, 30_000);
});
