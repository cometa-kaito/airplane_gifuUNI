"use client";

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";

type CellSpec = {
  k: keyof TelemetryFrame;
  label: string;
  unit?: string;
  decimals?: number;
  color?: string;
  warnAbs?: number; // 絶対値がこれを超えると警告色
};

const IMU_CELLS: CellSpec[] = [
  { k: "ax", label: "AX", unit: "g",     decimals: 3, color: "#ff5d6c", warnAbs: 1.5 },
  { k: "ay", label: "AY", unit: "g",     decimals: 3, color: "#3ddc97", warnAbs: 1.5 },
  { k: "az", label: "AZ", unit: "g",     decimals: 3, color: "#5cc8ff", warnAbs: 1.5 },
  { k: "gx", label: "GX", unit: "°/s",   decimals: 1, color: "#ff5d6c", warnAbs: 250 },
  { k: "gy", label: "GY", unit: "°/s",   decimals: 1, color: "#3ddc97", warnAbs: 250 },
  { k: "gz", label: "GZ", unit: "°/s",   decimals: 1, color: "#5cc8ff", warnAbs: 250 },
];

const SYS_CELLS: CellSpec[] = [
  { k: "seq",    label: "SEQ",     decimals: 0 },
  { k: "t_ms",   label: "T",       unit: "ms",  decimals: 0 },
  { k: "dt_ms",  label: "DT",      unit: "ms",  decimals: 0, warnAbs: 50 },
  { k: "wall_ms", label: "WALL",   unit: "ms",  decimals: 0 },
];

function MiniCell({
  spec,
  textRef,
}: {
  spec: CellSpec;
  textRef: (el: HTMLSpanElement | null) => void;
}) {
  return (
    <div className="bg-glider-surface border border-glider-border rounded-md px-2.5 py-1.5 flex flex-col items-start min-w-0">
      <span
        className="stat-label"
        style={spec.color ? { color: spec.color } : undefined}
      >
        {spec.label}
      </span>
      <div className="flex items-baseline gap-1 min-w-0 w-full">
        <span
          ref={textRef}
          className="stat-val text-base font-semibold truncate"
          style={{ color: spec.color ?? "#f1f5f9" }}
        >
          --
        </span>
        {spec.unit && (
          <span className="text-[10px] text-glider-textMute font-mono">
            {spec.unit}
          </span>
        )}
      </div>
    </div>
  );
}

function format(v: number | undefined, dec: number | undefined) {
  if (v === undefined || !Number.isFinite(v)) return "--";
  return v.toFixed(dec ?? 2);
}

function CellGroup({
  title,
  cells,
  attitudeRef,
}: {
  title: string;
  cells: CellSpec[];
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
}) {
  const refs = useRef<Record<string, HTMLSpanElement | null>>({});
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const f = attitudeRef.current;
      if (f) {
        for (const c of cells) {
          const el = refs.current[c.k as string];
          if (!el) continue;
          const v = f[c.k] as number;
          el.textContent = format(v, c.decimals);
          if (c.warnAbs !== undefined) {
            const warn = Math.abs(v) > c.warnAbs;
            el.style.color = warn ? "#f59e0b" : c.color ?? "#f1f5f9";
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [attitudeRef, cells]);

  return (
    <div className="card-pad">
      <div className="section-title mb-2">{title}</div>
      <div className="grid grid-cols-3 gap-1.5">
        {cells.map((c) => (
          <MiniCell
            key={c.k as string}
            spec={c}
            textRef={(el) => {
              refs.current[c.k as string] = el;
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function TelemetryPanel({
  attitudeRef,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <CellGroup title="IMU — Accel & Gyro" cells={IMU_CELLS} attitudeRef={attitudeRef} />
      <CellGroup title="System" cells={SYS_CELLS} attitudeRef={attitudeRef} />
    </div>
  );
}
