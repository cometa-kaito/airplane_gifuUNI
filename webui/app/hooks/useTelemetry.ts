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

const HISTORY = 300; // 50Hz で約 6 秒分

export function useTelemetry(url: string) {
  const [status, setStatus] = useState<Status>("connecting");
  const [latest, setLatest] = useState<TelemetryFrame | null>(null);
  const [rxCount, setRxCount] = useState(0);
  const historyRef = useRef<TelemetryFrame[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);

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
            const arr = historyRef.current;
            arr.push(msg);
            if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
            setLatest(msg);
            setRxCount((c) => c + 1);
          } catch {
            // 解析できない行は無視
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
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      if (retryRef.current !== null) {
        window.clearTimeout(retryRef.current);
      }
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { status, latest, rxCount, history: historyRef };
}
