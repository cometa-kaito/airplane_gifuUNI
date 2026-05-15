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
          onSend("auto").catch(() => undefined);
          setLastAction("→ AUTO");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pitchUp, pitchDn, rollL, rollR, center, onSend]);

  // ボタン共通スタイル
  const padBtn =
    "h-14 min-w-[5rem] rounded-md font-bold text-sm transition-all select-none " +
    "bg-glider-surface border border-glider-border text-glider-text " +
    "hover:bg-glider-panelHi hover:border-glider-borderHi active:scale-95 " +
    "disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="card-pad space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="section-title">Quick Manual Control</div>
          <div className="text-[11px] text-glider-textMute mt-1 leading-snug">
            ボタン or キーボード <kbd className="kbd">↑↓←→</kbd> /{" "}
            <kbd className="kbd">Space</kbd> /{" "}
            <kbd className="kbd">M</kbd>/<kbd className="kbd">A</kbd> でモード切替
          </div>
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

      {/* Status row */}
      <div className="bg-glider-surface border border-glider-border rounded-md px-3 py-2 flex items-center gap-4 flex-wrap font-mono">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute">
            R Ail
          </span>
          <span
            className="stat-val text-lg font-bold"
            style={{ color: "#ff922b" }}
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
            className="stat-val text-lg font-bold"
            style={{ color: "#ffd43b" }}
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
            className="stat-val text-lg font-bold"
            style={{ color: "#a9e34b" }}
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
          <div className="inline-flex p-1 bg-glider-surface border border-glider-border rounded-lg">
            {STEPS.map((s) => (
              <button
                key={s}
                onClick={() => setStep(s)}
                className={`px-3 py-1 rounded-md text-xs font-bold transition ${
                  step === s
                    ? "bg-glider-accent text-black shadow-[0_0_12px_rgba(56,189,248,0.25)]"
                    : "text-glider-textDim hover:bg-glider-panelHi"
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
                " !bg-glider-ok/15 !border-glider-ok/40 !text-glider-ok hover:!bg-glider-ok/25"
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

        {/* Mode shortcuts */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-glider-textMute font-semibold">
            Mode
          </span>
          <div className="flex flex-col gap-1.5">
            <button
              onClick={() => {
                onSend("manual").catch(() => undefined);
                setLastAction("→ MANUAL");
              }}
              disabled={!enabled}
              className="btn-ghost text-xs"
              title="MANUAL (M キー)"
            >
              MANUAL
            </button>
            <button
              onClick={() => {
                onSend("auto").catch(() => undefined);
                setLastAction("→ AUTO");
              }}
              disabled={!enabled}
              className="btn-ghost text-xs"
              title="AUTO (A キー)"
            >
              AUTO
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
