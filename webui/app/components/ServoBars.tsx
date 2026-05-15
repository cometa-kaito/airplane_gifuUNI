"use client";

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";

type ServoDef = {
  key: "s0" | "s1" | "s2";
  label: string;
  sub: string;
  color: string;
};

const SERVOS: ServoDef[] = [
  { key: "s0", label: "S0", sub: "R Aileron", color: "#ff922b" },
  { key: "s1", label: "S1", sub: "L Aileron", color: "#ffd43b" },
  { key: "s2", label: "S2", sub: "Elevator",  color: "#a9e34b" },
];

function ServoRow({
  def,
  valueRef,
  fillRef,
  knobRef,
}: {
  def: ServoDef;
  valueRef: (el: HTMLSpanElement | null) => void;
  fillRef: (el: HTMLDivElement | null) => void;
  knobRef: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-none w-24">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: def.color, boxShadow: `0 0 6px ${def.color}` }}
          />
          <span className="text-sm font-bold tracking-wider" style={{ color: def.color }}>
            {def.label}
          </span>
        </div>
        <div className="text-[10px] text-glider-textMute pl-3.5">{def.sub}</div>
      </div>

      <div className="flex-1 relative h-8 rounded-md bg-glider-surface border border-glider-border overflow-hidden">
        {/* Center line (90deg neutral) */}
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-glider-borderHi pointer-events-none" />
        {/* Quarter ticks */}
        {[25, 50, 75].map((p) => (
          <div
            key={p}
            className="absolute top-0 bottom-0 w-px bg-glider-border pointer-events-none"
            style={{ left: `${p}%` }}
          />
        ))}
        {/* fill bar */}
        <div
          ref={fillRef}
          className="absolute top-0 bottom-0 left-0 transition-[width] duration-75 ease-linear"
          style={{
            width: "50%",
            background: `linear-gradient(90deg, ${def.color}22, ${def.color}77)`,
          }}
        />
        {/* Knob */}
        <div
          ref={knobRef}
          className="absolute top-1/2 -translate-y-1/2 w-1 h-6 rounded-sm transition-[left] duration-75 ease-linear"
          style={{
            left: "calc(50% - 2px)",
            background: def.color,
            boxShadow: `0 0 12px ${def.color}`,
          }}
        />
        {/* Range labels */}
        <div className="absolute inset-0 flex items-center justify-between px-2 pointer-events-none">
          <span className="text-[9px] font-mono text-glider-textMute">0</span>
          <span className="text-[9px] font-mono text-glider-textMute">90</span>
          <span className="text-[9px] font-mono text-glider-textMute">180</span>
        </div>
      </div>

      <div className="flex-none w-20 text-right">
        <span
          ref={valueRef}
          className="stat-val text-2xl font-bold"
          style={{ color: def.color }}
        >
          --
        </span>
        <span className="text-[10px] text-glider-textMute font-mono ml-1">°</span>
      </div>
    </div>
  );
}

export function ServoBars({
  attitudeRef,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
}) {
  const valRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const fillRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const knobRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const f = attitudeRef.current;
      if (f) {
        for (const s of SERVOS) {
          const v = f[s.key];
          const pct = Math.max(0, Math.min(100, (v / 180) * 100));
          const valEl = valRefs.current[s.key];
          const fillEl = fillRefs.current[s.key];
          const knobEl = knobRefs.current[s.key];
          if (valEl) valEl.textContent = Number.isFinite(v) ? Math.round(v).toString() : "--";
          if (fillEl) fillEl.style.width = `${pct}%`;
          if (knobEl) knobEl.style.left = `calc(${pct}% - 2px)`;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [attitudeRef]);

  return (
    <div className="card-pad space-y-3">
      <div className="flex items-center justify-between">
        <span className="section-title">Servo Output</span>
        <span className="text-[10px] text-glider-textMute font-mono">0 – 180°</span>
      </div>
      <div className="space-y-2">
        {SERVOS.map((s) => (
          <ServoRow
            key={s.key}
            def={s}
            valueRef={(el) => {
              valRefs.current[s.key] = el;
            }}
            fillRef={(el) => {
              fillRefs.current[s.key] = el;
            }}
            knobRef={(el) => {
              knobRefs.current[s.key] = el;
            }}
          />
        ))}
      </div>
    </div>
  );
}
