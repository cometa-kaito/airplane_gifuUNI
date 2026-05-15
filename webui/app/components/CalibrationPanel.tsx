"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";

/**
 * Calibration Panel — 取付角ゼロ点キャリブレーション
 *
 * 機体に IMU を取り付けた瞬間、機体が水平でも IMU 出力は 0 にならない
 * (取付公差・治具)。「Zero Now」ボタンで現在の Madgwick 出力をオフセット
 * として記録し、以降 roll/pitch/yaw = 0 として扱う。
 *
 * 機体側ファーム (glider_nRF52840.ino):
 *   - `zero`   コマンドで現在値をオフセットに保存
 *   - `unzero` コマンドで解除して生値に戻す
 *
 * Note: オフセットは機体側 RAM のみ保持 (再起動でクリア)。
 *       フライト前に毎回キャリブレーションすることで、古い値の混入を防ぐ。
 *
 * ライブ表示:
 *   - 現在の roll/pitch/yaw (テレメトリ経由 = オフセット適用済)
 *   - 「水平面に置いた状態でこの値が ~0° になればキャリブレーション成功」
 */
export function CalibrationPanel({
  attitudeRef,
  onSend,
  enabled,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  const [zeroed, setZeroed] = useState(false);
  const [lastOffset, setLastOffset] = useState<
    { r: number; p: number; y: number } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>("");

  const rollRef = useRef<HTMLSpanElement>(null);
  const pitchRef = useRef<HTMLSpanElement>(null);
  const yawRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  // ライブ表示 (RAF, 再レンダなし)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const f = attitudeRef.current;
      if (f) {
        if (rollRef.current) {
          rollRef.current.textContent = (f.roll >= 0 ? "+" : "") + f.roll.toFixed(1);
        }
        if (pitchRef.current) {
          pitchRef.current.textContent = (f.pitch >= 0 ? "+" : "") + f.pitch.toFixed(1);
        }
        if (yawRef.current) {
          yawRef.current.textContent = (f.yaw >= 0 ? "+" : "") + f.yaw.toFixed(1);
        }
        if (statusRef.current) {
          const maxTilt = Math.max(Math.abs(f.roll), Math.abs(f.pitch));
          let msg = "";
          let color = "#64748b";
          if (maxTilt < 1.0) {
            msg = "✓ ほぼ水平 (±1°以内)";
            color = "#22c55e";
          } else if (maxTilt < 3.0) {
            msg = "△ やや傾き (±3°以内)";
            color = "#f59e0b";
          } else {
            msg = "✗ 大きく傾いている — 機体を水平面に置いて Zero Now";
            color = "#ef4444";
          }
          statusRef.current.textContent = msg;
          statusRef.current.style.color = color;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [attitudeRef]);

  const zeroNow = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    setFeedback("");
    // 現在の姿勢を記憶 (機体側でも同じ値が記録される)
    const f = attitudeRef.current;
    const snapshot = f
      ? { r: f.roll, p: f.pitch, y: f.yaw }
      : { r: 0, p: 0, y: 0 };
    try {
      await onSend("zero");
      setLastOffset(snapshot);
      setZeroed(true);
      setFeedback(
        `保存: roll=${snapshot.r.toFixed(2)}°  pitch=${snapshot.p.toFixed(2)}°  yaw=${snapshot.y.toFixed(2)}°`,
      );
    } catch (e) {
      console.error("[CalibrationPanel] zero failed:", e);
      setFeedback("送信失敗");
    } finally {
      setBusy(false);
    }
  }, [enabled, busy, onSend, attitudeRef]);

  const clearZero = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    try {
      await onSend("unzero");
      setLastOffset(null);
      setZeroed(false);
      setFeedback("オフセット解除");
    } catch (e) {
      console.error("[CalibrationPanel] unzero failed:", e);
      setFeedback("送信失敗");
    } finally {
      setBusy(false);
    }
  }, [enabled, busy, onSend]);

  return (
    <div className="card-pad space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">Calibration · 取付角ゼロ点</div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            機体を水平面 (机・治具) に置いて <strong>Zero Now</strong> を押すと、
            その瞬間の姿勢を「roll/pitch/yaw = 0°」として記録し、以降の
            <strong> PID / 安全装置 / テレメトリ </strong>すべてがこの基準で動きます。
            <br />
            <span className="text-glider-warn">
              ⚠ 機体側 RAM のみ保持。電源切ると消えるので、フライト前に毎回実行。
            </span>
          </div>
        </div>
        <div
          className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
            zeroed
              ? "bg-glider-ok/10 text-glider-ok"
              : "bg-glider-textMute/10 text-glider-textMute"
          }`}
        >
          {zeroed ? "ZEROED" : "RAW"}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={zeroNow}
          disabled={!enabled || busy}
          className="btn-primary text-base px-5 py-2.5 font-bold"
          title="現在の姿勢を 0° として登録"
        >
          {busy ? "..." : "● Zero Now"}
        </button>
        <button
          onClick={clearZero}
          disabled={!enabled || busy || !zeroed}
          className="btn-ghost"
          title="オフセットを解除して生 IMU 出力に戻す"
        >
          Clear
        </button>
        {feedback && (
          <span className="text-[11px] text-glider-textDim font-mono">
            {feedback}
          </span>
        )}
      </div>

      {/* ライブ姿勢 */}
      <div className="bg-glider-surface border border-glider-border rounded-md px-3 py-2.5 grid grid-cols-3 gap-3">
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wider text-glider-roll font-bold">
            ROLL
          </span>
          <div className="flex items-baseline gap-1">
            <span
              ref={rollRef}
              className="stat-val text-xl font-bold"
              style={{ color: "#ff5d6c" }}
            >
              --
            </span>
            <span className="text-[10px] text-glider-textMute">°</span>
          </div>
        </div>
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wider text-glider-pitch font-bold">
            PITCH
          </span>
          <div className="flex items-baseline gap-1">
            <span
              ref={pitchRef}
              className="stat-val text-xl font-bold"
              style={{ color: "#3ddc97" }}
            >
              --
            </span>
            <span className="text-[10px] text-glider-textMute">°</span>
          </div>
        </div>
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wider text-glider-yaw font-bold">
            YAW
          </span>
          <div className="flex items-baseline gap-1">
            <span
              ref={yawRef}
              className="stat-val text-xl font-bold"
              style={{ color: "#5cc8ff" }}
            >
              --
            </span>
            <span className="text-[10px] text-glider-textMute">°</span>
          </div>
        </div>
      </div>

      <div
        ref={statusRef}
        className="text-[11px] font-semibold min-h-[1em]"
        style={{ color: "#64748b" }}
      >
        --
      </div>

      {lastOffset && (
        <div className="text-[10px] text-glider-textMute font-mono">
          直近保存オフセット: roll={lastOffset.r >= 0 ? "+" : ""}
          {lastOffset.r.toFixed(2)}° / pitch={lastOffset.p >= 0 ? "+" : ""}
          {lastOffset.p.toFixed(2)}° / yaw={lastOffset.y >= 0 ? "+" : ""}
          {lastOffset.y.toFixed(2)}°
        </div>
      )}
    </div>
  );
}
