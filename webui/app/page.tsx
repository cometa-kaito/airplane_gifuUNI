"use client";

import { useEffect, useState, useMemo } from "react";
import { useTelemetry } from "./hooks/useTelemetry";
import { useWebSerial } from "./hooks/useWebSerial";
import { useHeartbeat } from "./hooks/useHeartbeat";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { ModeSelector, type SourceMode } from "./components/ModeSelector";
import { CommandPanel } from "./components/CommandPanel";
import { TelemetryPanel } from "./components/TelemetryPanel";
import { AttitudeHero } from "./components/AttitudeHero";
import { ArtificialHorizon } from "./components/ArtificialHorizon";
import { ServoBars } from "./components/ServoBars";
import { AttitudeChart } from "./components/AttitudeChart";
import { ServoChart } from "./components/ServoChart";
import { AccelChart } from "./components/AccelChart";
import { Glider3D } from "./components/Glider3D";
import { RateMeter } from "./components/RateMeter";
import { RecorderPanel } from "./components/RecorderPanel";
import { QuickControl } from "./components/QuickControl";
import { GainPanel } from "./components/GainPanel";
import { SafetyPanel } from "./components/SafetyPanel";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { LaunchPanel } from "./components/LaunchPanel";
import type { TelemetryFrame } from "./hooks/useTelemetry";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8765";
const WS_TOKEN = process.env.NEXT_PUBLIC_WS_TOKEN ?? undefined;
const SNAPSHOT_INTERVAL_MS = 200; // チャート再描画頻度（=5Hz）

/**
 * Step ヘッダ：操作フロー上のセクションに番号と一言の役割説明を付ける。
 * 「ユーザが触る順番」に並べた page.tsx 内のセクションで使う。
 */
function StepHeader({
  num,
  title,
  hint,
  tone = "default",
}: {
  num: number;
  title: string;
  hint: string;
  tone?: "default" | "warn" | "go";
}) {
  const toneCls =
    tone === "go"
      ? "bg-glider-ok/15 text-glider-ok border-glider-ok/30"
      : tone === "warn"
        ? "bg-glider-warn/15 text-glider-warn border-glider-warn/30"
        : "bg-glider-accent/15 text-glider-accent border-glider-accent/30";
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <span
        className={`inline-flex items-center justify-center w-6 h-6 rounded-full
                    border font-bold text-xs font-mono ${toneCls}`}
        aria-hidden
      >
        {num}
      </span>
      <div className="leading-tight">
        <div className="text-[13px] font-bold text-glider-text uppercase tracking-wider">
          {title}
        </div>
        <div className="text-[10px] text-glider-textMute">{hint}</div>
      </div>
    </div>
  );
}

export default function Page() {
  // 既定は WebSerial (Python 不要、USB 直結。WebSocket に切替えたい場合はタブから)
  const [mode, setMode] = useState<SourceMode>("webserial");

  const wsHook = useTelemetry(mode === "websocket" ? WS_URL : "", WS_TOKEN);
  const wsSerial = useWebSerial();

  const active = mode === "websocket" ? wsHook : wsSerial;
  const { status, latestRef, rxCount, history } = active;

  const [snap, setSnap] = useState<TelemetryFrame[]>([]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const all = history.current;
      setSnap(all.length > 200 ? all.slice(-200) : [...all]);
    }, SNAPSHOT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [history]);

  useEffect(() => {
    if (mode === "websocket") {
      (async () => {
        try {
          await wsSerial.disconnect();
        } catch {
          // already disconnected
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const url = mode === "websocket" ? WS_URL : "WebSerial (USB direct)";
  const attitudeRef = useMemo(() => latestRef, [latestRef]);

  // 接続中は ~750ms 毎に ping を送って機体の failsafe (uplink timeout) を発火させない
  const sendCommand =
    mode === "websocket" ? wsHook.sendCommand : wsSerial.sendCommand;
  const heartbeat = useHeartbeat({
    enabled: status === "open",
    intervalMs: 750,
    onSend: sendCommand,
  });

  return (
    <main className="min-h-screen">
      {/* Sticky header — Step 0: Connect */}
      <header
        className="sticky top-0 z-30 backdrop-blur-md bg-glider-bg/70
                   border-b border-glider-border"
      >
        <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-3
                        flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2.5">
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center
                           bg-gradient-to-br from-glider-accent to-glider-pitch
                           text-black font-extrabold text-lg shadow-glow"
                aria-hidden
              >
                ✈
              </div>
              <div className="leading-tight">
                <h1 className="text-base md:text-lg font-bold text-glider-text">
                  Glider Telemetry
                </h1>
                <div className="text-[10px] text-glider-textMute tracking-wider uppercase">
                  自律滑空機 表示 UI · Pre-flight Workflow
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <ModeSelector
              mode={mode}
              onChange={setMode}
              webSerialSupported={wsSerial.supported}
            />
            <div className="h-8 w-px bg-glider-border hidden md:block" />
            <ConnectionStatus status={status} rxCount={rxCount} url={url} />
            <RateMeter rxCount={rxCount} />
            {mode === "webserial" && status !== "open" && (
              <button
                onClick={() => {
                  wsSerial.connect().catch((e) => {
                    alert(`接続失敗: ${e?.message ?? e}`);
                  });
                }}
                className="btn-primary"
              >
                ▶ Connect Device
              </button>
            )}
            {mode === "webserial" && status === "open" && (
              <button
                onClick={() => void wsSerial.disconnect()}
                className="btn-danger"
              >
                ■ Disconnect
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-5 space-y-5">
        {/* ============================================================ */}
        {/* MONITOR (常時表示): 接続〜飛行中の視認用ヒーロー               */}
        {/* ============================================================ */}
        <section
          className="grid gap-4"
          style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)" }}
        >
          <AttitudeHero attitudeRef={attitudeRef} />
          <ArtificialHorizon
            attitudeRef={attitudeRef}
            className="min-h-[320px]"
          />
        </section>
        <ServoBars attitudeRef={attitudeRef} />

        {/* ============================================================ */}
        {/* PRE-FLIGHT WORKFLOW (上から順に触る)                          */}
        {/* ============================================================ */}
        <div className="rounded-lg border border-glider-border/60 bg-glider-bg/40 p-3 md:p-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-glider-accent">
                ▸ Pre-flight Workflow
              </span>
              <span className="text-[10px] text-glider-textMute">
                上から ① → ② → ③ → ④ → ⑤ の順に操作
              </span>
            </div>
            <span
              className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
                status === "open"
                  ? "bg-glider-ok/10 text-glider-ok"
                  : "bg-glider-textMute/10 text-glider-textMute"
              }`}
            >
              {status === "open" ? "DEVICE CONNECTED" : "WAITING DEVICE"}
            </span>
          </div>

          {/* Step 1: キャリブレーション（機体を水平面に置いた状態で実施） */}
          <div>
            <StepHeader
              num={1}
              title="Calibration · 取付角ゼロ点"
              hint="機体を水平に置いて Zero Now"
            />
            <CalibrationPanel
              attitudeRef={attitudeRef}
              onSend={sendCommand}
              enabled={status === "open"}
            />
          </div>

          {/* Step 2: 安全装置（しきい値・failsafe） */}
          <div>
            <StepHeader
              num={2}
              title="Safety · 自動 MANUAL 復帰条件"
              hint="姿勢角しきい値 + アップリンク Failsafe"
              tone="warn"
            />
            <SafetyPanel
              attitudeRef={attitudeRef}
              heartbeatSentCount={heartbeat.sentCount}
              onSend={sendCommand}
              enabled={status === "open"}
            />
          </div>

          {/* Step 3: 手動トリム + モード（MANUAL で各舵の中立を合わせる） */}
          <div>
            <StepHeader
              num={3}
              title="Trim & Mode · 手動操舵で中立調整"
              hint="MANUAL で D-Pad / 矢印キー、AUTO 切替も同パネル"
            />
            <QuickControl onSend={sendCommand} enabled={status === "open"} />
          </div>

          {/* Step 4: PID ゲイン（地上で挙動を確認しつつ調整） */}
          <div>
            <StepHeader
              num={4}
              title="PID Gains · 3軸ゲイン + D-LPF"
              hint="保存値は接続時に自動同期。プリセットから開始可"
            />
            <GainPanel onSend={sendCommand} enabled={status === "open"} />
          </div>

          {/* Step 5: 投擲検知（自律飛行モード）。最後に Arm して投げる。 */}
          <div>
            <StepHeader
              num={5}
              title="Launch · 投擲検知（自律滑空）"
              hint="他の Step が完了したら最後に Arm"
              tone="go"
            />
            <LaunchPanel
              attitudeRef={attitudeRef}
              onSend={sendCommand}
              enabled={status === "open"}
            />
          </div>
        </div>

        {/* ============================================================ */}
        {/* IN-FLIGHT MONITORING / POST-FLIGHT ANALYSIS                   */}
        {/* ============================================================ */}
        <div className="rounded-lg border border-glider-border/60 bg-glider-bg/40 p-3 md:p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-glider-pitch">
              ▸ In-flight / Post-flight
            </span>
            <span className="text-[10px] text-glider-textMute">
              飛行中の監視と、飛行後のログ操作
            </span>
          </div>

          {/* 3D + チャート群 (飛行中の視認・解析用) */}
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-6">
              <Glider3D attitudeRef={attitudeRef} />
            </div>
            <div className="lg:col-span-6 grid grid-cols-1 gap-4">
              <AttitudeChart data={snap} />
              <ServoChart data={snap} />
              <AccelChart data={snap} />
            </div>
          </section>

          {/* 詳細テレメトリ (IMU & system) */}
          <TelemetryPanel attitudeRef={attitudeRef} />

          {/* 記録: 保存 / 一覧 / 書き出し / 削除 */}
          <RecorderPanel historyRef={history} liveOK={status === "open"} />
        </div>

        {/* ============================================================ */}
        {/* ADVANCED · 生コマンド (フォールバック)                        */}
        {/* ============================================================ */}
        <details className="rounded-lg border border-glider-border/60 bg-glider-bg/40">
          <summary className="px-4 py-3 cursor-pointer select-none text-[12px] uppercase tracking-[0.18em] font-bold text-glider-textDim hover:text-glider-text">
            ▸ Advanced · 生コマンド入力（通常は不要）
          </summary>
          <div className="p-4 pt-0">
            <CommandPanel
              onSend={sendCommand}
              enabled={status === "open"}
              hint={
                mode === "websocket"
                  ? "WebSocket: ground_station 側で 'Accept WS commands' を ON にする必要あり"
                  : "WebSerial: USB 直結。Python 不要"
              }
            />
          </div>
        </details>

        <footer className="pt-2 pb-6 text-[11px] text-glider-textMute space-y-1
                           border-t border-glider-border/50">
          <div className="pt-3 flex flex-wrap gap-x-6 gap-y-1">
            <span>
              <strong className="text-glider-textDim">WebSocket</strong> —
              Python ground_station.py 経由 (PyQt と並行可、複数端末で共有可)
            </span>
            <span>
              <strong className="text-glider-textDim">WebSerial</strong> —
              ブラウザから USB を直接掴む (Chrome / Edge のみ、Python 不要)
            </span>
          </div>
          <div className="text-glider-textMute/70">
            Numeric ≈60Hz (RAF, no rerender) · Charts 5Hz (uPlot) · 3D 60fps · WS reconnect with backoff
          </div>
        </footer>
      </div>
    </main>
  );
}
