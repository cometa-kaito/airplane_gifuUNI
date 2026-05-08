"use client";

import { useState } from "react";

const QUICK_COMMANDS: { label: string; cmd: string }[] = [
  { label: "MANUAL", cmd: "manual" },
  { label: "AUTO", cmd: "auto" },
  { label: "P", cmd: "1" },
  { label: "PD", cmd: "2" },
  { label: "PID", cmd: "3" },
  { label: "status", cmd: "status" },
  { label: "help", cmd: "help" },
];

export function CommandPanel({
  onSend,
  enabled,
}: {
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  const [text, setText] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const send = async (cmd: string) => {
    if (!enabled || busy || !cmd) return;
    setBusy(true);
    try {
      await onSend(cmd);
      setLog((l) => [...l.slice(-9), `> ${cmd}`]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setLog((l) => [...l.slice(-9), `! ${msg}`]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-glider-panel rounded p-3 space-y-2">
      <div className="flex justify-between items-center">
        <div className="text-xs text-gray-400">
          Command Panel (WebSerial 直結時のみ有効)
        </div>
        <div className="text-xs text-gray-500">
          {enabled ? "ready" : "disconnected"}
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {QUICK_COMMANDS.map((q) => (
          <button
            key={q.cmd}
            disabled={!enabled || busy}
            onClick={() => send(q.cmd)}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed
                       text-gray-100 px-3 py-1 rounded text-sm transition"
          >
            {q.label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) {
            send(text.trim());
            setText("");
          }
        }}
        className="flex gap-2"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="kp p 1.5  /  target r 0  /  s0 5 ..."
          disabled={!enabled || busy}
          className="flex-1 bg-glider-bg border border-gray-700 rounded px-2 py-1
                     text-sm font-mono text-gray-100 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!enabled || busy || !text.trim()}
          className="bg-glider-accent hover:opacity-90 disabled:opacity-50
                     disabled:cursor-not-allowed text-black px-3 py-1 rounded
                     text-sm font-bold transition"
        >
          Send
        </button>
      </form>

      {log.length > 0 && (
        <div className="font-mono text-xs text-gray-400 space-y-0.5 max-h-24 overflow-y-auto bg-glider-bg rounded p-2">
          {log.map((l, i) => (
            <div key={i} className={l.startsWith("!") ? "text-red-400" : ""}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
