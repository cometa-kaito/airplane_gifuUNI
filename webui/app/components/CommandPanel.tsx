"use client";

import { useState } from "react";

type QuickCmd = {
  label: string;
  cmd: string;
  variant: "mode" | "gain" | "query";
  hint?: string;
};

const GROUPS: { title: string; variant: QuickCmd["variant"]; items: QuickCmd[] }[] = [
  {
    title: "Mode",
    variant: "mode",
    items: [
      { label: "MANUAL", cmd: "manual", variant: "mode", hint: "手動操縦" },
      { label: "AUTO",   cmd: "auto",   variant: "mode", hint: "自律制御 ON" },
    ],
  },
  {
    title: "Gain",
    variant: "gain",
    items: [
      { label: "P",   cmd: "1", variant: "gain", hint: "P 制御のみ" },
      { label: "PD",  cmd: "2", variant: "gain", hint: "PD 制御" },
      { label: "PID", cmd: "3", variant: "gain", hint: "PID 制御" },
    ],
  },
  {
    title: "Query",
    variant: "query",
    items: [
      { label: "status", cmd: "status", variant: "query", hint: "現状取得" },
      { label: "help",   cmd: "help",   variant: "query", hint: "ヘルプ表示" },
    ],
  },
];

const VARIANT_STYLE: Record<QuickCmd["variant"], string> = {
  mode:
    "bg-glider-accent/10 text-glider-accent border-glider-accent/30 hover:bg-glider-accent/20 hover:border-glider-accent",
  gain:
    "bg-glider-pitch/10 text-glider-pitch border-glider-pitch/30 hover:bg-glider-pitch/20 hover:border-glider-pitch",
  query:
    "bg-glider-textDim/10 text-glider-textDim border-glider-border hover:bg-glider-textDim/20 hover:text-glider-text",
};

export function CommandPanel({
  onSend,
  enabled,
  hint,
}: {
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
  hint?: string;
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
    <div className="card-pad space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="section-title">Command</div>
          {hint && (
            <div className="text-[11px] text-glider-textMute mt-1">{hint}</div>
          )}
        </div>
        <div
          className={`text-[10px] font-bold tracking-wider px-2 py-1 rounded ${
            enabled
              ? "bg-glider-ok/10 text-glider-ok"
              : "bg-glider-textMute/10 text-glider-textMute"
          }`}
        >
          {enabled ? "READY" : "DISCONNECTED"}
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        {GROUPS.map((g) => (
          <div key={g.title} className="flex flex-col gap-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              {g.title}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((q) => (
                <button
                  key={q.cmd}
                  disabled={!enabled || busy}
                  onClick={() => send(q.cmd)}
                  title={q.hint}
                  className={`btn border ${VARIANT_STYLE[q.variant]}`}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
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
        <div className="flex-1 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-glider-textMute font-mono text-sm pointer-events-none">
            $
          </span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="kp p 1.5  /  target r 0  /  s0 5 ..."
            disabled={!enabled || busy}
            className="w-full bg-glider-surface border border-glider-border rounded-md
                       pl-7 pr-3 py-2 text-sm font-mono text-glider-text
                       placeholder:text-glider-textMute
                       focus:outline-none focus:border-glider-accent focus:ring-1 focus:ring-glider-accent/40
                       disabled:opacity-50"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <button
          type="submit"
          disabled={!enabled || busy || !text.trim()}
          className="btn-primary"
        >
          {busy ? "..." : "Send"}
        </button>
      </form>

      {log.length > 0 && (
        <div className="font-mono text-[11px] space-y-0.5 max-h-28 overflow-y-auto bg-glider-surface border border-glider-border rounded-md px-3 py-2">
          {log.map((l, i) => (
            <div
              key={i}
              className={
                l.startsWith("!")
                  ? "text-glider-err"
                  : "text-glider-text"
              }
            >
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
