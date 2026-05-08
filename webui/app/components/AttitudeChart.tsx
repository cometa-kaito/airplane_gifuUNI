"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { TelemetryFrame } from "../hooks/useTelemetry";

export function AttitudeChart({ data }: { data: TelemetryFrame[] }) {
  const slice = data.slice(-300).map((d) => ({
    seq: d.seq,
    roll: d.roll,
    pitch: d.pitch,
    yaw: d.yaw,
  }));
  return (
    <div className="bg-glider-panel rounded p-3 h-64">
      <div className="text-xs text-gray-400 mb-1">Attitude (deg)</div>
      <ResponsiveContainer width="100%" height="90%">
        <LineChart data={slice}>
          <CartesianGrid stroke="#2a2f37" strokeDasharray="3 3" />
          <XAxis dataKey="seq" stroke="#7a8088" fontSize={10} />
          <YAxis domain={[-180, 180]} stroke="#7a8088" fontSize={10} />
          <Tooltip
            contentStyle={{ background: "#1a1d22", border: "1px solid #444" }}
            labelStyle={{ color: "#ccc" }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="roll" stroke="#ff6b6b" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="pitch" stroke="#51cf66" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="yaw" stroke="#4dabf7" dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
