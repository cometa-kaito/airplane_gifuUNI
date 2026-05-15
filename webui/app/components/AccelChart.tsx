"use client";

import { useMemo, memo } from "react";
import { UPlotChart } from "./UPlotChart";
import type { Options, AlignedData } from "uplot";
import type { TelemetryFrame } from "../hooks/useTelemetry";

const DISPLAY_POINTS = 200;

const baseOptions: Omit<Options, "width" | "height"> = {
  scales: { y: { auto: false, range: [-2, 2] } },
  axes: [
    {
      stroke: "#64748b",
      grid: { stroke: "#1a212d", width: 1 },
      ticks: { stroke: "#475569", size: 4 },
      font: '11px "JetBrains Mono", monospace',
    },
    {
      stroke: "#64748b",
      grid: { stroke: "#1a212d", width: 1 },
      ticks: { stroke: "#475569", size: 4 },
      font: '11px "JetBrains Mono", monospace',
      size: 44,
    },
  ],
  series: [
    {},
    { label: "ax", stroke: "#ff5d6c", width: 1.5 },
    { label: "ay", stroke: "#3ddc97", width: 1.5 },
    { label: "az", stroke: "#5cc8ff", width: 1.5 },
  ],
  legend: { show: true },
  cursor: { drag: { setScale: false } },
};

function AccelChartImpl({ data }: { data: TelemetryFrame[] }) {
  const aligned: AlignedData = useMemo(() => {
    const slice = data.slice(-DISPLAY_POINTS);
    const x  = new Float64Array(slice.length);
    const ax = new Float64Array(slice.length);
    const ay = new Float64Array(slice.length);
    const az = new Float64Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      x[i]  = slice[i].seq;
      ax[i] = slice[i].ax;
      ay[i] = slice[i].ay;
      az[i] = slice[i].az;
    }
    return [x, ax, ay, az];
  }, [data]);

  return (
    <div className="card-pad">
      <div className="flex items-center justify-between mb-2">
        <div className="section-title">Accel</div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1 text-glider-roll">
            <i className="inline-block w-2 h-2 rounded-sm bg-glider-roll" /> ax
          </span>
          <span className="flex items-center gap-1 text-glider-pitch">
            <i className="inline-block w-2 h-2 rounded-sm bg-glider-pitch" /> ay
          </span>
          <span className="flex items-center gap-1 text-glider-yaw">
            <i className="inline-block w-2 h-2 rounded-sm bg-glider-yaw" /> az
          </span>
          <span className="text-glider-textMute">±2g</span>
        </div>
      </div>
      <UPlotChart options={baseOptions} data={aligned} height={210} />
    </div>
  );
}

export const AccelChart = memo(AccelChartImpl);
