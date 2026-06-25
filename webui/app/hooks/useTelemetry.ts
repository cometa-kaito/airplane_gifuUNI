// =============================================================
//  useTelemetry.ts — テレメトリの共有型・定数モジュール
//
//  ⚠ 旧 WebSocket 版フック `useTelemetry()`（Python ground_station.py 経由）は
//     WebSerial 専用化に伴い廃止し、参照用に archive/websocket/useTelemetry_ws.ts
//     へ退避しました。本ファイルは型/定数のみを提供します（約20コンポーネントが
//     TelemetryFrame / Status / PHASE_NAMES をここから import しているためファイル名は据置）。
//     接続は useWebSerial.ts（USB 直結）に一本化。
// =============================================================

export type TelemetryFrame = {
  seq: number;
  t_ms: number;
  dt_ms: number;
  ax: number; ay: number; az: number;
  gx: number; gy: number; gz: number;
  roll: number; pitch: number; yaw: number;
  s0: number; s1: number; s2: number;
  // 17列拡張 (firmware v17+)。旧 firmware 接続時は 0 を入れる。
  phase: number;   // 0=DISARMED, 1=PRELAUNCH, 2=LAUNCH, 3=GLIDE, 4=LANDED
  accel_g: number; // sqrt(ax^2+ay^2+az^2) [g]
  wall_ms: number;
};

// PHASE_NAMES の index は firmware の FlightPhase 値に対応。
// LANDED (旧 phase=4) は DISARMED に統合済 (機能的に同じため)。
// 互換性のため文字列としては配列に残してあり、旧 firmware からの phase=4 を表示できる。
export const PHASE_NAMES = [
  "DISARMED",
  "PRELAUNCH",
  "LAUNCH",
  "GLIDE",
  "LANDED",     // 旧フェーズ。新 firmware では到達しない (DISARMED に統合)
  "WINDTUNNEL",
] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

export type Status = "connecting" | "open" | "closed" | "error";
