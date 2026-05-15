"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";

/**
 * Launch Panel — 投擲検知（自律滑空モード）の操作 UI
 *
 * 機体側ファーム (glider_nRF52840.ino) の `arm` / `disarm` / `launch_g` に対応。
 *
 * フロー:
 *   1. このパネルで「Arm」を押す → 機体は MANUAL ホールドのまま、
 *      |a| が launch_g を連続で超えるのを待つ。
 *   2. 投擲 → 機体は AUTO/PID へ自動遷移、500ms grace 後に PID 制御開始。
 *   3. 飛行終了後、回収して「Disarm」で武装解除。
 *
 * 重要:
 *   - armed 中は failsafe が抑制される（地上局接続が無くても飛行できる）。
 *   - 設定値は localStorage に保存。接続時に機体へ自動同期。
 *   - ライブで |a| 表示。投擲しきい値とのバー表示で残量が見える。
 */

const LAUNCH_G_STORAGE_KEY = "glider-webui:launch_g";
const DEFAULT_LAUNCH_G = 2.5;

const LAUNCH_G_PRESETS = [
  { value: 1.8, label: "1.8g", hint: "弱投擲（軽く放る）" },
  { value: 2.5, label: "2.5g", hint: "標準（既定）" },
  { value: 3.5, label: "3.5g", hint: "強投擲（しっかり投げる）" },
];

export function LaunchPanel({
  attitudeRef,
  onSend,
  enabled,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [armBusy, setArmBusy] = useState(false);
  const [launchG, setLaunchG] = useState<number>(DEFAULT_LAUNCH_G);
  const [launchGApplied, setLaunchGApplied] = useState<number | null>(null);
  const [launchGBusy, setLaunchGBusy] = useState(false);

  // ライブ表示 (RAF, 再レンダなし)
  const aMagRef = useRef<HTMLSpanElement>(null);
  const aBarRef = useRef<HTMLDivElement>(null);
  const aMsgRef = useRef<HTMLDivElement>(null);
  const launchGAppliedRef = useRef<number>(DEFAULT_LAUNCH_G);
  launchGAppliedRef.current = launchGApplied ?? launchG;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const launchedRef = useRef(launched);
  launchedRef.current = launched;

  // launched 検知: |a| が連続でしきい値を超えたら一旦 launched=true 表示
  // (機体側もほぼ同時に [LAUNCH] を返してくる)
  const overCountRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const f = attitudeRef.current;
      if (f) {
        const aMag = Math.sqrt(f.ax * f.ax + f.ay * f.ay + f.az * f.az);
        const thr = launchGAppliedRef.current;
        if (aMagRef.current) {
          aMagRef.current.textContent = aMag.toFixed(2);
        }
        if (aBarRef.current) {
          // バーは 0..1.5×threshold の範囲で見せる
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
          if (!armedRef.current) {
            msg = "Not armed — click Arm before throwing";
            color = "#64748b";
          } else if (launchedRef.current) {
            msg = "✓ Launched — AUTO/PID engaged";
            color = "#22c55e";
          } else if (aMag >= thr) {
            msg = `⚡ Over threshold (${aMag.toFixed(2)}g ≥ ${thr.toFixed(2)}g)`;
            color = "#ef4444";
          } else if (aMag > thr * 0.7) {
            msg = `⚠ Approaching (${((aMag / thr) * 100).toFixed(0)}% of trigger)`;
            color = "#f59e0b";
          } else {
            msg = "Waiting for throw...";
            color = "#22c55e";
          }
          aMsgRef.current.textContent = msg;
          aMsgRef.current.style.color = color;
        }

        // クライアント側でも launched を推定（機体側 [LAUNCH] と合わせるため）
        if (armedRef.current && !launchedRef.current && aMag >= launchGAppliedRef.current) {
          overCountRef.current++;
          if (overCountRef.current >= 2) {
            setLaunched(true);
          }
        } else {
          overCountRef.current = 0;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [attitudeRef]);

  // 初期値ロード
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(LAUNCH_G_STORAGE_KEY);
      if (v != null) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n >= 1.0 && n <= 8.0) {
          setLaunchG(n);
          setLaunchGApplied(n);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // 接続時に launch_g を機体へ自動同期（armed 状態は同期しない: 危険なので明示再 Arm）
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      autoSyncedRef.current = false;
      // 切断時、UI 上の armed/launched 状態もクリア（再接続時に整合性確保）
      setArmed(false);
      setLaunched(false);
      return;
    }
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    if (launchGApplied != null) {
      onSend(`launch_g ${launchGApplied.toFixed(2)}`).catch(() => undefined);
    }
  }, [enabled, launchGApplied, onSend]);

  const doArm = useCallback(async () => {
    if (!enabled || armBusy) return;
    setArmBusy(true);
    try {
      await onSend("arm");
      setArmed(true);
      setLaunched(false);
      overCountRef.current = 0;
    } catch (e) {
      console.error("[LaunchPanel] arm failed:", e);
    } finally {
      setArmBusy(false);
    }
  }, [enabled, armBusy, onSend]);

  const doDisarm = useCallback(async () => {
    if (!enabled || armBusy) return;
    setArmBusy(true);
    try {
      await onSend("disarm");
      setArmed(false);
      setLaunched(false);
      overCountRef.current = 0;
    } catch (e) {
      console.error("[LaunchPanel] disarm failed:", e);
    } finally {
      setArmBusy(false);
    }
  }, [enabled, armBusy, onSend]);

  const applyLaunchG = useCallback(
    async (value?: number) => {
      const v = Math.max(1.0, Math.min(8.0, value ?? launchG));
      if (!enabled || launchGBusy) return;
      setLaunchGBusy(true);
      try {
        await onSend(`launch_g ${v.toFixed(2)}`);
        setLaunchGApplied(v);
        setLaunchG(v);
        try {
          window.localStorage.setItem(LAUNCH_G_STORAGE_KEY, String(v));
        } catch {
          // ignore
        }
      } catch (e) {
        console.error("[LaunchPanel] launch_g failed:", e);
      } finally {
        setLaunchGBusy(false);
      }
    },
    [launchG, enabled, launchGBusy, onSend],
  );

  const launchGDirty = launchGApplied === null || launchG !== launchGApplied;

  return (
    <div className="card-pad space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">Launch · 投擲検知（自律滑空）</div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            <strong>Arm</strong> 後、機体は MANUAL ホールドのまま <code className="font-mono text-glider-textDim">|a|</code> がしきい値を連続超過するのを待ち、
            投擲を検知すると AUTO/PID に自動遷移します。投擲後 500ms は PID をゼロホールド (Madgwick 復帰猶予)。
            <br />
            <span className="text-glider-warn">
              ⚠ Arm 中は failsafe が抑制されます（地上局接続が無くても飛行できる）。回収後は <strong>Disarm</strong> してから操作。
            </span>
          </div>
        </div>
        <div
          className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
            launched
              ? "bg-glider-pitch/15 text-glider-pitch animate-pulse"
              : armed
                ? "bg-glider-warn/15 text-glider-warn"
                : "bg-glider-textMute/10 text-glider-textMute"
          }`}
        >
          {launched ? "LAUNCHED" : armed ? "ARMED" : "DISARMED"}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {!armed ? (
          <button
            onClick={doArm}
            disabled={!enabled || armBusy}
            className="btn-primary text-base px-5 py-2.5 font-bold"
            title="投擲待機モード開始（機体は MANUAL のまま待機）"
          >
            {armBusy ? "..." : "🚀 Arm"}
          </button>
        ) : (
          <button
            onClick={doDisarm}
            disabled={!enabled || armBusy}
            className="btn-danger text-base px-5 py-2.5 font-bold"
            title="武装解除（地上テスト用）"
          >
            {armBusy ? "..." : "■ Disarm"}
          </button>
        )}
        <div className="text-[11px] text-glider-textDim leading-tight">
          {!armed && "Pre-flight 完了後、最後に Arm → 機体を持って投げる"}
          {armed && !launched && "投擲待機中... 強く前方に放ってください"}
          {armed && launched && "AUTO/PID 実行中。回収後に Disarm"}
        </div>
      </div>

      {/* ライブ |a| 表示 */}
      <div className="space-y-1 pt-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-glider-textMute">
            現在の加速度 <code className="font-mono text-glider-textDim">|a|=√(ax²+ay²+az²)</code>
          </span>
          <span className="font-mono">
            <span ref={aMagRef} className="text-glider-text font-bold text-lg">
              --
            </span>
            <span className="text-glider-textMute">
              g / {launchGApplied != null ? `${launchGApplied.toFixed(2)}g` : "—"}
            </span>
          </span>
        </div>
        <div className="h-3 bg-glider-surface border border-glider-border rounded-full overflow-hidden relative">
          <div
            ref={aBarRef}
            className="h-full transition-[width] duration-75"
            style={{ width: "0%", background: "#22c55e" }}
          />
          {launchGApplied != null && (
            <div
              className="absolute top-0 bottom-0 w-px bg-glider-warn/60 pointer-events-none"
              style={{ left: `${(1 / 1.5) * 100}%` }}
              title="trigger threshold"
            />
          )}
        </div>
        <div
          ref={aMsgRef}
          className="text-[11px] font-semibold min-h-[1em]"
          style={{ color: "#64748b" }}
        >
          --
        </div>
      </div>

      {/* launch_g 設定 */}
      <div className="border-t border-glider-border/50 pt-3 space-y-2">
        <div className="text-sm font-bold text-glider-text">
          投擲しきい値 <code className="font-mono text-glider-textDim">launch_g</code>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              g (1.0..8.0)
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setLaunchG((v) => Math.max(1.0, Math.round((v - 0.1) * 10) / 10))}
                className="btn-ghost px-2 py-1.5 text-sm"
              >
                −
              </button>
              <input
                type="number"
                min={1.0}
                max={8.0}
                step={0.1}
                value={launchG}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  setLaunchG(
                    Number.isFinite(n) ? Math.max(1.0, Math.min(8.0, n)) : 2.5,
                  );
                }}
                onBlur={() => {
                  if (enabled && launchGDirty) applyLaunchG();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className={`bg-glider-surface border rounded-md
                            px-3 py-1.5 text-lg font-mono font-bold w-20 text-center
                            focus:outline-none focus:ring-1 focus:ring-glider-accent/40
                            ${
                              launchGDirty
                                ? "border-glider-warn text-glider-warn"
                                : "border-glider-border text-glider-text"
                            }`}
              />
              <button
                type="button"
                onClick={() => setLaunchG((v) => Math.min(8.0, Math.round((v + 0.1) * 10) / 10))}
                className="btn-ghost px-2 py-1.5 text-sm"
              >
                +
              </button>
            </div>
          </div>

          <button
            onClick={() => applyLaunchG()}
            disabled={!enabled || launchGBusy || !launchGDirty}
            className="btn-primary"
          >
            {launchGBusy ? "..." : "Apply"}
          </button>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              Presets
            </span>
            <div className="flex gap-1 flex-wrap">
              {LAUNCH_G_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => applyLaunchG(p.value)}
                  disabled={!enabled || launchGBusy}
                  title={p.hint}
                  className={`px-2.5 py-1.5 text-xs font-bold rounded-md border transition ${
                    launchGApplied != null && Math.abs(launchGApplied - p.value) < 0.01
                      ? "bg-glider-accent/15 border-glider-accent text-glider-accent"
                      : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
