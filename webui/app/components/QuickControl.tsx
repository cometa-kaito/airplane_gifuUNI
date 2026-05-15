"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const STEPS = [5, 10, 20] as const;
type Step = (typeof STEPS)[number];

/**
 * Quick Manual Control (D-pad)
 *
 * Python ground_station.py の Quick Manual Control を移植。
 * - ↑/↓: pitch (s2)
 * - ←/→: roll (s0/s1 を逆位相で動かす)
 * - Space: center (全部 0 に)
 * - M/A: モード切替
 *
 * MANUAL モードでは送信した数値が直接サーボ角度に、
 * AUTO モードでは PID 出力に対する trim となる (機体側 ino の仕様)。
 */
export function QuickControl({
  onSend,
  enabled,
}: {
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  const [step, setStep] = useState<Step>(10);
  const [trim, setTrim] = useState({ s0: 0, s1: 0, s2: 0 });
  const [lastAction, setLastAction] = useState<string>("");

  // closure に頼らず最新値を読むための ref
  const trimRef = useRef(trim);
  const stepRef = useRef<Step>(step);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    trimRef.current = trim;
  }, [trim]);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const clamp = (v: number) => Math.max(-90, Math.min(90, v));

  const setServo = useCallback(
    (idx: 0 | 1 | 2, value: number) => {
      const v = Math.round(clamp(value));
      const key = `s${idx}` as "s0" | "s1" | "s2";
      const next = { ...trimRef.current, [key]: v };
      trimRef.current = next;
      setTrim(next);
      if (enabledRef.current) {
        onSend(`s${idx} ${v}`).catch(() => {
          // 失敗してもUI状態は維持（次のコマンドで上書きされる）
        });
      }
    },
    [onSend],
  );

  const pitchUp = useCallback(() => {
    setServo(2, trimRef.current.s2 + stepRef.current);
    setLastAction("↑ Pitch Up");
  }, [setServo]);

  const pitchDn = useCallback(() => {
    setServo(2, trimRef.current.s2 - stepRef.current);
    setLastAction("↓ Pitch Down");
  }, [setServo]);

  const rollL = useCallback(() => {
    // 左ロール: 右エルロン下げ (-) / 左エルロン上げ (+)
    const d = stepRef.current;
    setServo(0, trimRef.current.s0 - d);
    setServo(1, trimRef.current.s1 + d);
    setLastAction("← Roll Left");
  }, [setServo]);

  const rollR = useCallback(() => {
    const d = stepRef.current;
    setServo(0, trimRef.current.s0 + d);
    setServo(1, trimRef.current.s1 - d);
    setLastAction("Roll Right →");
  }, [setServo]);

  const center = useCallback(() => {
    setServo(0, 0);
    setServo(1, 0);
    setServo(2, 0);
    setLastAction("⊙ Center");
  }, [setServo]);

  // キーボードハンドラ (input にフォーカス中はキャプチャしない)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (active?.isContentEditable) return;
      if (!enabledRef.current) return;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          pitchUp();
          break;
        case "ArrowDown":
          e.preventDefault();
          pitchDn();
          break;
        case "ArrowLeft":
          e.preventDefault();
          rollL();
          break;
        case "ArrowRight":
          e.preventDefault();
          rollR();
          break;
        case " ":
          e.preventDefault();
          center();
          break;
        case "m":
        case "M":
          onSend("manual").catch(() => undefined);
          setLastAction("→ MANUAL");
          break;
        case "a":
        case "A":
          // AUTO は実用上ほぼ常に PID で使うため、`3` (= MODE_AUTO + SUB_PID) を送る。
          // (`auto` 単体だと firmware の autoSub が前回値のまま=既定 P のため、
          //  ユーザが「PID で飛ばすつもり」のときに無音で P 制御に落ちる事故を防ぐ)
          onSend("3").catch(() => undefined);
          setLastAction("→ AUTO/PID");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pitchUp, pitchDn, rollL, rollR, center, onSend]);

  // D-pad ボタン共通スタイル (クリーンライトテーマ、shadow-sm で立体感)
  const padBtn =
    "h-14 min-w-[5rem] rounded-lg font-semibold text-sm transition-all select-none " +
    "bg-white text-slate-700 ring-1 ring-slate-200 shadow-sm " +
    "hover:bg-slate-50 hover:ring-slate-300 active:scale-95 " +
    "disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="card-pad space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-slate-800 tracking-tight">
            Quick Manual Control
          </h3>
          <div className="text-xs text-slate-500 mt-1 leading-snug">
            ボタン or キーボード <kbd className="kbd">↑↓←→</kbd> /{" "}
            <kbd className="kbd">Space</kbd> /{" "}
            <kbd className="kbd">M</kbd> (Manual) /{" "}
            <kbd className="kbd">A</kbd> (Auto/PID)
          </div>
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

      {/* Status row */}
      <div className="bg-slate-50 rounded-md px-3 py-2 flex items-center gap-4 flex-wrap font-mono">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute">
            R Ail
          </span>
          <span
            className="stat-val text-lg font-semibold"
            style={{ color: "#ea580c" }}
          >
            {trim.s0 >= 0 ? "+" : ""}
            {trim.s0}°
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute">
            L Ail
          </span>
          <span
            className="stat-val text-lg font-semibold"
            style={{ color: "#ca8a04" }}
          >
            {trim.s1 >= 0 ? "+" : ""}
            {trim.s1}°
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute">
            Elev
          </span>
          <span
            className="stat-val text-lg font-semibold"
            style={{ color: "#65a30d" }}
          >
            {trim.s2 >= 0 ? "+" : ""}
            {trim.s2}°
          </span>
        </div>
        {lastAction && (
          <span className="ml-auto text-[11px] text-glider-textDim">
            last: {lastAction}
          </span>
        )}
      </div>

      <div className="flex items-start gap-6 flex-wrap">
        {/* Step selector */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            Step
          </span>
          <div className="inline-flex p-1 bg-slate-100 rounded-lg">
            {STEPS.map((s) => (
              <button
                key={s}
                onClick={() => setStep(s)}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                  step === s
                    ? "bg-white text-indigo-700 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {s}°
              </button>
            ))}
          </div>
        </div>

        {/* D-pad */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            D-Pad
          </span>
          <div className="grid grid-cols-3 gap-1.5">
            <div />
            <button
              onClick={pitchUp}
              disabled={!enabled}
              className={padBtn}
              title="Pitch Up (↑)"
            >
              ↑<div className="text-[9px] font-normal text-glider-textMute">
                Pitch Up
              </div>
            </button>
            <div />

            <button
              onClick={rollL}
              disabled={!enabled}
              className={padBtn}
              title="Roll Left (←)"
            >
              ←<div className="text-[9px] font-normal text-glider-textMute">
                Roll L
              </div>
            </button>
            <button
              onClick={center}
              disabled={!enabled}
              className={
                padBtn +
                " !bg-emerald-50 !ring-emerald-200 !text-emerald-700 hover:!bg-emerald-100 hover:!ring-emerald-300"
              }
              title="Center all (Space)"
            >
              ⊙<div className="text-[9px] font-normal opacity-80">Center</div>
            </button>
            <button
              onClick={rollR}
              disabled={!enabled}
              className={padBtn}
              title="Roll Right (→)"
            >
              →<div className="text-[9px] font-normal text-glider-textMute">
                Roll R
              </div>
            </button>

            <div />
            <button
              onClick={pitchDn}
              disabled={!enabled}
              className={padBtn}
              title="Pitch Down (↓)"
            >
              ↓<div className="text-[9px] font-normal text-glider-textMute">
                Pitch Dn
              </div>
            </button>
            <div />
          </div>
        </div>

        {/* Mode shortcuts: MANUAL / AUTO(=PID) を主要ボタンに、P / PD は補助 */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
            Mode
          </span>
          <div className="flex flex-col gap-1.5">
            <button
              onClick={() => {
                onSend("manual").catch(() => undefined);
                setLastAction("→ MANUAL");
              }}
              disabled={!enabled}
              className="btn-ghost text-xs min-w-[120px]"
              title="MANUAL (M キー)"
            >
              MANUAL
            </button>
            <button
              onClick={() => {
                // AUTO は実用上 PID 一択なので `3` を送る (P 制御で無音に落ちる事故を防止)
                onSend("3").catch(() => undefined);
                setLastAction("→ AUTO/PID");
              }}
              disabled={!enabled}
              className="btn-primary text-xs min-w-[120px]"
              title="AUTO/PID (A キー)。フル PID 制御で起動"
            >
              AUTO <span className="opacity-80 text-[10px] ml-0.5">(PID)</span>
            </button>
            {/* 高度なサブモード切替 (P / PD): 通常は使わない */}
            <div className="flex items-center gap-1 mt-1">
              <span className="text-[9px] uppercase tracking-wider text-slate-400 mr-1">
                sub
              </span>
              <button
                onClick={() => {
                  onSend("1").catch(() => undefined);
                  setLastAction("→ AUTO/P");
                }}
                disabled={!enabled}
                className="flex-1 px-2 py-1 text-[10px] font-semibold rounded
                           bg-white ring-1 ring-slate-200 text-slate-600
                           hover:bg-slate-50 hover:ring-slate-300
                           disabled:opacity-40"
                title="P 制御のみ (デバッグ用)"
              >
                P
              </button>
              <button
                onClick={() => {
                  onSend("2").catch(() => undefined);
                  setLastAction("→ AUTO/PD");
                }}
                disabled={!enabled}
                className="flex-1 px-2 py-1 text-[10px] font-semibold rounded
                           bg-white ring-1 ring-slate-200 text-slate-600
                           hover:bg-slate-50 hover:ring-slate-300
                           disabled:opacity-40"
                title="PD 制御 (I 抜き)"
              >
                PD
              </button>
              <button
                onClick={() => {
                  onSend("3").catch(() => undefined);
                  setLastAction("→ AUTO/PID");
                }}
                disabled={!enabled}
                className="flex-1 px-2 py-1 text-[10px] font-semibold rounded
                           bg-indigo-50 ring-1 ring-indigo-200 text-indigo-700
                           hover:bg-indigo-100 hover:ring-indigo-300
                           disabled:opacity-40"
                title="PID 制御 (既定)"
              >
                PID
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
