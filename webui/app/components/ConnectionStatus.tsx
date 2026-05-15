"use client";

import type { Status } from "../hooks/useTelemetry";

const META: Record<
  Status,
  { label: string; dot: string; ring: string; text: string; bg: string; pulse?: string }
> = {
  open: {
    label: "ONLINE",
    dot: "bg-glider-ok",
    ring: "ring-glider-ok/30",
    text: "text-glider-ok",
    bg: "bg-glider-ok/10",
    pulse: "animate-pulseLive",
  },
  connecting: {
    label: "CONNECTING",
    dot: "bg-glider-warn",
    ring: "ring-glider-warn/30",
    text: "text-glider-warn",
    bg: "bg-glider-warn/10",
  },
  closed: {
    label: "OFFLINE",
    dot: "bg-glider-textMute",
    ring: "ring-glider-textMute/30",
    text: "text-glider-textDim",
    bg: "bg-glider-textMute/10",
  },
  error: {
    label: "ERROR",
    dot: "bg-glider-err",
    ring: "ring-glider-err/30",
    text: "text-glider-err",
    bg: "bg-glider-err/10",
    pulse: "animate-pulseWarn",
  },
};

export function ConnectionStatus({
  status,
  rxCount,
  url,
}: {
  status: Status;
  rxCount: number;
  url: string;
}) {
  const m = META[status];
  return (
    <div className="flex items-center gap-3">
      <div
        className={`flex items-center gap-2 px-3 py-1.5 rounded-md ${m.bg} ring-1 ${m.ring}`}
      >
        <span
          className={`relative inline-block w-2.5 h-2.5 rounded-full ${m.dot} ${m.pulse ?? ""}`}
        />
        <span className={`text-xs font-bold tracking-wider ${m.text}`}>
          {m.label}
        </span>
      </div>
      <div className="hidden sm:flex flex-col text-[10px] leading-tight">
        <span className="text-glider-textMute uppercase tracking-wider">RX</span>
        <span className="font-mono text-glider-text font-semibold">
          {rxCount.toLocaleString()}
        </span>
      </div>
      <div
        className="hidden md:block font-mono text-[10px] text-glider-textMute truncate max-w-[18rem]"
        title={url}
      >
        {url}
      </div>
    </div>
  );
}
