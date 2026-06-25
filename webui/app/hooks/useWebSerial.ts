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
  const lastSetInfo = useRef(0);  // InfoLog 通知用の独立スロットル (telemetry 用と分離)

  // ブラウザ API ハンドル
  const portRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  const writerRef = useRef<any>(null);
  const stopFlagRef = useRef(false);
  // 受信ループ完了を await できるようにする（disconnect で待ち合わせ用）
  const readLoopDoneRef = useRef<Promise<void> | null>(null);

  // 情報ログ ([STATUS], [PHASE], [PARAM] など [...] で始まる応答ライン)。
  // テレメトリ CSV パースで捨てられるので、ここに溜めて UI に見せる。
  const infoLogRef = useRef<{ ts: number; line: string }[]>([]);
  const [infoLogTick, setInfoLogTick] = useState(0);  // 再描画トリガ用

  // SSR 対応: 初期は false、マウント後に navigator.serial の有無を判定
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    if (typeof navigator !== "undefined" && "serial" in (navigator as any)) {
      setSupported(true);
    }
  }, []);

  // ---------- 1 行をパース → ref/state へ反映（state はスロットル） ----------
  //   下位互換: 旧 firmware の 15 列、新 firmware の 17 列（末尾に phase, accel_g）の両方を受理する。
  //   欠損列はそれぞれ 0 / 計算値で埋める。
  const parseLine = useCallback((line: string) => {
    if (!line) return;
    // 情報ログ ([...] / # / 旧ファームの LOG, 行)
    if (line.startsWith("[") || line.startsWith("#") || line.startsWith("LOG,")) {
      // 情報ログとして保持し、UI 側で参照させる（最大 200 行、古いものを捨てる）
      const buf = infoLogRef.current;
      buf.push({ ts: Date.now(), line });
      if (buf.length > 200) buf.splice(0, buf.length - 200);
      // 100ms スロットルで UI 通知（毎行 setState すると重い）。
      // ※ 専用タイマ lastSetInfo を使う（telemetry 用 lastSetLatest 流用だと
      //   テレメtrイ受信中に InfoLog がほぼ更新されないバグになる）。
      const now = performance.now();
      if (now - lastSetInfo.current > 100) {
        lastSetInfo.current = now;
        setInfoLogTick((n) => n + 1);
      }
      return;
    }

    let frame: TelemetryFrame | null = null;

    if (line.startsWith("DAT,")) {
      // 旧ファーム形式 (16 トークン):
      //   DAT,seq,t_ms,temp,ax,ay,az,gx,gy,gz,roll,pitch,yaw,servoL,servoR,servoE
      //   servo の並びは L,R,E（LOG 行の TL/TR/TE 順に対応）。
      //   glider_nRF52840 の TelemetryFrame は s0=右/s1=左/s2=Elev なので入れ替える。
      const p = line.split(",");
      if (p.length < 16) return;
      const n = p.map((x) => Number(x));
      // p[0]="DAT" は NaN になるので 1..15 が数値であることだけ確認する
      if (n.slice(1, 16).some((v) => Number.isNaN(v))) return;
      const ax = n[4], ay = n[5], az = n[6];
      frame = {
        seq: n[1], t_ms: n[2], dt_ms: 0,
        ax, ay, az,
        gx: n[7], gy: n[8], gz: n[9],
        roll: n[10], pitch: n[11], yaw: n[12],
        s0: n[14], s1: n[13], s2: n[15],   // R, L, E
        phase: 0,
        accel_g: Math.sqrt(ax * ax + ay * ay + az * az),
        wall_ms: Date.now(),
      };
    } else {
      // glider_nRF52840 形式: 15列(旧) / 17列(新, 末尾 phase, accel_g)
      const parts = line.split(",");
      if (parts.length < 15) return;
      const n = parts.map((x) => Number(x));
      if (n.slice(0, 15).some((v) => Number.isNaN(v))) return;

      const ax = n[3], ay = n[4], az = n[5];
      const phase = parts.length >= 16 && Number.isFinite(n[15]) ? n[15] : 0;
      const accel_g = parts.length >= 17 && Number.isFinite(n[16])
        ? n[16]
        : Math.sqrt(ax * ax + ay * ay + az * az);

      frame = {
        seq: n[0], t_ms: n[1], dt_ms: n[2],
        ax, ay, az,
        gx: n[6], gy: n[7], gz: n[8],
        roll: n[9], pitch: n[10], yaw: n[11],
        s0: n[12], s1: n[13], s2: n[14],
        phase, accel_g,
        wall_ms: Date.now(),
      };
    }

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

      // 受信ループは別プロミスで起動（disconnect 時に await できるよう保持）
      readLoopDoneRef.current = readLoop(port);
    } catch (e) {
      setStatus("error");
      throw e;
    }
  }, [supported, readLoop]);

  // ---------- 切断 ----------
  // ポイント:
  //   port.close() は readable / writable のロックがすべて解放されてからでないと
  //   失敗（→ OS レベルでポートを掴んだまま）になる。
  //   そのため reader.cancel → 読み込みループ終了待ち → writer.releaseLock の順で
  //   await してから close する。
  const disconnect = useCallback(async () => {
    stopFlagRef.current = true;

    // 1) reader をキャンセル（pending な reader.read() を {done:true} で resolve させる）
    // USB サスペンド時に cancel() が永久に hang するケースがあるため 2s でタイムアウト。
    if (readerRef.current) {
      try {
        const timeout = new Promise<void>((_, rej) => window.setTimeout(() => rej(new Error("cancel timeout")), 2000));
        await Promise.race([readerRef.current.cancel(), timeout]);
      } catch {}
    }

    // 2) 読み込みループの finally まで完了させる（reader.releaseLock() が中で走る）
    if (readLoopDoneRef.current) {
      try { await readLoopDoneRef.current; } catch {}
      readLoopDoneRef.current = null;
    }
    readerRef.current = null;

    // 3) writer のロックを解放
    if (writerRef.current) {
      try { writerRef.current.releaseLock(); } catch {}
      writerRef.current = null;
    }

    // 4) ここまで来れば readable/writable 双方のロックが空、port.close() が成功する
    if (portRef.current) {
      try {
        await portRef.current.close();
      } catch (e) {
        // ロック解放が間に合わなかった等で失敗した場合はログだけ残す
        console.warn("[useWebSerial] port.close() failed:", e);
      }
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
    infoLog: infoLogRef,
    infoLogTick,
    supported,
    connect,
    disconnect,
    sendCommand,
  };
}
