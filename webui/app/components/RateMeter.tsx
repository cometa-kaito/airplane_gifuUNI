"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 受信レート (Hz) を 1Hz で計算して表示する。
 * 親から渡される rxCount を 1秒間隔でサンプリングし、差分を Hz とする。
 */
export function RateMeter({ rxCount }: { rxCount: number }) {
  const [hz, setHz] = useState(0);
  const lastRxRef = useRef(rxCount);
  const lastTRef = useRef(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTRef.current) / 1000;
      if (dt > 0) {
        const drx = rxCount - lastRxRef.current;
        const rate = drx / dt;
        // 軽いLPF
        setHz((prev) => prev * 0.4 + rate * 0.6);
      }
      lastRxRef.current = rxCount;
      lastTRef.current = now;
    }, 500);
    return () => window.clearInterval(id);
  }, [rxCount]);

  // 色: 0 = ミュート, 良好 = 緑, 遅延気味 = 黄
  const color =
    hz < 1   ? "text-glider-textMute" :
    hz < 10  ? "text-glider-warn" :
               "text-glider-ok";

  return (
    <div className="hidden sm:flex flex-col items-end leading-tight">
      <span className="text-[10px] uppercase tracking-wider text-glider-textMute">Rate</span>
      <div className="flex items-baseline gap-1">
        <span className={`stat-val text-base font-bold ${color}`}>
          {hz.toFixed(1)}
        </span>
        <span className="text-[10px] text-glider-textMute font-mono">Hz</span>
      </div>
    </div>
  );
}
