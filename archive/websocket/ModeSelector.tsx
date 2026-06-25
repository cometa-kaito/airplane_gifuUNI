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
  return (
    <div className="flex flex-col gap-1">
      <span className="section-title">Source</span>
      <div
        className="inline-flex p-1 bg-glider-surface border border-glider-border rounded-lg"
        role="tablist"
      >
        <button
          role="tab"
          aria-selected={mode === "websocket"}
          className={`tab ${mode === "websocket" ? "tab-active" : ""}`}
          onClick={() => onChange("websocket")}
        >
          WebSocket
        </button>
        <button
          role="tab"
          aria-selected={mode === "webserial"}
          className={`tab ${mode === "webserial" ? "tab-active" : ""}`}
          onClick={() => onChange("webserial")}
          title={
            webSerialSupported
              ? "ブラウザから直接 USB シリアルを掴む"
              : "Web Serial API 未対応ブラウザの可能性 (Chrome / Edge を推奨)"
          }
        >
          WebSerial
          {!webSerialSupported && (
            <span className="ml-1 text-glider-warn" title="未対応ブラウザ">⚠</span>
          )}
        </button>
      </div>
    </div>
  );
}
