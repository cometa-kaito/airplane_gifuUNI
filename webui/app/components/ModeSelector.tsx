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
  const btn = (active: boolean) =>
    [
      "px-3 py-1 rounded text-sm font-bold transition cursor-pointer",
      active
        ? "bg-glider-accent text-black"
        : "bg-glider-panel text-gray-300 hover:bg-gray-700",
    ].join(" ");

  return (
    <div className="flex gap-2 items-center flex-wrap">
      <span className="text-xs text-gray-400">Source:</span>
      <button
        className={btn(mode === "websocket")}
        onClick={() => onChange("websocket")}
      >
        WebSocket
      </button>
      <button
        className={btn(mode === "webserial")}
        onClick={() => onChange("webserial")}
        title={
          webSerialSupported
            ? "ブラウザから直接 USB シリアルを掴む"
            : "Web Serial API 未対応ブラウザの可能性 (Chrome / Edge を推奨)"
        }
      >
        WebSerial
      </button>
      {mode === "webserial" && !webSerialSupported && (
        <span className="text-xs text-yellow-400">
          ⚠ 未対応ブラウザ (Chrome / Edge を使用してください)
        </span>
      )}
    </div>
  );
}
