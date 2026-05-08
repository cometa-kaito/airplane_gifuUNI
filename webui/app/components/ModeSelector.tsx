"use client";

export type SourceMode = "websocket" | "webserial";

export function ModeSelector({
  mode,
  onChange,
  webSerialSupported,
}: {
  mode: SourceMode;
  onChange: (m: SourceMode) => void;
  webSerialSupported: boolean;
}) {
  const btn = (active: boolean, disabled: boolean) =>
    [
      "px-3 py-1 rounded text-sm font-bold transition",
      active
        ? "bg-glider-accent text-black"
        : "bg-glider-panel text-gray-300 hover:bg-gray-700",
      disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
    ].join(" ");

  return (
    <div className="flex gap-2 items-center">
      <span className="text-xs text-gray-400">Source:</span>
      <button
        className={btn(mode === "websocket", false)}
        onClick={() => onChange("websocket")}
      >
        WebSocket
      </button>
      <button
        className={btn(mode === "webserial", !webSerialSupported)}
        onClick={() => webSerialSupported && onChange("webserial")}
        disabled={!webSerialSupported}
        title={
          webSerialSupported
            ? "ブラウザから直接 USB シリアルを掴む"
            : "Chromium 系ブラウザのみ対応"
        }
      >
        WebSerial
      </button>
    </div>
  );
}
