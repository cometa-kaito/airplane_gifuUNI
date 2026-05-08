"use client";

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import type { TelemetryFrame } from "../hooks/useTelemetry";

export function ServoChart({ data }: { data: TelemetryFrame[] }) {
  const slice = data.slice(-300).map((d) => ({
    seq: d.seq,
    s0: d.s0,
    s1: d.s1,
    s2: d.s2,
  }));
  return (
    <div className="bg-glider-panel rounded p-3 h-64">
      <div className="text-xs text-gray-400 mb-1">Servo (deg, 0-180)</div>
      <ResponsiveContainer width="100%" height="90%">
        <LineChart data={slice}>
          <CartesianGrid stroke="#2a2f37" strokeDasharray="3 3" />
          <XAxis dataKey="seq" stroke="#7a8088" fontSize={10} />
          <YAxis domain={[0, 180]} stroke="#7a8088" fontSize={10} />
          <Tooltip contentStyle={{ background: "#1a1d22", border: "1px solid #444" }} labelStyle={{ color: "#ccc" }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="s0" stroke="#ff922b" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="s1" stroke="#ffd43b" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="s2" stroke="#a9e34b" dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
