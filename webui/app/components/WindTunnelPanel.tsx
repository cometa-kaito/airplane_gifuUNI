"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { PHASE_NAMES, type TelemetryFrame } from "../hooks/useTelemetry";

/**
 * Wind Tunnel Panel — 風洞試験用モード（PHASE_WINDTUNNEL = 5）
 *
 * 通常のフェーズマシン (DISARMED → PRELAUNCH → ... → LANDED) には乗らず、
 * 機体を風洞の支柱に固定した状態で PID 応答を測定する用途。
 *
 * 機体側 firmware (`wt` コマンド) の挙動:
 *   - PID 常時 ON (Kp/Ki/Kd は GainPanel で設定したもの)
 *   - effective target_pitch / target_roll はユーザの target[] (本パネルで操作)
 *   - tilt safeguard 抑制（風洞支柱の角度で発火しないように）
 *   - failsafe 抑制（測定中の離席を許容）
 *   - launch_g / climb_ff / 自動 LANDED 検出は すべて無効
 *
 * 使い方:
 *   1. 機体を風洞内に支柱固定（水平 or 任意の取付角）
 *   2. Zero Now でその位置を 0° 基準にする
 *   3. PID Gains を設定（Step 4）
 *   4. このパネルで「Enter Wind Tunnel Mode」
 *   5. target_pitch / target_roll をスイープしながら応答を観察
 *   6. CSV ログから応答プロットを作成
 *   7. 「Exit (Disarm)」で DISARMED に戻る
 */

const STORAGE_KEY = "glider-webui:wt_targets";
const DEFAULT_PITCH = 0.0;
const DEFAULT_ROLL = 0.0;

// プリセット: ステップ応答測定 (±5°/±10° などを一気に設定)
const QUICK_PITCH = [-10, -5, 0, 5, 10];
const QUICK_ROLL = [-10, -5, 0, 5, 10];

export function WindTunnelPanel({
  attitudeRef,
  onSend,
  enabled,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  const [targetPitch, setTargetPitch] = useState<number>(DEFAULT_PITCH);
  const [targetRoll, setTargetRoll] = useState<number>(DEFAULT_ROLL);
  const [appliedPitch, setAppliedPitch] = useState<number>(DEFAULT_PITCH);
  const [appliedRoll, setAppliedRoll] = useState<number>(DEFAULT_ROLL);
  const [busy, setBusy] = useState(false);

  // 現在の phase を state でも保持 (ボタン disable 判定に使う、再レンダが必要)
  // RAF 内では phase 変化時のみ setState する設計で、毎フレーム再レンダを避ける。
  const [currentPhase, setCurrentPhase] = useState<number>(0);
  const lastPhaseSeenRef = useRef<number>(-1);

  // ライブ値の RAF refs
  const phaseRef = useRef<HTMLSpanElement>(null);
  const rollRef = useRef<HTMLSpanElement>(null);
  const pitchRef = useRef<HTMLSpanElement>(null);
  const errPRef = useRef<HTMLSpanElement>(null);
  const errRRef = useRef<HTMLSpanElement>(null);

  const appliedPitchRef = useRef(appliedPitch);
  appliedPitchRef.current = appliedPitch;
  const appliedRollRef = useRef(appliedRoll);
  appliedRollRef.current = appliedRoll;

  // 初期値ロード
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v) {
        const p = JSON.parse(v) as { pitch?: number; roll?: number };
        if (typeof p.pitch === "number" && Number.isFinite(p.pitch)) {
          setTargetPitch(p.pitch);
          setAppliedPitch(p.pitch);
        }
        if (typeof p.roll === "number" && Number.isFinite(p.roll)) {
          setTargetRoll(p.roll);
          setAppliedRoll(p.roll);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // ライブ表示
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const f = attitudeRef.current;
      if (f) {
        const phaseIdx = f.phase ?? 0;
        const phaseName = PHASE_NAMES[phaseIdx] ?? `?${phaseIdx}`;
        if (phaseRef.current) {
          phaseRef.current.textContent = phaseName;
          phaseRef.current.style.color =
            phaseIdx === 5 ? "#7c3aed" : "#64748b";  // violet-600 / slate-500
        }
        // phase が変わったら state を更新してボタン disable を再評価させる
        if (phaseIdx !== lastPhaseSeenRef.current) {
          lastPhaseSeenRef.current = phaseIdx;
          setCurrentPhase(phaseIdx);
        }
        if (rollRef.current) {
          rollRef.current.textContent =
            (f.roll >= 0 ? "+" : "") + f.roll.toFixed(1);
        }
        if (pitchRef.current) {
          pitchRef.current.textContent =
            (f.pitch >= 0 ? "+" : "") + f.pitch.toFixed(1);
        }
        if (errPRef.current) {
          const ep = appliedPitchRef.current - f.pitch;
          errPRef.current.textContent =
            (ep >= 0 ? "+" : "") + ep.toFixed(1);
          errPRef.current.style.color =
            Math.abs(ep) < 1 ? "#22c55e" : Math.abs(ep) < 5 ? "#f59e0b" : "#ef4444";
        }
        if (errRRef.current) {
          const er = appliedRollRef.current - f.roll;
          errRRef.current.textContent =
            (er >= 0 ? "+" : "") + er.toFixed(1);
          errRRef.current.style.color =
            Math.abs(er) < 1 ? "#22c55e" : Math.abs(er) < 5 ? "#f59e0b" : "#ef4444";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [attitudeRef]);

  const persist = useCallback((pitch: number, roll: number) => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ pitch, roll }),
      );
    } catch {
      // ignore
    }
  }, []);

  const sendTargetPitch = useCallback(
    async (v: number) => {
      if (!enabled || busy) return;
      const vv = Math.max(-90, Math.min(90, v));
      setBusy(true);
      try {
        await onSend(`target p ${vv.toFixed(1)}`);
        setAppliedPitch(vv);
        setTargetPitch(vv);
        persist(vv, appliedRollRef.current);
      } catch (e) {
        console.error("[WindTunnelPanel] target p failed:", e);
      } finally {
        setBusy(false);
      }
    },
    [enabled, busy, onSend, persist],
  );

  const sendTargetRoll = useCallback(
    async (v: number) => {
      if (!enabled || busy) return;
      const vv = Math.max(-90, Math.min(90, v));
      setBusy(true);
      try {
        await onSend(`target r ${vv.toFixed(1)}`);
        setAppliedRoll(vv);
        setTargetRoll(vv);
        persist(appliedPitchRef.current, vv);
      } catch (e) {
        console.error("[WindTunnelPanel] target r failed:", e);
      } finally {
        setBusy(false);
      }
    },
    [enabled, busy, onSend, persist],
  );

  const enterWT = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    try {
      // 入る前に現在の target を送り直す（DISARMED の間に変更されていた場合に備え）
      await onSend(`target p ${appliedPitchRef.current.toFixed(1)}`);
      await new Promise((r) => setTimeout(r, 15));
      await onSend(`target r ${appliedRollRef.current.toFixed(1)}`);
      await new Promise((r) => setTimeout(r, 15));
      await onSend("wt");
    } finally {
      setBusy(false);
    }
  }, [enabled, busy, onSend]);

  const exitWT = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    try {
      await onSend("disarm");
    } finally {
      setBusy(false);
    }
  }, [enabled, busy, onSend]);

  const pitchDirty = targetPitch !== appliedPitch;
  const rollDirty = targetRoll !== appliedRoll;

  return (
    <div className="card-pad space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">Wind Tunnel · 風洞試験モード</div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            機体を風洞の支柱に固定して PID 応答を測定。フェーズマシンを介さず PID 常時 ON、
            target_pitch / target_roll を手動操作してステップ応答などを取得。<br />
            <span className="text-glider-ok">
              ✓ servo_out = <strong>Step 0 のサーボトリム</strong> + PID出力。風洞でも trim が GND になります。事前に Step 0 を設定してください。
            </span>
            <br />
            <span className="text-glider-warn">
              ⚠ Wind Tunnel 中は tilt safeguard / failsafe / climb_ff すべて抑制されます。
              地上飛行テストでは使わないでください。
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            Current Phase
          </div>
          <span
            ref={phaseRef}
            className="font-extrabold text-xl tracking-wider"
            style={{ color: "#64748b" }}
          >
            DISARMED
          </span>
        </div>
      </div>

      {/* Enter / Exit (フェーズに応じて disable: WT 中は Enter 無効、それ以外は Exit 無効) */}
      {(() => {
        const inWT = currentPhase === 5;
        const inActiveFlight =
          currentPhase === 1 || currentPhase === 2 || currentPhase === 3;
        // Enter: DISARMED のみ。WT 中は無意味、飛行中は飛行放棄になるため禁止
        const enterDisabled = !enabled || busy || inWT || inActiveFlight;
        const enterTitle = inWT
          ? "すでに WINDTUNNEL モードです"
          : inActiveFlight
            ? "飛行中は使えません (先に Disarm)"
            : "風洞試験モードへ遷移（PID 起動）";
        // Exit: WT 中のみ有効 (他フェーズは LaunchPanel の Disarm を使う)
        const exitDisabled = !enabled || busy || !inWT;
        const exitTitle = inWT
          ? "DISARMED に戻る（PID 停止、target は維持）"
          : "WINDTUNNEL 中のみ使えます";
        return (
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={enterWT}
              disabled={enterDisabled}
              className="btn text-base px-5 py-2.5 font-semibold bg-violet-600 text-white shadow-sm hover:bg-violet-700 active:bg-violet-800"
              title={enterTitle}
            >
              {busy ? "..." : "🌬 Enter Wind Tunnel"}
            </button>
            <button
              onClick={exitWT}
              disabled={exitDisabled}
              className="btn-danger text-base px-5 py-2.5 font-bold"
              title={exitTitle}
            >
              ■ Exit (Disarm)
            </button>
            <div className="text-[11px] text-slate-500 leading-tight">
              機体固定 → Zero → PID 設定 → Enter → target スイープ
            </div>
          </div>
        );
      })()}

      {/* ライブ姿勢 / target / 偏差 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-glider-surface border border-glider-border rounded-md px-3 py-2.5">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-glider-roll font-bold">
            target_roll
          </span>
          <span className="font-mono text-base text-glider-text">
            {(appliedRoll >= 0 ? "+" : "") + appliedRoll.toFixed(1)}°
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-glider-roll font-bold">
            actual_roll
          </span>
          <span className="font-mono text-base text-glider-text">
            <span ref={rollRef}>--</span>°
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-glider-pitch font-bold">
            target_pitch
          </span>
          <span className="font-mono text-base text-glider-text">
            {(appliedPitch >= 0 ? "+" : "") + appliedPitch.toFixed(1)}°
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-glider-pitch font-bold">
            actual_pitch
          </span>
          <span className="font-mono text-base text-glider-text">
            <span ref={pitchRef}>--</span>°
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-glider-roll font-bold">
            err_roll
          </span>
          <span className="font-mono text-base">
            <span ref={errRRef} style={{ color: "#22c55e" }}>--</span>°
          </span>
        </div>
        <div className="flex flex-col col-span-3 md:col-span-1">
          <span className="text-[10px] uppercase tracking-wider text-glider-pitch font-bold">
            err_pitch
          </span>
          <span className="font-mono text-base">
            <span ref={errPRef} style={{ color: "#22c55e" }}>--</span>°
          </span>
        </div>
      </div>

      {/* target_pitch スイープ */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-semibold text-glider-textDim min-w-[90px]">
            target_pitch
          </span>
          <button
            onClick={() => sendTargetPitch(targetPitch - 1)}
            disabled={!enabled || busy || targetPitch <= -90}
            className="bg-glider-surface border border-glider-border rounded
                       text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                       w-6 h-7 text-sm font-bold disabled:opacity-40"
          >−</button>
          <input
            type="number"
            min={-90}
            max={90}
            step={0.5}
            value={targetPitch}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) setTargetPitch(Math.max(-90, Math.min(90, n)));
            }}
            onBlur={() => {
              if (enabled && pitchDirty) sendTargetPitch(targetPitch);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className={`bg-glider-surface border rounded text-center
                        px-2 py-1 w-20 text-sm font-mono font-bold
                        focus:outline-none focus:ring-1 focus:ring-glider-accent/40
                        ${pitchDirty ? "border-glider-warn text-glider-warn" : "border-glider-border text-glider-text"}`}
          />
          <button
            onClick={() => sendTargetPitch(targetPitch + 1)}
            disabled={!enabled || busy || targetPitch >= 90}
            className="bg-glider-surface border border-glider-border rounded
                       text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                       w-6 h-7 text-sm font-bold disabled:opacity-40"
          >+</button>
          <span className="text-[10px] text-glider-textMute">°</span>
          <div className="flex gap-1 flex-wrap ml-2">
            {QUICK_PITCH.map((q) => (
              <button
                key={q}
                onClick={() => sendTargetPitch(q)}
                disabled={!enabled || busy}
                className={`px-2 py-0.5 text-[10px] font-bold rounded border transition ${
                  Math.abs(appliedPitch - q) < 0.01
                    ? "bg-glider-pitch/15 border-glider-pitch text-glider-pitch"
                    : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                }`}
              >
                {q >= 0 ? "+" : ""}{q}°
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-semibold text-glider-textDim min-w-[90px]">
            target_roll
          </span>
          <button
            onClick={() => sendTargetRoll(targetRoll - 1)}
            disabled={!enabled || busy || targetRoll <= -90}
            className="bg-glider-surface border border-glider-border rounded
                       text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                       w-6 h-7 text-sm font-bold disabled:opacity-40"
          >−</button>
          <input
            type="number"
            min={-90}
            max={90}
            step={0.5}
            value={targetRoll}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) setTargetRoll(Math.max(-90, Math.min(90, n)));
            }}
            onBlur={() => {
              if (enabled && rollDirty) sendTargetRoll(targetRoll);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className={`bg-glider-surface border rounded text-center
                        px-2 py-1 w-20 text-sm font-mono font-bold
                        focus:outline-none focus:ring-1 focus:ring-glider-accent/40
                        ${rollDirty ? "border-glider-warn text-glider-warn" : "border-glider-border text-glider-text"}`}
          />
          <button
            onClick={() => sendTargetRoll(targetRoll + 1)}
            disabled={!enabled || busy || targetRoll >= 90}
            className="bg-glider-surface border border-glider-border rounded
                       text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                       w-6 h-7 text-sm font-bold disabled:opacity-40"
          >+</button>
          <span className="text-[10px] text-glider-textMute">°</span>
          <div className="flex gap-1 flex-wrap ml-2">
            {QUICK_ROLL.map((q) => (
              <button
                key={q}
                onClick={() => sendTargetRoll(q)}
                disabled={!enabled || busy}
                className={`px-2 py-0.5 text-[10px] font-bold rounded border transition ${
                  Math.abs(appliedRoll - q) < 0.01
                    ? "bg-glider-roll/15 border-glider-roll text-glider-roll"
                    : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                }`}
              >
                {q >= 0 ? "+" : ""}{q}°
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="text-[10px] text-glider-textMute leading-snug">
        💡 ステップ応答測定の例: 0° → +5° → 0° → -5° → 0° で各 3〜5 秒保持して
        CSV ログから整定時間 / オーバーシュート / 振動を読む。Z-N 法 (PDF 教材) や手動チューニングに。
      </div>
    </div>
  );
}
