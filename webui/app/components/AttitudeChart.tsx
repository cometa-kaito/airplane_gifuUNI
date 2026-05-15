"use client";

import { useMemo, memo } from "react";
import { UPlotChart } from "./UPlotChart";
import type { Options, AlignedData } from "uplot";
import type { TelemetryFrame } from "../hooks/useTelemetry";

const DISPLAY_POINTS = 200;

const baseOptions: Omit<Options, "width" | "height"> = {
  scales: { y: { auto: false, range: [-180, 180] } },
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
    { label: "roll",  stroke: "#ff5d6c", width: 1.75 },
    { label: "pitch", stroke: "#3ddc97", width: 1.75 },
    { label: "yaw",   stroke: "#5cc8ff", width: 1.75 },
  ],
  legend: { show: true },
  cursor: { drag: { setScale: false } },
};

function AttitudeChartImpl({ data }: { data: TelemetryFrame[] }) {
  const aligned: AlignedData = useMemo(() => {
    const slice = data.slice(-DISPLAY_POINTS);
    const x = new Float64Array(slice.length);
    const r = new Float64Array(slice.length);
    const p = new Float64Array(slice.length);
    const y = new Float64Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      x[i] = slice[i].seq;
      r[i] = slice[i].roll;
      p[i] = slice[i].pitch;
      y[i] = slice[i].yaw;
    }
    return [x, r, p, y];
  }, [data]);

  return (
    <div className="card-pad">
      <div className="flex items-center justify-between mb-2">
        <div className="section-title">Attitude</div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1 text-glider-roll">
            <i className="inline-block w-2 h-2 rounded-sm bg-glider-roll" /> roll
          </span>
          <span className="flex items-center gap-1 text-glider-pitch">
            <i className="inline-block w-2 h-2 rounded-sm bg-glider-pitch" /> pitch
          </span>
          <span className="flex items-center gap-1 text-glider-yaw">
            <i className="inline-block w-2 h-2 rounded-sm bg-glider-yaw" /> yaw
          </span>
          <span className="text-glider-textMute">±180°</span>
        </div>
      </div>
      <UPlotChart options={baseOptions} data={aligned} height={210} />
    </div>
  );
}

export const AttitudeChart = memo(AttitudeChartImpl);
