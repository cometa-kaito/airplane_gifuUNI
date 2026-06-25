"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "./useTelemetry";

/**
 * useAutoTune — PID ゲイン自動調整 (Full Auto Tune) の単一の真実の源
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  方式: Ziegler-Nichols 限界感度法 (closed-loop / ultimate-gain method)
 *  動作環境: 風洞 (Wind Tunnel) 前提。舵が機体を実際に動かせる気流が必須。
 *           無風では surface を振っても roll/pitch が変化せず、ゲインの良否を測れない。
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  既存ファーム (glider_nRF52840.ino) を一切変更せず、次の標準コマンドだけで実現する:
 *    - `wt`                : WINDTUNNEL モード (PID 常時 ON / tilt safeguard・failsafe 抑制)
 *    - `kp|ki|kd <axis> v` : ゲイン設定
 *    - `target <axis> v`   : 目標角 (キック励振に使う)
 *    - `m` / `disarm`      : 緊急停止 (MANUAL → 中立、PID 停止)
 *
 *  手順 (軸ごと、roll → pitch を順に):
 *    1. wt に入り、対象軸を P 単独 (Ki=Kd=0) にする。target=0。
 *    2. Kp を kpStart から kpStep 刻みで上げていく。
 *    3. 各 Kp で「キック」(target を一瞬 ±kickDeg にして戻す) で励振し、
 *       数秒間テレメトリ (roll/pitch) を録って応答を解析する:
 *         - 振幅 (peak-to-peak)、周期 Tu、減衰比 (隣接ピーク振幅の比) を測る。
 *    4. 振動が「持続」する (減衰比 ≈ 1、振幅がしきい値超) Kp を極限ゲイン Ku、
 *       その周期を Tu とみなす。
 *    5. Z-N 式で Kp/Ki/Kd を算出し、自動で機体へ適用 (+ localStorage に保存)。
 *
 *  安全:
 *    - 故意に発振近傍まで攻めるため、|角度偏差| が safeAngleDeg を超えたら即中断
 *      (`m` → `disarm`)、ゲインを開始前の値へ復元する。
 *    - kpMax / 全体タイムアウト / STOP ボタンでいつでも中断可。
 *    - Wind Tunnel 中はファーム側 tilt safeguard が抑制されるため、この WebUI が
 *      唯一の角度安全網になる。
 *
 *  注意: 解析は 30Hz テレメトリ由来でノイズを含むため、relay 法ほど厳密ではない。
 *        教材 (Z-N 法) の自動化版という位置づけ。結果は応答を見て検証すること。
 */

export type AutoTuneAxis = "r" | "p";

export type ZNRule = "classic" | "pessen" | "some-overshoot" | "no-overshoot";

export const ZN_RULES: { key: ZNRule; label: string; hint: string }[] = [
  { key: "classic", label: "Classic PID", hint: "Kp=0.6Ku / Ti=0.5Tu / Td=0.125Tu。標準。やや行き過ぎあり。" },
  { key: "pessen", label: "Pessen Integral", hint: "Kp=0.7Ku / Ti=0.4Tu / Td=0.15Tu。応答速いが攻め気味。" },
  { key: "some-overshoot", label: "Some Overshoot", hint: "Kp=0.33Ku / Ti=0.5Tu / Td=0.33Tu。穏やか。" },
  { key: "no-overshoot", label: "No Overshoot", hint: "Kp=0.2Ku / Ti=0.5Tu / Td=0.33Tu。最も穏やか・最安全。" },
];

export type AutoTuneState =
  | "idle"
  | "preparing" // wt 投入 / P 単独化
  | "settling" // 現 Kp で過渡を落ち着かせ baseline 取得
  | "kicking" // target キック印加
  | "recording" // 応答録り
  | "analyzing" // 解析中 (一瞬)
  | "done" // 成功・適用済み
  | "aborted" // 安全/ユーザ中断
  | "failed"; // kpMax まで発振せず

export type AutoTuneConfig = {
  axes: AutoTuneAxis[];
  rule: ZNRule;
  kpStart: number;
  kpStep: number;
  kpMax: number;
  kickDeg: number; // キック目標角 [deg]
  kickMs: number; // キック保持時間 [ms]
  settleMs: number; // 各 Kp の整定待ち [ms]
  recordMs: number; // 応答録り時間 [ms]
  safeAngleDeg: number; // |偏差| 中断しきい値 [deg]
  oscThreshDeg: number; // 発振とみなす最小 peak-to-peak [deg]
  sustainRatio: number; // 持続とみなす最小減衰比 (隣接ピーク比)
};

export const DEFAULT_CONFIG: AutoTuneConfig = {
  axes: ["r"],
  rule: "classic",
  kpStart: 0.5,
  kpStep: 0.3,
  kpMax: 8.0,
  kickDeg: 8.0,
  kickMs: 160,
  settleMs: 900,
  recordMs: 3600,
  safeAngleDeg: 40.0,
  oscThreshDeg: 3.0,
  sustainRatio: 0.9,
};

// 機体ファーム / GainPanel と一致させるゲイン範囲 (クランプ用)
const GAIN_RANGE = {
  kp: { min: 0, max: 10 },
  ki: { min: 0, max: 5 },
  kd: { min: 0, max: 2 },
};

// GainPanel と共有する localStorage キー (適用したゲインをここにも反映し、
// 再接続時の自動同期で巻き戻らないようにする)。
const GAINS_STORAGE_KEY = "glider-webui:pid_gains";

export type AppliedGains = { Kp: number; Ki: number; Kd: number };

export type AutoTuneAxisResult = {
  axis: AutoTuneAxis;
  Ku: number;
  Tu: number; // [s]
  rule: ZNRule;
  gains: AppliedGains;
  clamped: boolean;
};

export type AutoTuneLive = {
  state: AutoTuneState;
  axis: AutoTuneAxis | null;
  kp: number; // 現在試行中の Kp
  amplitude: number; // 直近の peak-to-peak [deg]
  periodSec: number; // 直近の周期 [s]
  decayRatio: number; // 直近の減衰比
  stepIndex: number; // 何ステップ目か
  message: string;
};

const INITIAL_LIVE: AutoTuneLive = {
  state: "idle",
  axis: null,
  kp: 0,
  amplitude: 0,
  periodSec: 0,
  decayRatio: 0,
  stepIndex: 0,
  message: "",
};

class CancelledError extends Error {}
class SafetyError extends Error {
  constructor(public angle: number) {
    super(`safety abort: |dev|=${angle.toFixed(1)}deg`);
  }
}

type Sample = { t: number; v: number };

const axisValue = (f: TelemetryFrame, axis: AutoTuneAxis): number =>
  axis === "r" ? f.roll : f.pitch;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Z-N 式: 限界ゲイン Ku / 限界周期 Tu [s] と規則から Kp/Ki/Kd を算出 */
export function zieglerNichols(Ku: number, Tu: number, rule: ZNRule): AppliedGains {
  let Kp = 0,
    Ti = Infinity,
    Td = 0;
  switch (rule) {
    case "classic":
      Kp = 0.6 * Ku; Ti = 0.5 * Tu; Td = 0.125 * Tu; break;
    case "pessen":
      Kp = 0.7 * Ku; Ti = 0.4 * Tu; Td = 0.15 * Tu; break;
    case "some-overshoot":
      Kp = 0.33 * Ku; Ti = 0.5 * Tu; Td = 0.33 * Tu; break;
    case "no-overshoot":
      Kp = 0.2 * Ku; Ti = 0.5 * Tu; Td = 0.33 * Tu; break;
  }
  const Ki = Ti > 0 && Number.isFinite(Ti) ? Kp / Ti : 0;
  const Kd = Kp * Td;
  return { Kp, Ki, Kd };
}

/**
 * 録った応答波形を解析して、peak-to-peak 振幅・周期・減衰比を返す。
 * baseline からの偏差で評価する (取付オフセットを吸収)。
 */
function analyzeResponse(
  samples: Sample[],
  baseline: number,
  noiseDeg: number,
): { p2p: number; periodSec: number; decay: number; nPeaks: number } {
  if (samples.length < 8) return { p2p: 0, periodSec: 0, decay: 0, nPeaks: 0 };

  // 3点移動平均で軽く平滑化
  const dev: number[] = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)].v;
    const b = samples[i].v;
    const c = samples[Math.min(samples.length - 1, i + 1)].v;
    dev[i] = (a + b + c) / 3 - baseline;
  }

  let maxV = -Infinity,
    minV = Infinity;
  for (const d of dev) {
    if (d > maxV) maxV = d;
    if (d < minV) minV = d;
  }
  const p2p = maxV - minV;

  // ゼロ交差から周期を推定 (ノイズ帯は無視)
  const crossT: number[] = [];
  let prevSign = 0;
  for (let i = 0; i < dev.length; i++) {
    if (Math.abs(dev[i]) < noiseDeg) continue;
    const s = dev[i] > 0 ? 1 : -1;
    if (prevSign !== 0 && s !== prevSign) {
      // 線形補間で交差時刻を近似
      const t0 = samples[Math.max(0, i - 1)].t;
      const t1 = samples[i].t;
      crossT.push((t0 + t1) / 2);
    }
    prevSign = s;
  }
  let periodSec = 0;
  if (crossT.length >= 2) {
    let sum = 0;
    for (let i = 1; i < crossT.length; i++) sum += crossT[i] - crossT[i - 1];
    const halfPeriodMs = sum / (crossT.length - 1);
    periodSec = (2 * halfPeriodMs) / 1000;
  }

  // ピーク (局所極大の |dev|) を順に集め、隣接振幅の比 (減衰比) を測る
  const peakMags: number[] = [];
  for (let i = 1; i < dev.length - 1; i++) {
    const a = Math.abs(dev[i - 1]);
    const b = Math.abs(dev[i]);
    const c = Math.abs(dev[i + 1]);
    if (b >= a && b >= c && b > noiseDeg) {
      peakMags.push(b);
      i++; // 同一ピーク近傍の二重採用を避ける
    }
  }
  let decay = 0;
  if (peakMags.length >= 2) {
    const ratios: number[] = [];
    for (let i = 1; i < peakMags.length; i++) {
      if (peakMags[i - 1] > 1e-6) ratios.push(peakMags[i] / peakMags[i - 1]);
    }
    if (ratios.length) {
      ratios.sort((x, y) => x - y);
      decay = ratios[Math.floor(ratios.length / 2)]; // 中央値
    }
  }

  return { p2p, periodSec, decay, nPeaks: peakMags.length };
}

export type AutoTuneApi = {
  state: AutoTuneState;
  live: AutoTuneLive;
  results: AutoTuneAxisResult[];
  /** 適用前のゲイン (中断/Revert 用スナップショット)。null なら未取得。 */
  canRevert: boolean;
  start: (cfg: AutoTuneConfig) => void;
  stop: () => void;
  /** 直近 run の適用ゲインを開始前へ戻す (機体 + localStorage)。 */
  revert: () => void;
  /** 解析中の対象軸の現在値を読むための getter (パネルの live 表示用)。 */
  running: boolean;
};

export function useAutoTune(
  onSend: (cmd: string) => Promise<void>,
  attitudeRef: MutableRefObject<TelemetryFrame | null>,
  enabled: boolean,
): AutoTuneApi {
  const [state, setState] = useState<AutoTuneState>("idle");
  const [live, setLive] = useState<AutoTuneLive>(INITIAL_LIVE);
  const [results, setResults] = useState<AutoTuneAxisResult[]>([]);
  const [canRevert, setCanRevert] = useState(false);

  // run の世代管理 (stop / 再 start / unmount で世代を進めて旧 run を止める)
  const runIdRef = useRef(0);
  const runningRef = useRef(false);

  // 適用前ゲインのスナップショット (軸ごと)。Revert に使う。
  const snapshotRef = useRef<Record<AutoTuneAxis, AppliedGains> | null>(null);

  // monitor 内で参照する「いま録っている軸」
  const runningAxisRef = useRef<AutoTuneAxis | null>(null);

  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  const pushLive = useCallback((patch: Partial<AutoTuneLive>) => {
    setLive((prev) => ({ ...prev, ...patch }));
  }, []);

  const send = useCallback(async (cmd: string) => {
    await onSendRef.current(cmd);
    await new Promise((r) => setTimeout(r, 20));
  }, []);

  // localStorage 上の GainPanel ゲインへ反映 (再接続時の巻き戻り防止)
  const persistGain = useCallback(
    (axis: AutoTuneAxis, g: AppliedGains) => {
      try {
        const raw = window.localStorage.getItem(GAINS_STORAGE_KEY);
        const obj = raw ? (JSON.parse(raw) as Record<string, number>) : {};
        obj[`kp_${axis}`] = g.Kp;
        obj[`ki_${axis}`] = g.Ki;
        obj[`kd_${axis}`] = g.Kd;
        window.localStorage.setItem(GAINS_STORAGE_KEY, JSON.stringify(obj));
      } catch {
        // ignore
      }
    },
    [],
  );

  // 開始前ゲインを localStorage から復元 (無ければファーム既定にフォールバック)
  const readSnapshot = useCallback((): Record<AutoTuneAxis, AppliedGains> => {
    const def: Record<AutoTuneAxis, AppliedGains> = {
      r: { Kp: 1.0, Ki: 0.2, Kd: 0.02 },
      p: { Kp: 1.0, Ki: 0.2, Kd: 0.02 },
    };
    try {
      const raw = window.localStorage.getItem(GAINS_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, number>;
        (["r", "p"] as AutoTuneAxis[]).forEach((ax) => {
          const kp = obj[`kp_${ax}`];
          const ki = obj[`ki_${ax}`];
          const kd = obj[`kd_${ax}`];
          if (Number.isFinite(kp)) def[ax].Kp = kp;
          if (Number.isFinite(ki)) def[ax].Ki = ki;
          if (Number.isFinite(kd)) def[ax].Kd = kd;
        });
      }
    } catch {
      // ignore
    }
    return def;
  }, []);

  const applyGain = useCallback(
    async (axis: AutoTuneAxis, g: AppliedGains) => {
      await send(`kp ${axis} ${g.Kp.toFixed(3)}`);
      await send(`ki ${axis} ${g.Ki.toFixed(3)}`);
      await send(`kd ${axis} ${g.Kd.toFixed(3)}`);
      persistGain(axis, g);
    },
    [send, persistGain],
  );

  /**
   * ms 間テレメトリを監視し、安全違反 (|v-baseline|>safe) なら SafetyError。
   * collect=true ならサンプルを返す。run 世代が変われば CancelledError。
   */
  const monitor = useCallback(
    async (
      ms: number,
      myRun: number,
      baseline: number,
      safeAngleDeg: number,
      collect: boolean,
    ): Promise<Sample[]> => {
      const out: Sample[] = [];
      const t0 = performance.now();
      let lastSeq = -1;
      // baseline=NaN のときは安全判定を絶対角に対して行う (settle 前)
      const useDev = Number.isFinite(baseline);
      while (performance.now() - t0 < ms) {
        if (myRun !== runIdRef.current) throw new CancelledError();
        const f = attitudeRef.current;
        if (f) {
          const v = axisValue(f, runningAxisRef.current ?? "r");
          const dev = useDev ? v - baseline : v;
          if (Math.abs(dev) > safeAngleDeg) throw new SafetyError(Math.abs(dev));
          if (collect && f.seq !== lastSeq) {
            lastSeq = f.seq;
            out.push({ t: performance.now(), v });
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return out;
    },
    [attitudeRef],
  );

  const finishSafe = useCallback(
    async (restore: Record<AutoTuneAxis, AppliedGains> | null) => {
      // 緊急: MANUAL → 中立、PID 停止
      try {
        await onSendRef.current("m");
        await new Promise((r) => setTimeout(r, 20));
        await onSendRef.current("disarm");
        await new Promise((r) => setTimeout(r, 20));
      } catch {
        // ignore
      }
      if (restore) {
        for (const ax of ["r", "p"] as AutoTuneAxis[]) {
          try {
            await applyGain(ax, restore[ax]);
          } catch {
            // ignore
          }
        }
      }
    },
    [applyGain],
  );

  const run = useCallback(
    async (cfg: AutoTuneConfig) => {
      const myRun = ++runIdRef.current;
      runningRef.current = true;
      setResults([]);
      setState("preparing");
      pushLive({ ...INITIAL_LIVE, state: "preparing", message: "Wind Tunnel へ投入中…" });

      const snapshot = readSnapshot();
      snapshotRef.current = snapshot;
      setCanRevert(false);

      const accum: AutoTuneAxisResult[] = [];

      try {
        // wt 投入 + 両軸 target 0
        await send("wt");
        await send("target r 0");
        await send("target p 0");

        for (const axis of cfg.axes) {
          if (myRun !== runIdRef.current) throw new CancelledError();
          runningAxisRef.current = axis;
          const axisLabel = axis === "r" ? "roll" : "pitch";

          // 対象軸を P 単独化 (Ki=Kd=0)
          await send(`ki ${axis} 0`);
          await send(`kd ${axis} 0`);

          let Ku: number | null = null;
          let Tu = 0;
          let stepIndex = 0;

          for (
            let kp = cfg.kpStart;
            kp <= cfg.kpMax + 1e-9;
            kp += cfg.kpStep
          ) {
            if (myRun !== runIdRef.current) throw new CancelledError();
            stepIndex++;
            const kpR = Math.round(kp * 1000) / 1000;

            setState("settling");
            pushLive({
              state: "settling",
              axis,
              kp: kpR,
              stepIndex,
              message: `${axisLabel}: Kp=${kpR.toFixed(2)} 整定待ち`,
            });
            await send(`kp ${axis} ${kpR.toFixed(3)}`);
            await send(`target ${axis} 0`);

            // 整定 + baseline 取得 (この間は絶対角に対して安全判定)
            const settleSamples = await monitor(
              cfg.settleMs,
              myRun,
              NaN,
              cfg.safeAngleDeg + 20,
              true,
            );
            const tail = settleSamples.slice(-10);
            const baseline =
              tail.length > 0
                ? tail.reduce((s, x) => s + x.v, 0) / tail.length
                : 0;

            // キック励振
            setState("kicking");
            pushLive({ state: "kicking", message: `${axisLabel}: キック ${cfg.kickDeg}°` });
            await send(`target ${axis} ${cfg.kickDeg.toFixed(1)}`);
            await new Promise((r) => setTimeout(r, cfg.kickMs));
            await send(`target ${axis} 0`);

            // 応答録り
            setState("recording");
            pushLive({ state: "recording", message: `${axisLabel}: 応答測定中…` });
            const resp = await monitor(
              cfg.recordMs,
              myRun,
              baseline,
              cfg.safeAngleDeg,
              true,
            );

            setState("analyzing");
            const noise = Math.max(0.8, cfg.oscThreshDeg * 0.25);
            const m = analyzeResponse(resp, baseline, noise);
            pushLive({
              state: "analyzing",
              kp: kpR,
              amplitude: m.p2p,
              periodSec: m.periodSec,
              decayRatio: m.decay,
              message: `${axisLabel}: Kp=${kpR.toFixed(2)} p2p=${m.p2p.toFixed(
                1,
              )}° 減衰比=${m.decay.toFixed(2)}`,
            });

            const sustained =
              m.p2p >= cfg.oscThreshDeg &&
              m.periodSec > 0.05 &&
              m.nPeaks >= 2 &&
              m.decay >= cfg.sustainRatio;

            if (sustained) {
              Ku = kpR;
              Tu = m.periodSec;
              break;
            }
            // まだ減衰: Kp を上げて再試行
          }

          if (Ku == null) {
            // kpMax まで持続振動が見えず: この軸は失敗扱い。安全側へ戻す。
            await finishSafe(snapshot);
            setState("failed");
            pushLive({
              state: "failed",
              message: `${axisLabel}: Kp=${cfg.kpMax} まで発振せず。キック量↑ / 気流確認 / Zero を確認してください。`,
            });
            runningRef.current = false;
            return;
          }

          // Z-N 算出 + クランプ
          const raw = zieglerNichols(Ku, Tu, cfg.rule);
          const g: AppliedGains = {
            Kp: clamp(raw.Kp, GAIN_RANGE.kp.min, GAIN_RANGE.kp.max),
            Ki: clamp(raw.Ki, GAIN_RANGE.ki.min, GAIN_RANGE.ki.max),
            Kd: clamp(raw.Kd, GAIN_RANGE.kd.min, GAIN_RANGE.kd.max),
          };
          const clamped =
            g.Kp !== raw.Kp || g.Ki !== raw.Ki || g.Kd !== raw.Kd;

          // 自動で即適用
          await applyGain(axis, g);
          setCanRevert(true);

          const r: AutoTuneAxisResult = { axis, Ku, Tu, rule: cfg.rule, gains: g, clamped };
          accum.push(r);
          setResults([...accum]);
          pushLive({
            message: `${axisLabel}: Ku=${Ku.toFixed(2)} Tu=${Tu.toFixed(
              2,
            )}s → Kp=${g.Kp.toFixed(2)} Ki=${g.Ki.toFixed(2)} Kd=${g.Kd.toFixed(2)} 適用`,
          });
        }

        // 後始末: target 0、PID 停止 (servo 中立)。適用済みゲインは RAM に残る。
        runningAxisRef.current = null;
        await send("target r 0");
        await send("target p 0");
        await send("disarm");

        setState("done");
        pushLive({ state: "done", message: "完了。算出ゲインを適用しました。" });
      } catch (e) {
        if (e instanceof CancelledError) {
          await finishSafe(snapshot);
          setState("aborted");
          pushLive({ state: "aborted", message: "ユーザ操作で中断。ゲインを元に戻しました。" });
        } else if (e instanceof SafetyError) {
          await finishSafe(snapshot);
          setState("aborted");
          pushLive({
            state: "aborted",
            message: `安全中断: 偏差 ${e.angle.toFixed(0)}° > ${cfg.safeAngleDeg}°。ゲインを元に戻しました。`,
          });
        } else {
          await finishSafe(snapshot);
          setState("aborted");
          pushLive({ state: "aborted", message: `エラーで中断: ${String(e)}` });
        }
      } finally {
        runningRef.current = false;
        runningAxisRef.current = null;
      }
    },
    [send, monitor, applyGain, finishSafe, readSnapshot, pushLive],
  );

  const start = useCallback(
    (cfg: AutoTuneConfig) => {
      if (!enabled || runningRef.current) return;
      void run(cfg);
    },
    [enabled, run],
  );

  const stop = useCallback(() => {
    // 世代を進めて run 内の monitor/ループを CancelledError で抜けさせる
    runIdRef.current++;
  }, []);

  const revert = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap || runningRef.current) return;
    (async () => {
      for (const ax of ["r", "p"] as AutoTuneAxis[]) {
        try {
          await applyGain(ax, snap[ax]);
        } catch {
          // ignore
        }
      }
      setCanRevert(false);
      pushLive({ message: "開始前のゲインへ戻しました。" });
    })();
  }, [applyGain, pushLive]);

  // unmount / 切断で確実に停止
  useEffect(() => {
    return () => {
      runIdRef.current++;
    };
  }, []);
  useEffect(() => {
    if (!enabled) runIdRef.current++; // 切断時は進行中 run を止める
  }, [enabled]);

  return {
    state,
    live,
    results,
    canRevert,
    start,
    stop,
    revert,
    running: runningRef.current,
  };
}
