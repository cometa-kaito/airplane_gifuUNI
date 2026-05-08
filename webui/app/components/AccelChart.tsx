"use client";

import { useMemo, memo } from "react";
import { UPlotChart } from "./UPlotChart";
import type { Options, AlignedData } from "uplot";
import type { TelemetryFrame } from "../hooks/useTelemetry";

const DISPLAY_POINTS = 200;

const baseOptions: Omit<Options, "width" | "height"> = {
  scales: { y: { auto: false, range: [-2, 2] } },
  axes: [
    { stroke: "#7a8088", grid: { stroke: "#2a2f37", width: 1 }, ticks: { stroke: "#7a8088" } },
    { stroke: "#7a8088", grid: { stroke: "#2a2f37", width: 1 }, ticks: { stroke: "#7a8088" } },
  ],
  series: [
    {},
    { label: "ax", stroke: "#ff6b6b", width: 1.2 },
    { label: "ay", stroke: "#51cf66", width: 1.2 },
    { label: "az", stroke: "#4dabf7", width: 1.2 },
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
    <div className="bg-glider-panel rounded p-3">
      <div className="text-xs text-gray-400 mb-1">Accel (g)</div>
      <UPlotChart options={baseOptions} data={aligned} height={220} />
    </div>
  );
}

export const AccelChart = memo(AccelChartImpl);
