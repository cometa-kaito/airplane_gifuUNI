"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";
import {
  US_ABS_MIN,
  US_ABS_MAX,
  type ServoCalApi,
  type ServoCalChannel,
  type ServoCalField,
  type ServoCalState,
} from "../hooks/useServoCal";

/**
 * ServoCalPanel — 物理サーボ較正（可動域 / 中立, µs エンドポイント）リデザイン版
 *
 * 「数値を手探りで入力」→「動かして見て決める (drive-and-set)」へ。
 *   - トラック上で min / center / max を**ドラッグ**設定。
 *   - 編集中の端点へサーボを**ライブ・ジョグ**（機体側 `sjog`、DISARMED 時のみ）。
 *   - `[− 端へ][中立へ][+ 端へ][スイープ]` で各位置へ動かして可動域・干渉を確認。
 *   - 粗/微刻み(±1/±10/±50)・% と振り幅表示・実位置マーカー・機械端ガード・左右ミラー。
 *
 * 機体側コマンド: smid/smax/smin <ch> <us>, srev <ch> <0|1>, sjog <ch> <us|off>
 *   ch: 0=右エルロン(D0) / 1=左エルロン(D1) / 2=エレベータ(D2)
 *
 * ※ ジョグには `sjog` 対応ファームが必要（未対応機では数値設定のみ動作）。
 */

type ChDef = {
  idx: 0 | 1 | 2;
  label: string;
  sub: string;
  color: string;
  minLabel: string;
  maxLabel: string;
};

const CHANNELS: ChDef[] = [
  { idx: 0, label: "右エルロン", sub: "R Aileron · D0", color: "#ea580c", minLabel: "−90°側", maxLabel: "+90°側" },
  { idx: 1, label: "左エルロン", sub: "L Aileron · D1", color: "#ca8a04", minLabel: "−90°側", maxLabel: "+90°側" },
  { idx: 2, label: "エレベータ", sub: "Elevator · D2", color: "#65a30d", minLabel: "下げ(−)", maxLabel: "上げ(+)" },
];

const FIELDS: { key: ServoCalField; label: string; end: "min" | "max" | "" }[] = [
  { key: "min", label: "− 端 (min)", end: "min" },
  { key: "center", label: "中立 (center)", end: "" },
  { key: "max", label: "+ 端 (max)", end: "max" },
];

const STEPS = [1, 10, 50];
const GAP = 10; // min<center<max を保つ最小間隔 [µs]
const SPAN = US_ABS_MAX - US_ABS_MIN;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pct = (us: number) => clamp(((us - US_ABS_MIN) / SPAN) * 100, 0, 100);

/** firmware servoLogicalToUs と同じ写像（テレメトリ実位置マーカー用） */
function logicalToUs(c: ServoCalChannel, deg: number): number {
  const d = clamp(deg, -90, 90);
  const us =
    d >= 0
      ? c.center + (d / 90) * (c.max - c.center)
      : c.center + (d / 90) * (c.center - c.min);
  const lo = Math.min(c.min, c.max);
  const hi = Math.max(c.min, c.max);
  return clamp(us, lo, hi);
}

export function ServoCalPanel({
  servoCal,
  attitudeRef,
  enabled,
}: {
  servoCal: ServoCalApi;
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  enabled: boolean;
}) {
  const { cal, setField, setReverse, resetAll, resend, jog, jogOff, jogOffAll } =
    servoCal;

  const [step, setStep] = useState<number>(10);

  // ドラッグ中の滑らかな表示用ローカルコピー（pointerup で確定送信）
  const [local, setLocal] = useState<ServoCalState>(cal);
  const localRef = useRef(local);
  localRef.current = local;
  const draggingRef = useRef<{ idx: 0 | 1 | 2; field: ServoCalField } | null>(null);
  useEffect(() => {
    if (!draggingRef.current) setLocal(cal);
  }, [cal]);

  // アクティブな jog µs（null=解除）。インジケータ + キープアライブ用。
  const [jogState, setJogState] = useState<(number | null)[]>([null, null, null]);
  // 高頻度更新（ドラッグ）はマーカー rAF が読む ref 側で持つ。
  const jogRef = useRef<(number | null)[]>([null, null, null]);
  const lastSendRef = useRef(0);

  const trackRefs = [
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
  ];
  const markerRefs = [
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
  ];

  // 実位置マーカー: jog 中はジョグ目標、idle はテレメトリ s から逆算
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const f = attitudeRef.current;
      for (let i = 0; i < 3; i++) {
        const m = markerRefs[i].current;
        if (!m) continue;
        const jv = jogRef.current[i];
        let us: number;
        if (jv != null) us = jv;
        else if (f) {
          const s = i === 0 ? f.s0 : i === 1 ? f.s1 : f.s2;
          us = logicalToUs(localRef.current[i], (s ?? 90) - 90);
        } else us = localRef.current[i].center;
        m.style.left = `${pct(us)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attitudeRef]);

  // jog キープアライブ（機体側 12s タイムアウトより短く再送）
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      jogState.forEach((v, i) => {
        if (v != null) jog(i as 0 | 1 | 2, v);
      });
    }, 6000);
    return () => window.clearInterval(id);
  }, [enabled, jogState, jog]);

  // 切断したらローカルの jog 状態をクリア（機体側は failsafe で解除される）
  useEffect(() => {
    if (!enabled) {
      jogRef.current = [null, null, null];
      setJogState([null, null, null]);
    }
  }, [enabled]);

  // パネル離脱時は全 ch 解除（サーボを通常制御へ戻す）
  useEffect(() => {
    return () => {
      jogOffAll();
    };
  }, [jogOffAll]);

  const setJogVal = useCallback((idx: 0 | 1 | 2, v: number | null) => {
    jogRef.current[idx] = v;
    setJogState((prev) => {
      const n = [...prev];
      n[idx] = v;
      return n;
    });
  }, []);

  const clampField = useCallback(
    (c: ServoCalChannel, field: ServoCalField, us: number) => {
      if (field === "min") return clamp(us, US_ABS_MIN, c.center - GAP);
      if (field === "max") return clamp(us, c.center + GAP, US_ABS_MAX);
      return clamp(us, c.min + GAP, c.max - GAP);
    },
    [],
  );

  const onHandleDown = useCallback(
    (idx: 0 | 1 | 2, field: ServoCalField) =>
      (e: ReactPointerEvent) => {
        if (draggingRef.current) return;
        e.preventDefault();
        draggingRef.current = { idx, field };
        const move = (ev: PointerEvent) => {
          const tr = trackRefs[idx].current;
          if (!tr) return;
          const rect = tr.getBoundingClientRect();
          const p = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
          const raw = US_ABS_MIN + p * SPAN;
          const us = Math.round(clampField(localRef.current[idx], field, raw));
          setLocal((prev) => {
            const n = prev.map((c) => ({ ...c })) as ServoCalState;
            n[idx][field] = us;
            localRef.current = n;
            return n;
          });
          jogRef.current[idx] = us;
          const now = performance.now();
          if (now - lastSendRef.current > 70) {
            lastSendRef.current = now;
            jog(idx, us);
          }
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          const d = draggingRef.current;
          draggingRef.current = null;
          if (d) {
            const v = localRef.current[d.idx][d.field];
            setField(d.idx, d.field, v); // 確定送信 + 永続化
            jog(d.idx, v);
            setJogVal(d.idx, v); // ジョグ位置を保持（インジケータ + keepalive）
          }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      },
    [clampField, jog, setField, setJogVal, trackRefs],
  );

  const nudge = useCallback(
    (idx: 0 | 1 | 2, field: ServoCalField, delta: number) => {
      const c = localRef.current[idx];
      const v = Math.round(clampField(c, field, c[field] + delta));
      setLocal((prev) => {
        const n = prev.map((x) => ({ ...x })) as ServoCalState;
        n[idx][field] = v;
        localRef.current = n;
        return n;
      });
      setField(idx, field, v);
      jog(idx, v);
      setJogVal(idx, v);
    },
    [clampField, setField, jog, setJogVal],
  );

  const goTo = useCallback(
    (idx: 0 | 1 | 2, field: ServoCalField) => {
      const v = cal[idx][field];
      jog(idx, v);
      setJogVal(idx, v);
    },
    [cal, jog, setJogVal],
  );

  const sweep = useCallback(
    (idx: 0 | 1 | 2) => {
      const c = cal[idx];
      const seq = [c.min, c.max, c.center];
      let k = 0;
      const run = () => {
        if (k >= seq.length) return;
        const v = seq[k];
        jog(idx, v);
        setJogVal(idx, v);
        k++;
        window.setTimeout(run, 550);
      };
      run();
    },
    [cal, jog, setJogVal],
  );

  const release = useCallback(
    (idx: 0 | 1 | 2) => {
      jogOff(idx);
      setJogVal(idx, null);
    },
    [jogOff, setJogVal],
  );

  const mirrorRtoL = useCallback(() => {
    const r = cal[0];
    setField(1, "min", r.min);
    setField(1, "center", r.center);
    setField(1, "max", r.max);
  }, [cal, setField]);

  const isDefault = cal.every(
    (c, i) =>
      c.min === 1000 &&
      c.center === 1500 &&
      c.max === 2000 &&
      c.reverse === (i === 1 ? false : true),
  );

  return (
    <div className="card-pad space-y-4">
      {/* ヘッダ */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">
            Servo Calibration · 機械的中立 + 可動域（µs エンドポイント）
          </div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            <strong>動かして見て決める</strong>較正。トラックのハンドルをドラッグ、または
            <strong>「端へ」</strong>でサーボを実際に動かし、舵を見ながら可動域を詰めます。
            両端を超えてサーボを突き当てません（stall 防止）。
            <br />
            <span className="text-glider-accent font-medium">
              ★ 舵の「真っすぐ」(機械的中立) は<strong>ここの中立 (center)</strong> で合わせます。
              こうすると failsafe / Land の安全リセット (trim=0) 時にも舵が真っすぐへ戻ります。
            </span>
            <br />
            <span className="text-glider-ok">
              ✓ 値はブラウザに保存され、接続時に自動同期。
            </span>{" "}
            <span className="text-glider-textMute">
              ジョグは <code className="font-mono">sjog</code> 対応ファーム・
              <strong>DISARMED 時のみ</strong>動作（飛行中は無効）。
            </span>
          </div>
        </div>
        <div
          className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
            isDefault
              ? "bg-glider-textMute/10 text-glider-textMute"
              : "bg-glider-accent/10 text-glider-accent"
          }`}
        >
          {isDefault ? "DEFAULT" : "CALIBRATED"}
        </div>
      </div>

      {/* ツールバー: 刻み + 再送 + 既定 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-glider-textDim">刻み</span>
        <div className="inline-flex rounded-md overflow-hidden border border-glider-border">
          {STEPS.map((s) => (
            <button
              key={s}
              onClick={() => setStep(s)}
              className={`px-2.5 py-1 text-xs font-bold transition ${
                step === s
                  ? "bg-glider-accent/15 text-glider-accent"
                  : "bg-glider-surface text-glider-textDim hover:bg-glider-panelHi"
              }`}
            >
              ±{s}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          onClick={() => resend()}
          disabled={!enabled}
          className="btn-ghost text-xs"
          title="保存済み較正値をもう一度機体へ送信"
        >
          ↻ 再送信
        </button>
        <button
          onClick={() => {
            jogOffAll();
            resetAll();
          }}
          className="btn-ghost text-xs"
          title="全チャンネルを既定値 (1000 / 1500 / 2000 µs) に戻す"
        >
          既定値に戻す
        </button>
      </div>

      {/* チャンネルごとの較正 */}
      <div className="space-y-3">
        {CHANNELS.map((ch) => {
          const c = local[ch.idx];
          const jogging = jogState[ch.idx] != null;
          const loUs = Math.min(c.min, c.max);
          const hiUs = Math.max(c.min, c.max);
          const narrow = Math.abs(c.max - c.min) < 100;
          return (
            <div
              key={ch.idx}
              className="bg-glider-surface border border-glider-border rounded-md px-3 py-2.5 space-y-3"
            >
              {/* ラベル + reverse + ジョグ中インジケータ */}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ background: ch.color }}
                  />
                  <span className="text-sm font-bold" style={{ color: ch.color }}>
                    {ch.label}
                  </span>
                  <span className="text-[10px] text-glider-textMute font-mono ml-1">
                    {ch.sub}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {jogging && (
                    <span className="flex items-center gap-1.5 text-[10px] text-glider-warn font-bold">
                      <span className="w-1.5 h-1.5 rounded-full bg-glider-warn animate-pulse" />
                      ジョグ中 {jogState[ch.idx]}µs
                      <button
                        onClick={() => release(ch.idx)}
                        className="ml-1 underline decoration-dotted hover:text-glider-text"
                        title="ジョグ解除（通常制御へ）"
                      >
                        解除
                      </button>
                    </span>
                  )}
                  <label className="flex items-center gap-1.5 text-[11px] text-glider-textDim cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={c.reverse}
                      onChange={(e) => setReverse(ch.idx, e.target.checked)}
                      className="accent-current"
                      style={{ color: ch.color }}
                    />
                    反転
                  </label>
                </div>
              </div>

              {/* インタラクティブ・トラック */}
              <div className="pt-5 pb-5 px-1">
                <div
                  ref={trackRefs[ch.idx]}
                  className="relative h-2 rounded-full bg-glider-panelHi/60"
                  style={{ touchAction: "none" }}
                >
                  {/* 可動域バンド */}
                  <div
                    className="absolute h-2 rounded-full opacity-40"
                    style={{
                      left: `${pct(loUs)}%`,
                      width: `${Math.max(0, pct(hiUs) - pct(loUs))}%`,
                      background: ch.color,
                    }}
                  />
                  {/* 中立ライン */}
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3.5 bg-glider-textDim"
                    style={{ left: `calc(${pct(c.center)}% - 1px)` }}
                  />
                  {/* 実位置マーカー */}
                  <div
                    ref={markerRefs[ch.idx]}
                    className="absolute -translate-x-1/2"
                    style={{ left: `${pct(c.center)}%`, top: "10px" }}
                  >
                    <div
                      className="w-0 h-0 mx-auto"
                      style={{
                        borderLeft: "4px solid transparent",
                        borderRight: "4px solid transparent",
                        borderBottom: `6px solid ${jogging ? "#f59e0b" : "#22c55e"}`,
                      }}
                    />
                    <span className="text-[8px] text-glider-textMute block text-center">
                      実位置
                    </span>
                  </div>
                  {/* ハンドル */}
                  {FIELDS.map((f) => (
                    <div
                      key={f.key}
                      onPointerDown={onHandleDown(ch.idx, f.key)}
                      className="absolute top-1/2 w-4 h-4 rounded-full bg-glider-panel border-2 cursor-grab active:cursor-grabbing"
                      style={{
                        left: `${pct(c[f.key])}%`,
                        transform: "translate(-50%,-50%)",
                        borderColor: f.key === "center" ? "#94a3b8" : ch.color,
                      }}
                      title={`${f.label} ${c[f.key]}µs`}
                    >
                      <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[9px] text-glider-textMute whitespace-nowrap">
                        {f.key === "min" ? "− 端" : f.key === "center" ? "中立" : "+ 端"}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-[9px] text-glider-textMute font-mono mt-3">
                  <span>{US_ABS_MIN}µs</span>
                  <span>{US_ABS_MAX}µs</span>
                </div>
              </div>

              {/* ジョグ・テストボタン */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => goTo(ch.idx, "min")}
                  disabled={!enabled}
                  className="btn-ghost text-[11px] px-2 py-1 disabled:opacity-40"
                  title="− 端へサーボを動かす"
                >
                  ◀ − 端へ
                </button>
                <button
                  onClick={() => goTo(ch.idx, "center")}
                  disabled={!enabled}
                  className="btn-ghost text-[11px] px-2 py-1 disabled:opacity-40"
                >
                  ◎ 中立へ
                </button>
                <button
                  onClick={() => goTo(ch.idx, "max")}
                  disabled={!enabled}
                  className="btn-ghost text-[11px] px-2 py-1 disabled:opacity-40"
                  title="+ 端へサーボを動かす"
                >
                  + 端へ ▶
                </button>
                <button
                  onClick={() => sweep(ch.idx)}
                  disabled={!enabled}
                  className="btn-ghost text-[11px] px-2 py-1 disabled:opacity-40"
                  title="− 端 → + 端 → 中立 と動かして可動域を確認"
                >
                  ⇄ スイープ
                </button>
                {ch.idx === 0 && (
                  <button
                    onClick={mirrorRtoL}
                    className="btn-ghost text-[11px] px-2 py-1 ml-auto"
                    title="右エルロンの min/center/max を左エルロンへコピー"
                  >
                    → 左へミラー
                  </button>
                )}
              </div>

              {/* min / center / max 入力（粗微刻み + % + 振り幅） */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {FIELDS.map((f) => {
                  const val = c[f.key];
                  const endLabel =
                    f.end === "min" ? ch.minLabel : f.end === "max" ? ch.maxLabel : "";
                  const travel =
                    f.key === "min"
                      ? `中立 −${c.center - c.min}µs`
                      : f.key === "max"
                        ? `中立 +${c.max - c.center}µs`
                        : "";
                  const nearEnd = val > US_ABS_MAX - 200 || val < US_ABS_MIN + 200;
                  return (
                    <div
                      key={f.key}
                      className="bg-glider-panel/40 border border-glider-border/60 rounded px-2 py-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
                          {f.label}
                        </span>
                        {endLabel && (
                          <span className="text-[9px] text-glider-textMute">{endLabel}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <button
                          type="button"
                          onClick={() => nudge(ch.idx, f.key, -step)}
                          className="bg-glider-surface border border-glider-border rounded
                                     text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                                     w-7 h-7 text-sm font-bold"
                          tabIndex={-1}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min={US_ABS_MIN}
                          max={US_ABS_MAX}
                          step={step}
                          value={val}
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            if (!Number.isFinite(n)) return;
                            const v = Math.round(clampField(localRef.current[ch.idx], f.key, n));
                            setLocal((prev) => {
                              const nn = prev.map((x) => ({ ...x })) as ServoCalState;
                              nn[ch.idx][f.key] = v;
                              localRef.current = nn;
                              return nn;
                            });
                            setField(ch.idx, f.key, v);
                          }}
                          className="bg-glider-surface border border-glider-border rounded text-center
                                     px-1 py-1 w-full text-sm font-mono font-bold text-glider-text
                                     focus:outline-none focus:ring-1 focus:ring-glider-accent/40"
                          aria-label={`${ch.label} ${f.label}`}
                        />
                        <button
                          type="button"
                          onClick={() => nudge(ch.idx, f.key, +step)}
                          className="bg-glider-surface border border-glider-border rounded
                                     text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                                     w-7 h-7 text-sm font-bold"
                          tabIndex={-1}
                        >
                          +
                        </button>
                        <span className="text-[9px] text-glider-textMute">µs</span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[9px] text-glider-textMute font-mono">
                          {Math.round(pct(val))}%{travel ? ` · ${travel}` : ""}
                        </span>
                        {nearEnd && (
                          <span
                            className="text-[9px] text-glider-warn"
                            title="機械端 (500/2500µs) に近い。突き当て(stall)注意"
                          >
                            ⚠端
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {narrow && (
                <div className="text-[10px] text-glider-warn">
                  ⚠ 可動域が狭すぎます（min と max が近い）。舵がほとんど動きません。
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="text-[10px] text-glider-textMute font-mono">
        送信: <code className="text-glider-textDim">smid 2 1500</code> /{" "}
        <code className="text-glider-textDim">smax 2 1850</code> /{" "}
        <code className="text-glider-textDim">smin 2 1200</code> /{" "}
        <code className="text-glider-textDim">srev 0 1</code> /{" "}
        <code className="text-glider-textDim">sjog 2 1850</code>（ジョグ） · ch 0=右/1=左/2=Elev
      </div>
    </div>
  );
}
