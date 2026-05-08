"use client";

import { useState, useEffect } from "react";
import { useTelemetry } from "./hooks/useTelemetry";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { TelemetryPanel } from "./components/TelemetryPanel";
import { AttitudeChart } from "./components/AttitudeChart";
import { ServoChart } from "./components/ServoChart";
import { AccelChart } from "./components/AccelChart";
import { Glider3D } from "./components/Glider3D";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8765";

export default function Page() {
  const { status, latest, rxCount, history } = useTelemetry(WS_URL);

  // Recharts と 3D 用に history を 100ms ごとにスナップショット
  const [snap, setSnap] = useState<typeof history.current>([]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setSnap([...history.current]);
    }, 100);
    return () => window.clearInterval(id);
  }, [history]);

  const attitude = latest
    ? { roll: latest.roll, pitch: latest.pitch, yaw: latest.yaw }
    : { roll: 0, pitch: 0, yaw: 0 };

  return (
    <main className="min-h-screen p-4 md:p-6 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl md:text-2xl font-bold">
          自律滑空機 テレメトリ <span className="text-glider-accent">(read-only)</span>
        </h1>
        <ConnectionStatus status={status} rxCount={rxCount} url={WS_URL} />
      </header>

      <TelemetryPanel frame={latest} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Glider3D attitude={attitude} />
        <AttitudeChart data={snap} />
        <ServoChart data={snap} />
        <AccelChart data={snap} />
      </div>

      <footer className="text-xs text-gray-500 pt-4">
        Source: Python ground_station.py (PyQt6 + WebSocket) /
        URL: {WS_URL} / 表示専用、コマンド送信は Python 地上局から行ってください
      </footer>
    </main>
  );
}
