"use client";

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";

/**
 * 大きな姿勢角ヒーロー表示。
 * 60fps の RAF ループで ref を直接読み、DOM の textContent と
 * SVG ゲージの strokeDasharray だけ書き換える。再レンダなしで滑らかに動く。
 */
type Axis = {
  key: "roll" | "pitch" | "yaw";
  label: string;
  jp: string;
  color: string;
  range: [number, number];
};

const AXES: Axis[] = [
  { key: "roll",  label: "ROLL",  jp: "ロール",  color: "#ff5d6c", range: [-180, 180] },
  { key: "pitch", label: "PITCH", jp: "ピッチ",  color: "#3ddc97", range: [-180, 180] },
  { key: "yaw",   label: "YAW",   jp: "ヨー",    color: "#5cc8ff", range: [-180, 180] },
];

const R = 56;
const ARC_PATH = `M ${-R} 0 A ${R} ${R} 0 0 1 ${R} 0`;
const PATH_LENGTH = 100; // 正規化長

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
    <div className="card-pad relative overflow-hidden flex flex-col items-center justify-end min-h-[200px]">
      {/* corner label */}
      <div className="absolute top-3 left-3 flex items-center gap-2">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: axis.color, boxShadow: `0 0 10px ${axis.color}` }}
        />
        <div className="leading-tight">
          <div
            className="text-[10px] uppercase tracking-[0.18em] font-bold"
            style={{ color: axis.color }}
          >
            {axis.label}
          </div>
          <div className="text-[9px] text-glider-textMute">{axis.jp}</div>
        </div>
      </div>

      <div className="absolute top-3 right-3 text-[10px] text-glider-textMute font-mono">
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
          stroke="#232b39"
          strokeWidth="9"
          strokeLinecap="round"
        />
        {/* ticks */}
        {[-90, -45, 0, 45, 90].map((t) => {
          // map t in [-90,90] to angle along upper-half arc
          // theta = π * ((t+90)/180) starting from left
          const theta = Math.PI * ((t + 90) / 180);
          const x1 = -R * Math.cos(theta);
          const y1 = -R * Math.sin(theta);
          const len = t === 0 ? 14 : 10;
          const x2 = -(R - len) * Math.cos(theta);
          const y2 = -(R - len) * Math.sin(theta);
          return (
            <line
              key={t}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={t === 0 ? axis.color : "#475569"}
              strokeWidth={t === 0 ? 2 : 1}
              opacity={t === 0 ? 0.9 : 0.6}
            />
          );
        })}
        {/* center label */}
        <text
          x="0"
          y="-2"
          fill="#475569"
          fontSize="7"
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
        >
          0°
        </text>
        <text
          x={-R}
          y="-2"
          fill="#475569"
          fontSize="7"
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
        >
          -180
        </text>
        <text
          x={R}
          y="-2"
          fill="#475569"
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
          strokeWidth="9"
          strokeLinecap="round"
          pathLength={PATH_LENGTH}
          strokeDasharray={`0 ${PATH_LENGTH}`}
          style={{
            filter: `drop-shadow(0 0 5px ${axis.color}80)`,
          }}
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
            filter: `drop-shadow(0 0 4px ${axis.color})`,
          }}
        />
        {/* hub */}
        <circle cx="0" cy="0" r="3" fill={axis.color} />
      </svg>

      {/* Numeric */}
      <div className="mt-1 flex items-baseline gap-1 leading-none">
        <span
          ref={valueRef}
          className="stat-val text-[3.2rem] md:text-6xl font-extrabold"
          style={{
            color: axis.color,
            textShadow: `0 0 24px ${axis.color}55`,
          }}
        >
          0.0
        </span>
        <span className="text-sm text-glider-textMute font-mono">°</span>
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
            // map norm (0..1) to angle (-90..90) deg
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
    <div className="grid grid-cols-3 gap-3">
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
