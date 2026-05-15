"use client";

import { useEffect, useState, useMemo } from "react";
import { useTelemetry } from "./hooks/useTelemetry";
import { useWebSerial } from "./hooks/useWebSerial";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { ModeSelector, type SourceMode } from "./components/ModeSelector";
import { CommandPanel } from "./components/CommandPanel";
import { TelemetryPanel } from "./components/TelemetryPanel";
import { AttitudeHero } from "./components/AttitudeHero";
import { ArtificialHorizon } from "./components/ArtificialHorizon";
import { ServoBars } from "./components/ServoBars";
import { AttitudeChart } from "./components/AttitudeChart";
import { ServoChart } from "./components/ServoChart";
import { AccelChart } from "./components/AccelChart";
import { Glider3D } from "./components/Glider3D";
import { RateMeter } from "./components/RateMeter";
import { RecorderPanel } from "./components/RecorderPanel";
import { QuickControl } from "./components/QuickControl";
import type { TelemetryFrame } from "./hooks/useTelemetry";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8765";
const WS_TOKEN = process.env.NEXT_PUBLIC_WS_TOKEN ?? undefined;
const SNAPSHOT_INTERVAL_MS = 200; // チャート再描画頻度（=5Hz）

export default function Page() {
  const [mode, setMode] = useState<SourceMode>("websocket");

  const wsHook = useTelemetry(mode === "websocket" ? WS_URL : "", WS_TOKEN);
  const wsSerial = useWebSerial();

  const active = mode === "websocket" ? wsHook : wsSerial;
  const { status, latestRef, rxCount, history } = active;

  const [snap, setSnap] = useState<TelemetryFrame[]>([]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const all = history.current;
      setSnap(all.length > 200 ? all.slice(-200) : [...all]);
    }, SNAPSHOT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [history]);

  useEffect(() => {
    if (mode === "websocket") {
      (async () => {
        try {
          await wsSerial.disconnect();
        } catch {
          // already disconnected
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const url = mode === "websocket" ? WS_URL : "WebSerial (USB direct)";
  const attitudeRef = useMemo(() => latestRef, [latestRef]);

  return (
    <main className="min-h-screen">
      {/* Sticky header */}
      <header
        className="sticky top-0 z-30 backdrop-blur-md bg-glider-bg/70
                   border-b border-glider-border"
      >
        <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-3
                        flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2.5">
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center
                           bg-gradient-to-br from-glider-accent to-glider-pitch
                           text-black font-extrabold text-lg shadow-glow"
                aria-hidden
              >
                ✈
              </div>
              <div className="leading-tight">
                <h1 className="text-base md:text-lg font-bold text-glider-text">
                  Glider Telemetry
                </h1>
                <div className="text-[10px] text-glider-textMute tracking-wider uppercase">
                  自律滑空機 表示 UI
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <ModeSelector
              mode={mode}
              onChange={setMode}
              webSerialSupported={wsSerial.supported}
            />
            <div className="h-8 w-px bg-glider-border hidden md:block" />
            <ConnectionStatus status={status} rxCount={rxCount} url={url} />
            <RateMeter rxCount={rxCount} />
            {mode === "webserial" && status !== "open" && (
              <button
                onClick={() => {
                  wsSerial.connect().catch((e) => {
                    alert(`接続失敗: ${e?.message ?? e}`);
                  });
                }}
                className="btn-primary"
              >
                ▶ Connect Device
              </button>
            )}
            {mode === "webserial" && status === "open" && (
              <button
                onClick={() => void wsSerial.disconnect()}
                className="btn-danger"
              >
                ■ Disconnect
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-5 space-y-5">
        {/* HERO: Primary attitude — huge values + artificial horizon */}
        <section
          className="grid gap-4"
          style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)" }}
        >
          <AttitudeHero attitudeRef={attitudeRef} />
          <ArtificialHorizon
            attitudeRef={attitudeRef}
            className="min-h-[320px]"
          />
        </section>

        {/* SERVO BARS — always visible visual feedback */}
        <ServoBars attitudeRef={attitudeRef} />

        {/* 3D + CHARTS */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-6">
            <Glider3D attitudeRef={attitudeRef} />
          </div>
          <div className="lg:col-span-6 grid grid-cols-1 gap-4">
            <AttitudeChart data={snap} />
            <ServoChart data={snap} />
            <AccelChart data={snap} />
          </div>
        </section>

        {/* SECONDARY TELEMETRY (IMU & system) */}
        <TelemetryPanel attitudeRef={attitudeRef} />

        {/* QUICK MANUAL CONTROL — D-pad + keyboard */}
        <QuickControl
          onSend={mode === "websocket" ? wsHook.sendCommand : wsSerial.sendCommand}
          enabled={status === "open"}
        />

        {/* COMMAND */}
        <CommandPanel
          onSend={mode === "websocket" ? wsHook.sendCommand : wsSerial.sendCommand}
          enabled={status === "open"}
          hint={
            mode === "websocket"
              ? "WebSocket: ground_station 側で 'Accept WS commands' を ON にする必要あり"
              : "WebSerial: USB 直結。Python 不要"
          }
        />

        {/* RECORDER — save / list / export / delete */}
        <RecorderPanel historyRef={history} liveOK={status === "open"} />

        <footer className="pt-2 pb-6 text-[11px] text-glider-textMute space-y-1
                           border-t border-glider-border/50">
          <div className="pt-3 flex flex-wrap gap-x-6 gap-y-1">
            <span>
              <strong className="text-glider-textDim">WebSocket</strong> —
              Python ground_station.py 経由 (PyQt と並行可、複数端末で共有可)
            </span>
            <span>
              <strong className="text-glider-textDim">WebSerial</strong> —
              ブラウザから USB を直接掴む (Chrome / Edge のみ、Python 不要)
            </span>
          </div>
          <div className="text-glider-textMute/70">
            Numeric ≈60Hz (RAF, no rerender) · Charts 5Hz (uPlot) · 3D 60fps · WS reconnect with backoff
          </div>
        </footer>
      </div>
    </main>
  );
}
