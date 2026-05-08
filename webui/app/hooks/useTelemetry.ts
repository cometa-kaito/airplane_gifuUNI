"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export type TelemetryFrame = {
  seq: number;
  t_ms: number;
  dt_ms: number;
  ax: number; ay: number; az: number;
  gx: number; gy: number; gz: number;
  roll: number; pitch: number; yaw: number;
  s0: number; s1: number; s2: number;
  wall_ms: number;
};

export type Status = "connecting" | "open" | "closed" | "error";

const HISTORY = 300;             // ref 内に保持するフレーム数（チャートは部分参照）
const SETLATEST_THROTTLE_MS = 50;  // 数値表示の更新頻度（=20Hz）
const SETRX_THROTTLE_MS = 100;     // 受信件数表示の更新頻度（=10Hz）

export function useTelemetry(url: string) {
  const [status, setStatus] = useState<Status>("connecting");
  const [latest, setLatest] = useState<TelemetryFrame | null>(null);
  const [rxCount, setRxCount] = useState(0);

  // 常に最新を持つ ref（毎フレーム参照可、再レンダ無し）
  const latestRef = useRef<TelemetryFrame | null>(null);
  const historyRef = useRef<TelemetryFrame[]>([]);
  const rxCounterRef = useRef(0);

  // スロットルタイマ
  const lastSetLatest = useRef(0);
  const lastSetRx = useRef(0);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);

  const ingest = useCallback((msg: TelemetryFrame) => {
    // ref は常に更新
    latestRef.current = msg;
    const arr = historyRef.current;
    arr.push(msg);
    if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
    rxCounterRef.current++;

    // React state はスロットル
    const now = performance.now();
    if (now - lastSetLatest.current >= SETLATEST_THROTTLE_MS) {
      lastSetLatest.current = now;
      setLatest(msg);
    }
    if (now - lastSetRx.current >= SETRX_THROTTLE_MS) {
      lastSetRx.current = now;
      setRxCount(rxCounterRef.current);
    }
  }, []);

  const connect = useCallback(() => {
    setStatus("connecting");
    let backoff = 1000;
    const tryConnect = () => {
      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.addEventListener("open", () => {
          setStatus("open");
          backoff = 1000;
        });

        ws.addEventListener("message", (ev) => {
          try {
            const msg = JSON.parse(ev.data) as TelemetryFrame;
            ingest(msg);
          } catch {
            // 無視
          }
        });

        ws.addEventListener("error", () => {
          setStatus("error");
        });

        ws.addEventListener("close", () => {
          setStatus("closed");
          retryRef.current = window.setTimeout(() => {
            backoff = Math.min(backoff * 1.5, 5000);
            tryConnect();
          }, backoff);
        });
      } catch {
        retryRef.current = window.setTimeout(tryConnect, backoff);
      }
    };
    tryConnect();
  }, [url, ingest]);

  useEffect(() => {
    if (!url) {
      setStatus("closed");
      return;
    }
    connect();
    return () => {
      if (retryRef.current !== null) {
        window.clearTimeout(retryRef.current);
      }
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
  }, [connect, url]);

  return { status, latest, latestRef, rxCount, history: historyRef };
}
