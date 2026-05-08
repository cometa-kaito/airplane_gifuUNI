"use client";

import type { TelemetryFrame } from "../hooks/useTelemetry";

function Cell({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
}) {
  return (
    <div className="bg-glider-panel rounded p-3 flex flex-col">
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`text-2xl font-mono ${color ?? "text-white"}`}>
        {value}
        {unit && <span className="text-sm text-gray-500 ml-1">{unit}</span>}
      </div>
    </div>
  );
}

export function TelemetryPanel({ frame }: { frame: TelemetryFrame | null }) {
  const fmt = (v: number | undefined, dec = 2) =>
    v === undefined ? "--" : v.toFixed(dec);
  const fmtInt = (v: number | undefined) =>
    v === undefined ? "--" : String(v);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      <Cell label="roll" value={fmt(frame?.roll)} unit="deg" color="text-glider-roll" />
      <Cell label="pitch" value={fmt(frame?.pitch)} unit="deg" color="text-glider-pitch" />
      <Cell label="yaw" value={fmt(frame?.yaw)} unit="deg" color="text-glider-yaw" />
      <Cell label="seq" value={fmtInt(frame?.seq)} />

      <Cell label="ax" value={fmt(frame?.ax, 3)} unit="g" />
      <Cell label="ay" value={fmt(frame?.ay, 3)} unit="g" />
      <Cell label="az" value={fmt(frame?.az, 3)} unit="g" />
      <Cell label="dt" value={fmtInt(frame?.dt_ms)} unit="ms" />

      <Cell label="gx" value={fmt(frame?.gx)} unit="deg/s" />
      <Cell label="gy" value={fmt(frame?.gy)} unit="deg/s" />
      <Cell label="gz" value={fmt(frame?.gz)} unit="deg/s" />
      <Cell label="t_ms" value={fmtInt(frame?.t_ms)} unit="ms" />

      <Cell label="s0" value={fmtInt(frame?.s0)} unit="deg" color="text-glider-servo0" />
      <Cell label="s1" value={fmtInt(frame?.s1)} unit="deg" color="text-glider-servo1" />
      <Cell label="s2" value={fmtInt(frame?.s2)} unit="deg" color="text-glider-servo2" />
      <Cell label="wall" value={fmtInt(frame?.wall_ms)} unit="ms" />
    </div>
  );
}
