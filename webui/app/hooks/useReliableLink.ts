"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { TelemetryFrame } from "./useTelemetry";

/**
 * useReliableLink — 無線リンクの信頼性レイヤ (確認応答つき送信 + 状態再同期)
 *
 * 背景 (バグ):
 *   WebUI → 地上機 → ESP-NOW → 機体 の経路は「送りっぱなし」で、ESP-NOW が
 *   不安定なときコマンド (s0/smid/kp/...) が黙って消える。UI はローカル state を
 *   送信成功前提で更新するため、機体の実サーボ状態と UI 表示が乖離していた。
 *   さらに uplink が途絶えると機体側 failsafe が trim=0 + MANUAL にリセットするが、
 *   UI はそれを反映せず、通信回復後も乖離したままだった。
 *
 * 対策 (このフック):
 *   1. 確認応答つき送信 — 機体ファームは設定系コマンドに必ず [PARAM]/[MODE]/[PHASE]
 *      のエコーを返す。send() はエコーを待ち、届かなければ自動再送する
 *      (最大 MAX_ATTEMPTS 回)。コマンドは絶対値指定で冪等なので再送は安全。
 *      同一キー (例: 同じ ch の s0) の新しい送信は古い保留を破棄する (スライダー連打対応)。
 *   2. FAILSAFE / SAFEGUARD 検知 — 機体からの [FAILSAFE] / [SAFEGUARD] 行を監視し、
 *      「機体側で trim=0 + MANUAL にリセットされた」ことを UI へ通知する。
 *   3. 自動再同期 — failsafe 発火後、リンクが回復 (テレメトリ受信再開) したら
 *      onResync コールバック (トリム・較正の再送) を自動実行して機体を UI 設定に戻す。
 *
 * 返す send() は既存 sendCommand と同じ シグネチャ (Promise<void>) で、
 * 確認失敗でも reject しない (既存パネルの挙動を変えない)。失敗は failures に
 * 蓄積され、LinkHealthBanner から一括再送できる。
 */

const ACK_TIMEOUT_MS = 600; // エコー待ちタイムアウト (往復は通常 <100ms)
const MAX_ATTEMPTS = 3; // 初回送信 + 再送2回
const TLM_FRESH_MS = 800; // テレメトリが「生きている」とみなす最大フレーム年齢
const TLM_LOST_MS = 1500; // これを超えたら「テレメトリ途絶」表示
const RESYNC_MIN_INTERVAL_MS = 3000; // 自動再同期の最短間隔 (暴走防止)

export type LinkQuality = "offline" | "ok" | "lost";

export type FailedCommand = { cmd: string; ts: number };

export type ReliableLinkApi = {
  /** 確認応答つき送信。エコー対象外コマンド (ping/status 等) は素通し。 */
  send: (cmd: string) => Promise<void>;
  /** テレメトリ鮮度から見たリンク品質。 */
  quality: LinkQuality;
  /** 機体 failsafe 発火中 (機体は MANUAL + trim=0 に退避、回復時に自動再同期)。 */
  failsafeActive: boolean;
  /** SAFEGUARD (姿勢角超過) 発火メッセージ。dismiss まで保持。 */
  safeguardMsg: string | null;
  clearSafeguard: () => void;
  /** 再送しても確認できなかったコマンド (新しい順、最大 20 件)。 */
  failures: FailedCommand[];
  /** failures を一括再送。 */
  retryFailures: () => void;
  /** 累計の自動再送回数 (成功したものも含む)。 */
  retryCount: number;
  /** 直近の自動再同期時刻 (トースト表示用)。 */
  lastResyncAt: number | null;
};

// ---- コマンド → 期待エコーの対応表 ----
//   機体ファーム (glider_nRF52840.ino) の応答フォーマットに対応。
//   null を返すコマンドは確認なしで素通し (ping / status / help / ローカル "/" 等)。
type Expectation = {
  /** 同一対象の新旧送信を束ねるキー (新しい送信が古い保留を破棄する)。 */
  key: string;
  /** 受信した情報ラインが期待エコーか (行は lowercase 済で渡される)。 */
  lineTest: (lowerLine: string) => boolean;
  /** ライン以外の確認手段 (テレメトリの phase 等)。タイムアウト時に評価。 */
  checkNow?: () => boolean;
};

function parseAxisToken(tok: string | undefined): number | null {
  if (!tok) return null;
  const t = tok.toLowerCase();
  if (t[0] === "0" || t === "r" || t === "roll") return 0;
  if (t[0] === "1" || t === "p" || t === "pitch") return 1;
  if (t[0] === "2" || t === "y" || t === "yaw") return 2;
  return null;
}

function buildExpectation(
  cmd: string,
  latestRef: MutableRefObject<TelemetryFrame | null>,
  sentAt: number,
): Expectation | null {
  const toks = cmd.trim().split(/\s+/);
  const t0 = (toks[0] ?? "").toLowerCase();
  const prefix = (p: string) => {
    const pl = p.toLowerCase();
    return (line: string) => line.startsWith(pl);
  };
  const exact = (p: string) => {
    const pl = p.toLowerCase();
    return (line: string) => line === pl;
  };
  // フェーズ遷移はエコー ([PHASE] -> X) か、テレメトリ 16 列目の phase 値で確認する。
  // (既に目標フェーズなら firmware はエコーを返さないため、phase 値の確認が必須)
  const phaseCheck = (want: number, echoName: string): Expectation => ({
    key: "phase",
    lineTest: prefix(`[PHASE] -> ${echoName}`),
    checkNow: () => {
      const f = latestRef.current;
      return !!f && f.wall_ms >= sentAt - 200 && f.phase === want;
    },
  });

  switch (t0) {
    case "s0":
    case "s1":
    case "s2":
      return { key: t0, lineTest: prefix(`[PARAM] ${t0} trim=`) };
    case "kp":
    case "ki":
    case "kd":
    case "target": {
      const axis = parseAxisToken(toks[1]);
      if (axis === null) return null;
      return {
        key: `${t0}:${axis}`,
        lineTest: prefix(`[PARAM] ${t0} axis=${axis}`),
      };
    }
    case "smin":
    case "smid":
    case "smax": {
      const ch = toks[1];
      if (ch === undefined) return null;
      return { key: `${t0}:${ch}`, lineTest: prefix(`[PARAM] ${t0} ch=${ch}`) };
    }
    case "srev": {
      const ch = toks[1];
      if (ch === undefined) return null;
      return { key: `srev:${ch}`, lineTest: prefix(`[PARAM] srev ch=${ch}`) };
    }
    case "sjog": {
      // ドラッグ中の連続 jog は確認しない (すぐ次の値で上書きされる)。
      // `sjog N off` だけは「舵が端で止まったまま」を防ぐため確認+再送する。
      const ch = toks[1];
      if (ch === undefined || (toks[2] ?? "").toLowerCase() !== "off") return null;
      return {
        key: `sjog:${ch}`,
        lineTest: prefix(`[PARAM] sjog ch=${ch} off`),
      };
    }
    case "m":
    case "manual":
      return { key: "mode", lineTest: exact("[MODE] MANUAL") };
    case "a":
    case "auto":
      return { key: "mode", lineTest: exact("[MODE] AUTO") };
    case "1":
      return { key: "mode", lineTest: exact("[MODE] AUTO/P") };
    case "2":
      return { key: "mode", lineTest: exact("[MODE] AUTO/PD") };
    case "3":
      return { key: "mode", lineTest: exact("[MODE] AUTO/PID") };
    case "arm":
      return phaseCheck(1, "PRELAUNCH");
    case "disarm":
      return phaseCheck(0, "DISARMED");
    case "land":
      return phaseCheck(0, "DISARMED");
    case "wt":
    case "wt_mode":
    case "windtunnel":
      return phaseCheck(5, "WINDTUNNEL");
    case "failsafe":
      return { key: "failsafe", lineTest: prefix("[PARAM] failsafe=") };
    case "safe_angle":
    case "tilt_limit":
      return { key: "safe_angle", lineTest: prefix("[PARAM] safe_angle=") };
    case "dfilter":
      return { key: "dfilter", lineTest: prefix("[PARAM] dfilter=") };
    case "launch_g":
    case "climb_ms":
    case "climb_pitch":
    case "climb_ff":
    case "glide_pitch":
      return { key: t0, lineTest: prefix(`[PARAM] ${t0}=`) };
    case "d_source":
      return { key: "d_source", lineTest: prefix("[PARAM] d_source=") };
    case "mixl":
    case "mixr":
      // firmware は入力トークンをそのままエコーする ([PARAM] mixR = 1.000)
      return { key: t0, lineTest: prefix(`[PARAM] ${t0}`) };
    case "zero":
      return { key: "zero", lineTest: prefix("[PARAM] zero set") };
    case "unzero":
      return { key: "zero", lineTest: prefix("[PARAM] zero cleared") };
    case "tlm": {
      const arg = (toks[1] ?? "").toLowerCase();
      if (arg !== "on" && arg !== "off") return null;
      return { key: "tlm", lineTest: prefix(`[INFO] tlm ${arg}`) };
    }
    default:
      return null; // ping / status / help / "/..." 等は素通し
  }
}

type Pending = {
  cmd: string;
  exp: Expectation;
  attempts: number;
  timer: number;
  resolve: () => void;
};

export function useReliableLink({
  sendRaw,
  subscribeLine,
  latestRef,
  enabled,
  onResync,
}: {
  sendRaw: (cmd: string) => Promise<void>;
  subscribeLine: (cb: (line: string) => void) => () => void;
  latestRef: MutableRefObject<TelemetryFrame | null>;
  enabled: boolean;
  /** failsafe 回復後に呼ばれる。トリム・較正など「UI が真とする状態」を再送する。 */
  onResync: () => Promise<void> | void;
}): ReliableLinkApi {
  const [quality, setQuality] = useState<LinkQuality>("offline");
  const [failsafeActive, setFailsafeActive] = useState(false);
  const [safeguardMsg, setSafeguardMsg] = useState<string | null>(null);
  const [failures, setFailures] = useState<FailedCommand[]>([]);
  const [retryCount, setRetryCount] = useState(0);
  const [lastResyncAt, setLastResyncAt] = useState<number | null>(null);

  const pendingRef = useRef<Map<string, Pending>>(new Map());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const sendRawRef = useRef(sendRaw);
  sendRawRef.current = sendRaw;
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;
  const needResyncRef = useRef(false);
  const lastResyncTryRef = useRef(0);
  const resyncBusyRef = useRef(false);
  const wasLostRef = useRef(false);
  const enabledSinceRef = useRef(0);

  // ---- 確認応答つき送信 ----
  const settle = useCallback((p: Pending) => {
    window.clearTimeout(p.timer);
    pendingRef.current.delete(p.exp.key);
    p.resolve();
  }, []);

  const send = useCallback(
    (cmd: string): Promise<void> => {
      const sentAt = Date.now();
      const exp = buildExpectation(cmd, latestRef, sentAt);
      if (!exp || !enabledRef.current) {
        return sendRawRef.current(cmd);
      }

      // 同一キーの古い保留は破棄 (スライダー連打で古い値を再送しない)
      const old = pendingRef.current.get(exp.key);
      if (old) settle(old);

      return new Promise<void>((resolve) => {
        const p: Pending = { cmd, exp, attempts: 0, timer: 0, resolve };
        pendingRef.current.set(exp.key, p);

        const attempt = () => {
          p.attempts++;
          sendRawRef.current(cmd).catch(() => {
            // シリアル書き込み自体の失敗 (切断等)。再送タイマに任せる。
          });
          p.timer = window.setTimeout(() => {
            if (pendingRef.current.get(exp.key) !== p) return; // 破棄済み
            // エコーは来なかったが、別の確認手段 (テレメトリ phase 等) で通っていれば成功
            if (p.exp.checkNow?.()) {
              settle(p);
              return;
            }
            if (p.attempts < MAX_ATTEMPTS && enabledRef.current) {
              setRetryCount((n) => n + 1);
              attempt();
            } else {
              // 諦める: failures へ記録 (banner から一括再送可能)。resolve はする。
              settle(p);
              setFailures((prev) =>
                [{ cmd, ts: Date.now() }, ...prev.filter((f) => f.cmd !== cmd)].slice(0, 20),
              );
            }
          }, ACK_TIMEOUT_MS);
        };
        attempt();
      });
    },
    [latestRef, settle],
  );

  // ---- 受信ライン監視: ACK 照合 + FAILSAFE / SAFEGUARD 検知 ----
  useEffect(() => {
    const unsub = subscribeLine((line) => {
      const lower = line.toLowerCase();

      // ACK 照合
      for (const p of pendingRef.current.values()) {
        if (p.exp.lineTest(lower)) {
          // 確認できたら failures からも消す (再送で回復したケース)
          setFailures((prev) =>
            prev.length ? prev.filter((f) => f.cmd !== p.cmd) : prev,
          );
          settle(p);
          break;
        }
      }

      // 機体イベント検知
      if (lower.startsWith("[failsafe] uplink lost")) {
        // 機体は trim=0 + MANUAL に退避した。リンク回復後に自動再同期する。
        setFailsafeActive(true);
        needResyncRef.current = true;
      } else if (lower.startsWith("[failsafe] cleared")) {
        setFailsafeActive(false);
        // cleared 直後に再同期 (下の interval が実行する)
        needResyncRef.current = true;
      } else if (lower.startsWith("[safeguard]")) {
        // 飛行中の安全リセット (意図的な trim=0)。自動では戻さず表示のみ。
        setSafeguardMsg(line);
      } else if (lower.startsWith("[ready]")) {
        // 機体マイコンが再起動した (trim / 較正 / ゲインすべて既定値に戻っている)。
        // テレメトリが流れ出したら UI の保存値を送り直す。
        needResyncRef.current = true;
      }
    });
    return unsub;
  }, [subscribeLine, settle]);

  // ---- リンク品質判定 + 自動再同期ループ ----
  useEffect(() => {
    if (!enabled) {
      setQuality("offline");
      setFailsafeActive(false);
      needResyncRef.current = false;
      // 切断時は保留を全部流す (再接続時のオートシンクが真の状態を送り直す)
      pendingRef.current.forEach((p) => {
        window.clearTimeout(p.timer);
        p.resolve();
      });
      pendingRef.current.clear();
      return;
    }

    enabledSinceRef.current = Date.now();
    wasLostRef.current = false;

    const id = window.setInterval(() => {
      const f = latestRef.current;
      // まだ 1 フレームも来ていない間は「接続してからの経過」で判定する
      // (接続直後の一瞬だけ赤バナーが出るのを防ぎつつ、機体電源 OFF は検出する)
      const age = f
        ? Date.now() - f.wall_ms
        : Date.now() - enabledSinceRef.current;
      const fresh = age < TLM_FRESH_MS;
      const lost = age > TLM_LOST_MS;
      setQuality(lost ? "lost" : "ok");

      // リンク回復 (lost → ok) を検知したら念のため再同期を予約する。
      // 途絶中に機体 failsafe が発火していても、[FAILSAFE] の通知行そのものが
      // ロストして UI が気付けないケースがあるため。再同期は冪等なので無害。
      if (wasLostRef.current && !lost) {
        needResyncRef.current = true;
      }
      wasLostRef.current = lost;

      // failsafe からの回復: テレメトリが流れ出したら UI 設定を機体へ送り直す
      if (
        needResyncRef.current &&
        fresh &&
        !resyncBusyRef.current &&
        Date.now() - lastResyncTryRef.current > RESYNC_MIN_INTERVAL_MS
      ) {
        needResyncRef.current = false;
        lastResyncTryRef.current = Date.now();
        resyncBusyRef.current = true;
        Promise.resolve(onResyncRef.current())
          .then(() => {
            setFailsafeActive(false);
            setLastResyncAt(Date.now());
          })
          .catch(() => {
            needResyncRef.current = true; // 失敗したら次の tick で再試行
          })
          .finally(() => {
            resyncBusyRef.current = false;
          });
      }
    }, 300);
    return () => window.clearInterval(id);
  }, [enabled, latestRef]);

  const retryFailures = useCallback(() => {
    const list = failures;
    setFailures([]);
    // 古い順 (逆順) に送り直す
    (async () => {
      for (const f of [...list].reverse()) {
        await send(f.cmd);
      }
    })();
  }, [failures, send]);

  const clearSafeguard = useCallback(() => setSafeguardMsg(null), []);

  return {
    send,
    quality,
    failsafeActive,
    safeguardMsg,
    clearSafeguard,
    failures,
    retryFailures,
    retryCount,
    lastResyncAt,
  };
}
