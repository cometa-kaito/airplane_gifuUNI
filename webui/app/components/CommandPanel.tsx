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
      { label: "MANUAL",   cmd: "manual", variant: "mode", hint: "手動操縦" },
      // AUTO は実用 PID 一択なので `3` を送る (P 制御で無音に落ちる事故を防止)
      { label: "AUTO/PID", cmd: "3",      variant: "mode", hint: "自律制御 ON (PID)" },
    ],
  },
  {
    title: "Sub-mode",
    variant: "gain",
    items: [
      { label: "P",   cmd: "1", variant: "gain", hint: "P 制御のみ (デバッグ)" },
      { label: "PD",  cmd: "2", variant: "gain", hint: "PD 制御" },
      { label: "PID", cmd: "3", variant: "gain", hint: "PID 制御 (既定)" },
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
    "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100 hover:bg-indigo-100 hover:ring-indigo-200",
  gain:
    "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 hover:bg-emerald-100 hover:ring-emerald-200",
  query:
    "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 hover:ring-slate-300",
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
    <div className="card-pad space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-800 tracking-tight">
            Command
          </h3>
          {hint && (
            <div className="text-xs text-slate-500 mt-1">{hint}</div>
          )}
        </div>
        <div
          className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full ${
            enabled
              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
              : "bg-slate-100 text-slate-500 ring-1 ring-slate-200"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              enabled ? "bg-emerald-500" : "bg-slate-400"
            }`}
            aria-hidden
          />
          {enabled ? "Ready" : "Disconnected"}
        </div>
      </div>

      <div className="flex flex-wrap gap-5">
        {GROUPS.map((g) => (
          <div key={g.title} className="flex flex-col gap-1.5 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
              {g.title}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((q) => (
                <button
                  key={q.cmd}
                  disabled={!enabled || busy}
                  onClick={() => send(q.cmd)}
                  title={q.hint}
                  className={`btn ${VARIANT_STYLE[q.variant]}`}
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
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-mono text-sm pointer-events-none">
            $
          </span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="kp p 1.5  /  target r 0  /  s0 5 ..."
            disabled={!enabled || busy}
            className="w-full bg-white ring-1 ring-slate-200 rounded-md
                       pl-7 pr-3 py-2 text-sm font-mono text-slate-700
                       placeholder:text-slate-400
                       focus:outline-none focus:ring-2 focus:ring-indigo-400
                       hover:ring-slate-300
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
        <div className="font-mono text-[11px] space-y-0.5 max-h-28 overflow-y-auto bg-slate-50 rounded-md px-3 py-2">
          {log.map((l, i) => (
            <div
              key={i}
              className={l.startsWith("!") ? "text-rose-600" : "text-slate-700"}
            >
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
