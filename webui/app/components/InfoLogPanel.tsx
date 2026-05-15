"use client";

import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

/**
 * Info Log Panel — 機体側ファームからの `[STATUS]` / `[PHASE]` / `[PARAM]` /
 * `[FAILSAFE]` / `[LAUNCH]` などの応答ラインを表示する。
 *
 * WebSerial モードでは useWebSerial 内でこれらを infoLogRef に溜めている。
 * WebSocket モードでは Python ground_station が CSV テレメトリのみ転送する
 * 設計のため、現状はラインが届かない（必要なら ground_station 側を拡張）。
 *
 * フィルタ機能:
 *   - 種類別 (`[STATUS]`, `[PHASE]` …) のチェックボックス
 *   - 自動スクロール、Clear ボタン
 */

type LogEntry = { ts: number; line: string };

const PREFIX_KINDS = [
  { key: "[STATUS]",   label: "STATUS",   color: "#5cc8ff" },
  { key: "[PHASE]",    label: "PHASE",    color: "#3ddc97" },
  { key: "[PARAM]",    label: "PARAM",    color: "#a9e34b" },
  { key: "[MODE]",     label: "MODE",     color: "#ffd43b" },
  { key: "[LAUNCH]",   label: "LAUNCH",   color: "#ff922b" },
  { key: "[FAILSAFE]", label: "FAILSAFE", color: "#ff5d6c" },
  { key: "[SAFEGUARD]",label: "SAFE",     color: "#ff5d6c" },
  { key: "[INFO]",     label: "INFO",     color: "#94a3b8" },
  { key: "[READY]",    label: "READY",    color: "#a9e34b" },
];

const KIND_KEYS = PREFIX_KINDS.map((k) => k.key);

function categorize(line: string): string {
  for (const k of KIND_KEYS) {
    if (line.startsWith(k)) return k;
  }
  return "[INFO]";
}

function colorFor(line: string): string {
  const k = categorize(line);
  return PREFIX_KINDS.find((p) => p.key === k)?.color ?? "#cbd5e1";
}

export function InfoLogPanel({
  logRef,
  tick,
}: {
  logRef: MutableRefObject<LogEntry[]>;
  tick: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [enabledKinds, setEnabledKinds] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(KIND_KEYS.map((k) => [k, true])),
  );
  const [, force] = useState(0);

  // tick が変わったら再描画
  useEffect(() => {
    force((n) => n + 1);
  }, [tick]);

  const entries = logRef.current.filter((e) => enabledKinds[categorize(e.line)] !== false);

  // 自動スクロール
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [autoScroll, entries.length]);

  const toggleKind = (k: string) =>
    setEnabledKinds((m) => ({ ...m, [k]: !m[k] }));

  const clearLog = () => {
    logRef.current.length = 0;
    force((n) => n + 1);
  };

  return (
    <div className="card-pad space-y-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">Device Log · 機体応答</div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            <code className="font-mono text-glider-textDim">[STATUS]</code> /{" "}
            <code className="font-mono text-glider-textDim">[PHASE]</code> /{" "}
            <code className="font-mono text-glider-textDim">[PARAM]</code> など機体側からの
            応答ライン。コマンド送信後の結果確認に使う。WebSerial モードのみ動作。
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-glider-textDim flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-glider-accent"
            />
            auto-scroll
          </label>
          <button onClick={clearLog} className="btn-ghost text-xs">
            Clear
          </button>
        </div>
      </div>

      {/* カテゴリフィルタ */}
      <div className="flex flex-wrap gap-1.5">
        {PREFIX_KINDS.map((p) => {
          const on = enabledKinds[p.key] !== false;
          return (
            <button
              key={p.key}
              onClick={() => toggleKind(p.key)}
              className={`px-2 py-0.5 text-[10px] font-bold rounded border transition ${
                on
                  ? "bg-glider-surface border-glider-borderHi"
                  : "bg-transparent border-glider-border opacity-40"
              }`}
              style={{ color: on ? p.color : undefined }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* ログ表示 */}
      <div
        ref={containerRef}
        className="bg-glider-surface border border-glider-border rounded-md p-2
                   font-mono text-[11px] leading-snug max-h-72 min-h-[6rem] overflow-y-auto"
      >
        {entries.length === 0 ? (
          <div className="text-glider-textMute italic">
            (no messages yet — try `status` or `help` after connecting)
          </div>
        ) : (
          entries.map((e, i) => {
            const date = new Date(e.ts);
            const hh = String(date.getHours()).padStart(2, "0");
            const mm = String(date.getMinutes()).padStart(2, "0");
            const ss = String(date.getSeconds()).padStart(2, "0");
            return (
              <div key={`${e.ts}-${i}`} className="whitespace-pre-wrap">
                <span className="text-glider-textMute">{hh}:{mm}:{ss}</span>{" "}
                <span style={{ color: colorFor(e.line) }}>{e.line}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
