"use client";

import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { PHASE_NAMES, type TelemetryFrame } from "../hooks/useTelemetry";
import {
  useAutoTune,
  DEFAULT_CONFIG,
  ZN_RULES,
  type AutoTuneAxis,
  type AutoTuneConfig,
  type AutoTuneState,
  type ZNRule,
} from "../hooks/useAutoTune";

/**
 * AutoTunePanel — Full Auto Tune (PID ゲイン自動調整)
 *
 * 既存の GainPanel (手動) / WindTunnelPanel (手動スイープ) とは独立した
 * 「全自動」モード。Ziegler-Nichols 限界感度法を WebUI 側で自動実行する:
 *   Kp を自動で上げて発振 (極限ゲイン Ku) を探し、周期 Tu を測り、Z-N 式で
 *   Kp/Ki/Kd を算出して自動適用する。
 *
 *   ⚠ 風洞 (Wind Tunnel) 専用。気流が無いと舵が機体を動かせず測定が成立しない。
 *   ⚠ 故意に発振近傍まで攻めるため、必ず機体を支柱固定し、人が監視すること。
 *
 * 手順: 機体を風洞固定 → Zero Now (Step 1) → 軸/規則を選ぶ → Start Auto Tune。
 */

const RUNNING_STATES: AutoTuneState[] = [
  "preparing",
  "settling",
  "kicking",
  "recording",
  "analyzing",
];

const STATE_LABEL: Record<AutoTuneState, string> = {
  idle: "待機",
  preparing: "準備",
  settling: "整定待ち",
  kicking: "励振",
  recording: "応答測定",
  analyzing: "解析",
  done: "完了",
  aborted: "中断",
  failed: "失敗",
};

const STATE_COLOR: Record<AutoTuneState, string> = {
  idle: "#64748b",
  preparing: "#6366f1",
  settling: "#6366f1",
  kicking: "#f59e0b",
  recording: "#0ea5e9",
  analyzing: "#8b5cf6",
  done: "#22c55e",
  aborted: "#ef4444",
  failed: "#ef4444",
};

const SPARK_N = 160;

export function AutoTunePanel({
  attitudeRef,
  onSend,
  enabled,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  const tuner = useAutoTune(onSend, attitudeRef, enabled);
  const isRunning = RUNNING_STATES.includes(tuner.state);

  // --- 設定 (config) ---
  const [axisSel, setAxisSel] = useState<"r" | "p" | "rp">("r");
  const [rule, setRule] = useState<ZNRule>("classic");
  const [kickDeg, setKickDeg] = useState<number>(DEFAULT_CONFIG.kickDeg);
  const [kpMax, setKpMax] = useState<number>(DEFAULT_CONFIG.kpMax);
  const [safeAngle, setSafeAngle] = useState<number>(DEFAULT_CONFIG.safeAngleDeg);

  // --- ライブ表示 (rAF) ---
  const phaseRef = useRef<HTMLSpanElement>(null);
  const rollRef = useRef<HTMLSpanElement>(null);
  const pitchRef = useRef<HTMLSpanElement>(null);
  const sparkRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<number[]>([]);
  const lastSeqRef = useRef<number>(-1);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const f = attitudeRef.current;
      if (f) {
        const pn = PHASE_NAMES[f.phase ?? 0] ?? `?${f.phase}`;
        if (phaseRef.current) {
          phaseRef.current.textContent = pn;
          phaseRef.current.style.color = f.phase === 5 ? "#7c3aed" : "#64748b";
        }
        if (rollRef.current)
          rollRef.current.textContent = (f.roll >= 0 ? "+" : "") + f.roll.toFixed(1);
        if (pitchRef.current)
          pitchRef.current.textContent = (f.pitch >= 0 ? "+" : "") + f.pitch.toFixed(1);

        // スパークライン: 解析対象軸の値をリングバッファに
        if (f.seq !== lastSeqRef.current) {
          lastSeqRef.current = f.seq;
          const v = axisSel === "p" ? f.pitch : f.roll;
          const ring = ringRef.current;
          ring.push(v);
          if (ring.length > SPARK_N) ring.shift();
          if (sparkRef.current) sparkRef.current.innerHTML = renderSpark(ring);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [attitudeRef, axisSel]);

  const startTune = () => {
    const axes: AutoTuneAxis[] = axisSel === "rp" ? ["r", "p"] : [axisSel];
    const cfg: AutoTuneConfig = {
      ...DEFAULT_CONFIG,
      axes,
      rule,
      kickDeg,
      kpMax,
      safeAngleDeg: safeAngle,
    };
    ringRef.current = [];
    tuner.start(cfg);
  };

  const live = tuner.live;

  return (
    <div className="card-pad space-y-3">
      {/* ヘッダ */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">Full Auto Tune · PID 自動調整 (Z-N 限界感度法)</div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            Kp を自動で上げて発振点 (極限ゲイン Ku) を探し、周期 Tu から Ziegler-Nichols 式で
            Kp/Ki/Kd を算出し<strong>自動適用</strong>します。GainPanel / Wind Tunnel とは独立した全自動モード。
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            Phase
          </div>
          <span ref={phaseRef} className="font-extrabold text-lg tracking-wider" style={{ color: "#64748b" }}>
            DISARMED
          </span>
        </div>
      </div>

      {/* 安全注意 */}
      <div className="text-[11px] leading-snug rounded-md border border-amber-300 bg-amber-50 text-amber-800 px-3 py-2">
        <strong>⚠ 風洞専用・故意に発振させます。</strong>
        必ず ① 機体を風洞支柱に固定 ② 気流ON ③ Step 1 で <strong>Zero Now</strong> 済み ④ 人が監視、の状態で実行してください。
        |角度偏差| が <strong>{safeAngle}°</strong> を超えると自動で中断し、ゲインを開始前に戻します。
        Wind Tunnel 中はファーム側 tilt safeguard が効かないため、この画面が唯一の安全網です。
      </div>

      {/* 設定 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* 軸 */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            対象軸
          </label>
          <div className="flex gap-1">
            {([
              { k: "r", label: "Roll" },
              { k: "p", label: "Pitch" },
              { k: "rp", label: "両方" },
            ] as const).map((o) => (
              <button
                key={o.k}
                onClick={() => setAxisSel(o.k)}
                disabled={isRunning}
                className={`flex-1 px-2 py-1.5 text-xs font-bold rounded-md border transition ${
                  axisSel === o.k
                    ? "bg-glider-accent/15 border-glider-accent text-glider-accent"
                    : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                } disabled:opacity-40`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Z-N 規則 */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            Z-N 規則
          </label>
          <select
            value={rule}
            onChange={(e) => setRule(e.target.value as ZNRule)}
            disabled={isRunning}
            title={ZN_RULES.find((r) => r.key === rule)?.hint}
            className="bg-glider-surface border border-glider-border rounded px-2 py-1.5 text-xs font-mono
                       text-glider-text focus:outline-none focus:ring-1 focus:ring-glider-accent/40 disabled:opacity-40"
          >
            {ZN_RULES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* キック量 */}
        <NumberField
          label="キック量 °"
          value={kickDeg}
          min={2}
          max={20}
          step={1}
          disabled={isRunning}
          onChange={setKickDeg}
        />

        {/* Kp 上限 */}
        <NumberField
          label="Kp 上限"
          value={kpMax}
          min={2}
          max={10}
          step={0.5}
          disabled={isRunning}
          onChange={setKpMax}
        />
      </div>

      {/* 実行 / 停止 */}
      <div className="flex items-center gap-3 flex-wrap">
        {!isRunning ? (
          <button
            onClick={startTune}
            disabled={!enabled}
            className="btn text-base px-5 py-2.5 font-semibold bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-40"
            title={enabled ? "自動チューニング開始 (wt 投入 → Kp スイープ)" : "未接続"}
          >
            ▶ Start Auto Tune
          </button>
        ) : (
          <button
            onClick={tuner.stop}
            className="btn-danger text-base px-5 py-2.5 font-bold"
            title="即中断し、ゲインを開始前へ戻す"
          >
            ■ STOP
          </button>
        )}

        {/* 安全しきい値 (実行中も変更不可で表示) */}
        <NumberField
          label="中断角 °"
          value={safeAngle}
          min={10}
          max={80}
          step={5}
          disabled={isRunning}
          onChange={setSafeAngle}
          compact
        />

        {tuner.canRevert && !isRunning && (
          <button
            onClick={tuner.revert}
            className="btn-ghost text-xs"
            title="適用したゲインを開始前の値へ戻す"
          >
            ↺ 適用前に戻す
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span
            className="text-[11px] font-bold px-2.5 py-1 rounded"
            style={{ color: STATE_COLOR[tuner.state], background: `${STATE_COLOR[tuner.state]}1a` }}
          >
            {STATE_LABEL[tuner.state]}
          </span>
        </div>
      </div>

      {/* ライブ計測 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 bg-glider-surface border border-glider-border rounded-md px-3 py-2.5">
        <LiveStat label="試行 Kp" value={live.kp > 0 ? live.kp.toFixed(2) : "--"} />
        <LiveStat
          label="振幅 p2p"
          value={live.amplitude > 0 ? `${live.amplitude.toFixed(1)}°` : "--"}
        />
        <LiveStat
          label="周期 Tu"
          value={live.periodSec > 0 ? `${live.periodSec.toFixed(2)}s` : "--"}
        />
        <LiveStat
          label="減衰比"
          value={live.decayRatio > 0 ? live.decayRatio.toFixed(2) : "--"}
          hint="1.0 ≈ 持続振動 (Ku)"
        />
        <LiveStat label="step" value={live.stepIndex > 0 ? String(live.stepIndex) : "--"} />
      </div>

      {/* 現在姿勢 + スパークライン */}
      <div className="flex items-center gap-4 flex-wrap bg-glider-surface border border-glider-border rounded-md px-3 py-2.5">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-glider-roll font-bold">roll</span>
          <span className="font-mono text-base text-glider-text">
            <span ref={rollRef}>--</span>°
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-glider-pitch font-bold">pitch</span>
          <span className="font-mono text-base text-glider-text">
            <span ref={pitchRef}>--</span>°
          </span>
        </div>
        <div className="flex-1 min-w-[160px]">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            {axisSel === "p" ? "pitch" : "roll"} 応答
          </span>
          <div ref={sparkRef} className="h-10 w-full" />
        </div>
      </div>

      {/* メッセージ */}
      {live.message && (
        <div className="text-[12px] font-mono text-glider-textDim bg-glider-panelHi/40 rounded px-3 py-2">
          {live.message}
        </div>
      )}

      {/* 結果 */}
      {tuner.results.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-glider-textMute font-semibold">
            結果 (適用済み)
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-glider-textMute">
                  <th className="text-left py-1 pr-3">軸</th>
                  <th className="text-right py-1 px-2">Ku</th>
                  <th className="text-right py-1 px-2">Tu [s]</th>
                  <th className="text-right py-1 px-2">Kp</th>
                  <th className="text-right py-1 px-2">Ki</th>
                  <th className="text-right py-1 px-2">Kd</th>
                  <th className="text-left py-1 pl-2">規則</th>
                </tr>
              </thead>
              <tbody>
                {tuner.results.map((r) => (
                  <tr key={r.axis} className="border-t border-glider-border/40">
                    <td className="py-1.5 pr-3 font-bold" style={{ color: r.axis === "r" ? "#ff5d6c" : "#3ddc97" }}>
                      {r.axis === "r" ? "roll" : "pitch"}
                    </td>
                    <td className="py-1.5 px-2 text-right text-glider-text">{r.Ku.toFixed(3)}</td>
                    <td className="py-1.5 px-2 text-right text-glider-text">{r.Tu.toFixed(3)}</td>
                    <td className="py-1.5 px-2 text-right text-glider-accent font-bold">{r.gains.Kp.toFixed(3)}</td>
                    <td className="py-1.5 px-2 text-right text-glider-accent font-bold">{r.gains.Ki.toFixed(3)}</td>
                    <td className="py-1.5 px-2 text-right text-glider-accent font-bold">{r.gains.Kd.toFixed(3)}</td>
                    <td className="py-1.5 pl-2 text-glider-textDim">
                      {ZN_RULES.find((x) => x.key === r.rule)?.label}
                      {r.clamped && <span className="text-glider-warn"> *clamped</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-glider-textMute leading-snug">
            ✓ 機体 (RAM) と GainPanel の保存値 (localStorage) の両方へ反映済み。GainPanel 表示は再読込で同期します。<br />
            応答を必ず確認し、行き過ぎが大きければ「No Overshoot」規則で再実行、または GainPanel で微調整してください。
          </div>
        </div>
      )}

      <div className="text-[10px] text-glider-textMute leading-snug">
        💡 仕組み: 各 Kp で target を一瞬 ±{kickDeg}° 振って (キック) 応答を録り、振幅・周期・減衰比を解析。
        減衰比が約 1 (= 持続振動) になった Kp を Ku、その周期を Tu として Z-N 式 (PDF 教材) で PID を決めます。
      </div>
    </div>
  );
}

/* ---------- 小物 ---------- */

function NumberField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
  compact,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
        {label}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        className={`bg-glider-surface border border-glider-border rounded text-center px-2 py-1.5 font-mono
                    text-glider-text focus:outline-none focus:ring-1 focus:ring-glider-accent/40
                    disabled:opacity-40 ${compact ? "w-20 text-xs" : "text-sm"}`}
      />
    </div>
  );
}

function LiveStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col" title={hint}>
      <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
        {label}
      </span>
      <span className="font-mono text-base text-glider-text">{value}</span>
    </div>
  );
}

/** リングバッファを正規化して inline SVG の折れ線にする (依存無しの軽量スパークライン) */
function renderSpark(ring: number[]): string {
  if (ring.length < 2) return "";
  let mn = Infinity,
    mx = -Infinity;
  for (const v of ring) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const pad = 2;
  const W = 100,
    H = 28;
  const span = mx - mn || 1;
  const pts = ring
    .map((v, i) => {
      const x = (i / (ring.length - 1)) * (W - pad * 2) + pad;
      const y = H - pad - ((v - mn) / span) * (H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  // baseline (mean) ライン
  const mean = ring.reduce((s, v) => s + v, 0) / ring.length;
  const yb = H - pad - ((mean - mn) / span) * (H - pad * 2);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="100%">
    <line x1="0" y1="${yb.toFixed(1)}" x2="${W}" y2="${yb.toFixed(1)}" stroke="#cbd5e1" stroke-width="0.5" stroke-dasharray="2 2"/>
    <polyline points="${pts}" fill="none" stroke="#6366f1" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
