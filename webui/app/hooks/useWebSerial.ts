"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Status, TelemetryFrame } from "./useTelemetry";

const HISTORY = 300;
const SETLATEST_THROTTLE_MS = 50;
const SETRX_THROTTLE_MS = 100;

/**
 * Web Serial API でブラウザから直接 USB シリアルを掴む。
 * Chromium 系（Chrome / Edge / Opera）のみ動作。
 *
 * 使い方:
 *   const ws = useWebSerial();
 *   <button onClick={ws.connect}>Connect</button>
 *   ws.sendCommand("status");
 */
export function useWebSerial() {
  const [status, setStatus] = useState<Status>("closed");
  const [latest, setLatest] = useState<TelemetryFrame | null>(null);
  const [rxCount, setRxCount] = useState(0);
  const historyRef = useRef<TelemetryFrame[]>([]);

  // 常時更新の ref（再レンダ無し）
  const latestRef = useRef<TelemetryFrame | null>(null);
  const rxCounterRef = useRef(0);
  const lastSetLatest = useRef(0);
  const lastSetRx = useRef(0);

  // ブラウザ API ハンドル
  const portRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  const writerRef = useRef<any>(null);
  const stopFlagRef = useRef(false);

  const supported =
    typeof navigator !== "undefined" && "serial" in (navigator as any);

  // ---------- 1 行をパース → ref/state へ反映（state はスロットル） ----------
  const parseLine = useCallback((line: string) => {
    if (!line) return;
    if (line.startsWith("[") || line.startsWith("#")) return;
    const parts = line.split(",");
    if (parts.length !== 15) return;
    const n = parts.map((p) => Number(p));
    if (n.some((v) => Number.isNaN(v))) return;

    const frame: TelemetryFrame = {
      seq: n[0], t_ms: n[1], dt_ms: n[2],
      ax: n[3], ay: n[4], az: n[5],
      gx: n[6], gy: n[7], gz: n[8],
      roll: n[9], pitch: n[10], yaw: n[11],
      s0: n[12], s1: n[13], s2: n[14],
      wall_ms: Date.now(),
    };

    latestRef.current = frame;
    const arr = historyRef.current;
    arr.push(frame);
    if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
    rxCounterRef.current++;

    const now = performance.now();
    if (now - lastSetLatest.current >= SETLATEST_THROTTLE_MS) {
      lastSetLatest.current = now;
      setLatest(frame);
    }
    if (now - lastSetRx.current >= SETRX_THROTTLE_MS) {
      lastSetRx.current = now;
      setRxCount(rxCounterRef.current);
    }
  }, []);

  // ---------- 受信ループ ----------
  const readLoop = useCallback(
    async (port: any) => {
      const decoder = new TextDecoder();
      const reader = port.readable.getReader();
      readerRef.current = reader;

      let buf = "";
      try {
        while (!stopFlagRef.current) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            parseLine(line);
          }
        }
      } catch {
        // ignore - 切断時に発生
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    },
    [parseLine],
  );

  // ---------- 接続 ----------
  const connect = useCallback(async () => {
    if (!supported) {
      setStatus("error");
      throw new Error("このブラウザは Web Serial API に対応していません (Chrome / Edge を使用してください)");
    }
    try {
      setStatus("connecting");
      const port: any = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: 115200 });
      portRef.current = port;
      stopFlagRef.current = false;

      // writer 確保
      writerRef.current = port.writable.getWriter();

      setStatus("open");

      // 別プロミスで受信ループ開始（await しない）
      readLoop(port).then(() => {
        setStatus("closed");
      });
    } catch (e) {
      setStatus("error");
      throw e;
    }
  }, [supported, readLoop]);

  // ---------- 切断 ----------
  const disconnect = useCallback(async () => {
    stopFlagRef.current = true;
    try { readerRef.current?.cancel(); } catch {}
    try { writerRef.current?.releaseLock(); } catch {}
    writerRef.current = null;
    if (portRef.current) {
      try { await portRef.current.close(); } catch {}
      portRef.current = null;
    }
    setStatus("closed");
  }, []);

  // ---------- コマンド送信 ----------
  const sendCommand = useCallback(async (cmd: string) => {
    if (!writerRef.current) throw new Error("not connected");
    const text = cmd.trim() + "\n";
    const buf = new TextEncoder().encode(text);
    await writerRef.current.write(buf);
  }, []);

  // ---------- アンマウント時にクリーンアップ ----------
  useEffect(() => {
    return () => {
      void disconnect();
    };
  }, [disconnect]);

  return {
    status,
    latest,
    latestRef,
    rxCount,
    history: historyRef,
    supported,
    connect,
    disconnect,
    sendCommand,
  };
}
