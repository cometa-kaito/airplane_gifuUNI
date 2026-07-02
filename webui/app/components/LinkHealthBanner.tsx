"use client";

import { useEffect, useState } from "react";
import type { ReliableLinkApi } from "../hooks/useReliableLink";

/**
 * LinkHealthBanner — 無線リンクと機体状態の健全性を1か所で知らせるバナー。
 *
 * 表示条件 (上から優先):
 *   1. テレメトリ途絶 (接続中なのに機体からフレームが来ない) … 赤
 *   2. 機体 FAILSAFE 発火中 (機体は MANUAL + trim=0 に退避)   … 赤
 *   3. SAFEGUARD 発火 (姿勢角超過で機体が安全リセット)         … 琥珀 (dismiss 可)
 *   4. 未達コマンドあり (再送しても機体から確認が取れなかった)  … 琥珀 (一括再送)
 *   5. 自動再同期完了                                          … 緑 (5秒で消える)
 *
 * 問題が無いときは何も描画しない (画面を占有しない)。
 */
export function LinkHealthBanner({
  link,
  connected,
}: {
  link: ReliableLinkApi;
  connected: boolean;
}) {
  // 再同期完了トースト (5 秒で自動消灯)
  const [showResynced, setShowResynced] = useState(false);
  useEffect(() => {
    if (link.lastResyncAt == null) return;
    setShowResynced(true);
    const id = window.setTimeout(() => setShowResynced(false), 5000);
    return () => window.clearTimeout(id);
  }, [link.lastResyncAt]);

  if (!connected) return null;

  const items: JSX.Element[] = [];

  if (link.quality === "lost") {
    items.push(
      <div
        key="lost"
        className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-red-50 ring-1 ring-red-200 text-red-700"
        role="alert"
      >
        <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulseWarn shrink-0" aria-hidden />
        <div className="text-sm">
          <strong className="font-semibold">機体からのテレメトリが途絶しています。</strong>{" "}
          電源・距離・アンテナ向きを確認してください。この間のサーボ設定操作は機体に届いていない可能性があります (回復後に自動再送されます)。
        </div>
      </div>,
    );
  }

  if (link.failsafeActive) {
    items.push(
      <div
        key="failsafe"
        className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-red-50 ring-1 ring-red-200 text-red-700"
        role="alert"
      >
        <span className="text-base shrink-0" aria-hidden>
          🛑
        </span>
        <div className="text-sm">
          <strong className="font-semibold">機体 FAILSAFE 発火中 — 機体は MANUAL + trim=0 に退避しています。</strong>{" "}
          UI のトリム表示と実機は一時的に一致しません。通信が回復すると設定値を自動で送り直します。
        </div>
      </div>,
    );
  }

  if (link.safeguardMsg) {
    items.push(
      <div
        key="safeguard"
        className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-amber-50 ring-1 ring-amber-200 text-amber-800"
        role="alert"
      >
        <span className="text-base shrink-0" aria-hidden>
          ⚠
        </span>
        <div className="text-sm min-w-0">
          <strong className="font-semibold">姿勢角セーフガード発火 — 機体は MANUAL + trim=0 に退避しました。</strong>{" "}
          安全のため自動復元はしません (トリム表示は 0 に合わせ済み)。姿勢を確認し、必要なら Step 0 / Step 3 から設定し直してください。
          <div className="font-mono text-[11px] text-amber-700/80 truncate mt-0.5">{link.safeguardMsg}</div>
        </div>
        <button
          onClick={link.clearSafeguard}
          className="ml-auto shrink-0 text-xs font-semibold px-2.5 py-1 rounded-md bg-amber-100 hover:bg-amber-200 transition-colors"
        >
          了解
        </button>
      </div>,
    );
  }

  if (link.failures.length > 0) {
    items.push(
      <div
        key="failures"
        className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-amber-50 ring-1 ring-amber-200 text-amber-800"
        role="alert"
      >
        <span className="text-base shrink-0" aria-hidden>
          📡
        </span>
        <div className="text-sm min-w-0">
          <strong className="font-semibold">
            機体に届いたか確認できなかったコマンドが {link.failures.length} 件あります。
          </strong>
          <div className="font-mono text-[11px] text-amber-700/80 truncate mt-0.5">
            {link.failures.map((f) => f.cmd).join(" · ")}
          </div>
        </div>
        <button
          onClick={link.retryFailures}
          className="ml-auto shrink-0 text-xs font-semibold px-2.5 py-1 rounded-md bg-amber-100 hover:bg-amber-200 transition-colors"
        >
          ↻ 一括再送
        </button>
      </div>,
    );
  }

  if (showResynced && items.length === 0) {
    items.push(
      <div
        key="resynced"
        className="flex items-center gap-3 px-4 py-2 rounded-lg bg-emerald-50 ring-1 ring-emerald-200 text-emerald-700"
        role="status"
      >
        <span className="text-base shrink-0" aria-hidden>
          ✓
        </span>
        <div className="text-sm">
          通信が回復したため、サーボトリム設定を機体へ自動再同期しました。
        </div>
      </div>,
    );
  }

  if (items.length === 0) return null;

  return (
    // header(68px) + StepNav(~48px) の直下に sticky。スクロール中も警告が見え続ける
    <div className="sticky top-[116px] z-20 max-w-[1600px] mx-auto px-4 md:px-8 pt-3 space-y-2">
      {items}
    </div>
  );
}
