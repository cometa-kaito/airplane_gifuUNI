"use client";

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";

/**
 * AttitudeHero — Roll / Pitch / Yaw を大きく表示するヒーローカード。
 * モダンライトテーマ: 真っ黒は避けて slate-800、アクセントは軸ごとの識別色のみ。
 * 60fps の RAF ループで ref を直接更新 (再レンダ無し)。
 */
type Axis = {
  key: "roll" | "pitch" | "yaw";
  label: string;
  jp: string;
  color: string;
  bg: string;       // 軸ごとの薄い背景アクセント
  range: [number, number];
};

const AXES: Axis[] = [
  { key: "roll",  label: "ROLL",  jp: "ロール",  color: "#e11d48", bg: "#fff1f2", range: [-180, 180] },
  { key: "pitch", label: "PITCH", jp: "ピッチ",  color: "#059669", bg: "#ecfdf5", range: [-180, 180] },
  { key: "yaw",   label: "YAW",   jp: "ヨー",    color: "#0284c7", bg: "#f0f9ff", range: [-180, 180] },
];

const R = 56;
const ARC_PATH = `M ${-R} 0 A ${R} ${R} 0 0 1 ${R} 0`;
const PATH_LENGTH = 100;

function AxisCard({
  axis,
  valueRef,
  gaugeRef,
  needleRef,
}: {
  axis: Axis;
  valueRef: (el: HTMLSpanElement | null) => void;
  gaugeRef: (el: SVGPathElement | null) => void;
  needleRef: (el: SVGLineElement | null) => void;
}) {
  return (
    <div
      className="card-pad relative overflow-hidden flex flex-col items-center justify-end min-h-[220px]"
    >
      {/* 軸固有の薄いアクセント帯 (識別性) */}
      <div
        className="absolute top-0 left-0 right-0 h-1 rounded-t-xl"
        style={{ background: axis.color, opacity: 0.6 }}
        aria-hidden
      />

      {/* corner label */}
      <div className="absolute top-4 left-4 flex items-center gap-2">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: axis.color }}
          aria-hidden
        />
        <div className="leading-tight">
          <div
            className="text-[11px] uppercase tracking-[0.14em] font-semibold"
            style={{ color: axis.color }}
          >
            {axis.label}
          </div>
          <div className="text-[10px] text-slate-400">{axis.jp}</div>
        </div>
      </div>

      <div className="absolute top-4 right-4 text-[10px] text-slate-400 font-mono">
        ±180°
      </div>

      {/* Half-circle gauge */}
      <svg
        viewBox="-72 -72 144 80"
        className="w-full max-w-[230px] h-auto"
        aria-hidden
      >
        {/* track */}
        <path
          d={ARC_PATH}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="8"
          strokeLinecap="round"
        />
        {/* ticks */}
        {[-90, -45, 0, 45, 90].map((t) => {
          const theta = Math.PI * ((t + 90) / 180);
          const x1 = -R * Math.cos(theta);
          const y1 = -R * Math.sin(theta);
          const len = t === 0 ? 12 : 8;
          const x2 = -(R - len) * Math.cos(theta);
          const y2 = -(R - len) * Math.sin(theta);
          return (
            <line
              key={t}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={t === 0 ? axis.color : "#cbd5e1"}
              strokeWidth={t === 0 ? 1.5 : 1}
              opacity={t === 0 ? 0.7 : 0.6}
            />
          );
        })}
        {/* center labels */}
        <text
          x="0"
          y="-2"
          fill="#94a3b8"
          fontSize="7"
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
        >
          0°
        </text>
        <text
          x={-R}
          y="-2"
          fill="#cbd5e1"
          fontSize="7"
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
        >
          -180
        </text>
        <text
          x={R}
          y="-2"
          fill="#cbd5e1"
          fontSize="7"
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
        >
          +180
        </text>

        {/* value arc (foreground) */}
        <path
          ref={gaugeRef}
          d={ARC_PATH}
          fill="none"
          stroke={axis.color}
          strokeWidth="8"
          strokeLinecap="round"
          pathLength={PATH_LENGTH}
          strokeDasharray={`0 ${PATH_LENGTH}`}
        />

        {/* needle */}
        <line
          ref={needleRef}
          x1="0"
          y1="0"
          x2="0"
          y2={-R + 2}
          stroke={axis.color}
          strokeWidth="2"
          strokeLinecap="round"
          style={{
            transformOrigin: "0px 0px",
            transformBox: "view-box",
            transform: "rotate(0deg)",
          }}
        />
        {/* hub */}
        <circle cx="0" cy="0" r="3" fill={axis.color} />
      </svg>

      {/* Numeric — slate-800 でクリーン、識別色は控えめ */}
      <div className="mt-2 flex items-baseline gap-1 leading-none">
        <span
          ref={valueRef}
          className="stat-val text-[2.6rem] md:text-5xl font-bold text-slate-800"
        >
          0.0
        </span>
        <span className="text-base text-slate-400 font-mono">°</span>
      </div>
    </div>
  );
}

export function AttitudeHero({
  attitudeRef,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
}) {
  const valRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const gaugeRefs = useRef<Record<string, SVGPathElement | null>>({});
  const needleRefs = useRef<Record<string, SVGLineElement | null>>({});
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const f = attitudeRef.current;
      if (f) {
        for (const axis of AXES) {
          const v = f[axis.key];
          const valEl = valRefs.current[axis.key];
          const arcEl = gaugeRefs.current[axis.key];
          const needleEl = needleRefs.current[axis.key];
          if (valEl) {
            const sign = v >= 0 ? "+" : "";
            valEl.textContent = `${sign}${v.toFixed(1)}`;
          }
          const [lo, hi] = axis.range;
          const norm = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
          if (arcEl) {
            const visible = PATH_LENGTH * norm;
            arcEl.setAttribute("stroke-dasharray", `${visible} ${PATH_LENGTH}`);
          }
          if (needleEl) {
            const deg = -90 + norm * 180;
            needleEl.setAttribute("transform", `rotate(${deg})`);
          }
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
    <div className="grid grid-cols-3 gap-4">
      {AXES.map((axis) => (
        <AxisCard
          key={axis.key}
          axis={axis}
          valueRef={(el) => {
            valRefs.current[axis.key] = el;
          }}
          gaugeRef={(el) => {
            gaugeRefs.current[axis.key] = el;
          }}
          needleRef={(el) => {
            needleRefs.current[axis.key] = el;
          }}
        />
      ))}
    </div>
  );
}
