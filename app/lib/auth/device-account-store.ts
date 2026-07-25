"use client";

import {
  AUTH_AGREEMENT_VERSION,
  AUTH_RECOVERY_QUESTIONS,
  type AuthProfile,
  type AuthRecoveryQuestionId,
} from "./contracts";

const DATABASE_NAME = "xingxun-local-account-v2";
const DATABASE_VERSION = 1;
const ACCOUNT_STORE = "accounts";
const PROFILE_STORE = "profiles";
const LEGACY_ENROLLMENTS_KEY = "xingxun.local-auth.enrollments.v1";
const FALLBACK_KEY = "xingxun.local-auth.device-store.v2";

export interface DeviceAccountRecord {
  username: string;
  enrollment: string;
  recoveryQuestionId: AuthRecoveryQuestionId | null;
  updatedAt: string;
}
interface FallbackStore {
  accounts: Record<string, DeviceAccountRecord>;
  profiles: Record<string, AuthProfile>;
}

function canonical(value: string) {
  return value.trim().toLowerCase();
}

function emptyFallback(): FallbackStore {
  return { accounts: {}, profiles: {} };
}

function readFallback() {
  if (typeof window === "undefined") return emptyFallback();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FALLBACK_KEY) ?? "{}") as Partial<FallbackStore>;
    return {
      accounts: parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {},
      profiles: parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {},
    } satisfies FallbackStore;
  } catch {
    return emptyFallback();
  }
}

function writeFallback(value: FallbackStore) {
  window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(value));
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前设备不支持本地账户存储"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("本地账户存储打开失败"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ACCOUNT_STORE)) {
        database.createObjectStore(ACCOUNT_STORE, { keyPath: "username" });
      }
      if (!database.objectStoreNames.contains(PROFILE_STORE)) {
        database.createObjectStore(PROFILE_STORE, { keyPath: "username" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readRecord<T>(storeName: string, key: string): Promise<T | null> {
  try {
    const database = await openDatabase();
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      transaction.oncomplete = () => database.close();
    });
  } catch {
    const fallback = readFallback();
    return ((storeName === ACCOUNT_STORE ? fallback.accounts[key] : fallback.profiles[key]) as T | undefined) ?? null;
  }
}

async function writeRecord<T extends { username: string }>(storeName: string, value: T) {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
    });
  } catch {
    const fallback = readFallback();
    if (storeName === ACCOUNT_STORE) fallback.accounts[value.username] = value as unknown as DeviceAccountRecord;
    else fallback.profiles[value.username] = value as unknown as AuthProfile;
    writeFallback(fallback);
  }
}

function decodeQuestionId(enrollment: string): AuthRecoveryQuestionId | null {
  try {
    const encoded = enrollment.split(".")[0];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)))) as { recoveryQuestionId?: unknown };
    return AUTH_RECOVERY_QUESTIONS.some((question) => question.id === payload.recoveryQuestionId)
      ? payload.recoveryQuestionId as AuthRecoveryQuestionId
      : null;
  } catch {
    return null;
  }
}

export async function migrateLegacyEnrollments() {
  if (typeof window === "undefined") return;
  let legacy: Record<string, string> = {};
  try {
    const value = JSON.parse(window.localStorage.getItem(LEGACY_ENROLLMENTS_KEY) ?? "{}") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      legacy = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
  } catch {
    legacy = {};
  }
  for (const [username, enrollment] of Object.entries(legacy)) {
    const key = canonical(username);
    if (!await readRecord<DeviceAccountRecord>(ACCOUNT_STORE, key)) {
      await writeRecord(ACCOUNT_STORE, {
        username: key,
        enrollment,
        recoveryQuestionId: decodeQuestionId(enrollment),
        updatedAt: new Date().toISOString(),
      } satisfies DeviceAccountRecord);
    }
  }
  window.localStorage.removeItem(LEGACY_ENROLLMENTS_KEY);
}

export async function readDeviceAccount(username: string) {
  await migrateLegacyEnrollments();
  return readRecord<DeviceAccountRecord>(ACCOUNT_STORE, canonical(username));
}

export async function saveDeviceEnrollment(
  username: string,
  enrollment: string,
  recoveryQuestionId?: AuthRecoveryQuestionId | null,
) {
  const key = canonical(username);
  const record: DeviceAccountRecord = {
    username: key,
    enrollment,
    recoveryQuestionId: recoveryQuestionId ?? decodeQuestionId(enrollment),
    updatedAt: new Date().toISOString(),
  };
  await writeRecord(ACCOUNT_STORE, record);
  return record;
}

export async function readDeviceProfile(username: string): Promise<AuthProfile> {
  const key = canonical(username);
  const existing = await readRecord<AuthProfile>(PROFILE_STORE, key);
  return existing ?? {
    username: key,
    displayName: username.trim() || key,
    avatarDataUrl: null,
    agreementVersion: null,
    recoveryQuestionId: (await readDeviceAccount(key))?.recoveryQuestionId ?? null,
    updatedAt: new Date().toISOString(),
  };
}

export async function updateDeviceProfile(
  username: string,
  changes: Partial<Pick<AuthProfile, "displayName" | "avatarDataUrl" | "agreementVersion" | "recoveryQuestionId">>,
) {
  const current = await readDeviceProfile(username);
  const next: AuthProfile = {
    ...current,
    ...changes,
    username: canonical(username),
    updatedAt: new Date().toISOString(),
  };
  await writeRecord(PROFILE_STORE, next);
  return next;
}

export async function acceptedCurrentAgreement(username: string) {
  return (await readDeviceProfile(username)).agreementVersion === AUTH_AGREEMENT_VERSION;
}
