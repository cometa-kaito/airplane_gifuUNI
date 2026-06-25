"use client";

import { useEffect, useState, useMemo } from "react";
import { useWebSerial } from "./hooks/useWebSerial";
import { useHeartbeat } from "./hooks/useHeartbeat";
import { ConnectionStatus } from "./components/ConnectionStatus";
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
import { TrimSetupPanel } from "./components/TrimSetupPanel";
import { ServoCalPanel } from "./components/ServoCalPanel";
import { GainPanel } from "./components/GainPanel";
import { useTrim } from "./hooks/useTrim";
import { useServoCal } from "./hooks/useServoCal";
import { SafetyPanel } from "./components/SafetyPanel";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { LaunchPanel } from "./components/LaunchPanel";
import { WindTunnelPanel } from "./components/WindTunnelPanel";
import { AutoTunePanel } from "./components/AutoTunePanel";
import { InfoLogPanel } from "./components/InfoLogPanel";
import { FirmwarePanel } from "./components/FirmwarePanel";
import type { TelemetryFrame } from "./hooks/useTelemetry";

const SNAPSHOT_INTERVAL_MS = 200; // チャート再描画頻度（=5Hz）

/**
 * Step ヘッダ：操作フロー上のセクションに番号と一言の役割説明を付ける。
 * 番号バッジ + タイトル + サブテキストで階層を明確化（タイポグラフィのコントラスト）。
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
  const badgeCls =
    tone === "go"
      ? "step-badge-go"
      : tone === "warn"
        ? "step-badge-warn"
        : "step-badge-default";
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className={badgeCls} aria-hidden>
        {num}
      </span>
      <div className="leading-tight">
        <div className="text-base font-semibold text-slate-800 tracking-tight">
          {title}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">{hint}</div>
      </div>
    </div>
  );
}

export default function Page() {
  // 接続は WebSerial (USB 直結) 専用。Python 不要。Chrome / Edge のみ。
  // 旧 WebSocket 経路 (Python ground_station.py) は archive/websocket/ へ退避済み。
  const wsSerial = useWebSerial();

  const { status, latestRef, rxCount, history } = wsSerial;
  const infoLog = wsSerial.infoLog;
  const infoLogTick = wsSerial.infoLogTick;

  const [snap, setSnap] = useState<TelemetryFrame[]>([]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const all = history.current;
      setSnap(all.length > 200 ? all.slice(-200) : [...all]);
    }, SNAPSHOT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [history]);

  const url = "WebSerial (USB direct)";
  const attitudeRef = useMemo(() => latestRef, [latestRef]);

  // 接続中は ~750ms 毎に ping を送って機体の failsafe (uplink timeout) を発火させない
  const sendCommand = wsSerial.sendCommand;
  const heartbeat = useHeartbeat({
    enabled: status === "open",
    intervalMs: 750,
    onSend: sendCommand,
  });

  // サーボ中立トリム (s0/s1/s2) — TrimSetupPanel と QuickControl で共有。
  // 保存済み中立を接続時に機体へ自動同期する。
  const trim = useTrim(sendCommand, status === "open");

  // サーボ物理較正 (smid/smax/smin/srev) — 可動域・中立(µs)・反転。
  // 保存済み較正を接続時に機体へ自動同期する。
  const servoCal = useServoCal(sendCommand, status === "open");

  return (
    <main className="min-h-screen">
      {/* Sticky header — Step 0: Connect。クリーンな白背景、薄い shadow で区切る */}
      <header className="sticky top-0 z-30 backdrop-blur-md bg-white/80 shadow-sm">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 py-4
                        flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center
                           bg-indigo-600 text-white font-semibold text-xl shadow-sm"
                aria-hidden
              >
                ✈
              </div>
              <div className="leading-tight">
                <h1 className="text-lg font-semibold text-slate-800 tracking-tight">
                  Glider Telemetry
                </h1>
                <div className="text-xs text-slate-500 mt-0.5">
                  自律滑空機 · Pre-flight Workflow
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            {!wsSerial.supported && (
              <span
                className="text-[11px] font-medium text-amber-700 bg-amber-50 ring-1 ring-amber-200 rounded px-2 py-1"
                title="Web Serial API 未対応ブラウザの可能性"
              >
                ⚠ Chrome / Edge 推奨
              </span>
            )}
            <ConnectionStatus status={status} rxCount={rxCount} url={url} />
            <RateMeter rxCount={rxCount} />
            {status !== "open" && (
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
            {status === "open" && (
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

      <div className="max-w-[1600px] mx-auto px-4 md:px-8 py-8 space-y-8">
        {/* ============================================================ */}
        {/* MONITOR (常時表示): 接続〜飛行中の視認用ヒーロー               */}
        {/* ============================================================ */}
        <section
          className="grid gap-5"
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
        <section className="space-y-5">
          <div className="flex items-center justify-between flex-wrap gap-3 px-1">
            <div>
              <h2 className="text-xl font-semibold text-slate-800 tracking-tight">
                Pre-flight Workflow
              </h2>
              <p className="text-sm text-slate-500 mt-0.5">
                上から順に ⓪ サーボトリム → ① キャリブ → ② 安全装置 → ③ 手動確認 → ④ PID → ⑤ Launch
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full ${
                status === "open"
                  ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
                  : "bg-slate-100 text-slate-500 ring-1 ring-slate-200"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  status === "open" ? "bg-emerald-500 animate-pulseLive" : "bg-slate-400"
                }`}
                aria-hidden
              />
              {status === "open" ? "Device Connected" : "Waiting Device"}
            </span>
          </div>

          {/* Step 0: サーボトリム（全モード共通の機械的 GND。最初に設定する） */}
          <div>
            <StepHeader
              num={0}
              title="Servo Trim · 機械的中立（全モード GND）"
              hint="サーボ 0° と実機の真っすぐが一致しない場合、ここで補正する。AUTO・風洞どちらもこの値が基準"
            />
            <TrimSetupPanel
              trim={trim}
              attitudeRef={attitudeRef}
              onSend={sendCommand}
              enabled={status === "open"}
            />
          </div>

          {/* Step 0b: サーボ可動域較正（取付ごとに 1 回。中立 µs + 両端 µs + 反転） */}
          <div>
            <StepHeader
              num={0}
              title="Servo Calibration · 可動域 / 中立（µs エンドポイント）"
              hint="取付で変わる実際の可動域を µs で設定。両端を超えてサーボを突き当てない（stall 防止）。取付ごとに1回"
            />
            <ServoCalPanel
              servoCal={servoCal}
              attitudeRef={attitudeRef}
              enabled={status === "open"}
            />
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

          {/* Step 3: 手動操舵確認（MANUAL でサーボ動作・舵の効きをチェック） */}
          <div>
            <StepHeader
              num={3}
              title="Manual Check · 手動操舵確認"
              hint="MANUAL に切替えて D-Pad / 矢印キーで舵の効きを確認"
            />
            <QuickControl
              trim={trim}
              onSend={sendCommand}
              enabled={status === "open"}
            />
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

          {/* Step 5b (代替): 風洞試験モード。フライトでは使わない */}
          <details className="pt-2">
            <summary className="cursor-pointer select-none flex items-center gap-3 mb-3">
              <span className="step-badge-alt" aria-hidden>
                5b
              </span>
              <div className="leading-tight">
                <div className="text-base font-semibold text-slate-800 tracking-tight">
                  Wind Tunnel · 風洞試験モード（代替）
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  風洞でステップ応答や PID 調整をする時のみ展開。フライトでは使わない
                </div>
              </div>
              <svg className="w-4 h-4 ml-auto text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <WindTunnelPanel
              attitudeRef={attitudeRef}
              onSend={sendCommand}
              enabled={status === "open"}
            />
          </details>

          {/* Step 5c (代替): Full Auto Tune。風洞で PID を全自動調整。独立モード */}
          <details className="pt-2">
            <summary className="cursor-pointer select-none flex items-center gap-3 mb-3">
              <span className="step-badge-alt" aria-hidden>
                5c
              </span>
              <div className="leading-tight">
                <div className="text-base font-semibold text-slate-800 tracking-tight">
                  Full Auto Tune · PID 自動調整（Z-N 限界感度法）
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  風洞固定で Kp を自動スイープ→Ku/Tu 検出→Ziegler-Nichols で PID を自動算出・適用。GainPanel とは独立
                </div>
              </div>
              <svg className="w-4 h-4 ml-auto text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <AutoTunePanel
              attitudeRef={attitudeRef}
              onSend={sendCommand}
              enabled={status === "open"}
            />
          </details>
        </section>

        {/* ============================================================ */}
        {/* IN-FLIGHT MONITORING / POST-FLIGHT ANALYSIS                   */}
        {/* ============================================================ */}
        <section className="space-y-5">
          <div className="px-1">
            <h2 className="text-xl font-semibold text-slate-800 tracking-tight">
              In-flight / Post-flight
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              飛行中の監視と、飛行後のログ操作
            </p>
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
        </section>

        {/* ============================================================ */}
        {/* ADVANCED · 生コマンド + デバイスログ (Test/デバッグ用)         */}
        {/* ============================================================ */}
        <details className="rounded-xl bg-white shadow-card ring-1 ring-slate-200/60" open>
          <summary className="px-5 py-4 cursor-pointer select-none text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors">
            <span className="inline-flex items-center gap-2">
              <svg className="w-4 h-4 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Advanced · 生コマンド + デバイスログ
            </span>
          </summary>
          <div className="px-5 pb-5 pt-1 space-y-4">
            <CommandPanel
              onSend={sendCommand}
              enabled={status === "open"}
              hint="WebSerial: USB 直結。Python 不要。地上機ペアリングは /mac /setpeer も可"
            />
            <InfoLogPanel logRef={infoLog} tick={infoLogTick} />
          </div>
        </details>

        {/* ============================================================ */}
        {/* FIRMWARE · 書き込み & 機体ペアリング (初回セットアップ)          */}
        {/* ============================================================ */}
        <FirmwarePanel onSend={sendCommand} enabled={status === "open"} />

        <footer className="pt-6 pb-8 text-xs text-slate-500 space-y-2 mt-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>
              <strong className="font-medium text-slate-700">WebSerial</strong> —
              ブラウザから USB を直接掴む (Chrome / Edge のみ、Python 不要)
            </span>
          </div>
          <div className="text-slate-400">
            Numeric ≈60Hz · Charts 5Hz · 3D 60fps · USB direct (Web Serial API)
          </div>
        </footer>
      </div>
    </main>
  );
}
