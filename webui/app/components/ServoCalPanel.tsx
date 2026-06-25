"use client";

import { useCallback } from "react";
import {
  US_ABS_MIN,
  US_ABS_MAX,
  type ServoCalApi,
  type ServoCalField,
} from "../hooks/useServoCal";

/**
 * ServoCalPanel — 物理サーボ較正（subtrim + エンドポイント, µs）
 *
 * 「論理舵角 ±90° → 0..180°」の固定変換をやめ、サーボごとに
 *   中立(center) / 両端(min,max) / 反転(reverse)
 * をパルス幅(µs)で設定する。取付（ホーン長・リンケージ・向き）で変わる
 * 実際の可動域・中立・左右(上下)非対称をここで吸収する。
 *
 * 機体側コマンド: smid/smax/smin <ch> <us> , srev <ch> <0|1>
 *   ch: 0=右エルロン(D0) / 1=左エルロン(D1) / 2=エレベータ(D2)
 *
 * Step 0 の Servo Trim(度) との役割分担:
 *   - こちら(µs)   … サーボの物理較正。中立パルスと「これ以上動かさない」両端。取付ごとに1回。
 *   - Servo Trim(度) … 制御の中立（PID の 0 点 / 全モード GND）の微調整。
 */

type ChDef = {
  idx: 0 | 1 | 2;
  label: string;
  sub: string;
  color: string;
  /** エンドポイントの意味ラベル（min 側 / max 側） */
  minLabel: string;
  maxLabel: string;
};

const CHANNELS: ChDef[] = [
  { idx: 0, label: "右エルロン", sub: "R Aileron · D0", color: "#ea580c", minLabel: "−90°側", maxLabel: "+90°側" },
  { idx: 1, label: "左エルロン", sub: "L Aileron · D1", color: "#ca8a04", minLabel: "−90°側", maxLabel: "+90°側" },
  { idx: 2, label: "エレベータ", sub: "Elevator · D2", color: "#65a30d", minLabel: "下げ(−)", maxLabel: "上げ(+)" },
];

const FIELDS: { key: ServoCalField; label: string; hint: string }[] = [
  { key: "min", label: "− 端 (min)", hint: "論理 -90° 側の機械端パルス" },
  { key: "center", label: "中立 (center)", hint: "論理 0° = 中立のパルス (subtrim)" },
  { key: "max", label: "+ 端 (max)", hint: "論理 +90° 側の機械端パルス" },
];

const STEP = 10; // µs 刻み

/** 500..2500 を 0..100% に */
const pct = (us: number) =>
  ((us - US_ABS_MIN) / (US_ABS_MAX - US_ABS_MIN)) * 100;

export function ServoCalPanel({
  servoCal,
  enabled,
}: {
  servoCal: ServoCalApi;
  enabled: boolean;
}) {
  const { cal, setField, setReverse, resetAll, resend } = servoCal;

  const nudge = useCallback(
    (idx: 0 | 1 | 2, field: ServoCalField, delta: number) => {
      setField(idx, field, cal[idx][field] + delta);
    },
    [cal, setField],
  );

  const isDefault = cal.every(
    (c, i) =>
      c.min === 1000 &&
      c.center === 1500 &&
      c.max === 2000 &&
      c.reverse === (i === 1 ? false : true),
  );

  return (
    <div className="card-pad space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">
            Servo Calibration · 可動域 / 中立（µs エンドポイント）
          </div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            取付（ホーン長・リンケージ・向き）で変わる<strong>実際の可動域</strong>を補正します。
            各舵の<strong> 中立(center)</strong> と<strong> 両端(min/max)</strong>を µs で設定すると、
            制御出力はこの範囲へ写像され、<strong>両端を超えてサーボを突き当てません</strong>
            （stall・ギア欠け防止）。center→max と center→min は別々なので
            <strong> 左右(上下)で可動域が違っても</strong>表現できます。
            <br />
            <span className="text-glider-ok">
              ✓ 値はブラウザに保存され、接続時に自動で機体へ送信されます（電源 OFF で消える機体側較正を毎回復元）。
            </span>
            <br />
            <span className="text-glider-textMute">
              ※ こちらは<strong>サーボの物理較正</strong>。制御の中立（真っすぐ）の微調整は
              Step 0 の <strong>Servo Trim(度)</strong> で行います。可動域の確認は Step 3 の
              <strong> Manual Check</strong> で舵を端まで動かして見ます。
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

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => resend()}
          disabled={!enabled}
          className="btn-ghost text-xs"
          title="保存済み較正値をもう一度機体へ送信"
        >
          ↻ 再送信
        </button>
        <button
          onClick={() => resetAll()}
          className="btn-ghost text-xs"
          title="全チャンネルを既定値 (1000 / 1500 / 2000 µs) に戻す"
        >
          既定値に戻す
        </button>
      </div>

      {/* チャンネルごとの較正 */}
      <div className="space-y-3">
        {CHANNELS.map((ch) => {
          const c = cal[ch.idx];
          const loUs = Math.min(c.min, c.max);
          const hiUs = Math.max(c.min, c.max);
          return (
            <div
              key={ch.idx}
              className="bg-glider-surface border border-glider-border rounded-md px-3 py-2.5 space-y-2.5"
            >
              {/* ラベル + reverse */}
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
                <label className="flex items-center gap-1.5 text-[11px] text-glider-textDim cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={c.reverse}
                    onChange={(e) => setReverse(ch.idx, e.target.checked)}
                    className="accent-current"
                    style={{ color: ch.color }}
                  />
                  反転 (reverse)
                </label>
              </div>

              {/* 可動域のビジュアル: 500..2500 のトラック上に min..max と center を表示 */}
              <div className="relative h-2 rounded-full bg-glider-panelHi/60 overflow-visible">
                <div
                  className="absolute h-2 rounded-full opacity-40"
                  style={{
                    left: `${pct(loUs)}%`,
                    width: `${Math.max(0, pct(hiUs) - pct(loUs))}%`,
                    background: ch.color,
                  }}
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-4 rounded"
                  style={{ left: `${pct(c.center)}%`, background: ch.color }}
                  title={`中立 ${c.center}µs`}
                />
              </div>

              {/* min / center / max 入力 */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {FIELDS.map((f) => {
                  const val = c[f.key];
                  const endLabel =
                    f.key === "min" ? ch.minLabel : f.key === "max" ? ch.maxLabel : "";
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
                          onClick={() => nudge(ch.idx, f.key, -STEP)}
                          className="bg-glider-surface border border-glider-border rounded
                                     text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                                     w-7 h-7 text-sm font-bold disabled:opacity-40"
                          tabIndex={-1}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min={US_ABS_MIN}
                          max={US_ABS_MAX}
                          step={STEP}
                          value={val}
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            if (Number.isFinite(n)) setField(ch.idx, f.key, n);
                          }}
                          className="bg-glider-surface border border-glider-border rounded text-center
                                     px-1 py-1 w-full text-sm font-mono font-bold text-glider-text
                                     focus:outline-none focus:ring-1 focus:ring-glider-accent/40"
                          aria-label={`${ch.label} ${f.label}`}
                          title={f.hint}
                        />
                        <button
                          type="button"
                          onClick={() => nudge(ch.idx, f.key, +STEP)}
                          className="bg-glider-surface border border-glider-border rounded
                                     text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                                     w-7 h-7 text-sm font-bold disabled:opacity-40"
                          tabIndex={-1}
                        >
                          +
                        </button>
                        <span className="text-[9px] text-glider-textMute">µs</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-[10px] text-glider-textMute font-mono">
        送信フォーマット:{" "}
        <code className="text-glider-textDim">smid 2 1500</code> /{" "}
        <code className="text-glider-textDim">smax 2 1850</code> /{" "}
        <code className="text-glider-textDim">smin 2 1200</code> /{" "}
        <code className="text-glider-textDim">srev 0 1</code>{" "}
        (ch 0=右/1=左/2=Elev, 500..2500µs)
      </div>
    </div>
  );
}
