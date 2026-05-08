"use client";

import { useMemo, memo } from "react";
import { UPlotChart } from "./UPlotChart";
import type { Options, AlignedData } from "uplot";
import type { TelemetryFrame } from "../hooks/useTelemetry";

const DISPLAY_POINTS = 200;

const baseOptions: Omit<Options, "width" | "height"> = {
  scales: { y: { auto: false, range: [0, 180] } },
  axes: [
    { stroke: "#7a8088", grid: { stroke: "#2a2f37", width: 1 }, ticks: { stroke: "#7a8088" } },
    { stroke: "#7a8088", grid: { stroke: "#2a2f37", width: 1 }, ticks: { stroke: "#7a8088" } },
  ],
  series: [
    {},
    { label: "s0 (R aileron)", stroke: "#ff922b", width: 1.5 },
    { label: "s1 (L aileron)", stroke: "#ffd43b", width: 1.5 },
    { label: "s2 (Elevator)",  stroke: "#a9e34b", width: 1.5 },
  ],
  legend: { show: true },
  cursor: { drag: { setScale: false } },
};

function ServoChartImpl({ data }: { data: TelemetryFrame[] }) {
  const aligned: AlignedData = useMemo(() => {
    const slice = data.slice(-DISPLAY_POINTS);
    const x  = new Float64Array(slice.length);
    const s0 = new Float64Array(slice.length);
    const s1 = new Float64Array(slice.length);
    const s2 = new Float64Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      x[i] = slice[i].seq;
      s0[i] = slice[i].s0;
      s1[i] = slice[i].s1;
      s2[i] = slice[i].s2;
    }
    return [x, s0, s1, s2];
  }, [data]);

  return (
    <div className="bg-glider-panel rounded p-3">
      <div className="text-xs text-gray-400 mb-1">Servo (deg, 0-180)</div>
      <UPlotChart options={baseOptions} data={aligned} height={220} />
    </div>
  );
}

export const ServoChart = memo(ServoChartImpl);
