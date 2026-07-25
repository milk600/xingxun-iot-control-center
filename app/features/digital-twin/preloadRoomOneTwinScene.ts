import {
  ROOM_ONE_DEFAULT_ASSETS,
  ROOM_ONE_RECOMMENDED_MODELS,
} from "@/app/lib/digital-twin/contracts";
import { assertLocalModelFileSize } from "@/app/lib/digital-twin/model-safety";

export interface SerializedPlyAttribute {
  buffer: ArrayBuffer;
  arrayType: string;
  itemSize: number;
  normalized: boolean;
}

export interface ParsedPly {
  position: SerializedPlyAttribute;
  normal: SerializedPlyAttribute | null;
  color: SerializedPlyAttribute | null;
  index: SerializedPlyAttribute | null;
  vertexCount: number;
  faceCount: number;
  bucketCount: number;
  interactiveVertexCount: number;
  optimizedPointCloud: boolean;
}

export interface RoomOneTwinSceneFiles {
  primary: File;
  gap: File | null;
  framework: File | null;
}

export interface PlyParseHandle {
  promise: Promise<ParsedPly>;
  terminate: () => void;
}

type RoomOneAssetKey = keyof typeof ROOM_ONE_DEFAULT_ASSETS;
type ProgressListener = (progress: number) => void;

interface CachedParseEntry {
  file: File;
  promise: Promise<ParsedPly>;
  resolve: (parsed: ParsedPly) => void;
  reject: (error: Error) => void;
  progress: number;
  listeners: Set<ProgressListener>;
}

type ParserWorkerMessage =
  | { type: "result"; result: ParsedPly }
  | { type: "progress"; progress: number }
  | { type: "error"; message: string };

const roomOneAssetKeys: RoomOneAssetKey[] = ["primary", "gap", "framework"];
const roomOneFilePromises = new Map<RoomOneAssetKey, Promise<File>>();
const roomOneFiles = new WeakSet<File>();
const parsedRoomOneFiles = new WeakMap<File, CachedParseEntry>();
const sharedParseQueue: CachedParseEntry[] = [];

let sharedParserWorker: Worker | null = null;
let activeSharedParse: CachedParseEntry | null = null;
let roomOnePreloadPromise: Promise<RoomOneTwinSceneFiles> | null = null;

function createParserWorker(name: string) {
  return new Worker(new URL("./PlyParser.worker.ts", import.meta.url), {
    type: "module",
    name,
  });
}

async function fetchRoomOneAsset(key: RoomOneAssetKey) {
  const response = await fetch(ROOM_ONE_DEFAULT_ASSETS[key], {
    cache: "force-cache",
  });
  if (!response.ok) {
    throw new Error(`本地模型读取失败（HTTP ${response.status}）`);
  }

  const blob = await response.blob();
  assertLocalModelFileSize(blob.size);
  const file = new File([blob], ROOM_ONE_RECOMMENDED_MODELS[key], {
    type: blob.type || "application/octet-stream",
    lastModified: 0,
  });
  roomOneFiles.add(file);
  return file;
}

function loadRoomOneAsset(key: RoomOneAssetKey) {
  const cached = roomOneFilePromises.get(key);
  if (cached) return cached;

  const pending = fetchRoomOneAsset(key).catch((error: unknown) => {
    if (roomOneFilePromises.get(key) === pending) {
      roomOneFilePromises.delete(key);
    }
    throw error;
  });
  roomOneFilePromises.set(key, pending);
  return pending;
}

export async function loadRoomOneTwinSceneFiles(): Promise<RoomOneTwinSceneFiles> {
  const [primary, gap, framework] = await Promise.allSettled([
    loadRoomOneAsset("primary"),
    loadRoomOneAsset("gap"),
    loadRoomOneAsset("framework"),
  ]);

  if (primary.status === "rejected") throw primary.reason;
  return {
    primary: primary.value,
    gap: gap.status === "fulfilled" ? gap.value : null,
    framework: framework.status === "fulfilled" ? framework.value : null,
  };
}

function resetSharedWorker(error?: Error) {
  sharedParserWorker?.terminate();
  sharedParserWorker = null;
  if (activeSharedParse && error) {
    const failed = activeSharedParse;
    activeSharedParse = null;
    failed.reject(error);
  } else {
    activeSharedParse = null;
  }
}

function runNextSharedParse() {
  if (activeSharedParse || sharedParseQueue.length === 0) return;
  const entry = sharedParseQueue.shift();
  if (!entry) return;
  activeSharedParse = entry;

  const worker = sharedParserWorker ?? createParserWorker("room-one-ply-preloader");
  sharedParserWorker = worker;
  worker.onmessage = (event: MessageEvent<ParserWorkerMessage>) => {
    if (activeSharedParse !== entry) return;
    if (event.data.type === "progress") {
      entry.progress = event.data.progress;
      for (const listener of entry.listeners) listener(entry.progress);
      return;
    }

    activeSharedParse = null;
    if (event.data.type === "result") {
      entry.progress = 1;
      for (const listener of entry.listeners) listener(1);
      entry.resolve(event.data.result);
    } else {
      entry.reject(new Error(event.data.message));
    }
    runNextSharedParse();
  };
  worker.onerror = (event) => {
    resetSharedWorker(new Error(event.message || "PLY 后台解析失败。"));
    runNextSharedParse();
  };
  worker.postMessage({ file: entry.file });
}

function getOrCreateCachedParse(file: File) {
  const cached = parsedRoomOneFiles.get(file);
  if (cached) return cached;

  let resolve!: (parsed: ParsedPly) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ParsedPly>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  const entry: CachedParseEntry = {
    file,
    promise,
    resolve,
    reject,
    progress: 0,
    listeners: new Set(),
  };
  parsedRoomOneFiles.set(file, entry);
  void promise.catch(() => {
    if (parsedRoomOneFiles.get(file) === entry) parsedRoomOneFiles.delete(file);
  });
  sharedParseQueue.push(entry);
  runNextSharedParse();
  return entry;
}

function parseStandalonePly(file: File, onProgress: ProgressListener): PlyParseHandle {
  const worker = createParserWorker("cpu-ply-parser");
  const promise = new Promise<ParsedPly>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<ParserWorkerMessage>) => {
      if (event.data.type === "result") resolve(event.data.result);
      else if (event.data.type === "progress") onProgress(event.data.progress);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => reject(new Error(event.message || "PLY 后台解析失败。"));
    worker.postMessage({ file });
  });
  return { promise, terminate: () => worker.terminate() };
}

/**
 * The bundled room files share a session-level worker queue and parsed buffers.
 * User-selected files intentionally keep the original isolated worker lifecycle.
 */
export function parsePlyFile(
  file: File,
  onProgress: ProgressListener = () => undefined,
): PlyParseHandle {
  if (!roomOneFiles.has(file)) return parseStandalonePly(file, onProgress);

  const entry = getOrCreateCachedParse(file);
  let listening = true;
  entry.listeners.add(onProgress);
  if (entry.progress > 0) queueMicrotask(() => listening && onProgress(entry.progress));
  return {
    promise: entry.promise,
    terminate: () => {
      listening = false;
      entry.listeners.delete(onProgress);
    },
  };
}

/**
 * Fetches and parses the bundled room scene without creating Three.js or WebGL.
 * Safe to call repeatedly; every call shares the same session promises.
 */
export function preloadRoomOneTwinScene(): Promise<RoomOneTwinSceneFiles> {
  if (roomOnePreloadPromise) return roomOnePreloadPromise;

  const parsePromises = roomOneAssetKeys.map((key) => (
    loadRoomOneAsset(key).then((file) => getOrCreateCachedParse(file).promise)
  ));
  const pending = Promise.allSettled(parsePromises)
    .then((results) => {
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
      return loadRoomOneTwinSceneFiles();
    })
    .catch((error: unknown) => {
      if (roomOnePreloadPromise === pending) roomOnePreloadPromise = null;
      throw error;
    });
  roomOnePreloadPromise = pending;
  return pending;
}
