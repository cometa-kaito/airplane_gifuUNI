"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";
import type { TrimApi } from "../hooks/useTrim";

/**
 * TrimSetupPanel — サーボ機械的中立設定（Step 0 / 全モード GND）
 *
 * 自作エルロンは「真っすぐ」がサーボ角 0° とは限らない。
 * ここで右/左エルロン・エレベータの機械的中立角（オフセット）を設定する。
 *
 * ファームウェアは全モードで servo_out = trimDeg + 制御出力 として動く:
 *   - MANUAL: servo_out = trimDeg (PID なし → 舵が物理的に真っすぐになることを目視確認)
 *   - AUTO:   servo_out = trimDeg + PID出力
 *   - 風洞:   servo_out = trimDeg + PID出力  (AUTO と同じ)
 * つまり「全モード共通のゼロ基準」がここで設定する trimDeg。
 *
 * 使い方:
 *   1. スライダ / 数値 / 微調整ボタンで、実機の舵が真っすぐになる角度に合わせる。
 *      → 接続中はリアルタイムで機体へ送信され、サーボが動く。
 *   2. 「MANUAL で保持」を押すと目視確認しやすい (MANUAL は PID を切るのでサーボが止まる)。
 *   3. 設定値はブラウザに保存され、次回接続時に自動で機体へ送信される
 *      (機体は電源 OFF で trim が消えるが、ここの保存値から毎回復元できる)。
 *
 * 機体側コマンド: `s0/s1/s2 <deg>` (右エルロン/左エルロン/エレベータ, -90..+90)
 */

type ChDef = {
  idx: 0 | 1 | 2;
  key: "s0" | "s1" | "s2";
  label: string;
  sub: string;
  color: string;
};

const CHANNELS: ChDef[] = [
  { idx: 0, key: "s0", label: "右エルロン", sub: "R Aileron · D0", color: "#ea580c" },
  { idx: 1, key: "s1", label: "左エルロン", sub: "L Aileron · D1", color: "#ca8a04" },
  { idx: 2, key: "s2", label: "エレベータ", sub: "Elevator · D2", color: "#65a30d" },
];

const FINE = [-5, -1, +1, +5] as const;
const SLIDER_RANGE = 45; // スライダ表示レンジ (数値入力は ±90 まで)

export function TrimSetupPanel({
  trim,
  attitudeRef,
  onSend,
  enabled,
}: {
  trim: TrimApi;
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  const { neutral, setNeutralChannel, resetNeutral, resendNeutral } = trim;
  const [manualHeld, setManualHeld] = useState(false);
  const [feedback, setFeedback] = useState("");

  // 入力中の文字列 (数値入力欄。blur/Enter で commit)
  const [draft, setDraft] = useState<Record<string, string>>({});

  // 実測サーボ出力 (テレメトリ s0/s1/s2 は 0..180, 90=中立 → 角度 = s-90)
  const actualRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const matchRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const neutralRef = useRef(neutral);
  neutralRef.current = neutral;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const f = attitudeRef.current;
      for (const ch of CHANNELS) {
        const el = actualRefs.current[ch.key];
        const matchEl = matchRefs.current[ch.key];
        if (f) {
          const deg = Math.round(f[ch.key] - 90); // 0..180 → -90..+90
          if (el) el.textContent = (deg >= 0 ? "+" : "") + deg + "°";
          // MANUAL 保持中なら実測 ≒ 設定中立になるはず。一致を表示。
          if (matchEl) {
            const target = neutralRef.current[ch.key];
            const ok = Math.abs(deg - target) <= 1;
            matchEl.textContent = ok ? "✓ 一致" : "";
            matchEl.style.color = "#16a34a";
          }
        } else {
          if (el) el.textContent = "--";
          if (matchEl) matchEl.textContent = "";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [attitudeRef]);

  const holdManual = useCallback(async () => {
    if (!enabled) return;
    try {
      await onSend("manual");
      setManualHeld(true);
      setFeedback("MANUAL 保持中 — サーボは設定した中立角を出力します");
    } catch {
      setFeedback("送信失敗");
    }
  }, [enabled, onSend]);

  const commitDraft = useCallback(
    (ch: ChDef) => {
      const raw = draft[ch.key];
      if (raw == null || raw === "") {
        setDraft((d) => ({ ...d, [ch.key]: "" }));
        return;
      }
      const n = parseFloat(raw);
      if (Number.isFinite(n)) setNeutralChannel(ch.idx, n);
      setDraft((d) => {
        const next = { ...d };
        delete next[ch.key];
        return next;
      });
    },
    [draft, setNeutralChannel],
  );

  const anyNonZero = neutral.s0 !== 0 || neutral.s1 !== 0 || neutral.s2 !== 0;

  return (
    <div className="card-pad space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">Servo Trim · 機械的中立設定（全モード GND）</div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            各舵の<strong> 機械的中立角</strong>（サーボ 0° と物理的な真っすぐのズレ）を補正します。
            スライダ / 数値で実機の舵が真っすぐになる値へ調整。
            <strong> MANUAL で保持</strong> を押すと PID が切れてサーボが静止するので目視確認しやすいです。
            <br />
            <span className="text-glider-ok font-medium">
              ✓ この値は MANUAL / AUTO / 風洞の全モードで GND（servo_out = trim + 制御出力）として使われます。
            </span>
            <br />
            <span className="text-glider-ok">
              ✓ 設定値はブラウザに保存され、次回接続時に自動で機体へ送信されます
              (電源 OFF で消える機体側 trim を毎回復元)。
            </span>
          </div>
        </div>
        <div
          className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
            anyNonZero
              ? "bg-glider-accent/10 text-glider-accent"
              : "bg-glider-textMute/10 text-glider-textMute"
          }`}
        >
          {anyNonZero ? "TRIM SET" : "ALL ZERO"}
        </div>
      </div>

      {/* MANUAL 保持 + 一括操作 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={holdManual}
          disabled={!enabled}
          className="btn-primary"
          title="MANUAL に切替えてサーボを中立角で保持 (中立合わせは必ず MANUAL で)"
        >
          ● MANUAL で保持
        </button>
        <button
          onClick={() => {
            resendNeutral();
            setFeedback("保存済み中立を再送信しました");
          }}
          disabled={!enabled}
          className="btn-ghost text-xs"
          title="保存済み中立をもう一度機体へ送信"
        >
          ↻ 再送信
        </button>
        <button
          onClick={() => {
            resetNeutral();
            setDraft({});
            setFeedback("中立を全て 0° にリセットしました");
          }}
          className="btn-ghost text-xs"
          title="全チャンネルの中立を 0° に戻す"
        >
          全て 0° に
        </button>
        {feedback && (
          <span className="text-[11px] text-glider-textDim">{feedback}</span>
        )}
      </div>

      {!manualHeld && (
        <div className="text-[11px] text-glider-textMute bg-glider-surface border border-glider-border rounded-md px-3 py-2">
          💡 <strong>MANUAL で保持</strong> を押すと PID が切れてサーボが trim 角で静止するため、
          目視で真っすぐか確認しやすくなります。設定値自体は AUTO / 風洞にも自動で反映されます。
        </div>
      )}

      {/* チャンネルごとの中立設定 */}
      <div className="space-y-3">
        {CHANNELS.map((ch) => {
          const value = neutral[ch.key];
          const draftVal = draft[ch.key];
          return (
            <div
              key={ch.key}
              className="bg-glider-surface border border-glider-border rounded-md px-3 py-2.5"
            >
              <div className="flex items-center gap-3 flex-wrap">
                {/* ラベル */}
                <div className="flex-none w-28">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: ch.color }}
                    />
                    <span
                      className="text-sm font-bold"
                      style={{ color: ch.color }}
                    >
                      {ch.label}
                    </span>
                  </div>
                  <div className="text-[10px] text-glider-textMute pl-3.5 font-mono">
                    {ch.sub}
                  </div>
                </div>

                {/* スライダ */}
                <div className="flex-1 min-w-[160px] flex items-center gap-2">
                  <span className="text-[9px] font-mono text-glider-textMute w-7 text-right">
                    -{SLIDER_RANGE}
                  </span>
                  <input
                    type="range"
                    min={-SLIDER_RANGE}
                    max={SLIDER_RANGE}
                    step={1}
                    value={Math.max(-SLIDER_RANGE, Math.min(SLIDER_RANGE, value))}
                    onChange={(e) =>
                      setNeutralChannel(ch.idx, parseInt(e.target.value, 10))
                    }
                    className="flex-1 accent-current"
                    style={{ color: ch.color }}
                    aria-label={`${ch.label} 中立角`}
                  />
                  <span className="text-[9px] font-mono text-glider-textMute w-7">
                    +{SLIDER_RANGE}
                  </span>
                </div>

                {/* 数値入力 + 微調整 */}
                <div className="flex items-center gap-1">
                  {FINE.slice(0, 2).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setNeutralChannel(ch.idx, value + d)}
                      className="bg-glider-surface border border-glider-border rounded
                                 text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                                 w-8 h-7 text-[11px] font-bold disabled:opacity-40"
                      tabIndex={-1}
                    >
                      {d}
                    </button>
                  ))}
                  <input
                    type="number"
                    min={-90}
                    max={90}
                    step={1}
                    value={draftVal ?? value}
                    onChange={(e) =>
                      setDraft((dd) => ({ ...dd, [ch.key]: e.target.value }))
                    }
                    onBlur={() => commitDraft(ch)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="bg-glider-surface border border-glider-border rounded text-center
                               px-1 py-1 w-14 text-sm font-mono font-bold text-glider-text
                               focus:outline-none focus:ring-1 focus:ring-glider-accent/40"
                  />
                  <span className="text-[10px] text-glider-textMute">°</span>
                  {FINE.slice(2).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setNeutralChannel(ch.idx, value + d)}
                      className="bg-glider-surface border border-glider-border rounded
                                 text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                                 w-8 h-7 text-[11px] font-bold disabled:opacity-40"
                      tabIndex={-1}
                    >
                      +{d}
                    </button>
                  ))}
                </div>

                {/* 実測 (テレメトリ) */}
                <div className="flex-none w-24 text-right">
                  <div className="text-[9px] uppercase tracking-wider text-glider-textMute">
                    実測
                  </div>
                  <span
                    ref={(el) => {
                      actualRefs.current[ch.key] = el;
                    }}
                    className="stat-val text-base font-bold font-mono text-glider-textDim"
                  >
                    --
                  </span>
                  <span
                    ref={(el) => {
                      matchRefs.current[ch.key] = el;
                    }}
                    className="block text-[9px] font-bold"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-[10px] text-glider-textMute font-mono">
        送信フォーマット: <code className="text-glider-textDim">s0 -8</code> /{" "}
        <code className="text-glider-textDim">s1 5</code> /{" "}
        <code className="text-glider-textDim">s2 0</code> (右/左エルロン, エレベータ
        trim, -90..+90)
      </div>
    </div>
  );
}
