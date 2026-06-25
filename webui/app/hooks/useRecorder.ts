"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "./useTelemetry";
import {
  appendFrames,
  createSession,
  deleteAllSessions,
  deleteSession,
  finalizeSession,
  listSessions,
  loadSessionFrames,
  type SessionMeta,
} from "../lib/db";

const FLUSH_INTERVAL_MS = 1000; // IndexedDB への書き込み頻度
const COUNT_UI_UPDATE_MS = 250; // 「frames 数」表示の更新頻度

/**
 * テレメトリ記録フック。
 * historyRef (受信中のリングバッファ) を毎 RAF で見て、最後に保存した seq より先のフレームを
 * 内部バッファに積み、定期的に IndexedDB に flush する。
 *
 * 設計トレードオフ:
 *   - hooks に invasive な subscribe を生やさずに済む → 後方互換
 *   - 60Hz RAF × 20Hz 受信 = 3倍オーバサンプルで取りこぼし無し
 *   - 唯一の弱点: タブが非アクティブで RAF が止まる長時間バックグラウンドでは取りこぼす
 *     (アクティブ使用前提)
 */
export function useRecorder(historyRef: MutableRefObject<TelemetryFrame[]>) {
  const [recording, setRecording] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [liveFrameCount, setLiveFrameCount] = useState(0);
  const [liveStartedAt, setLiveStartedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const sessionIdRef = useRef<number | null>(null);
  const bufferRef = useRef<TelemetryFrame[]>([]);
  // 前回までに記録した「最後のフレーム」そのもの (参照) を保持する。
  // seq は機体リブートで 0 に戻るため起点に使えない → オブジェクト同一性で追う。
  const lastFrameRef = useRef<TelemetryFrame | null>(null);
  const totalFramesRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await listSessions();
      setSessions(s);
    } catch (e) {
      console.warn("[recorder] listSessions failed:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ---- RAF tail loop: pick up new frames from historyRef ----
  useEffect(() => {
    if (!recording) return;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const hist = historyRef.current;
      if (hist.length > 0) {
        // 取りこぼし/重複なく「前回以降の新規フレーム」を拾う。
        // seq は機体リブートで 0 に戻るので使わず、前回記録した最後の
        // フレームオブジェクトを参照一致 (lastIndexOf) で探して位置を特定する。
        // → リブートで seq が巻き戻っても記録が止まらない。
        const marker = lastFrameRef.current;
        let firstNew: number;
        if (marker === null) {
          // 録画開始時に history が空だった場合: 先頭から全部新規
          firstNew = 0;
        } else {
          const idx = hist.lastIndexOf(marker);
          // idx<0 = marker がリングバッファから押し出された (長時間 RAF 停止)。
          // 取りこぼしは諦め、現在バッファ全体を新規扱いにして記録を継続する。
          firstNew = idx >= 0 ? idx + 1 : 0;
        }
        for (let i = firstNew; i < hist.length; i++) {
          bufferRef.current.push(hist[i]);
          totalFramesRef.current++;
        }
        lastFrameRef.current = hist[hist.length - 1];
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [recording, historyRef]);

  // ---- Periodic flush to IndexedDB ----
  useEffect(() => {
    if (!recording || sessionId === null) return;
    flushTimerRef.current = window.setInterval(async () => {
      if (bufferRef.current.length === 0) return;
      const toSave = bufferRef.current.splice(0, bufferRef.current.length);
      try {
        await appendFrames(sessionId, toSave);
      } catch (e) {
        console.error("[recorder] flush failed:", e);
      }
    }, FLUSH_INTERVAL_MS);

    // Also refresh session list periodically so size grows live in the UI
    const sizeTimer = window.setInterval(() => refresh(), 2000);
    return () => {
      if (flushTimerRef.current !== null) {
        window.clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      window.clearInterval(sizeTimer);
    };
  }, [recording, sessionId, refresh]);

  // ---- Live frame counter UI update (throttled) ----
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      setLiveFrameCount(totalFramesRef.current);
    }, COUNT_UI_UPDATE_MS);
    return () => window.clearInterval(id);
  }, [recording]);

  const start = useCallback(
    async (name?: string) => {
      if (busy || recording) return;
      setBusy(true);
      try {
        const now = new Date();
        const fmt = (n: number) => String(n).padStart(2, "0");
        const auto = `${now.getFullYear()}-${fmt(now.getMonth() + 1)}-${fmt(
          now.getDate(),
        )} ${fmt(now.getHours())}:${fmt(now.getMinutes())}:${fmt(
          now.getSeconds(),
        )}`;
        const meta = await createSession(name || auto);

        // 「今からの」記録: 現在の history 末尾フレームを起点マーカにする
        // (seq ではなくオブジェクト同一性で追うため機体リブートに強い)
        const hist = historyRef.current;
        lastFrameRef.current =
          hist.length > 0 ? hist[hist.length - 1] : null;
        bufferRef.current = [];
        totalFramesRef.current = 0;

        sessionIdRef.current = meta.id;
        setSessionId(meta.id);
        setLiveFrameCount(0);
        setLiveStartedAt(meta.startedAt);
        setRecording(true);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, recording, historyRef, refresh],
  );

  const stop = useCallback(async () => {
    if (busy || !recording) return;
    setBusy(true);
    try {
      setRecording(false);
      const id = sessionIdRef.current;
      if (id !== null) {
        const remaining = bufferRef.current.splice(
          0,
          bufferRef.current.length,
        );
        if (remaining.length > 0) {
          try {
            await appendFrames(id, remaining);
          } catch (e) {
            console.error("[recorder] final flush failed:", e);
          }
        }
        try {
          await finalizeSession(id);
        } catch (e) {
          console.error("[recorder] finalize failed:", e);
        }
      }
      sessionIdRef.current = null;
      setSessionId(null);
      setLiveStartedAt(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, recording, refresh]);

  const removeSession = useCallback(
    async (id: number) => {
      if (busy) return;
      setBusy(true);
      try {
        await deleteSession(id);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  const removeAll = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteAllSessions();
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const exportCSV = useCallback(async (id: number, name: string) => {
    const frames = await loadSessionFrames(id);
    // firmware 17 列 (末尾 phase, accel_g) + 受信時刻 wall_ms。
    const header =
      "seq,t_ms,dt_ms,ax,ay,az,gx,gy,gz,roll,pitch,yaw,s0,s1,s2,phase,accel_g,wall_ms\n";
    // Build in chunks to avoid one huge string
    const parts: string[] = [header];
    for (const f of frames) {
      parts.push(
        `${f.seq},${f.t_ms},${f.dt_ms},${f.ax},${f.ay},${f.az},${f.gx},${f.gy},${f.gz},${f.roll},${f.pitch},${f.yaw},${f.s0},${f.s1},${f.s2},${f.phase ?? 0},${f.accel_g ?? ""},${f.wall_ms}\n`,
      );
    }
    const blob = new Blob(parts, { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^\w\-]/g, "_")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  return {
    recording,
    busy,
    sessionId,
    sessions,
    liveFrameCount,
    liveStartedAt,
    start,
    stop,
    removeSession,
    removeAll,
    exportCSV,
    refresh,
  };
}
