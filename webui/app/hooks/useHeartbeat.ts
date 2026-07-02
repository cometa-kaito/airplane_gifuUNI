"use client";

import { useEffect, useRef, useState } from "react";

/**
 * ハートビート送信フック。
 *
 * 機体側ファームウェアは failsafeTimeoutMs (既定 1500ms) 間アップリンクが
 * 途絶えると自動的に MANUAL + trim=0 に強制復帰する。
 * 通常運用ではユーザーが UI に触っていなくても uplink を生存させたいので、
 * 接続中はバックグラウンドで `ping` コマンドを定期送信する。
 *
 * 既定間隔 300ms (failsafe 既定 1500ms の 1/5)。
 * 旧値 750ms では ping 1〜2 発のロスト (ESP-NOW 不安定時に普通に起きる) で
 * failsafe が発火し、機体側 trim=0 リセット → UI と機体のサーボ状態乖離の
 * 主要因になっていた。300ms なら連続 4 発落ちても発火しない。
 * ping は 5 byte/行 なので帯域・機体側処理とも影響は無視できる。
 *
 * 返り値:
 *   - sentCount:    累積送信回数 (UI 表示用)
 *   - lastErrorAt:  直近の送信失敗時刻 (null = 健全)
 */
export function useHeartbeat({
  enabled,
  intervalMs = 300,
  onSend,
}: {
  enabled: boolean;
  intervalMs?: number;
  onSend: (cmd: string) => Promise<void>;
}) {
  const [sentCount, setSentCount] = useState(0);
  const [lastErrorAt, setLastErrorAt] = useState<number | null>(null);

  // closure 経由で onSend / enabled を最新に保つ
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const busyRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;

    const tick = async () => {
      if (stopped || !enabledRef.current || busyRef.current) return;
      busyRef.current = true;
      try {
        await onSendRef.current("ping");
        if (!stopped) {
          setSentCount((n) => n + 1);
        }
      } catch (e) {
        if (!stopped) {
          setLastErrorAt(Date.now());
          // 静かに失敗 (接続切れの可能性)
          console.debug("[heartbeat] ping failed:", e);
        }
      } finally {
        busyRef.current = false;
      }
    };

    // 接続直後はすぐ1発投げて failsafe を即クリア
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [enabled, intervalMs]);

  return { sentCount, lastErrorAt };
}
