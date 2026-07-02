"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";

/**
 * Safety Panel — 姿勢角しきい値 + アップリンク Failsafe の設定 UI
 *
 * 機体側ファームウェアは下記2つの自動 MANUAL 復帰トリガを持つ:
 *   1. `safe_angle <deg>`  AUTO 中に |roll| or |pitch| が超過 → MANUAL
 *   2. `failsafe <ms>`     アップリンクが ms 間無音 → MANUAL + trim=0
 * このパネルでは両方を設定でき、現在状態をライブ表示する。
 *
 * ライブ監視:
 *   - tilt: max(|roll|, |pitch|) と safe_angle のバー
 *   - heartbeat: 直近 ping 送信からの経過時間と failsafe しきい値のバー
 *
 * 設定値は localStorage に保存。
 */

const TILT_STORAGE_KEY = "glider-webui:safe_angle";
const FAIL_STORAGE_KEY = "glider-webui:failsafe_ms";
const DEFAULT_ANGLE = 60;
const DEFAULT_FAILSAFE_MS = 1500;

const TILT_PRESETS = [30, 45, 60, 75, 90];
const FAIL_PRESETS = [1000, 1500, 3000, 5000];

export function SafetyPanel({
  attitudeRef,
  heartbeatSentCount,
  onSend,
  enabled,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  /** useHeartbeat の sentCount。これが増えるたびに「直近 ping 時刻」を更新する */
  heartbeatSentCount: number;
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  // ---- tilt safeguard ----
  const [tiltTarget, setTiltTarget] = useState<number>(DEFAULT_ANGLE);
  const [tiltApplied, setTiltApplied] = useState<number | null>(null);
  const [tiltBusy, setTiltBusy] = useState(false);

  // ---- failsafe ----
  const [failTarget, setFailTarget] = useState<number>(DEFAULT_FAILSAFE_MS);
  const [failApplied, setFailApplied] = useState<number | null>(null);
  const [failBusy, setFailBusy] = useState(false);

  const tiltNumRef = useRef<HTMLSpanElement>(null);
  const tiltBarRef = useRef<HTMLDivElement>(null);
  const tiltMsgRef = useRef<HTMLDivElement>(null);
  const tiltAppliedRef = useRef<number | null>(null);
  tiltAppliedRef.current = tiltApplied;

  const linkAgeRef = useRef<HTMLSpanElement>(null);
  const linkBarRef = useRef<HTMLDivElement>(null);
  const linkMsgRef = useRef<HTMLDivElement>(null);
  const failAppliedRef = useRef<number | null>(null);
  failAppliedRef.current = failApplied;

  // 直近 ping 送信時刻
  const lastPingAtRef = useRef<number>(Date.now());
  useEffect(() => {
    lastPingAtRef.current = Date.now();
  }, [heartbeatSentCount]);

  // 初期値ロード
  useEffect(() => {
    try {
      const t = window.localStorage.getItem(TILT_STORAGE_KEY);
      if (t != null) {
        const n = parseFloat(t);
        if (Number.isFinite(n) && n >= 0 && n <= 180) {
          setTiltTarget(n);
          setTiltApplied(n);
        }
      }
      const f = window.localStorage.getItem(FAIL_STORAGE_KEY);
      if (f != null) {
        const n = parseFloat(f);
        if (Number.isFinite(n) && n >= 0 && n <= 60000) {
          setFailTarget(n);
          setFailApplied(n);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // 接続したら現在保存値を機体へ自動送信
  // (機体が再起動して既定値に戻っている可能性に備える)
  const autoAppliedRef = useRef(false);
  useEffect(() => {
    if (!enabled || autoAppliedRef.current) return;
    if (tiltApplied != null) {
      onSend(`safe_angle ${tiltApplied}`).catch(() => undefined);
    }
    if (failApplied != null) {
      onSend(`failsafe ${failApplied}`).catch(() => undefined);
    }
    autoAppliedRef.current = true;
  }, [enabled, tiltApplied, failApplied, onSend]);
  useEffect(() => {
    if (!enabled) autoAppliedRef.current = false;
  }, [enabled]);

  // ライブ表示 (RAF, 再レンダなし)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // --- tilt ---
      const f = attitudeRef.current;
      const tiltTh = tiltAppliedRef.current ?? 0;
      const tiltActive = tiltTh > 0 && tiltTh < 180;
      if (f) {
        const tilt = Math.max(Math.abs(f.roll), Math.abs(f.pitch));
        if (tiltNumRef.current) tiltNumRef.current.textContent = tilt.toFixed(0);

        if (tiltBarRef.current) {
          const pct = tiltActive ? Math.min(100, (tilt / tiltTh) * 100) : 0;
          tiltBarRef.current.style.width = `${pct}%`;
          let color = "#22c55e";
          if (!tiltActive) color = "#64748b";
          else if (pct >= 100) color = "#ef4444";
          else if (pct > 80) color = "#ef4444";
          else if (pct > 50) color = "#f59e0b";
          tiltBarRef.current.style.background = color;
        }

        if (tiltMsgRef.current) {
          let msg = "";
          if (!tiltActive) {
            msg = tiltTh === 0 ? "Safeguard OFF (0°)" : "Safeguard OFF (≥180°)";
          } else if (tilt >= tiltTh) {
            msg = `⚠ Over threshold (${tilt.toFixed(0)}° > ${tiltTh}°) — firmware will revert to MANUAL`;
          } else if (tilt > tiltTh * 0.8) {
            msg = `⚠ Approaching (${((tilt / tiltTh) * 100).toFixed(0)}% of limit)`;
          } else {
            msg = "Safe";
          }
          tiltMsgRef.current.textContent = msg;
          tiltMsgRef.current.style.color = !tiltActive
            ? "#64748b"
            : tilt >= tiltTh
              ? "#ef4444"
              : tilt > tiltTh * 0.8
                ? "#f59e0b"
                : "#22c55e";
        }
      }

      // --- link / heartbeat ---
      const failTh = failAppliedRef.current ?? DEFAULT_FAILSAFE_MS;
      const failActive = failTh > 0;
      const age = Date.now() - lastPingAtRef.current;
      if (linkAgeRef.current) {
        linkAgeRef.current.textContent = age < 10000 ? `${age}` : "—";
      }
      if (linkBarRef.current) {
        const pct = failActive ? Math.min(100, (age / failTh) * 100) : 0;
        linkBarRef.current.style.width = `${pct}%`;
        let color = "#22c55e";
        if (!failActive) color = "#64748b";
        else if (pct >= 100) color = "#ef4444";
        else if (pct > 80) color = "#ef4444";
        else if (pct > 60) color = "#f59e0b";
        linkBarRef.current.style.background = color;
      }
      if (linkMsgRef.current) {
        let msg = "";
        if (!failActive) {
          msg = "Failsafe OFF — uplink loss will NOT auto-revert";
        } else if (age >= failTh) {
          msg = `⚠ Uplink lost (${age}ms > ${failTh}ms) — firmware reverted to MANUAL + trim=0`;
        } else if (age > failTh * 0.6) {
          msg = `⚠ Heartbeat late (${age}ms / ${failTh}ms)`;
        } else {
          msg = "Heartbeat OK";
        }
        linkMsgRef.current.textContent = msg;
        linkMsgRef.current.style.color = !failActive
          ? "#64748b"
          : age >= failTh
            ? "#ef4444"
            : age > failTh * 0.6
              ? "#f59e0b"
              : "#22c55e";
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [attitudeRef]);

  const applyTilt = useCallback(
    async (value?: number) => {
      const v = Math.round(Math.max(0, Math.min(180, value ?? tiltTarget)));
      if (!enabled || tiltBusy) return;
      setTiltBusy(true);
      try {
        await onSend(`safe_angle ${v}`);
        setTiltApplied(v);
        setTiltTarget(v);
        try {
          window.localStorage.setItem(TILT_STORAGE_KEY, String(v));
        } catch {
          // ignore
        }
      } catch (e) {
        console.error("[SafetyPanel] safe_angle failed:", e);
      } finally {
        setTiltBusy(false);
      }
    },
    [tiltTarget, enabled, tiltBusy, onSend],
  );

  const applyFail = useCallback(
    async (value?: number) => {
      const v = Math.round(Math.max(0, Math.min(60000, value ?? failTarget)));
      if (!enabled || failBusy) return;
      setFailBusy(true);
      try {
        await onSend(`failsafe ${v}`);
        setFailApplied(v);
        setFailTarget(v);
        try {
          window.localStorage.setItem(FAIL_STORAGE_KEY, String(v));
        } catch {
          // ignore
        }
      } catch (e) {
        console.error("[SafetyPanel] failsafe failed:", e);
      } finally {
        setFailBusy(false);
      }
    },
    [failTarget, enabled, failBusy, onSend],
  );

  const tiltDirty = tiltApplied === null || tiltTarget !== tiltApplied;
  const failDirty = failApplied === null || failTarget !== failApplied;

  return (
    <div className="card-pad space-y-5">
      <div>
        <div className="section-title">Safety</div>
        <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
          AUTO の自動 MANUAL 復帰条件を 2 種類設定できます。設定値は機体側に保存されないため、接続時にこの UI から自動で送り直されます。
        </div>
      </div>

      {/* ============ TILT SAFEGUARD ============ */}
      <section className="space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-bold text-glider-text">
              ① 姿勢角しきい値 (safe_angle)
            </div>
            <div className="text-[11px] text-glider-textMute mt-0.5">
              AUTO 中に <code className="font-mono text-glider-textDim">max(|roll|, |pitch|)</code> がしきい値超過で MANUAL + trim=0。
              <strong>0 または ≥180 で無効</strong>。
            </div>
          </div>
          <div
            className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
              tiltApplied === null
                ? "bg-glider-textMute/10 text-glider-textMute"
                : tiltApplied <= 0 || tiltApplied >= 180
                  ? "bg-glider-warn/10 text-glider-warn"
                  : "bg-glider-ok/10 text-glider-ok"
            }`}
          >
            {tiltApplied === null
              ? "NOT SET"
              : tiltApplied <= 0 || tiltApplied >= 180
                ? "DISABLED"
                : `ARMED @ ${tiltApplied}°`}
          </div>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              deg
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setTiltTarget((v) => Math.max(0, v - 5))}
                className="btn-ghost px-2 py-1.5 text-sm"
              >
                −
              </button>
              <input
                type="number"
                min={0}
                max={180}
                step={1}
                value={tiltTarget}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  setTiltTarget(
                    Number.isFinite(n) ? Math.max(0, Math.min(180, n)) : 0,
                  );
                }}
                className="bg-glider-surface border border-glider-border rounded-md
                           px-3 py-1.5 text-lg font-mono font-bold text-glider-text w-20 text-center
                           focus:outline-none focus:border-glider-accent focus:ring-1 focus:ring-glider-accent/40"
              />
              <button
                type="button"
                onClick={() => setTiltTarget((v) => Math.min(180, v + 5))}
                className="btn-ghost px-2 py-1.5 text-sm"
              >
                +
              </button>
            </div>
          </div>

          <button
            onClick={() => applyTilt()}
            disabled={!enabled || tiltBusy || !tiltDirty}
            className="btn-primary"
          >
            {tiltBusy ? "..." : "Apply"}
          </button>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              Quick
            </span>
            <div className="flex gap-1 flex-wrap">
              {TILT_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => applyTilt(p)}
                  disabled={!enabled || tiltBusy}
                  className={`px-2.5 py-1.5 text-xs font-bold rounded-md border transition ${
                    tiltApplied === p
                      ? "bg-glider-accent/15 border-glider-accent text-glider-accent"
                      : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                  }`}
                >
                  {p}°
                </button>
              ))}
              <button
                onClick={() => applyTilt(0)}
                disabled={!enabled || tiltBusy}
                className={`px-2.5 py-1.5 text-xs font-bold rounded-md border transition ${
                  tiltApplied === 0 || (tiltApplied != null && tiltApplied >= 180)
                    ? "bg-glider-warn/15 border-glider-warn text-glider-warn"
                    : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                }`}
              >
                OFF
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-1 pt-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-glider-textMute">
              現在の傾き <code className="font-mono text-glider-textDim">max(|roll|,|pitch|)</code>
            </span>
            <span className="font-mono">
              <span ref={tiltNumRef} className="text-glider-text font-bold text-lg">
                --
              </span>
              <span className="text-glider-textMute">
                ° / {tiltApplied != null && tiltApplied > 0 && tiltApplied < 180 ? `${tiltApplied}°` : "—"}
              </span>
            </span>
          </div>
          <div className="h-3 bg-glider-surface border border-glider-border rounded-full overflow-hidden relative">
            <div
              ref={tiltBarRef}
              className="h-full transition-[width] duration-75"
              style={{ width: "0%", background: "#22c55e" }}
            />
            {tiltApplied != null && tiltApplied > 0 && tiltApplied < 180 && (
              <div
                className="absolute top-0 bottom-0 w-px bg-glider-warn/50 pointer-events-none"
                style={{ left: "80%" }}
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
      </section>

      <div className="border-t border-glider-border/50" />

      {/* ============ FAILSAFE (UPLINK TIMEOUT) ============ */}
      <section className="space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-bold text-glider-text">
              ② アップリンク Failsafe (failsafe)
            </div>
            <div className="text-[11px] text-glider-textMute mt-0.5">
              この時間アップリンク (コマンド) 受信が無いと MANUAL + trim=0 に強制復帰。
              WebUI は <strong>~300ms 毎に <code className="font-mono text-glider-textDim">ping</code> を自動送信</strong> して uplink を生存させます (無線が数発落ちても発火しない設計)。<strong>0 で無効</strong>。
            </div>
          </div>
          <div
            className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
              failApplied === null
                ? "bg-glider-textMute/10 text-glider-textMute"
                : failApplied <= 0
                  ? "bg-glider-warn/10 text-glider-warn"
                  : "bg-glider-ok/10 text-glider-ok"
            }`}
          >
            {failApplied === null
              ? "NOT SET"
              : failApplied <= 0
                ? "DISABLED"
                : `ARMED @ ${failApplied}ms`}
          </div>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              ms
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setFailTarget((v) => Math.max(0, v - 250))}
                className="btn-ghost px-2 py-1.5 text-sm"
              >
                −
              </button>
              <input
                type="number"
                min={0}
                max={60000}
                step={250}
                value={failTarget}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  setFailTarget(
                    Number.isFinite(n) ? Math.max(0, Math.min(60000, n)) : 0,
                  );
                }}
                className="bg-glider-surface border border-glider-border rounded-md
                           px-3 py-1.5 text-lg font-mono font-bold text-glider-text w-24 text-center
                           focus:outline-none focus:border-glider-accent focus:ring-1 focus:ring-glider-accent/40"
              />
              <button
                type="button"
                onClick={() => setFailTarget((v) => Math.min(60000, v + 250))}
                className="btn-ghost px-2 py-1.5 text-sm"
              >
                +
              </button>
            </div>
          </div>

          <button
            onClick={() => applyFail()}
            disabled={!enabled || failBusy || !failDirty}
            className="btn-primary"
          >
            {failBusy ? "..." : "Apply"}
          </button>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              Quick
            </span>
            <div className="flex gap-1 flex-wrap">
              {FAIL_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => applyFail(p)}
                  disabled={!enabled || failBusy}
                  className={`px-2.5 py-1.5 text-xs font-bold rounded-md border transition ${
                    failApplied === p
                      ? "bg-glider-accent/15 border-glider-accent text-glider-accent"
                      : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                  }`}
                >
                  {p}ms
                </button>
              ))}
              <button
                onClick={() => applyFail(0)}
                disabled={!enabled || failBusy}
                className={`px-2.5 py-1.5 text-xs font-bold rounded-md border transition ${
                  failApplied === 0
                    ? "bg-glider-warn/15 border-glider-warn text-glider-warn"
                    : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                }`}
              >
                OFF
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-1 pt-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-glider-textMute">
              直近 <code className="font-mono text-glider-textDim">ping</code> からの経過 · heartbeat #{heartbeatSentCount}
            </span>
            <span className="font-mono">
              <span ref={linkAgeRef} className="text-glider-text font-bold text-lg">
                --
              </span>
              <span className="text-glider-textMute">
                ms / {failApplied != null && failApplied > 0 ? `${failApplied}ms` : "—"}
              </span>
            </span>
          </div>
          <div className="h-3 bg-glider-surface border border-glider-border rounded-full overflow-hidden relative">
            <div
              ref={linkBarRef}
              className="h-full transition-[width] duration-75"
              style={{ width: "0%", background: "#22c55e" }}
            />
            {failApplied != null && failApplied > 0 && (
              <div
                className="absolute top-0 bottom-0 w-px bg-glider-warn/50 pointer-events-none"
                style={{ left: "60%" }}
                title="60% caution"
              />
            )}
          </div>
          <div
            ref={linkMsgRef}
            className="text-[11px] font-semibold min-h-[1em]"
            style={{ color: "#64748b" }}
          >
            Heartbeat OK
          </div>
        </div>
      </section>
    </div>
  );
}
