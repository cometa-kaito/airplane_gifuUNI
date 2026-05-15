"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * PID Gain Panel — Python ground_station.py の PID gains セクション相当の WebUI 版
 *
 * 3軸 × 4パラメータ (Kp / Ki / Kd / target) を個別に編集可能。
 * Python と同じ入力レンジ・ステップ:
 *   - Kp:     0..10,  step 0.1,  default 1.0
 *   - Ki:     0..5,   step 0.05, default 0.2
 *   - Kd:     0..2,   step 0.01, default 0.02
 *   - target: -90..90, step 1.0,  default 0
 *
 * 送信タイミング:
 *   - 値変更後、フォーカス離脱 (blur) または Enter キー
 *   - +/- ボタンクリック (即時)
 *   - "Apply All" ボタン (変更ある全項目をまとめて送信)
 *
 * 送信フォーマット: `{kp|ki|kd|target} {r|p|y} {value}` (Python ground_station と互換)
 *
 * 設定値は localStorage に保存。接続時に自動で機体へ送信。
 */

type Axis = "r" | "p" | "y";
type Param = "kp" | "ki" | "kd" | "target";

type ParamSpec = {
  key: Param;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  defaults: [number, number, number]; // [roll, pitch, yaw]
};

const PARAMS: ParamSpec[] = [
  { key: "kp",     label: "Kp",     min: 0,    max: 10, step: 0.1,  decimals: 3, defaults: [1.0, 1.0, 0.0] },
  { key: "ki",     label: "Ki",     min: 0,    max: 5,  step: 0.05, decimals: 3, defaults: [0.2, 0.2, 0.0] },
  { key: "kd",     label: "Kd",     min: 0,    max: 2,  step: 0.01, decimals: 3, defaults: [0.02, 0.02, 0.0] },
  { key: "target", label: "Target", min: -90,  max: 90, step: 1,    decimals: 1, defaults: [0.0, 0.0, 0.0] },
];

const AXES: { letter: Axis; label: string; color: string }[] = [
  { letter: "r", label: "roll",  color: "#ff5d6c" },
  { letter: "p", label: "pitch", color: "#3ddc97" },
  { letter: "y", label: "yaw",   color: "#5cc8ff" },
];

const AXIS_IDX: Record<Axis, number> = { r: 0, p: 1, y: 2 };

const STORAGE_KEY = "glider-webui:pid_gains";
const DFILTER_STORAGE_KEY = "glider-webui:dfilter";
const DFILTER_DEFAULT = 0.7;
const DFILTER_PRESETS: { value: number; label: string; hint: string }[] = [
  { value: 0,    label: "0 (raw)",  hint: "フィルタ無し (生 D)" },
  { value: 0.5,  label: "0.5",      hint: "軽 (~8 Hz)" },
  { value: 0.7,  label: "0.7",      hint: "標準 (~2.4 Hz)" },
  { value: 0.85, label: "0.85",     hint: "強 (~1.2 Hz)" },
  { value: 0.95, label: "0.95",     hint: "最大 (~0.4 Hz)" },
];

/** State: 12個の値を { kp_r: number, kp_p: number, ... } で扱う */
type GainsState = Record<string, number>; // key = `${param}_${axis}`

function key(param: Param, axis: Axis) {
  return `${param}_${axis}`;
}

function defaults(): GainsState {
  const out: GainsState = {};
  for (const p of PARAMS) {
    for (const a of AXES) {
      out[key(p.key, a.letter)] = p.defaults[AXIS_IDX[a.letter]];
    }
  }
  return out;
}

export function GainPanel({
  onSend,
  enabled,
}: {
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  // editing: 入力中の値 (string で持ち、blur/Enter で commit)
  const [values, setValues] = useState<GainsState>(defaults());
  // applied: 直近送信に成功した値
  const [applied, setApplied] = useState<GainsState>(defaults());
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // D-term LPF (機体側 dfilter コマンド) の値
  const [dfilter, setDfilter] = useState<number>(DFILTER_DEFAULT);
  const [dfilterApplied, setDfilterApplied] = useState<number>(DFILTER_DEFAULT);
  const [dfilterBusy, setDfilterBusy] = useState(false);

  // closure 経由ではなく ref で最新を読む
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const dfilterAppliedRef = useRef(dfilterApplied);
  dfilterAppliedRef.current = dfilterApplied;

  // 初期値ロード
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v) {
        const parsed = JSON.parse(v) as Partial<GainsState>;
        const next = { ...defaults() };
        for (const k of Object.keys(next)) {
          const n = parsed[k];
          if (typeof n === "number" && Number.isFinite(n)) {
            next[k] = n;
          }
        }
        setValues(next);
        setApplied(next);
      }
      const df = window.localStorage.getItem(DFILTER_STORAGE_KEY);
      if (df != null) {
        const n = parseFloat(df);
        if (Number.isFinite(n) && n >= 0 && n < 1) {
          setDfilter(n);
          setDfilterApplied(n);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // 接続したら applied 値を機体へ自動同期
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      autoSyncedRef.current = false;
      return;
    }
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;

    // 逐次送信 (連続送信で文字溢れしないよう小さく間隔を入れる)
    (async () => {
      for (const p of PARAMS) {
        for (const a of AXES) {
          const k = key(p.key, a.letter);
          const v = appliedRef.current[k];
          try {
            await onSend(`${p.key} ${a.letter} ${v.toFixed(p.decimals)}`);
            await new Promise((r) => setTimeout(r, 15));
          } catch {
            // 切断時は静かに止める
            autoSyncedRef.current = false;
            return;
          }
        }
      }
      // dfilter も送信
      try {
        await onSend(`dfilter ${dfilterAppliedRef.current.toFixed(3)}`);
      } catch {
        // ignore
      }
    })();
  }, [enabled, onSend]);

  // localStorage 保存
  const persist = useCallback((next: GainsState) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const sendOne = useCallback(
    async (param: Param, axis: Axis, value: number) => {
      const spec = PARAMS.find((p) => p.key === param)!;
      const v = Math.max(spec.min, Math.min(spec.max, value));
      const k = key(param, axis);
      setBusyKey(k);
      try {
        await onSend(`${param} ${axis} ${v.toFixed(spec.decimals)}`);
        setApplied((prev) => {
          const next = { ...prev, [k]: v };
          persist(next);
          return next;
        });
        setValues((prev) => ({ ...prev, [k]: v }));
      } catch (e) {
        console.error(`[GainPanel] ${param} ${axis} failed:`, e);
      } finally {
        setBusyKey(null);
      }
    },
    [onSend, persist],
  );

  const applyAll = useCallback(async () => {
    if (!enabled) return;
    for (const p of PARAMS) {
      for (const a of AXES) {
        const k = key(p.key, a.letter);
        if (values[k] !== applied[k]) {
          await sendOne(p.key, a.letter, values[k]);
          await new Promise((r) => setTimeout(r, 15));
        }
      }
    }
  }, [enabled, values, applied, sendOne]);

  const resetAll = useCallback(() => {
    const d = defaults();
    setValues(d);
  }, []);

  const applyDfilter = useCallback(
    async (value?: number) => {
      const v = Math.max(0, Math.min(0.99, value ?? dfilter));
      if (!enabled || dfilterBusy) return;
      setDfilterBusy(true);
      try {
        await onSend(`dfilter ${v.toFixed(3)}`);
        setDfilterApplied(v);
        setDfilter(v);
        try {
          window.localStorage.setItem(DFILTER_STORAGE_KEY, String(v));
        } catch {
          // ignore
        }
      } catch (e) {
        console.error("[GainPanel] dfilter failed:", e);
      } finally {
        setDfilterBusy(false);
      }
    },
    [dfilter, enabled, dfilterBusy, onSend],
  );

  // dfilter の参考カットオフ周波数 (50Hz サンプリング, 1次 IIR)
  const dfilterCutoffHz = (a: number) => {
    if (a <= 0) return Infinity;
    if (a >= 1) return 0;
    const dt = 0.02; // 50Hz
    const tau = (dt * a) / (1 - a);
    return 1 / (2 * Math.PI * tau);
  };

  const dirtyCount = Object.keys(values).filter(
    (k) => values[k] !== applied[k],
  ).length;

  return (
    <div className="card-pad space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">PID Gains · 3軸ゲイン + 目標角</div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            Blur (フォーカスを外す) または Enter で送信。+/- ボタンは即時送信。
            接続時に保存値を機体へ自動同期します。
          </div>
        </div>
        <div className="flex items-center gap-2">
          {dirtyCount > 0 && (
            <span className="text-[10px] text-glider-warn font-mono">
              {dirtyCount} unsaved
            </span>
          )}
          <button
            onClick={resetAll}
            className="btn-ghost text-xs"
            title="既定値に戻す (送信しない)"
          >
            ↺ Defaults
          </button>
          <button
            onClick={applyAll}
            disabled={!enabled || dirtyCount === 0}
            className="btn-primary"
            title="変更ある全項目を機体へ送信"
          >
            Apply All
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-glider-textMute">
              <th className="text-left py-1 pr-3 w-24"></th>
              {PARAMS.map((p) => (
                <th key={p.key} className="text-center py-1 px-2 font-semibold">
                  {p.label}
                  <div className="text-[9px] text-glider-textMute/70 normal-case font-normal">
                    {p.min}..{p.max}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AXES.map((axis) => (
              <tr key={axis.letter}>
                <td
                  className="py-1.5 pr-3 font-bold text-xs"
                  style={{ color: axis.color }}
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full mr-1.5"
                    style={{
                      background: axis.color,
                      boxShadow: `0 0 6px ${axis.color}`,
                    }}
                  />
                  {axis.label}
                  <div className="text-[9px] text-glider-textMute font-normal pl-3.5">
                    {axis.letter}
                  </div>
                </td>
                {PARAMS.map((p) => {
                  const k = key(p.key, axis.letter);
                  const cur = values[k];
                  const ap = applied[k];
                  const dirty = cur !== ap;
                  const busy = busyKey === k;
                  return (
                    <td key={p.key} className="py-1.5 px-1">
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.max(
                              p.min,
                              Math.min(p.max, cur - p.step),
                            );
                            if (enabled) {
                              sendOne(p.key, axis.letter, next);
                            } else {
                              setValues((prev) => ({ ...prev, [k]: next }));
                            }
                          }}
                          disabled={busy || cur <= p.min}
                          className="bg-glider-surface border border-glider-border rounded
                                     text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                                     w-6 h-7 text-sm font-bold disabled:opacity-40"
                          tabIndex={-1}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min={p.min}
                          max={p.max}
                          step={p.step}
                          value={cur}
                          onChange={(e) => {
                            const n = parseFloat(e.target.value);
                            setValues((prev) => ({
                              ...prev,
                              [k]: Number.isFinite(n) ? n : prev[k],
                            }));
                          }}
                          onBlur={() => {
                            if (enabled && cur !== ap) {
                              sendOne(p.key, axis.letter, cur);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            }
                          }}
                          className={`bg-glider-surface border rounded text-center
                                      px-1 py-1 w-16 text-xs font-mono
                                      focus:outline-none focus:ring-1 focus:ring-glider-accent/40
                                      ${
                                        dirty
                                          ? "border-glider-warn text-glider-warn"
                                          : "border-glider-border text-glider-text"
                                      }
                                      ${busy ? "opacity-50" : ""}`}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.max(
                              p.min,
                              Math.min(p.max, cur + p.step),
                            );
                            if (enabled) {
                              sendOne(p.key, axis.letter, next);
                            } else {
                              setValues((prev) => ({ ...prev, [k]: next }));
                            }
                          }}
                          disabled={busy || cur >= p.max}
                          className="bg-glider-surface border border-glider-border rounded
                                     text-glider-textDim hover:bg-glider-panelHi hover:border-glider-borderHi
                                     w-6 h-7 text-sm font-bold disabled:opacity-40"
                          tabIndex={-1}
                        >
                          +
                        </button>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ============ D-term LPF ============ */}
      <div className="border-t border-glider-border/50 pt-3 space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-bold text-glider-text">
              D-term LPF · D 項ローパスフィルタ
            </div>
            <div className="text-[11px] text-glider-textMute mt-0.5 leading-snug">
              D 項は <code className="font-mono text-glider-textDim">(e - prevE) / dt</code> で計算され dt=20ms では IMU 雑音を約 50倍に増幅します。
              <strong>サーボの「ぴくぴく」の主因。</strong>1次 IIR で高周波だけ落とします。
              0 = 生 D / 大 = 滑らか (応答は遅延)
            </div>
          </div>
          <div
            className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
              dfilterApplied === 0
                ? "bg-glider-warn/10 text-glider-warn"
                : "bg-glider-ok/10 text-glider-ok"
            }`}
          >
            {dfilterApplied === 0 ? "RAW (no filter)" : `α=${dfilterApplied.toFixed(2)}`}
          </div>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              α (0..0.99)
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setDfilter((v) => Math.max(0, Math.round((v - 0.05) * 100) / 100))}
                className="btn-ghost px-2 py-1.5 text-sm"
              >
                −
              </button>
              <input
                type="number"
                min={0}
                max={0.99}
                step={0.05}
                value={dfilter}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  setDfilter(
                    Number.isFinite(n) ? Math.max(0, Math.min(0.99, n)) : 0,
                  );
                }}
                onBlur={() => {
                  if (enabled && dfilter !== dfilterApplied) applyDfilter();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className={`bg-glider-surface border rounded text-center
                            px-2 py-1.5 w-20 text-sm font-mono font-bold
                            focus:outline-none focus:ring-1 focus:ring-glider-accent/40
                            ${
                              dfilter !== dfilterApplied
                                ? "border-glider-warn text-glider-warn"
                                : "border-glider-border text-glider-text"
                            }`}
              />
              <button
                type="button"
                onClick={() => setDfilter((v) => Math.min(0.99, Math.round((v + 0.05) * 100) / 100))}
                className="btn-ghost px-2 py-1.5 text-sm"
              >
                +
              </button>
            </div>
          </div>

          <button
            onClick={() => applyDfilter()}
            disabled={!enabled || dfilterBusy || dfilter === dfilterApplied}
            className="btn-primary"
          >
            {dfilterBusy ? "..." : "Apply"}
          </button>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              Presets
            </span>
            <div className="flex gap-1 flex-wrap">
              {DFILTER_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => applyDfilter(p.value)}
                  disabled={!enabled || dfilterBusy}
                  title={p.hint}
                  className={`px-2.5 py-1.5 text-xs font-bold rounded-md border transition ${
                    Math.abs(dfilterApplied - p.value) < 0.001
                      ? p.value === 0
                        ? "bg-glider-warn/15 border-glider-warn text-glider-warn"
                        : "bg-glider-accent/15 border-glider-accent text-glider-accent"
                      : "bg-glider-surface border-glider-border text-glider-textDim hover:border-glider-borderHi"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-0.5 ml-auto text-right">
            <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              ~Cutoff
            </span>
            <span className="font-mono text-sm text-glider-text">
              {Number.isFinite(dfilterCutoffHz(dfilter))
                ? `${dfilterCutoffHz(dfilter).toFixed(1)} Hz`
                : "∞"}
            </span>
            <span className="text-[9px] text-glider-textMute font-mono">
              @ 50 Hz サンプリング
            </span>
          </div>
        </div>
      </div>

      <div className="text-[10px] text-glider-textMute font-mono">
        送信フォーマット: <code className="text-glider-textDim">kp p 1.5</code> /{" "}
        <code className="text-glider-textDim">target r 0</code> /{" "}
        <code className="text-glider-textDim">dfilter 0.7</code> など (Python ground_station と互換)
      </div>
    </div>
  );
}
