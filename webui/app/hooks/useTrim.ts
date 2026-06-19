"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useTrim — サーボ中立トリム (s0/s1/s2) の単一の真実の源
 *
 * 背景:
 *   自作エルロンは機械的な「真っすぐ」がサーボ角 0° とは限らない。
 *   そこで各舵の中立角 (trim) を初期設定として保存しておき、
 *   接続のたびに機体へ自動送信する。
 *
 * 機体側ファーム (glider_nRF52840.ino):
 *   - `s0 <deg>` / `s1 <deg>` / `s2 <deg>` で trim[0..2] をセット (-90..+90)
 *   - MANUAL モードでは servo = trim が直接出力される (中立合わせはここで行う)
 *   - trim は機体側 RAM のみ保持 → 電源 OFF で消える
 *
 * 設計:
 *   - `neutral` … localStorage に保存される「定義済み中立」(= 初期設定)。
 *                 接続時に機体へ自動送信される。
 *   - `live`    … 現在機体へ送っている値。中立 + 一時的なテスト偏向 (QuickControl)。
 *   TrimSetupPanel は neutral を編集し、QuickControl は live を一時的に動かす。
 *   両者が同じインスタンスを共有することで firmware の trimDeg[] を奪い合わない。
 */

export type TrimState = { s0: number; s1: number; s2: number };

const KEYS = ["s0", "s1", "s2"] as const;
const ZERO: TrimState = { s0: 0, s1: 0, s2: 0 };
const STORAGE_KEY = "glider-webui:trim_neutral";

export const clampDeg = (v: number): number =>
  Math.max(-90, Math.min(90, Math.round(v)));

function sanitize(p: Partial<TrimState> | null | undefined): TrimState {
  const pick = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? clampDeg(v) : 0;
  return { s0: pick(p?.s0), s1: pick(p?.s1), s2: pick(p?.s2) };
}

export type TrimApi = {
  /** 保存された中立 (初期設定)。接続時に機体へ自動送信される。 */
  neutral: TrimState;
  /** 現在機体へ送っている値 (中立 + 一時的なテスト偏向)。 */
  live: TrimState;
  /** localStorage 読み込み完了フラグ (SSR/初期化対策)。 */
  hydrated: boolean;
  /** 1 チャンネルの中立をセット (即送信 + 永続化)。live も追従する。 */
  setNeutralChannel: (idx: 0 | 1 | 2, value: number) => void;
  /** 全チャンネルの中立を 0 にリセット。 */
  resetNeutral: () => void;
  /** live を一時的に動かす (中立は変えない)。QuickControl の D-Pad 用。 */
  nudgeLive: (idx: 0 | 1 | 2, delta: number) => void;
  /** live を保存済み中立に戻す。 */
  recallNeutral: () => void;
  /** 保存済み中立をもう一度機体へ送信する。 */
  resendNeutral: () => void;
};

export function useTrim(
  onSend: (cmd: string) => Promise<void>,
  enabled: boolean,
): TrimApi {
  const [neutral, setNeutral] = useState<TrimState>(ZERO);
  const [live, setLive] = useState<TrimState>(ZERO);
  const [hydrated, setHydrated] = useState(false);

  const neutralRef = useRef(neutral);
  neutralRef.current = neutral;
  const liveRef = useRef(live);
  liveRef.current = live;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // 起動時: 保存済み中立を読み込む
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const n = sanitize(JSON.parse(raw) as Partial<TrimState>);
        setNeutral(n);
        setLive(n);
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  const persist = useCallback((n: TrimState) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(n));
    } catch {
      // ignore
    }
  }, []);

  // 1 チャンネルを機体へ送信 (未接続時は何もしない)
  const sendCh = useCallback(
    (idx: 0 | 1 | 2, v: number) => {
      if (!enabledRef.current) return;
      onSend(`s${idx} ${v}`).catch(() => {
        // 切断等。UI 状態は維持 (再接続時のオートシンクで復旧)
      });
    },
    [onSend],
  );

  // 接続 (再接続) のたびに保存済み中立を機体へ自動送信
  const syncedRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      syncedRef.current = false;
      return;
    }
    if (syncedRef.current) return;
    syncedRef.current = true;
    (async () => {
      const n = neutralRef.current;
      for (let i = 0; i < 3; i++) {
        try {
          await onSend(`s${i} ${n[KEYS[i]]}`);
          // 連続送信で文字溢れしないよう小さく間隔 (GainPanel と同じ作法)
          await new Promise((r) => setTimeout(r, 15));
        } catch {
          syncedRef.current = false;
          return;
        }
      }
      setLive({ ...n });
    })();
  }, [enabled, onSend]);

  const setNeutralChannel = useCallback(
    (idx: 0 | 1 | 2, value: number) => {
      const v = clampDeg(value);
      const k = KEYS[idx];
      setNeutral((prev) => {
        const next = { ...prev, [k]: v };
        neutralRef.current = next;
        persist(next);
        return next;
      });
      setLive((prev) => {
        const next = { ...prev, [k]: v };
        liveRef.current = next;
        return next;
      });
      sendCh(idx, v);
    },
    [persist, sendCh],
  );

  const resetNeutral = useCallback(() => {
    const z = { ...ZERO };
    neutralRef.current = z;
    liveRef.current = z;
    setNeutral(z);
    setLive(z);
    persist(z);
    sendCh(0, 0);
    sendCh(1, 0);
    sendCh(2, 0);
  }, [persist, sendCh]);

  const nudgeLive = useCallback(
    (idx: 0 | 1 | 2, delta: number) => {
      const v = clampDeg(liveRef.current[KEYS[idx]] + delta);
      const k = KEYS[idx];
      setLive((prev) => {
        const next = { ...prev, [k]: v };
        liveRef.current = next;
        return next;
      });
      sendCh(idx, v);
    },
    [sendCh],
  );

  const recallNeutral = useCallback(() => {
    const n = { ...neutralRef.current };
    liveRef.current = n;
    setLive(n);
    sendCh(0, n.s0);
    sendCh(1, n.s1);
    sendCh(2, n.s2);
  }, [sendCh]);

  const resendNeutral = recallNeutral;

  return {
    neutral,
    live,
    hydrated,
    setNeutralChannel,
    resetNeutral,
    nudgeLive,
    recallNeutral,
    resendNeutral,
  };
}
