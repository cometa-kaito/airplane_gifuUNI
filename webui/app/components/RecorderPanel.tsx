"use client";

import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "../hooks/useTelemetry";
import { useRecorder } from "../hooks/useRecorder";
import { getStorageEstimate, type StorageEstimate } from "../lib/db";

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatTimestamp(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function RecorderPanel({
  historyRef,
  liveOK,
}: {
  historyRef: MutableRefObject<TelemetryFrame[]>;
  liveOK: boolean;
}) {
  const rec = useRecorder(historyRef);
  const [elapsed, setElapsed] = useState(0);
  const [usage, setUsage] = useState<StorageEstimate>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  useEffect(() => {
    if (rec.liveStartedAt === null) {
      setElapsed(0);
      return;
    }
    const id = window.setInterval(() => {
      setElapsed(Date.now() - (rec.liveStartedAt ?? Date.now()));
    }, 250);
    return () => window.clearInterval(id);
  }, [rec.liveStartedAt]);

  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      try {
        const e = await getStorageEstimate();
        if (!cancelled) setUsage(e);
      } catch {
        // ignore
      }
    };
    update();
    const id = window.setInterval(update, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [rec.sessions]);

  const totalBytes = rec.sessions.reduce((sum, s) => sum + s.sizeBytes, 0);
  const totalFrames = rec.sessions.reduce((sum, s) => sum + s.frameCount, 0);

  return (
    <div className="card-pad space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">Recorder · データ保存</div>
          <div className="text-[11px] text-glider-textMute mt-1">
            ブラウザのローカルDB (IndexedDB) に保存 · CSV ダウンロード/削除はワンクリック · ストレージは下の表示で確認可能
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!rec.recording ? (
            <button
              onClick={() => rec.start()}
              disabled={!liveOK || rec.busy}
              className="btn-primary"
              title={liveOK ? "新しい記録セッションを開始" : "接続中のみ記録できます"}
            >
              <span className="inline-block w-2 h-2 rounded-full bg-glider-err mr-1.5" />
              Record
            </button>
          ) : (
            <button
              onClick={() => rec.stop()}
              disabled={rec.busy}
              className="btn-danger"
            >
              <span className="inline-block w-2.5 h-2.5 bg-white mr-1.5" />
              Stop
            </button>
          )}
        </div>
      </div>

      {rec.recording && (
        <div className="bg-glider-err/10 border border-glider-err/40 rounded-lg px-4 py-3 flex items-center gap-5 flex-wrap animate-fadeIn">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-glider-err animate-pulseWarn" />
            <span className="text-glider-err font-bold text-sm tracking-wider">
              RECORDING
            </span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-[10px] text-glider-textMute uppercase tracking-wider">
              elapsed
            </span>
            <span className="stat-val text-lg font-bold text-glider-text">
              {formatDuration(elapsed)}
            </span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-[10px] text-glider-textMute uppercase tracking-wider">
              frames
            </span>
            <span className="stat-val text-lg font-bold text-glider-text">
              {rec.liveFrameCount.toLocaleString()}
            </span>
          </div>
          {!liveOK && (
            <span className="text-[11px] text-glider-warn font-semibold">
              ⚠ 接続が切れています
            </span>
          )}
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="bg-glider-surface border border-glider-border rounded-md px-3 py-2">
          <div className="stat-label">セッション</div>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className="stat-val text-xl font-bold text-glider-text">
              {rec.sessions.length}
            </span>
            <span className="text-[10px] text-glider-textMute">件</span>
          </div>
        </div>
        <div className="bg-glider-surface border border-glider-border rounded-md px-3 py-2">
          <div className="stat-label">総フレーム</div>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className="stat-val text-xl font-bold text-glider-text">
              {totalFrames.toLocaleString()}
            </span>
          </div>
        </div>
        <div className="bg-glider-surface border border-glider-border rounded-md px-3 py-2">
          <div className="stat-label">本UIの使用量</div>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className="stat-val text-xl font-bold text-glider-text">
              {formatBytes(totalBytes)}
            </span>
          </div>
        </div>
        <div className="bg-glider-surface border border-glider-border rounded-md px-3 py-2">
          <div className="stat-label">ブラウザ枠</div>
          <div className="flex items-baseline gap-1 mt-0.5">
            {usage ? (
              <>
                <span className="stat-val text-sm font-bold text-glider-text">
                  {formatBytes(usage.used)}
                </span>
                <span className="text-[10px] text-glider-textMute">
                  / {formatBytes(usage.quota)}
                </span>
              </>
            ) : (
              <span className="text-xs text-glider-textMute">N/A</span>
            )}
          </div>
        </div>
      </div>

      {/* Sessions list */}
      {rec.sessions.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
              記録済みセッション
            </div>
            <button
              onClick={() => setConfirmAll(true)}
              className="text-[11px] text-glider-err hover:underline disabled:opacity-50"
              disabled={rec.busy}
            >
              ✕ すべて削除
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
            {rec.sessions.map((s) => {
              const dur =
                s.endedAt != null
                  ? s.endedAt - s.startedAt
                  : Date.now() - s.startedAt;
              const isActive = rec.recording && rec.sessionId === s.id;
              return (
                <div
                  key={s.id}
                  className={`relative bg-glider-surface border rounded-md px-3 py-2.5 transition-colors ${
                    isActive
                      ? "border-glider-err/50"
                      : "border-glider-border hover:border-glider-borderHi"
                  }`}
                >
                  {confirmId === s.id ? (
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="text-sm text-glider-text">
                        「<span className="font-mono">{s.name}</span>」を削除しますか？
                        <span className="text-glider-textMute text-xs ml-2">
                          ({s.frameCount.toLocaleString()} frames · {formatBytes(s.sizeBytes)})
                        </span>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => {
                            rec.removeSession(s.id);
                            setConfirmId(null);
                          }}
                          className="btn-danger text-xs"
                        >
                          削除する
                        </button>
                        <button
                          onClick={() => setConfirmId(null)}
                          className="btn-ghost text-xs"
                        >
                          キャンセル
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {isActive && (
                            <span className="w-2 h-2 rounded-full bg-glider-err animate-pulseWarn" />
                          )}
                          <div className="font-mono text-sm text-glider-text truncate">
                            {s.name}
                          </div>
                        </div>
                        <div className="text-[10px] text-glider-textMute font-mono flex flex-wrap gap-x-3 mt-0.5">
                          <span>{formatTimestamp(s.startedAt)}</span>
                          <span>· {formatDuration(dur)}</span>
                          <span>· {s.frameCount.toLocaleString()} frames</span>
                          <span>· {formatBytes(s.sizeBytes)}</span>
                        </div>
                      </div>
                      <div className="flex gap-1.5 ml-auto">
                        <button
                          onClick={() => rec.exportCSV(s.id, s.name)}
                          disabled={rec.busy || s.frameCount === 0}
                          className="btn-ghost text-xs"
                          title="CSV としてダウンロード"
                        >
                          ↓ CSV
                        </button>
                        <button
                          onClick={() => setConfirmId(s.id)}
                          disabled={rec.busy || isActive}
                          className="btn text-xs bg-glider-err/10 text-glider-err border border-glider-err/30 hover:bg-glider-err/20 disabled:opacity-40"
                          title={isActive ? "記録中のセッションは削除できません" : "削除"}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="text-center py-6 text-[11px] text-glider-textMute border border-dashed border-glider-border rounded-md">
          まだ記録はありません · Record ボタンで開始
        </div>
      )}

      {confirmAll && (
        <div className="bg-glider-err/10 border border-glider-err/40 rounded-md p-3 flex items-center justify-between gap-3 flex-wrap animate-fadeIn">
          <div className="text-sm text-glider-text">
            <strong className="text-glider-err">全削除確認</strong> ·{" "}
            <span className="font-mono">{rec.sessions.length}</span> 件 (
            {formatBytes(totalBytes)}) を完全に削除します。元に戻せません。
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                rec.removeAll();
                setConfirmAll(false);
              }}
              className="btn-danger"
            >
              全部削除
            </button>
            <button
              onClick={() => setConfirmAll(false)}
              className="btn-ghost"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
