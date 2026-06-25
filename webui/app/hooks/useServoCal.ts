"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useServoCal — 物理サーボ較正（subtrim + エンドポイント, µs）の単一の真実の源
 *
 * 背景:
 *   旧ファームは「論理舵角 ±90° → 0..180° → servo.write()」と固定変換していたが、
 *   実際の中立・可動域・左右(上下)の非対称は、サーボホーン長 / リンケージ /
 *   取付向きで決まり、固定 ±90 では表現できない（突き当たり stall / 可動不足）。
 *   そこでサーボごとに次をパルス幅(µs)で持ち、接続のたびに機体へ送る:
 *     - center (smid) … 中立(subtrim)。論理 0° のパルス。
 *     - max    (smax) … 論理 +90° 側の機械端（エルロン: 片側 / エレベータ: 上）。
 *     - min    (smin) … 論理 -90° 側の機械端（エルロン: 反対側 / エレベータ: 下）。
 *     - reverse(srev) … 取付向きの出力反転。
 *
 * 機体側ファーム (glider_nRF52840.ino):
 *   - `smin|smid|smax <ch 0..2> <us>` / `srev <ch 0..2> <0|1>`
 *   - 制御出力(論理角 ±90°)を center から min/max へ線形(左右非対称可)に写像し、
 *     最終パルスを [min,max] でクランプして機械端の突き当たりを防ぐ。
 *   - 較正値は機体側 RAM のみ保持 → 電源 OFF で消える（ここの保存値から毎回復元）。
 *
 * 設計は useTrim と同じ:
 *   - localStorage に保存し、接続(再接続)のたびに機体へ自動送信。
 *   - 各 setter は即時送信 + 永続化。
 */

export type ServoCalChannel = {
  min: number;
  center: number;
  max: number;
  reverse: boolean;
};
export type ServoCalState = [ServoCalChannel, ServoCalChannel, ServoCalChannel];

export const US_ABS_MIN = 500;
export const US_ABS_MAX = 2500;

// 既定はファームと一致させる（center=1500, min/max=1000/2000）。
// reverse は既定 {R 反転 / L 正転 / E 反転}（従来の出力方向と同じ）。
const DEFAULTS: ServoCalState = [
  { min: 1000, center: 1500, max: 2000, reverse: true },
  { min: 1000, center: 1500, max: 2000, reverse: false },
  { min: 1000, center: 1500, max: 2000, reverse: true },
];

const STORAGE_KEY = "glider-webui:servo_cal";

export const clampUs = (v: number): number =>
  Math.max(US_ABS_MIN, Math.min(US_ABS_MAX, Math.round(v)));

function cloneDefaults(): ServoCalState {
  return DEFAULTS.map((c) => ({ ...c })) as ServoCalState;
}

function sanitize(raw: unknown): ServoCalState {
  const out = cloneDefaults();
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < 3; i++) {
    const c = raw[i] as Partial<ServoCalChannel> | undefined;
    if (!c) continue;
    if (typeof c.min === "number" && Number.isFinite(c.min)) out[i].min = clampUs(c.min);
    if (typeof c.center === "number" && Number.isFinite(c.center)) out[i].center = clampUs(c.center);
    if (typeof c.max === "number" && Number.isFinite(c.max)) out[i].max = clampUs(c.max);
    if (typeof c.reverse === "boolean") out[i].reverse = c.reverse;
  }
  return out;
}

export type ServoCalField = "min" | "center" | "max";

export type ServoCalApi = {
  /** 保存された較正値。接続時に機体へ自動送信される。 */
  cal: ServoCalState;
  /** localStorage 読み込み完了フラグ。 */
  hydrated: boolean;
  /** 1 チャンネルの min/center/max をセット（即送信 + 永続化）。 */
  setField: (idx: 0 | 1 | 2, field: ServoCalField, us: number) => void;
  /** 1 チャンネルの reverse をセット（即送信 + 永続化）。 */
  setReverse: (idx: 0 | 1 | 2, reverse: boolean) => void;
  /** 全チャンネルを既定値に戻す（即送信 + 永続化）。 */
  resetAll: () => void;
  /** 保存済み較正値をもう一度すべて機体へ送信する。 */
  resend: () => void;
  /** 較正ジョグ: 指定 ch を生 µs で直接駆動（DISARMED 時のみ機体側で有効）。永続化しない。 */
  jog: (idx: 0 | 1 | 2, us: number) => void;
  /** 較正ジョグ解除（1 ch）。 */
  jogOff: (idx: 0 | 1 | 2) => void;
  /** 較正ジョグ解除（全 ch）。パネル離脱・切断時に呼ぶ。 */
  jogOffAll: () => void;
};

const FIELD_CMD: Record<ServoCalField, "smin" | "smid" | "smax"> = {
  min: "smin",
  center: "smid",
  max: "smax",
};

export function useServoCal(
  onSend: (cmd: string) => Promise<void>,
  enabled: boolean,
): ServoCalApi {
  const [cal, setCal] = useState<ServoCalState>(cloneDefaults);
  const [hydrated, setHydrated] = useState(false);

  const calRef = useRef(cal);
  calRef.current = cal;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // 起動時: 保存済み較正値を読み込む
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setCal(sanitize(JSON.parse(raw)));
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  const persist = useCallback((next: ServoCalState) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  // 1 チャンネル全項目を機体へ送信（未接続時は何もしない）。
  const sendChannel = useCallback(
    async (idx: number, c: ServoCalChannel) => {
      if (!enabledRef.current) return;
      // smid(中立) → smax → smin → srev の順。各送信間に小さく間隔（文字溢れ防止）。
      const lines = [
        `smid ${idx} ${c.center}`,
        `smax ${idx} ${c.max}`,
        `smin ${idx} ${c.min}`,
        `srev ${idx} ${c.reverse ? 1 : 0}`,
      ];
      for (const line of lines) {
        await onSend(line);
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    [onSend],
  );

  // 接続(再接続)のたびに保存済み較正値を全送信
  const syncedRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      syncedRef.current = false;
      return;
    }
    if (syncedRef.current) return;
    syncedRef.current = true;
    (async () => {
      try {
        for (let i = 0; i < 3; i++) {
          await sendChannel(i, calRef.current[i]);
        }
      } catch {
        // 切断時はリセットして次回接続で再試行
        syncedRef.current = false;
      }
    })();
  }, [enabled, sendChannel]);

  const sendOne = useCallback(
    (cmd: string) => {
      if (!enabledRef.current) return;
      onSend(cmd).catch(() => {
        // 切断等。UI 状態は維持（再接続時のオートシンクで復旧）。
      });
    },
    [onSend],
  );

  const setField = useCallback(
    (idx: 0 | 1 | 2, field: ServoCalField, us: number) => {
      const v = clampUs(us);
      setCal((prev) => {
        const next = prev.map((c) => ({ ...c })) as ServoCalState;
        next[idx][field] = v;
        calRef.current = next;
        persist(next);
        return next;
      });
      sendOne(`${FIELD_CMD[field]} ${idx} ${v}`);
    },
    [persist, sendOne],
  );

  const setReverse = useCallback(
    (idx: 0 | 1 | 2, reverse: boolean) => {
      setCal((prev) => {
        const next = prev.map((c) => ({ ...c })) as ServoCalState;
        next[idx].reverse = reverse;
        calRef.current = next;
        persist(next);
        return next;
      });
      sendOne(`srev ${idx} ${reverse ? 1 : 0}`);
    },
    [persist, sendOne],
  );

  const resetAll = useCallback(() => {
    const d = cloneDefaults();
    calRef.current = d;
    setCal(d);
    persist(d);
    if (!enabledRef.current) return;
    (async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await sendChannel(i, d[i]);
        } catch {
          return;
        }
      }
    })();
  }, [persist, sendChannel]);

  const resend = useCallback(() => {
    if (!enabledRef.current) return;
    (async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await sendChannel(i, calRef.current[i]);
        } catch {
          return;
        }
      }
    })();
  }, [sendChannel]);

  // ---- 較正ジョグ (sjog) ----
  //   機体側は DISARMED 時のみ生 µs で直接駆動。較正値(localStorage)は変更しない。
  const jog = useCallback(
    (idx: 0 | 1 | 2, us: number) => {
      if (!enabledRef.current) return;
      onSend(`sjog ${idx} ${Math.round(clampUs(us))}`).catch(() => {});
    },
    [onSend],
  );

  const jogOff = useCallback(
    (idx: 0 | 1 | 2) => {
      if (!enabledRef.current) return;
      onSend(`sjog ${idx} off`).catch(() => {});
    },
    [onSend],
  );

  const jogOffAll = useCallback(() => {
    if (!enabledRef.current) return;
    (async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await onSend(`sjog ${i} off`);
          await new Promise((r) => setTimeout(r, 12));
        } catch {
          return;
        }
      }
    })();
  }, [onSend]);

  return { cal, hydrated, setField, setReverse, resetAll, resend, jog, jogOff, jogOffAll };
}
