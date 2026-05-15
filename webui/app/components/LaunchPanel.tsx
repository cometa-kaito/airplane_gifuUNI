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

type StoredParams = {
  launch_g: number;
  climb_ms: number;
  climb_pitch: number;
  climb_ff: number;
  glide_pitch: number;
  landed_g: number;        // ||a|-1g| 許容偏差 (旧: |az|<th。意味が変わった点に注意)
  landed_gyro: number;     // 角速度しきい値 [deg/s]
  landed_ms: number;
  glide_timeout: number;   // GLIDE 強制 LANDED タイムアウト [ms]、0 で無効
};

const DEFAULTS: StoredParams = {
  launch_g: 2.5,
  climb_ms: 1500,
  climb_pitch: 15,
  climb_ff: 5,
  glide_pitch: 3,
  landed_g: 0.15,           // 新セマンティクスでの既定（旧 0.3 を更新）
  landed_gyro: 15,          // LSM6DS3 のバイアス+ノイズを呑み込める実用値 (旧 5 だと机置きで未発火)
  landed_ms: 1000,
  glide_timeout: 20000,
};

const STORAGE_KEY = "glider-webui:phase_params";

const LAUNCH_G_PRESETS = [
  { value: 1.8, label: "1.8g", hint: "弱投擲（軽く放る）" },
  { value: 2.5, label: "2.5g", hint: "標準（既定）" },
  { value: 3.5, label: "3.5g", hint: "強投擲（しっかり投げる）" },
];

const PHASE_COLORS: Record<number, string> = {
  0: "#64748b",   // DISARMED   gray
  1: "#f59e0b",   // PRELAUNCH  amber
  2: "#ef4444",   // LAUNCH     red
  3: "#22c55e",   // GLIDE      green
  4: "#3b82f6",   // LANDED     blue
  5: "#a855f7",   // WINDTUNNEL purple
};

const PHASE_DESC: Record<number, string> = {
  0: "地上テスト中。failsafe 有効。Arm すると PRELAUNCH に遷移します。",
  1: "投擲待機中。|a| が launch_g を連続超過したら LAUNCH に自動遷移。",
  2: "上昇 (climb-out)。最初の数百 ms は PID ゼロホールド、その後 climb_pitch を目標に制御。",
  3: "滑空中。glide_pitch を目標に PID 制御。静置検出で LANDED へ。",
  4: "着地検出。サーボ中立、PID 停止。Disarm で DISARMED に戻せます。",
  5: "風洞試験中。PID 常時稼働 / target 手動 / tilt safeguard・failsafe・climb_ff すべて抑制。",
};

export function LaunchPanel({
  attitudeRef,
  onSend,
  enabled,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  const [params, setParams] = useState<StoredParams>(DEFAULTS);
  const [applied, setApplied] = useState<StoredParams>(DEFAULTS);
  const [busy, setBusy] = useState(false);

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
        await onSend(`glide_pitch ${applied.glide_pitch.toFixed(1)}`); await sleep(15);
        await onSend(`landed_g ${applied.landed_g.toFixed(2)}`); await sleep(15);
        await onSend(`landed_gyro ${applied.landed_gyro.toFixed(1)}`); await sleep(15);
        await onSend(`landed_ms ${Math.round(applied.landed_ms)}`); await sleep(15);
        await onSend(`glide_timeout ${Math.round(applied.glide_timeout)}`);
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

        // 大きなフェーズ表示
        if (phaseLabelRef.current) {
          const name = PHASE_NAMES[phase] ?? `?${phase}`;
          if (phaseLabelRef.current.textContent !== name) {
            phaseLabelRef.current.textContent = name;
            const color = PHASE_COLORS[phase] ?? "#fff";
            phaseLabelRef.current.style.color = color;
            phaseLabelRef.current.style.textShadow = `0 0 18px ${color}88`;
          }
        }
        if (phaseDescRef.current) {
          const desc = PHASE_DESC[phase] ?? "";
          if (phaseDescRef.current.textContent !== desc) {
            phaseDescRef.current.textContent = desc;
          }
        }

        // フェーズ遷移時刻のトラッキング
        if (phase !== lastPhaseRef.current) {
          lastPhaseRef.current = phase;
          lastPhaseAtRef.current = Date.now();
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
          } else if (phase === 4) {
            msg = "■ LANDED — Disarm で復帰";
            color = "#3b82f6";
          }
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
          </div>
        </div>
        <div className="text-right">
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

      {/* Arm / Land / Disarm */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={doArm}
          disabled={!enabled || busy}
          className="btn-primary text-base px-5 py-2.5 font-bold"
          title="PRELAUNCH に遷移、投擲待機開始"
        >
          {busy ? "..." : "🚀 Arm"}
        </button>
        <button
          onClick={doLand}
          disabled={!enabled || busy}
          className="btn-ghost text-base px-5 py-2.5 font-bold !border-glider-pitch/40 !text-glider-pitch hover:!bg-glider-pitch/10"
          title="強制 LANDED 遷移（GLIDE で自動検出が起きないとき / 安全停止）"
        >
          🛬 Land
        </button>
        <button
          onClick={doDisarm}
          disabled={!enabled || busy}
          className="btn-danger text-base px-5 py-2.5 font-bold"
          title="DISARMED に戻す（地上テスト用 / 着地後の復帰）"
        >
          ■ Disarm
        </button>
        <div className="text-[11px] text-glider-textDim leading-tight">
          Step 1〜4 完了後 → Arm → 投擲。詰まったら Land → Disarm。
        </div>
      </div>

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

      {/* launch_g preset 行 */}
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

      {/* 詳細パラメータ */}
      <details className="border-t border-glider-border/50 pt-2">
        <summary className="cursor-pointer select-none text-[12px] uppercase tracking-wider font-semibold text-glider-textDim hover:text-glider-text">
          ▸ Advanced phase parameters (climb / glide / landed)
        </summary>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 pt-3 pb-1">
          {numInput("launch_g", "launch_g", "g", "launch_g", 1.0, 8.0, 0.1, 2, "投擲しきい値")}
          {numInput("climb_ms", "climb_ms", "ms", "climb_ms", 200, 10000, 100, 0, "LAUNCH 持続時間")}
          {numInput("climb_pitch", "climb_pitch", "deg", "climb_pitch", -45, 60, 1, 1, "上昇目標角")}
          {numInput("climb_ff", "climb_ff", "deg", "climb_ff", -30, 30, 1, 1, "エレベータ FF")}
          {numInput("glide_pitch", "glide_pitch", "deg", "glide_pitch", -20, 30, 0.5, 1, "滑空目標角")}
          {numInput("landed_g", "landed_g", "g", "landed_g", 0.05, 1.0, 0.05, 2, "||a|-1g| 偏差")}
          {numInput("landed_gyro", "landed_gyro", "°/s", "landed_gyro", 0.5, 50, 0.5, 1, "停止判定 max|gyro|")}
          {numInput("landed_ms", "landed_ms", "ms", "landed_ms", 100, 10000, 100, 0, "両条件 累積時間")}
          {numInput("glide_timeout", "glide_timeout", "ms", "glide_timeout", 0, 120000, 1000, 0, "GLIDE 強制終了 (0=無効)")}
        </div>
        <div className="text-[10px] text-glider-textMute leading-snug pt-2">
          ※ landed_g の意味は v17 以降「<code className="font-mono">||a|-1g| &lt; 値</code>」(地面に静置されている = 重力のみ作用) に変更。
          旧版は <code className="font-mono">|az| &lt; 値</code> で自由落下しか想定していなかったため、机置きで発火しないバグでした。
        </div>
      </details>
    </div>
  );
}
