"use client";

import { useMemo, memo } from "react";
import { UPlotChart } from "./UPlotChart";
import type { Options, AlignedData } from "uplot";
import type { TelemetryFrame } from "../hooks/useTelemetry";

const DISPLAY_POINTS = 200;

const baseOptions: Omit<Options, "width" | "height"> = {
  scales: { y: { auto: false, range: [-180, 180] } },
  axes: [
    { stroke: "#7a8088", grid: { stroke: "#2a2f37", width: 1 }, ticks: { stroke: "#7a8088" } },
    { stroke: "#7a8088", grid: { stroke: "#2a2f37", width: 1 }, ticks: { stroke: "#7a8088" } },
  ],
  series: [
    {},
    { label: "roll",  stroke: "#ff6b6b", width: 1.5 },
    { label: "pitch", stroke: "#51cf66", width: 1.5 },
    { label: "yaw",   stroke: "#4dabf7", width: 1.5 },
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
    <div className="bg-glider-panel rounded p-3">
      <div className="text-xs text-gray-400 mb-1">Attitude (deg)</div>
      <UPlotChart options={baseOptions} data={aligned} height={220} />
    </div>
  );
}

export const AttitudeChart = memo(AttitudeChartImpl);
