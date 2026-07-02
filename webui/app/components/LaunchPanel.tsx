"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { PHASE_NAMES, type TelemetryFrame } from "../hooks/useTelemetry";

/**
 * Launch Panel — Flight Phase Machine の操作と監視 UI
 *
 * 機体側ファーム (glider_nRF52840.ino) のフェーズマシン対応:
 *   DISARMED → (arm) → PRELAUNCH → (|a|>launch_g) → LAUNCH → (climb_ms) → GLIDE → (|az|<landed_g) → LANDED
 *
 * 表示要素:
 *   - 現在フェーズの大きな表示（色分け）
 *   - ライブ |a| バー（しきい値接近を可視化）
 *   - 各種パラメータ:
 *       launch_g, climb_ms, climb_pitch, climb_ff, glide_pitch, landed_g, landed_ms
 *
 * UI 上の判定: テレメトリ frame.phase を信頼する（機体が真の状態）。
 * クライアント側の擬似遷移は廃止（旧版で実装していた overCountRef 廃止）。
 */

// LANDED は手動のみ（`land` コマンド / 🛬 Land ボタン）。
// 飛行中の安定滑空でも |a|≈1g + 一瞬の低 gyro で自動 LANDED が誤発火する
// リスクを完全排除するため、auto-LANDED 系パラメータは UI から削除。
type StoredParams = {
  launch_g: number;
  launch_grace: number;
  climb_ms: number;
  climb_pitch: number;
  climb_ff: number;
  glide_pitch: number;
};

const DEFAULTS: StoredParams = {
  launch_g: 2.5,
  launch_grace: 500,
  climb_ms: 1500,
  climb_pitch: 15,
  climb_ff: 5,
  glide_pitch: 3,
};

const STORAGE_KEY = "glider-webui:phase_params";

const LAUNCH_G_PRESETS = [
  { value: 1.8, label: "1.8g", hint: "弱投擲（軽く放る）" },
  { value: 2.5, label: "2.5g", hint: "標準（既定）" },
  { value: 3.5, label: "3.5g", hint: "強投擲（しっかり投げる）" },
];

// 投擲直後にエレベータを何度上げるか (feed-forward)。LAUNCH フェーズ全体で加算される。
const CLIMB_FF_PRESETS = [
  { value: 0, label: "0° なし", hint: "機首上げ補助なし (PID のみ)" },
  { value: 3, label: "+3° 弱", hint: "軽い機首上げ" },
  { value: 5, label: "+5° 標準", hint: "既定値" },
  { value: 10, label: "+10° 強", hint: "強い機首上げ (失速に注意)" },
];

const PHASE_COLORS: Record<number, string> = {
  0: "#64748b",   // DISARMED   slate-500
  1: "#d97706",   // PRELAUNCH  amber-600
  2: "#dc2626",   // LAUNCH     red-600
  3: "#059669",   // GLIDE      emerald-600
  4: "#2563eb",   // LANDED     blue-600
  5: "#7c3aed",   // WINDTUNNEL violet-600
};

const PHASE_DESC: Record<number, string> = {
  0: "待機中 (地上テスト or 飛行終了後)。failsafe 有効。Arm で PRELAUNCH に遷移、Wind Tunnel で WT へ。",
  1: "投擲待機中。|a| が launch_g を連続超過したら LAUNCH に自動遷移。",
  2: "上昇 (climb-out)。最初の数百 ms は PID ゼロホールド、その後 climb_pitch を目標に制御。",
  3: "滑空中。glide_pitch を目標に PID 制御。手動で 🛬 Land を押すと飛行終了。",
  4: "(旧フェーズ。新 firmware では DISARMED に統合)",
  5: "風洞試験中。PID 常時稼働 / target 手動 / tilt safeguard・failsafe・climb_ff すべて抑制。",
};

export function LaunchPanel({
  attitudeRef,
  onSend,
  enabled,
  recording = false,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
  /** テレメトリ記録中か (飛行中は page 側が自動で記録を開始する)。 */
  recording?: boolean;
}) {
  const [params, setParams] = useState<StoredParams>(DEFAULTS);
  const [applied, setApplied] = useState<StoredParams>(DEFAULTS);
  const [busy, setBusy] = useState(false);

  // 現在の phase を state で持つ (ボタン disable 判定用、再レンダが必要)。
  // RAF 内で phase 変化時のみ setState する。
  const [currentPhase, setCurrentPhase] = useState<number>(0);

  // ライブ表示の RAF refs
  const phaseLabelRef = useRef<HTMLSpanElement>(null);
  const phaseDescRef = useRef<HTMLDivElement>(null);
  const aMagRef = useRef<HTMLSpanElement>(null);
  const aBarRef = useRef<HTMLDivElement>(null);
  const aMsgRef = useRef<HTMLDivElement>(null);
  const phaseAgeRef = useRef<HTMLSpanElement>(null);

  // 直近の phase 遷移時刻 (UI 上での表示用)
  const lastPhaseRef = useRef<number>(-1);
  const lastPhaseAtRef = useRef<number>(Date.now());

  const launchGAppliedRef = useRef<number>(applied.launch_g);
  launchGAppliedRef.current = applied.launch_g;

  // 初期値ロード
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v) {
        const parsed = JSON.parse(v) as Partial<StoredParams>;
        const next = { ...DEFAULTS };
        for (const k of Object.keys(next) as (keyof StoredParams)[]) {
          const n = parsed[k];
          if (typeof n === "number" && Number.isFinite(n)) {
            next[k] = n;
          }
        }
        setParams(next);
        setApplied(next);
      }
    } catch {
      // ignore
    }
  }, []);

  // 接続時にパラメータを機体へ自動同期 (armed 状態は同期しない)
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      autoSyncedRef.current = false;
      return;
    }
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    (async () => {
      try {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        await onSend(`launch_g ${applied.launch_g.toFixed(2)}`); await sleep(15);
        await onSend(`climb_ms ${Math.round(applied.climb_ms)}`); await sleep(15);
        await onSend(`climb_pitch ${applied.climb_pitch.toFixed(1)}`); await sleep(15);
        await onSend(`climb_ff ${applied.climb_ff.toFixed(1)}`); await sleep(15);
        await onSend(`glide_pitch ${applied.glide_pitch.toFixed(1)}`);
        // launch_grace は 2026-07 以降のファームのみ対応。既定値 (500) のままなら
        // 送信不要なので、旧ファームで「未達コマンド」警告を出さないよう変更時のみ送る。
        if (applied.launch_grace !== DEFAULTS.launch_grace) {
          await sleep(15);
          await onSend(`launch_grace ${Math.round(applied.launch_grace)}`);
        }
      } catch {
        autoSyncedRef.current = false;
      }
    })();
  }, [enabled, applied, onSend]);

  // 1 個ずつ送信して applied を更新する汎用ハンドラ
  const sendOne = useCallback(
    async (cmd: string, key: keyof StoredParams, value: number) => {
      if (!enabled) {
        setParams((p) => ({ ...p, [key]: value }));
        return;
      }
      setBusy(true);
      try {
        await onSend(`${cmd} ${value}`);
        setParams((p) => {
          const next = { ...p, [key]: value };
          setApplied((a) => {
            const a2 = { ...a, [key]: value };
            try {
              window.localStorage.setItem(STORAGE_KEY, JSON.stringify(a2));
            } catch {
              // ignore
            }
            return a2;
          });
          return next;
        });
      } catch (e) {
        console.error("[LaunchPanel]", cmd, "failed:", e);
      } finally {
        setBusy(false);
      }
    },
    [enabled, onSend],
  );

  // ライブ更新ループ
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const f = attitudeRef.current;
      if (f) {
        const phase = f.phase ?? 0;
        const aMag =
          f.accel_g ?? Math.sqrt(f.ax * f.ax + f.ay * f.ay + f.az * f.az);

        // 大きなフェーズ表示 (テキストシャドウは使わない、色のみで識別)
        if (phaseLabelRef.current) {
          const name = PHASE_NAMES[phase] ?? `?${phase}`;
          if (phaseLabelRef.current.textContent !== name) {
            phaseLabelRef.current.textContent = name;
            phaseLabelRef.current.style.color = PHASE_COLORS[phase] ?? "#1e293b";
          }
        }
        if (phaseDescRef.current) {
          const desc = PHASE_DESC[phase] ?? "";
          if (phaseDescRef.current.textContent !== desc) {
            phaseDescRef.current.textContent = desc;
          }
        }

        // フェーズ遷移時刻のトラッキング (state も合わせて更新 → ボタン disable 再評価)
        if (phase !== lastPhaseRef.current) {
          lastPhaseRef.current = phase;
          lastPhaseAtRef.current = Date.now();
          setCurrentPhase(phase);
        }
        if (phaseAgeRef.current) {
          const dt = Date.now() - lastPhaseAtRef.current;
          phaseAgeRef.current.textContent =
            dt < 60000 ? `${(dt / 1000).toFixed(1)}s` : `${Math.floor(dt / 60000)}m`;
        }

        // |a| バー
        const thr = launchGAppliedRef.current;
        if (aMagRef.current) aMagRef.current.textContent = aMag.toFixed(2);
        if (aBarRef.current) {
          const pct = Math.min(100, (aMag / (thr * 1.5)) * 100);
          aBarRef.current.style.width = `${pct}%`;
          let color = "#22c55e";
          if (aMag >= thr) color = "#ef4444";
          else if (aMag > thr * 0.7) color = "#f59e0b";
          aBarRef.current.style.background = color;
        }
        if (aMsgRef.current) {
          let msg = "";
          let color = "#64748b";
          if (phase === 0) {
            msg = "DISARMED — Arm を押して投擲待機に入る";
          } else if (phase === 1) {
            if (aMag >= thr) {
              msg = `⚡ Over threshold (${aMag.toFixed(2)}g ≥ ${thr.toFixed(2)}g)`;
              color = "#ef4444";
            } else if (aMag > thr * 0.7) {
              msg = `⚠ Approaching (${((aMag / thr) * 100).toFixed(0)}%)`;
              color = "#f59e0b";
            } else {
              msg = "Waiting for throw...";
              color = "#22c55e";
            }
          } else if (phase === 2) {
            msg = "✈ LAUNCH 中 (climb-out)";
            color = "#ef4444";
          } else if (phase === 3) {
            msg = "✓ GLIDE 中 (滑空 PID 制御)";
            color = "#22c55e";
          } else if (phase === 5) {
            msg = "🌬 WINDTUNNEL 中 (target スイープ可)";
            color = "#7c3aed";
          }
          // phase === 4 (旧 LANDED) は DISARMED に統合済のため到達しない
          aMsgRef.current.textContent = msg;
          aMsgRef.current.style.color = color;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [attitudeRef]);

  const doArm = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    try {
      await onSend("arm");
    } finally {
      setBusy(false);
    }
  }, [enabled, busy, onSend]);

  const doDisarm = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    try {
      await onSend("disarm");
    } finally {
      setBusy(false);
    }
  }, [enabled, busy, onSend]);

  // 強制 LANDED 遷移（GLIDE で自動検出が起こらない場合のエスケープ）
  const doLand = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    try {
      await onSend("land");
    } finally {
      setBusy(false);
    }
  }, [enabled, busy, onSend]);

  // 数値スピナー UI 部品
  const numInput = (
    key: keyof StoredParams,
    label: string,
    suffix: string,
    cmd: string,
    min: number,
    max: number,
    step: number,
    decimals: number,
    hint?: string,
  ) => {
    const cur = params[key];
    const ap = applied[key];
    const dirty = cur !== ap;
    return (
      <div key={key} className="flex flex-col gap-0.5">
        <label className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
          {label}
          {hint && (
            <span className="ml-1 normal-case font-normal text-glider-textMute/70">
              ({hint})
            </span>
          )}
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const next = Math.max(min, Math.min(max, cur - step));
              if (enabled) sendOne(cmd, key, parseFloat(next.toFixed(decimals)));
              else setParams((p) => ({ ...p, [key]: next }));
            }}
            disabled={busy || cur <= min}
            className="bg-glider-surface border border-glider-border rounded
                       text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                       w-6 h-7 text-sm font-bold disabled:opacity-40"
            tabIndex={-1}
          >
            −
          </button>
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={cur}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n))
                setParams((p) => ({ ...p, [key]: Math.max(min, Math.min(max, n)) }));
            }}
            onBlur={() => {
              if (enabled && cur !== ap) sendOne(cmd, key, parseFloat(cur.toFixed(decimals)));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className={`bg-glider-surface border rounded text-center
                        px-2 py-1 w-20 text-xs font-mono
                        focus:outline-none focus:ring-1 focus:ring-glider-accent/40
                        ${dirty ? "border-glider-warn text-glider-warn" : "border-glider-border text-glider-text"}`}
          />
          <button
            type="button"
            onClick={() => {
              const next = Math.max(min, Math.min(max, cur + step));
              if (enabled) sendOne(cmd, key, parseFloat(next.toFixed(decimals)));
              else setParams((p) => ({ ...p, [key]: next }));
            }}
            disabled={busy || cur >= max}
            className="bg-glider-surface border border-glider-border rounded
                       text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                       w-6 h-7 text-sm font-bold disabled:opacity-40"
            tabIndex={-1}
          >
            +
          </button>
          <span className="text-[10px] text-glider-textMute">{suffix}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="card-pad space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">Launch · Flight Phase Machine</div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            機体側のフェーズマシン (DISARMED→PRELAUNCH→LAUNCH→GLIDE→LANDED) を操作・監視。
            Arm 後の遷移はすべて機体側で自動。armed 中 (DISARMED 以外) は failsafe 抑制。
            <br />
            <span className="text-glider-ok">
              ⏺ Arm すると自動でテレメトリ記録が始まり、Land / Disarm の 2 秒後に保存されます
              (In-flight / Post-flight の Recorder から CSV 取得)。
            </span>
          </div>
        </div>
        <div className="text-right">
          {recording && (
            <div className="inline-flex items-center gap-1.5 mb-1 px-2 py-0.5 rounded bg-glider-err/10 ring-1 ring-glider-err/30">
              <span className="w-2 h-2 rounded-full bg-glider-err animate-pulseWarn" aria-hidden />
              <span className="text-[10px] font-bold tracking-wider text-glider-err">REC</span>
            </div>
          )}
          <div className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            Current Phase
          </div>
          <div className="leading-tight mt-0.5">
            <span
              ref={phaseLabelRef}
              className="font-extrabold text-2xl tracking-wider"
              style={{ color: "#64748b" }}
            >
              DISARMED
            </span>
          </div>
          <div className="text-[10px] text-glider-textMute mt-0.5">
            in <span ref={phaseAgeRef} className="font-mono">0.0s</span>
          </div>
        </div>
      </div>

      <div
        ref={phaseDescRef}
        className="text-[11px] text-glider-textDim bg-glider-surface border border-glider-border/50 rounded px-3 py-2 font-mono leading-relaxed"
      >
        {PHASE_DESC[0]}
      </div>

      {/* Arm / Land / Disarm — フェーズ依存で disable して誤操作を防止 */}
      {(() => {
        // Arm: DISARMED からのみ (LANDED は DISARMED に統合済)。
        //   飛行中 / WT 中は禁止 (現在の飛行をリセットする事故防止)
        const armEnabled = enabled && !busy && currentPhase === 0;
        // Land: LAUNCH または GLIDE のみ。それ以外では意味がない (PRELAUNCH なら Disarm 推奨)
        const landEnabled = enabled && !busy && (currentPhase === 2 || currentPhase === 3);
        // Disarm: DISARMED 以外 (常に安全脱出として使える、trim は維持される)
        const disarmEnabled = enabled && !busy && currentPhase !== 0;

        const armTitle =
          currentPhase === 1 ? "すでに PRELAUNCH (Arm 済み)"
          : currentPhase === 2 ? "LAUNCH 中 (再 Arm は飛行リセットになるため禁止)"
          : currentPhase === 3 ? "GLIDE 中 (再 Arm は飛行リセットになるため禁止)"
          : currentPhase === 5 ? "WINDTUNNEL 中 (先に Exit してから)"
          : "PRELAUNCH へ遷移し、投擲を待機する";
        const landTitle =
          currentPhase === 0
            ? "LAUNCH / GLIDE 中のみ使えます"
          : currentPhase === 1 ? "PRELAUNCH では Disarm を使ってください"
          : currentPhase === 5 ? "WINDTUNNEL では Exit / Disarm を使ってください"
          : "飛行終了: trim を 0 にリセットして DISARMED に戻る";
        const disarmTitle =
          currentPhase === 0
            ? "すでに DISARMED 状態です"
            : "DISARMED に戻す (trim は維持) — 中止 / 緊急脱出";

        return (
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={doArm}
              disabled={!armEnabled}
              className="btn-primary text-base px-5 py-2.5 font-semibold"
              title={armTitle}
            >
              {busy ? "..." : "🚀 Arm"}
            </button>
            <button
              onClick={doLand}
              disabled={!landEnabled}
              className="btn text-base px-5 py-2.5 font-semibold bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-300 disabled:text-slate-500"
              title={landTitle}
            >
              🛬 Land
            </button>
            <button
              onClick={doDisarm}
              disabled={!disarmEnabled}
              className="btn-danger text-base px-5 py-2.5 font-semibold"
              title={disarmTitle}
            >
              ■ Disarm
            </button>
            <div className="text-xs text-slate-500 leading-tight">
              Step 1〜4 完了後 → Arm → 投擲。着地は手動で Land → Disarm。
            </div>
          </div>
        );
      })()}

      {/* ライブ |a| 表示 */}
      <div className="space-y-1 pt-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-glider-textMute">
            <code className="font-mono text-glider-textDim">|a|</code> (telemetry)
          </span>
          <span className="font-mono">
            <span ref={aMagRef} className="text-glider-text font-bold text-lg">
              --
            </span>
            <span className="text-glider-textMute">
              g / {applied.launch_g.toFixed(2)}g
            </span>
          </span>
        </div>
        <div className="h-3 bg-glider-surface border border-glider-border rounded-full overflow-hidden relative">
          <div
            ref={aBarRef}
            className="h-full transition-[width] duration-75"
            style={{ width: "0%", background: "#22c55e" }}
          />
          <div
            className="absolute top-0 bottom-0 w-px bg-glider-warn/60 pointer-events-none"
            style={{ left: `${(1 / 1.5) * 100}%` }}
            title="trigger threshold"
          />
        </div>
        <div
          ref={aMsgRef}
          className="text-[11px] font-semibold min-h-[1em]"
          style={{ color: "#64748b" }}
        >
          --
        </div>
      </div>

      {/* launch_g preset 行 (+微調整スピナー) */}
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            launch_g preset
          </span>
          {LAUNCH_G_PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => sendOne("launch_g", "launch_g", p.value)}
              disabled={!enabled || busy}
              title={p.hint}
              className={`px-2.5 py-1 text-xs font-bold rounded-md border transition ${
                Math.abs(applied.launch_g - p.value) < 0.01
                  ? "bg-glider-accent/15 border-glider-accent text-glider-accent"
                  : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {numInput("launch_g", "微調整", "g", "launch_g", 1.0, 8.0, 0.1, 2)}
      </div>

      {/* ============ 投擲直後の機首上げ (Climb-out) ============ */}
      <div className="border-t border-glider-border/50 pt-3 space-y-2">
        <div className="text-[12px] uppercase tracking-wider font-semibold text-glider-textDim">
          ✈ 投擲直後の機首上げ (Climb-out)
        </div>
        <div className="text-[11px] text-glider-textDim bg-glider-surface border border-glider-border/50 rounded px-3 py-2 leading-relaxed">
          投擲を検知すると、まず <strong>launch_grace</strong> の間は PID を止めてエレベータを{" "}
          <strong>climb_ff</strong> 分だけ上げて保持します (姿勢推定の復帰待ち)。
          その後 <strong>climb_pitch</strong> を目標に PID + climb_ff で上昇し、
          <strong>climb_ms</strong> 経過で GLIDE (巡航) に移ります。
          <br />
          <span className="text-glider-textMute">
            💡 機首上げが強すぎて宙返り気味 → climb_ff を下げる / 上昇が足りず沈む → climb_ff を上げる。
          </span>
        </div>

        {/* climb_ff プリセット (最重要ノブなのでワンタップで変更可能に) */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            エレベータ上げ量 (climb_ff)
          </span>
          {CLIMB_FF_PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => sendOne("climb_ff", "climb_ff", p.value)}
              disabled={!enabled || busy}
              title={p.hint}
              className={`px-2.5 py-1 text-xs font-bold rounded-md border transition ${
                Math.abs(applied.climb_ff - p.value) < 0.01
                  ? "bg-glider-accent/15 border-glider-accent text-glider-accent"
                  : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1 pb-1">
          {numInput("climb_ff", "climb_ff", "deg", "climb_ff", -30, 30, 1, 1, "エレベータ上げ量")}
          {numInput("climb_pitch", "climb_pitch", "deg", "climb_pitch", -45, 60, 1, 1, "上昇目標角")}
          {numInput("climb_ms", "climb_ms", "ms", "climb_ms", 200, 10000, 100, 0, "上昇時間")}
          {numInput("launch_grace", "launch_grace", "ms", "launch_grace", 0, 5000, 100, 0, "PID 停止保持")}
        </div>
        <div className="text-[10px] text-glider-textMute leading-snug">
          ⚠ <strong>launch_grace</strong> の変更は 2026-07 以降の機体ファーム (nRF52840) が必要です
          (旧ファームでは無視され、既定 500ms で動作)。他の項目は旧ファームでも調整できます。
        </div>
      </div>

      {/* ============ 滑空 (GLIDE) ============ */}
      <div className="border-t border-glider-border/50 pt-3 space-y-1">
        <div className="text-[12px] uppercase tracking-wider font-semibold text-glider-textDim">
          🕊 滑空 (Glide)
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1 pb-1">
          {numInput("glide_pitch", "glide_pitch", "deg", "glide_pitch", -20, 30, 0.5, 1, "滑空目標角")}
        </div>
        <div className="text-[10px] text-glider-textMute leading-snug">
          ※ <strong>LANDED は手動のみ</strong>。GLIDE フェーズから抜けるには 🛬 Land ボタンか Disarm を押してください。
          安定滑空中の |a|≈1g で誤発火するリスクを完全排除するため、auto-LANDED 検出は実装していません。
        </div>
      </div>
    </div>
  );
}
