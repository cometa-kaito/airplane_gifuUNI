"use client";

import type { TelemetryFrame } from "../hooks/useTelemetry";

/**
 * テレメトリ記録用 IndexedDB ラッパ。
 * - sessions: メタデータ (開始/終了/フレーム数/サイズ)
 * - frames:   フレームのチャンク (1チャンク = 1秒分くらい)
 *
 * 1フレーム ≈ 150 byte。20Hz × 1時間 = 約 10MB。
 * IndexedDB のクォータは大抵 数百MB 以上なので十分。
 */

const DB_NAME = "glider-telemetry";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const FRAME_STORE = "frames";

const FRAME_BYTES_EST = 150;

export type SessionMeta = {
  id: number;
  name: string;
  startedAt: number;       // unix ms
  endedAt: number | null;
  frameCount: number;
  sizeBytes: number;       // estimate
};

export type FrameChunk = {
  id?: number;
  sessionId: number;
  startSeq: number;
  frames: TelemetryFrame[];
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(FRAME_STORE)) {
        const fs = db.createObjectStore(FRAME_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        fs.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function createSession(name: string): Promise<SessionMeta> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const meta: Omit<SessionMeta, "id"> = {
      name,
      startedAt: Date.now(),
      endedAt: null,
      frameCount: 0,
      sizeBytes: 0,
    };
    const tx = db.transaction(SESSION_STORE, "readwrite");
    const req = tx.objectStore(SESSION_STORE).add(meta);
    req.onsuccess = () => {
      resolve({ id: req.result as number, ...meta });
    };
    req.onerror = () => reject(req.error);
  });
}

export async function appendFrames(
  sessionId: number,
  frames: TelemetryFrame[],
): Promise<void> {
  if (frames.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([SESSION_STORE, FRAME_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);

    const chunk: FrameChunk = {
      sessionId,
      startSeq: frames[0].seq,
      frames,
    };
    tx.objectStore(FRAME_STORE).add(chunk);

    const sessionStore = tx.objectStore(SESSION_STORE);
    const getReq = sessionStore.get(sessionId);
    getReq.onsuccess = () => {
      const m = getReq.result as SessionMeta | undefined;
      if (!m) return;
      m.frameCount += frames.length;
      m.sizeBytes += frames.length * FRAME_BYTES_EST;
      sessionStore.put(m);
    };
  });
}

export async function finalizeSession(sessionId: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore(SESSION_STORE);
    const getReq = store.get(sessionId);
    getReq.onsuccess = () => {
      const m = getReq.result as SessionMeta | undefined;
      if (!m) return;
      m.endedAt = Date.now();
      store.put(m);
    };
  });
}

export async function listSessions(): Promise<SessionMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readonly");
    const req = tx.objectStore(SESSION_STORE).getAll();
    req.onsuccess = () => {
      const arr = (req.result as SessionMeta[]).sort(
        (a, b) => b.startedAt - a.startedAt,
      );
      resolve(arr);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function loadSessionFrames(
  sessionId: number,
): Promise<TelemetryFrame[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FRAME_STORE, "readonly");
    const idx = tx.objectStore(FRAME_STORE).index("sessionId");
    const req = idx.getAll(sessionId);
    req.onsuccess = () => {
      const chunks = (req.result as FrameChunk[]).sort(
        (a, b) => a.startSeq - b.startSeq,
      );
      const out: TelemetryFrame[] = [];
      for (const c of chunks) out.push(...c.frames);
      resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSession(sessionId: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([SESSION_STORE, FRAME_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(SESSION_STORE).delete(sessionId);
    const idx = tx.objectStore(FRAME_STORE).index("sessionId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(sessionId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}

export async function deleteAllSessions(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([SESSION_STORE, FRAME_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(SESSION_STORE).clear();
    tx.objectStore(FRAME_STORE).clear();
  });
}

export type StorageEstimate = {
  used: number;
  quota: number;
} | null;

export async function getStorageEstimate(): Promise<StorageEstimate> {
  if (
    typeof navigator !== "undefined" &&
    navigator.storage &&
    typeof navigator.storage.estimate === "function"
  ) {
    const e = await navigator.storage.estimate();
    if (e.usage != null && e.quota != null) {
      return { used: e.usage, quota: e.quota };
    }
  }
  return null;
}
