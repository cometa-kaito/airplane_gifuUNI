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
  // 17列拡張 (firmware v17+)。旧 firmware 接続時は 0 を入れる。
  phase: number;   // 0=DISARMED, 1=PRELAUNCH, 2=LAUNCH, 3=GLIDE, 4=LANDED
  accel_g: number; // sqrt(ax^2+ay^2+az^2) [g]
  wall_ms: number;
};

export const PHASE_NAMES = [
  "DISARMED",
  "PRELAUNCH",
  "LAUNCH",
  "GLIDE",
  "LANDED",
  "WINDTUNNEL",
] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

export type Status = "connecting" | "open" | "closed" | "error";

const HISTORY = 300;             // ref 内に保持するフレーム数（チャートは部分参照）
const SETLATEST_THROTTLE_MS = 50;  // 数値表示の更新頻度（=20Hz）
const SETRX_THROTTLE_MS = 100;     // 受信件数表示の更新頻度（=10Hz）

export function useTelemetry(url: string, token?: string) {
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
  const tokenRef = useRef<string | undefined>(token);
  tokenRef.current = token;

  const ingest = useCallback((msg: TelemetryFrame) => {
    // 旧サーバ (phase/accel_g 非送信) との互換: 欠損は 0 で埋める。
    if (typeof msg.phase !== "number") (msg as any).phase = 0;
    if (typeof msg.accel_g !== "number") {
      // ax,ay,az があるなら計算で補う
      const ax = msg.ax ?? 0, ay = msg.ay ?? 0, az = msg.az ?? 0;
      (msg as any).accel_g = Math.sqrt(ax * ax + ay * ay + az * az);
    }

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
          // トークンがあれば最初に認証メッセージを送る
          if (tokenRef.current) {
            try {
              ws.send(JSON.stringify({ auth: tokenRef.current }));
            } catch {
              // 無視
            }
          }
        });

        ws.addEventListener("message", (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            // テレメトリ判定: seq/roll/pitch を含むものだけ取り込む
            if (msg && typeof msg === "object" && "seq" in msg && "roll" in msg) {
              ingest(msg as TelemetryFrame);
            }
            // auth/cmd ack 等は単に無視（必要ならここでログ）
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

  const sendCommand = useCallback(async (cmd: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    ws.send(JSON.stringify({ cmd }));
  }, []);

  // WebSocket 経路では Python 側が CSV を JSON テレメトリのみ転送するため、
  // [...] 系の info ログは（現状の Python ground_station では）届かない。
  // 互換性のため空の ref と tick を返す。
  const infoLogStub = useRef<{ ts: number; line: string }[]>([]);
  return {
    status,
    latest,
    latestRef,
    rxCount,
    history: historyRef,
    infoLog: infoLogStub,
    infoLogTick: 0,
    sendCommand,
  };
}
