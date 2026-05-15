"use client";

import { useMemo, memo } from "react";
import { UPlotChart } from "./UPlotChart";
import type { Options, AlignedData } from "uplot";
import type { TelemetryFrame } from "../hooks/useTelemetry";

const DISPLAY_POINTS = 200;

const baseOptions: Omit<Options, "width" | "height"> = {
  scales: { y: { auto: false, range: [0, 180] } },
  axes: [
    {
      stroke: "#64748b",
      grid: { stroke: "#f1f5f9", width: 1 },
      ticks: { stroke: "#cbd5e1", size: 4 },
      font: '11px "JetBrains Mono", monospace',
    },
    {
      stroke: "#64748b",
      grid: { stroke: "#f1f5f9", width: 1 },
      ticks: { stroke: "#cbd5e1", size: 4 },
      font: '11px "JetBrains Mono", monospace',
      size: 44,
    },
  ],
  series: [
    {},
    { label: "s0 R-aileron", stroke: "#ea580c", width: 1.75 },  // orange-600
    { label: "s1 L-aileron", stroke: "#ca8a04", width: 1.75 },  // yellow-600
    { label: "s2 elevator",  stroke: "#65a30d", width: 1.75 },  // lime-600
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
    <div className="card-pad">
      <div className="flex items-center justify-between mb-2">
        <div className="section-title">Servo</div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1 text-glider-servo0">
            <i className="inline-block w-2 h-2 rounded-sm bg-glider-servo0" /> s0
          </span>
          <span className="flex items-center gap-1 text-glider-servo1">
            <i className="inline-block w-2 h-2 rounded-sm bg-glider-servo1" /> s1
          </span>
          <span className="flex items-center gap-1 text-glider-servo2">
            <i className="inline-block w-2 h-2 rounded-sm bg-glider-servo2" /> s2
          </span>
          <span className="text-glider-textMute">0 – 180°</span>
        </div>
      </div>
      <UPlotChart options={baseOptions} data={aligned} height={210} />
    </div>
  );
}

export const ServoChart = memo(ServoChartImpl);
