"use client";

import type { Status } from "../hooks/useTelemetry";

const COLORS: Record<Status, string> = {
  connecting: "bg-yellow-600",
  open: "bg-green-600",
  closed: "bg-red-700",
  error: "bg-red-700",
};

const LABELS: Record<Status, string> = {
  connecting: "CONNECTING",
  open: "ONLINE",
  closed: "DISCONNECTED",
  error: "ERROR",
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
  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        className={`px-3 py-1 rounded font-bold text-white ${COLORS[status]}`}
      >
        {LABELS[status]}
      </span>
      <span className="font-mono text-gray-300">RX: {rxCount}</span>
      <span className="font-mono text-gray-500">{url}</span>
    </div>
  );
}
