"use client";

import { useEffect, useState } from "react";
import { useTelemetry } from "./hooks/useTelemetry";
import { useWebSerial } from "./hooks/useWebSerial";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { ModeSelector, type SourceMode } from "./components/ModeSelector";
import { CommandPanel } from "./components/CommandPanel";
import { TelemetryPanel } from "./components/TelemetryPanel";
import { AttitudeChart } from "./components/AttitudeChart";
import { ServoChart } from "./components/ServoChart";
import { AccelChart } from "./components/AccelChart";
import { Glider3D } from "./components/Glider3D";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8765";

export default function Page() {
  const [mode, setMode] = useState<SourceMode>("websocket");

  // 両方のフックを常に呼び出し（rules of hooks）。アクティブでない側は idle のまま。
  const wsHook = useTelemetry(mode === "websocket" ? WS_URL : "");
  const wsSerial = useWebSerial();

  // アクティブソースを選択
  const active = mode === "websocket" ? wsHook : wsSerial;
  const { status, latest, rxCount, history } = active;

  // チャート用に history を 100ms ごとにスナップショット
  const [snap, setSnap] = useState<typeof history.current>([]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setSnap([...history.current]);
    }, 100);
    return () => window.clearInterval(id);
  }, [history]);

  // モード切替時に WebSerial を切断
  useEffect(() => {
    if (mode === "websocket") {
      void wsSerial.disconnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const attitude = latest
    ? { roll: latest.roll, pitch: latest.pitch, yaw: latest.yaw }
    : { roll: 0, pitch: 0, yaw: 0 };

  const url = mode === "websocket" ? WS_URL : "WebSerial (USB direct)";

  return (
    <main className="min-h-screen p-4 md:p-6 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl md:text-2xl font-bold">
          自律滑空機 テレメトリ
        </h1>
        <div className="flex gap-3 items-center flex-wrap">
          <ModeSelector
            mode={mode}
            onChange={setMode}
            webSerialSupported={wsSerial.supported}
          />
          <ConnectionStatus status={status} rxCount={rxCount} url={url} />
          {mode === "webserial" && status !== "open" && (
            <button
              onClick={() => {
                wsSerial.connect().catch((e) => {
                  alert(`接続失敗: ${e?.message ?? e}`);
                });
              }}
              className="bg-glider-accent text-black px-3 py-1 rounded text-sm font-bold hover:opacity-90"
            >
              Connect Device
            </button>
          )}
          {mode === "webserial" && status === "open" && (
            <button
              onClick={() => void wsSerial.disconnect()}
              className="bg-red-700 text-white px-3 py-1 rounded text-sm font-bold hover:opacity-90"
            >
              Disconnect
            </button>
          )}
        </div>
      </header>

      <TelemetryPanel frame={latest} />

      {mode === "webserial" && (
        <CommandPanel
          onSend={wsSerial.sendCommand}
          enabled={status === "open"}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Glider3D attitude={attitude} />
        <AttitudeChart data={snap} />
        <ServoChart data={snap} />
        <AccelChart data={snap} />
      </div>

      <footer className="text-xs text-gray-500 pt-4 space-y-1">
        <div>
          <strong className="text-gray-400">WebSocket モード</strong>:
          Python ground_station.py 経由（PyQt 操作 UI と並行可能、複数端末で共有可）
        </div>
        <div>
          <strong className="text-gray-400">WebSerial モード</strong>:
          ブラウザから USB を直接掴む（Chromium 系のみ、Python 不要）
        </div>
      </footer>
    </main>
  );
}
