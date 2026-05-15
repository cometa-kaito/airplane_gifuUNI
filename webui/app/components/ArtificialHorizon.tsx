"use client";

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";

/**
 * 人工水平儀 (Attitude Indicator)
 * - 60fps で ref を直接読みに行き、React の再レンダなしで更新
 * - roll: 中央の円板を回転 / pitch: 円板を上下に移動
 * - SVG を直接いじる（DOM 更新は transform 文字列の差し替えのみで非常に軽い）
 */
export function ArtificialHorizon({
  attitudeRef,
  className,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  className?: string;
}) {
  const skyRef = useRef<SVGGElement | null>(null);
  const rollRef = useRef<SVGGElement | null>(null);
  const rollTextRef = useRef<SVGTextElement | null>(null);
  const pitchTextRef = useRef<SVGTextElement | null>(null);
  const yawTextRef = useRef<SVGTextElement | null>(null);
  const yawRef = useRef<SVGGElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const f = attitudeRef.current;
      if (f) {
        // pitch: 1deg = 2px shift
        const pxShift = Math.max(-90, Math.min(90, f.pitch)) * 2;
        if (skyRef.current) {
          skyRef.current.setAttribute(
            "transform",
            `rotate(${-f.roll}) translate(0 ${pxShift})`,
          );
        }
        if (rollRef.current) {
          rollRef.current.setAttribute("transform", `rotate(${-f.roll})`);
        }
        if (rollTextRef.current) {
          rollTextRef.current.textContent = `${f.roll >= 0 ? "+" : ""}${f.roll.toFixed(0)}°`;
        }
        if (pitchTextRef.current) {
          pitchTextRef.current.textContent = `${f.pitch >= 0 ? "+" : ""}${f.pitch.toFixed(0)}°`;
        }
        if (yawRef.current) {
          // compass strip translates: 1deg = 2px
          const yawNorm = ((f.yaw % 360) + 360) % 360;
          yawRef.current.setAttribute("transform", `translate(${-yawNorm * 2} 0)`);
        }
        if (yawTextRef.current) {
          const yn = ((f.yaw % 360) + 360) % 360;
          yawTextRef.current.textContent = `${yn.toFixed(0).padStart(3, "0")}°`;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [attitudeRef]);

  // Compass tick marks across a 720-degree strip so wrap is seamless
  const compassTicks: JSX.Element[] = [];
  for (let deg = -360; deg <= 720; deg += 10) {
    const x = deg * 2;
    const major = deg % 30 === 0;
    compassTicks.push(
      <line
        key={`t${deg}`}
        x1={x}
        y1={0}
        x2={x}
        y2={major ? 10 : 6}
        stroke="#94a3b8"
        strokeWidth={major ? 1.5 : 1}
      />,
    );
    if (major) {
      const dn = ((deg % 360) + 360) % 360;
      const lbl =
        dn === 0 ? "N" :
        dn === 90 ? "E" :
        dn === 180 ? "S" :
        dn === 270 ? "W" :
        dn.toString();
      compassTicks.push(
        <text
          key={`l${deg}`}
          x={x}
          y={24}
          fill={dn % 90 === 0 ? "#5cc8ff" : "#cbd5e1"}
          fontSize={dn % 90 === 0 ? 14 : 10}
          fontWeight={dn % 90 === 0 ? 700 : 500}
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
        >
          {lbl}
        </text>,
      );
    }
  }

  return (
    <div
      className={`card relative overflow-hidden ${className ?? ""}`}
      aria-label="人工水平儀"
    >
      <div className="absolute top-3 left-3 z-10 section-title">Artificial Horizon</div>

      <svg
        viewBox="-100 -100 200 220"
        className="w-full h-full block"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Outer clip - circular instrument */}
        <defs>
          <clipPath id="horizonClip">
            <circle cx="0" cy="0" r="90" />
          </clipPath>
          <linearGradient id="skyGrad" x1="0" y1="-1" x2="0" y2="0">
            <stop offset="0" stopColor="#1e3a8a" />
            <stop offset="1" stopColor="#2563eb" />
          </linearGradient>
          <linearGradient id="groundGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#854d0e" />
            <stop offset="1" stopColor="#4a2e0a" />
          </linearGradient>
        </defs>

        {/* Instrument face */}
        <g clipPath="url(#horizonClip)">
          {/* Sky + Ground (rotates with roll, translates with pitch) */}
          <g ref={skyRef}>
            <rect x="-300" y="-300" width="600" height="300" fill="url(#skyGrad)" />
            <rect x="-300" y="0"    width="600" height="300" fill="url(#groundGrad)" />
            <line x1="-300" y1="0" x2="300" y2="0" stroke="#fafafa" strokeWidth="1.5" />
            {/* pitch ladder */}
            {[-60, -45, -30, -20, -10, 10, 20, 30, 45, 60].map((p) => {
              const y = -p * 2; // invert: positive pitch nose-up moves horizon DOWN
              const isMajor = p % 30 === 0;
              const w = isMajor ? 50 : p % 10 === 0 ? 30 : 16;
              return (
                <g key={p}>
                  <line
                    x1={-w / 2}
                    y1={y}
                    x2={w / 2}
                    y2={y}
                    stroke="#fafafa"
                    strokeWidth={isMajor ? 1.5 : 1}
                  />
                  {isMajor && (
                    <>
                      <text
                        x={-w / 2 - 4}
                        y={y + 3}
                        fill="#fafafa"
                        fontSize="8"
                        textAnchor="end"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {Math.abs(p)}
                      </text>
                      <text
                        x={w / 2 + 4}
                        y={y + 3}
                        fill="#fafafa"
                        fontSize="8"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {Math.abs(p)}
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </g>

        {/* Roll arc + tick marks (fixed outer ring with rotating pointer) */}
        <g>
          {[-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((r) => {
            const rad = ((r - 90) * Math.PI) / 180;
            const x1 = 90 * Math.cos(rad);
            const y1 = 90 * Math.sin(rad);
            const len = r % 30 === 0 ? 8 : 5;
            const x2 = (90 - len) * Math.cos(rad);
            const y2 = (90 - len) * Math.sin(rad);
            return (
              <line
                key={r}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#cbd5e1"
                strokeWidth={r === 0 ? 2 : 1}
              />
            );
          })}
        </g>

        {/* Roll pointer (rotates with -roll so it stays vertically aligned with sky) */}
        <g ref={rollRef}>
          <polygon points="0,-85 -4,-78 4,-78" fill="#fbbf24" />
        </g>

        {/* Outer ring */}
        <circle cx="0" cy="0" r="90" fill="none" stroke="#2e3849" strokeWidth="2" />

        {/* Center "aircraft" symbol (fixed) */}
        <g>
          <line x1="-40" y1="0" x2="-15" y2="0" stroke="#fbbf24" strokeWidth="3" />
          <line x1="15"  y1="0" x2="40"  y2="0" stroke="#fbbf24" strokeWidth="3" />
          <circle cx="0" cy="0" r="2.5" fill="#fbbf24" />
          <line x1="-15" y1="0" x2="-15" y2="5" stroke="#fbbf24" strokeWidth="3" />
          <line x1="15"  y1="0" x2="15"  y2="5" stroke="#fbbf24" strokeWidth="3" />
        </g>

        {/* Yaw compass strip at the bottom */}
        <g transform="translate(0 95)">
          <rect x="-90" y="-12" width="180" height="30" fill="#0b1018" stroke="#2e3849" />
          <g clipPath="url(#yawClip)">
            <g ref={yawRef}>{compassTicks}</g>
          </g>
          <defs>
            <clipPath id="yawClip">
              <rect x="-90" y="-12" width="180" height="30" />
            </clipPath>
          </defs>
          {/* Center indicator */}
          <polygon points="0,-12 -4,-6 4,-6" fill="#fbbf24" />
        </g>

        {/* Numeric readouts overlay */}
        <text
          ref={rollTextRef}
          x="-80" y="-72"
          fill="#ff5d6c"
          fontSize="10"
          fontWeight="700"
          fontFamily="JetBrains Mono, monospace"
        >
          0°
        </text>
        <text
          ref={pitchTextRef}
          x="80" y="-72"
          fill="#3ddc97"
          fontSize="10"
          fontWeight="700"
          textAnchor="end"
          fontFamily="JetBrains Mono, monospace"
        >
          0°
        </text>
        <text
          ref={yawTextRef}
          x="0" y="110"
          fill="#5cc8ff"
          fontSize="11"
          fontWeight="700"
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
        >
          000°
        </text>
      </svg>
    </div>
  );
}
