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
 * 既定間隔 750ms = failsafe 1500ms の半分。ジッタや一時的な送信失敗があっても
 * failsafe 発火前に必ず 1度は届く設計。
 *
 * 返り値:
 *   - sentCount:    累積送信回数 (UI 表示用)
 *   - lastErrorAt:  直近の送信失敗時刻 (null = 健全)
 */
export function useHeartbeat({
  enabled,
  intervalMs = 750,
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
