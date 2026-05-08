"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import type { Options, AlignedData } from "uplot";
import "uplot/dist/uPlot.min.css";

/**
 * uPlot を React で扱う薄いラッパ。
 * - options はコンポーネントマウント時に1度だけ使われる（変更したい場合は key を付け替える）
 * - data 更新時は setData() で差分更新（再生成しない）
 * - ResizeObserver で親要素の幅に追従
 */
export function UPlotChart({
  options,
  data,
  height = 220,
  className,
}: {
  options: Omit<Options, "width" | "height">;
  data: AlignedData;
  height?: number;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<uPlot | null>(null);
  const dataRef = useRef<AlignedData>(data);

  // 直近 data を ref で保持（リサイズ時の再描画用）
  dataRef.current = data;

  // 初回マウント時のみチャート作成
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = container.clientWidth || 400;
    const opts: Options = { ...(options as Options), width: w, height };
    const chart = new uPlot(opts, dataRef.current, container);
    chartRef.current = chart;

    // 幅変更を追跡
    const ro = new ResizeObserver(() => {
      const newW = container.clientWidth;
      if (newW > 0) chart.setSize({ width: newW, height });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.destroy();
      chartRef.current = null;
    };
    // options は仮に変えたら再生成したい場合のため依存に含めず、
    // 「options を変えたいときは key を付け替えて再マウント」の運用にする
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // データ更新は setData で差分反映
  useEffect(() => {
    chartRef.current?.setData(data);
  }, [data]);

  return <div ref={containerRef} className={className} style={{ height }} />;
}
