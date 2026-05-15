"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";

/**
 * Safety Panel — 姿勢角しきい値安全装置の設定・監視 UI
 *
 * 機体側 (glider_nRF52840.ino) は `safe_angle <deg>` コマンドで
 *   AUTO 中に max(|roll|, |pitch|) > N を超えると MANUAL + trim=0 へ強制復帰する。
 *   (0 で無効化、上限 180°)
 *
 * このコンポーネントは:
 *   - しきい値を入力 → `safe_angle N` を送信
 *   - 現在の傾きをライブで監視 (60fps RAF, 再レンダなし)
 *   - 安全圏 / 注意 / 危険 / トリガ済 を色で示す
 *   - 設定値は localStorage に保存
 */

const STORAGE_KEY = "glider-webui:safe_angle";
const DEFAULT_ANGLE = 60;

const PRESETS = [30, 45, 60, 75, 90];

export function SafetyPanel({
  attitudeRef,
  onSend,
  enabled,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  const [target, setTarget] = useState<number>(DEFAULT_ANGLE);
  const [applied, setApplied] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const tiltNumRef = useRef<HTMLSpanElement>(null);
  const tiltBarRef = useRef<HTMLDivElement>(null);
  const tiltMsgRef = useRef<HTMLDivElement>(null);
  const appliedRef = useRef<number | null>(null);
  appliedRef.current = applied;

  // 初期値を localStorage から読む
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v != null) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n >= 0 && n <= 180) {
          setTarget(n);
          setApplied(n);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // 現在の傾きをライブ表示 (RAF, 再レンダなし)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const f = attitudeRef.current;
      const th = appliedRef.current ?? 0;
      if (f) {
        const tilt = Math.max(Math.abs(f.roll), Math.abs(f.pitch));
        if (tiltNumRef.current) tiltNumRef.current.textContent = tilt.toFixed(0);

        if (tiltBarRef.current) {
          const pct = th > 0 ? Math.min(100, (tilt / th) * 100) : 0;
          tiltBarRef.current.style.width = `${pct}%`;
          let color = "#22c55e";
          if (th <= 0) color = "#64748b";
          else if (pct >= 100) color = "#ef4444";
          else if (pct > 80) color = "#ef4444";
          else if (pct > 50) color = "#f59e0b";
          tiltBarRef.current.style.background = color;
        }

        if (tiltMsgRef.current) {
          let msg = "";
          if (th <= 0) {
            msg = "Safeguard OFF";
          } else if (tilt >= th) {
            msg = `⚠ Over threshold (${tilt.toFixed(0)}° > ${th}°) — firmware will revert to MANUAL`;
          } else if (tilt > th * 0.8) {
            msg = `⚠ Approaching (${((tilt / th) * 100).toFixed(0)}% of limit)`;
          } else {
            msg = "Safe";
          }
          tiltMsgRef.current.textContent = msg;
          tiltMsgRef.current.style.color =
            th <= 0 ? "#64748b" :
            tilt >= th ? "#ef4444" :
            tilt > th * 0.8 ? "#f59e0b" :
            "#22c55e";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [attitudeRef]);

  const apply = useCallback(
    async (value?: number) => {
      const v = Math.round(Math.max(0, Math.min(180, value ?? target)));
      if (!enabled || busy) return;
      setBusy(true);
      try {
        await onSend(`safe_angle ${v}`);
        setApplied(v);
        setTarget(v);
        try {
          window.localStorage.setItem(STORAGE_KEY, String(v));
        } catch {
          // ignore
        }
      } catch (e) {
        console.error("[SafetyPanel] failed to send safe_angle:", e);
      } finally {
        setBusy(false);
      }
    },
    [target, enabled, busy, onSend],
  );

  const isDirty = applied === null || target !== applied;

  return (
    <div className="card-pad space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title flex items-center gap-2">
            <span>Safety · 姿勢角しきい値</span>
          </div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            AUTO 中に <code className="font-mono text-glider-textDim">max(|roll|, |pitch|)</code> がしきい値を超えると、
            機体側で自動的に <strong className="text-glider-warn">MANUAL + trim=0</strong> に復帰します。
            再武装は AUTO 系コマンドを再送した時。<strong>0 で無効化</strong>。
          </div>
        </div>
        <div
          className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
            applied === null
              ? "bg-glider-textMute/10 text-glider-textMute"
              : applied <= 0
                ? "bg-glider-warn/10 text-glider-warn"
                : "bg-glider-ok/10 text-glider-ok"
          }`}
        >
          {applied === null ? "NOT SET" : applied <= 0 ? "DISABLED" : `ARMED @ ${applied}°`}
        </div>
      </div>

      {/* Input + Apply + Presets */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            しきい値 (deg)
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setTarget((v) => Math.max(0, v - 5))}
              className="btn-ghost px-2 py-1.5 text-sm"
              aria-label="decrement"
            >
              −
            </button>
            <input
              type="number"
              min={0}
              max={180}
              step={1}
              value={target}
              onChange={(e) => {
                const n = parseFloat(e.target.value);
                setTarget(Number.isFinite(n) ? Math.max(0, Math.min(180, n)) : 0);
              }}
              className="bg-glider-surface border border-glider-border rounded-md
                         px-3 py-1.5 text-lg font-mono font-bold text-glider-text w-20 text-center
                         focus:outline-none focus:border-glider-accent focus:ring-1 focus:ring-glider-accent/40"
            />
            <button
              type="button"
              onClick={() => setTarget((v) => Math.min(180, v + 5))}
              className="btn-ghost px-2 py-1.5 text-sm"
              aria-label="increment"
            >
              +
            </button>
          </div>
        </div>

        <button
          onClick={() => apply()}
          disabled={!enabled || busy || !isDirty}
          className="btn-primary"
          title={!enabled ? "接続中のみ送信できます" : isDirty ? "機体に送信" : "現在の値と同じ"}
        >
          {busy ? "..." : "Apply"}
        </button>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            Quick
          </span>
          <div className="flex gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => apply(p)}
                disabled={!enabled || busy}
                className={`px-2.5 py-1.5 text-xs font-bold rounded-md border transition ${
                  applied === p
                    ? "bg-glider-accent/15 border-glider-accent text-glider-accent"
                    : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                }`}
              >
                {p}°
              </button>
            ))}
            <button
              onClick={() => apply(0)}
              disabled={!enabled || busy}
              className={`px-2.5 py-1.5 text-xs font-bold rounded-md border transition ${
                applied === 0
                  ? "bg-glider-warn/15 border-glider-warn text-glider-warn"
                  : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
              }`}
              title="安全装置を無効化"
            >
              OFF
            </button>
          </div>
        </div>
      </div>

      {/* Live tilt indicator */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-glider-textMute">
            現在の傾き <code className="font-mono text-glider-textDim">max(|roll|, |pitch|)</code>
          </span>
          <span className="font-mono">
            <span ref={tiltNumRef} className="text-glider-text font-bold text-lg">
              --
            </span>
            <span className="text-glider-textMute">
              ° / {applied != null && applied > 0 ? `${applied}°` : "—"}
            </span>
          </span>
        </div>
        <div className="h-3 bg-glider-surface border border-glider-border rounded-full overflow-hidden relative">
          <div
            ref={tiltBarRef}
            className="h-full transition-[width] duration-75"
            style={{ width: "0%", background: "#22c55e" }}
          />
          {/* 80% caution mark */}
          {applied != null && applied > 0 && (
            <div
              className="absolute top-0 bottom-0 w-px bg-glider-warn/50 pointer-events-none"
              style={{ left: "80%" }}
              title="80% caution"
            />
          )}
        </div>
        <div
          ref={tiltMsgRef}
          className="text-[11px] font-semibold min-h-[1em]"
          style={{ color: "#64748b" }}
        >
          Safe
        </div>
      </div>
    </div>
  );
}
