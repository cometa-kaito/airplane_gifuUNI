// =============================================================
//  glider_nRF52840.ino
//  自律滑空機・機体側メインスケッチ（Exercise05+ エルロン構成版）
//  対象: Seeed XIAO nRF52840 Sense
//
//  サーボ構成:
//    D0 -> 右エルロン (servo[0])
//    D1 -> 左エルロン (servo[1])
//    D2 -> エレベータ (servo[2])
//    ※ ラダーは無し（yaw 制御は使わない）
//
//  制御の流れ:
//    1. IMU 読み取り -> Madgwick で roll/pitch/yaw 推定
//    2. 3軸 PID で操作量 u_roll, u_pitch, u_yaw を計算
//       （yaw は通常 K=0 で実質無効、必要時のみ有効化）
//    3. サーボミキシングで物理サーボ角に展開:
//         右エルロン (D0)  = trim[0] + u_roll
//         左エルロン (D1)  = trim[1] - u_roll   (左右逆位相)
//         エレベータ (D2)  = trim[2] + u_pitch
//
//  自律飛行 (Launch detection):
//    `arm` コマンドで投擲検知を有効化。
//    投擲時 |a|>2.5g を一定時間連続検出すると AUTO/PID へ自動遷移し、
//    その後 500ms の grace 期間は PID 出力をゼロホールド（Madgwick が
//    投擲ショックから復帰する猶予）。その後 PID 制御開始。
//
//  CSV テレメトリ (17 列):
//    seq, t_ms, dt_ms, ax, ay, az, gx, gy, gz,
//    roll, pitch, yaw, s0(右エルロン), s1(左エルロン), s2(エレベータ),
//    phase(0..4), accel_g(|a|)
//    ※ 旧 15 列パーサとの互換性のため、付属 Python/WebUI viewer は
//      「列数 >= 15」を受理する下位互換実装。phase/accel_g 不明時は 0 扱い。
//
//  コマンド (Serial1 行末 LF):
//    m / manual         -> MANUAL（trim をそのままサーボへ）
//    a / auto           -> AUTO（PID + ミキシングでサーボへ）
//    1 / 2 / 3          -> P / PD / PID
//    kp <axis> <value>  (axis = 0/1/2 or r/p/y)
//    ki <axis> <value>
//    kd <axis> <value>
//    target <axis> <value>
//    s0 <deg> / s1 <deg> / s2 <deg>   (各サーボの trim、-90..+90)
//    smid/smax/smin <ch> <us>         (サーボ較正: 中立/＋端/−端、µs)
//    srev <ch> <0|1>                  (サーボ出力反転、取付向き補正)
//    status / help / tlm on / tlm off
//    failsafe <ms>      アップリンク途絶でフェイルセーフ発動するまでの ms (0 で無効)
//    arm / disarm       投擲検知の有効化 / 解除（自律滑空モード）
//    land               強制 LANDED 遷移（手動着地、GLIDE 詰まり脱出）
//    launch_g <g>       投擲検知しきい値 (既定 2.5g)
//    wt                 風洞試験モード遷移 (PID 常時 ON、safeguards 抑制)
// =============================================================

#include <LSM6DS3.h>
#include <Wire.h>
#include <MadgwickAHRS.h>
#include <Servo.h>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>     // sqrtf, fabsf (launch detection / tilt safeguard)

// nRF52840 内蔵ウォッチドッグ（ループブロック時の暴走防止）
#define ENABLE_WDT 1
#if ENABLE_WDT
  // 32.768 kHz LFCLK 基準。WDT_TIMEOUT_S 秒で reset。
  #define WDT_TIMEOUT_S 3
#endif

// 制御ループ周期 [Hz]。Madgwick・PID・テレメトリすべてこのレートで動く。
// 旧 50Hz は宣言だけで、実測 ~32Hz だった (sensor read + Madgwick + radio TX が
// ~11ms 消費、delay(20) 追加で計 31ms)。これだと filter.begin(50) と実周期が
// 一致せず姿勢推定にバイアスが乗るため、実測に近い 30Hz に下げて宣言と実態を
// 揃える。loop 末尾は固定 delay() でなく micros() ベースの絶対時刻ピリオドで
// 駆動するので、実周期は ±数百 µs 精度で 30Hz に固定される。
#define MEASURING_FREQ 30
#define RADIO_SERIAL  Serial1
#define DEBUG_SERIAL  Serial

#define SERVO_PIN_0   0   // D0: 右エルロン
#define SERVO_PIN_1   1   // D1: 左エルロン
#define SERVO_PIN_2   2   // D2: エレベータ

LSM6DS3 IMU(I2C_MODE, 0x6A);
Madgwick filter;
Servo servo[3];

// ---- mode ----
enum BaseMode { MODE_MANUAL = 0, MODE_AUTO = 1 };
enum AutoSub  { SUB_P = 1, SUB_PD = 2, SUB_PID = 3 };
BaseMode baseMode = MODE_MANUAL;
AutoSub  autoSub  = SUB_P;
BaseMode prevBase = MODE_MANUAL;
AutoSub  prevSub  = SUB_P;

// ---- 3-axis PID（roll, pitch, yaw のフィードバック係数）----
float Kp[3] = {1.0f, 1.0f, 0.0f};
float Ki[3] = {0.2f, 0.2f, 0.0f};
float Kd[3] = {0.02f, 0.02f, 0.0f};
float target[3] = {0.0f, 0.0f, 0.0f};

// ---- 物理サーボの基準角（trim） ----
//   trim[0] = 右エルロン基準角
//   trim[1] = 左エルロン基準角（左右で異なる中立位置を吸収できる）
//   trim[2] = エレベータ基準角
float trimDeg[3] = {0.0f, 0.0f, 0.0f};

// ---- ミキシングパラメータ ----
//   左エルロンの位相反転（標準は反転 = -1.0）。物理取付の都合で逆相にしたい場合に変更
float aileronMixL = -1.0f;
float aileronMixR = +1.0f;

// ---- 物理サーボ較正（subtrim + エンドポイント, µs） ----
//   旧実装は「論理舵角 ±90° → 0..180° → servo.write()」と固定変換していたが、
//   実際の可動域・中立・左右(上下)非対称はサーボホーン長/リンケージ/取付向きで
//   決まり、固定 ±90 では表現できない（突き当たり stall / 可動不足の原因）。
//   そこでサーボごとに次の3点を µs で持ち、制御出力(論理角 ±90°)を写像する:
//       servoCenterUs[i] : 中立(subtrim)。論理 0° のパルス幅。
//       servoMaxUs[i]    : 論理 +90° 側の機械端。
//       servoMinUs[i]    : 論理 -90° 側の機械端。
//   center→max と center→min で傾きが別なので「左右/上下で異なる可動域」を表現でき、
//   最終パルスは [min,max] でクランプして機械端の突き当たりを防ぐ。
//   servoReverse[i] : 取付向きの出力反転。既定は従来コードと同一
//                     (D0 右エルロン=反転 / D1 左エルロン=正転 / D2 エレベータ=反転)。
//   いずれも RAM のみ保持（電源 OFF で消える）。WebUI/地上局が接続時に再送する。
const int SERVO_US_ABS_MIN = 500;    // 設定として許す絶対下限
const int SERVO_US_ABS_MAX = 2500;   // 設定として許す絶対上限
int  servoMinUs[3]    = {1000, 1000, 1000};
int  servoCenterUs[3] = {1500, 1500, 1500};
int  servoMaxUs[3]    = {2000, 2000, 2000};
bool servoReverse[3]  = {true, false, true};

// ---- サーボ・ジョグ (エンドポイント較正の実位置確認用) ----
//   DISARMED(地上)時のみ、WebUI から `sjog <ch> <us>` で該当chを生µsで直接駆動する。
//   制御ループ最終段のサーボ出力をこの値で上書き(度数/reverse/PID を経由しない)。
//   `sjog <ch> off` / arm / disarm / failsafe / 無操作タイムアウト で自動解除する。
int      servoJogUs[3] = {-1, -1, -1};            // >=0 のとき有効 (生µs)
uint32_t servoJogMs = 0;                          // 最終 jog 指令時刻
const uint32_t SERVO_JOG_TIMEOUT_MS = 12000;      // 無操作自動解除 [ms]
// ※ clearServoJog() の定義は FlightPhase enum より後ろ（下方）に置くこと。
//   enum より前に関数定義があると、Arduino の自動プロトタイプ生成が FlightPhase 宣言より
//   前に挿入され、phaseTransition(FlightPhase) が "FlightPhase not declared" でコンパイル失敗する。

float integralE[3] = {0, 0, 0};
float prevE[3] = {0, 0, 0};
// integralLimit: Ki=0.2 のとき I 単独で ±10°相当 (= 50 * 0.2) になる物理意味のある値。
// (旧値 200 では I 単独 ±40° → サーボ可動 ±90° のうち半分近くを占有する暴走源だった)
const float integralLimit = 50.0f;

// ---- D-term low-pass filter ----
//   D 項は de = (e - prevE) / dt で計算するため、dt=33ms (30Hz) では
//   IMU 雑音が約 30倍に増幅され、サーボがバタつく (ぴくぴく) 主因になる。
//   1次 IIR LPF を掛けて高周波ノイズだけ落とす:
//     dFilt[i] = α * dFilt[i] + (1-α) * de_raw
//   既定 α=0.85 (30Hz サンプリングで時定数 ~189ms ≈ 0.84Hz cutoff)。
//   実機ログでサーボの急変ピーク 6°/frame、残差 4.4° が観測されたため、
//   α を従来 0.7 から 0.85 に強めて高周波抑制。
//   `dfilter <alpha>` コマンドで動的調整、0 で生 D 動作。
float dFilterAlpha = 0.85f;
float dFilt[3] = {0.0f, 0.0f, 0.0f};

// ---- attitude zero offset (取付角キャリブレーション) ----
//   機体に IMU を取り付けた際、機体水平 ≠ IMU 水平 になることが多い。
//   `zero` コマンドで現在の生 Madgwick 出力を「0°」基準として記録し、
//   以降の Q[] からこのオフセットを差し引いて PID / safeguard /
//   テレメトリに渡す。`unzero` で解除。RAM のみ保持 (再起動でクリア)。
float attitudeOffset[3] = {0.0f, 0.0f, 0.0f};   // [roll, pitch, yaw]
bool  attitudeOffsetActive = false;

// ---- telemetry ----
uint32_t srcSeq = 0;
uint32_t prevUs = 0;
bool telemetryOn = true;

// ---- failsafe (uplink loss) ----
//   アップリンク（地上側からのコマンド受信）が一定時間途絶えたら
//   AUTO/PID を解除して MANUAL + 中立 trim に戻す。
//   コマンドは [STATUS] や [PARAM] 等の応答受信時刻で判定するのではなく、
//   実際にコマンド行が解釈された時刻（handleCommandLine 末尾）で更新する。
uint32_t lastUplinkMs = 0;
uint32_t failsafeTimeoutMs = 1500;  // 0 で無効化
bool failsafeActive = false;

// ---- attitude safeguard (over-tilt -> MANUAL) ----
//   AUTO 中に |roll| または |pitch| が tiltSafeguardDeg を超えたら、
//   自動的に MANUAL + trim=0 へ強制復帰する。
//   0 で無効化。`safe_angle <deg>` コマンドで実行時設定可。
//   再武装は `a`/`auto`/`1`/`2`/`3` コマンドで AUTO に戻ったタイミング。
float tiltSafeguardDeg = 60.0f;     // 既定 60°
bool  tiltSafeguardTriggered = false;

// ---- Flight Phase Machine ----
//   PRELAUNCH → (|a|>launch_g) → LAUNCH → (t>climb_ms) → GLIDE → (|az|<landed_g sustained) → LANDED
//
//   フェーズごとに目標 pitch と feed-forward を切り替える:
//     PRELAUNCH: MANUAL ホールド (trim 維持)、launch_g 監視
//     LAUNCH    : 最初の launchGraceMs は PID 出力 0（高G ショック復帰猶予）。
//                 その後 climb_target_pitch (例 +15°) で機首上げ、feed-forward でエレベータ +5°。
//     GLIDE     : glide_target_pitch (例 +3°、最良滑空角)、feed-forward なし。
//     LANDED    : MANUAL + trim=0、PID 完全停止。地面で延々サーボを駆動しない。
//
//   armed 中 (PHASE_DISARMED 以外) は failsafe を抑制（地上局接続が無くても飛行継続）。
//   下位互換: `arm` → PRELAUNCH、`disarm` → DISARMED、`launch_g` も従来通り。
enum FlightPhase {
  PHASE_DISARMED   = 0,   // arm されていない / 飛行終了後（地上テスト用、failsafe 有効）
                          //   ※ 旧 LANDED と区別していたが「servos 中立 + MANUAL」が両者で同じため統合。
                          //     `land` コマンドが trim を 0 にリセットしてここに戻し、`disarm` は trim を保持。
  PHASE_PRELAUNCH  = 1,   // armed、|a| > launch_g を待機（MANUAL ホールド）
  PHASE_LAUNCH     = 2,   // 投擲検知後 climb_ms まで（climb-out: 機首上げ）
  PHASE_GLIDE      = 3,   // 滑空（最良滑空 pitch）
  // PHASE_LANDED = 4 was removed (merged into DISARMED). Value reserved for backward-compat with old logs.
  PHASE_WINDTUNNEL = 5,   // 風洞試験: PID 常時 ON / 自動遷移なし / tilt safeguard +
                          //           failsafe + climb_ff を抑制。target[] を手動操作して応答計測。
};
FlightPhase phase = PHASE_DISARMED;
uint32_t phaseStartMs = 0;

// 較正ジョグの解除（servoJogUs を無効化）。定義は FlightPhase enum より後ろに置く必要がある
// （上の servoJogUs 付近の注記参照: Arduino 自動プロトタイプ生成順の都合）。
static inline void clearServoJog() { servoJogUs[0] = servoJogUs[1] = servoJogUs[2] = -1; }

float launchAccelG = 2.5f;                  // 投擲判定しきい値 [g]
uint32_t climbMs = 1500;                    // LAUNCH 持続時間 [ms]
uint32_t launchGraceMs = 500;               // LAUNCH 直後の PID ゼロホールド [ms]
float climbTargetPitch = 15.0f;             // LAUNCH 中の目標 pitch [deg]
float glideTargetPitch = 3.0f;              // GLIDE 中の目標 pitch [deg]
float climbElevatorFF = 5.0f;               // LAUNCH 中のエレベータ feed-forward [deg]
// 着地: 自動検出は実装しない (ユーザ判断による誤発火リスク回避)。
//   GLIDE フェーズは `land` コマンド / WebUI の 🛬 Land ボタン / PyQt の Land ボタンで
//   手動 LANDED に遷移させる。`disarm` で直接 DISARMED に飛ばすことも可能。
//   旧設計にあった landed_g / landed_gyro / landed_ms / glide_timeout / landed_impact_g は
//   削除済 (滑空中の |a|≈1g + 静かな瞬間で誤動作する可能性があったため)。
const uint8_t LAUNCH_TRIGGER_FRAMES = 2;    // 連続超過フレーム数 (~62ms @30Hz)

uint8_t launchHighGCount = 0;               // 連続検出カウンタ

// PID 出力の物理飽和しきい値 (back-calc anti-windup 用)
//   ミキシング後の servo angle は ±90° にクリップされるが、I 項の暴走を防ぐため
//   PID 段階でも u を ±OUTPUT_SAT に近づける。
//   ※ サーボ機械限界より少し小さくすることで「リザーブ」を確保。
const float OUTPUT_SAT = 90.0f;

// ---- D 項のソース選択 ----
//   ERROR : 従来 (e - prevE)/dt + dFilter LPF。Madgwick の積分出力に依存し位相遅れ + ノイズ増幅。
//   GYRO  : ジャイロ生値 (-gx for roll, -gy for pitch, -gz for yaw) を直接使う。
//           IMU の角速度がそのまま rate 信号として効く。Lesson17 推奨方式。
//           Kd の単位は同じ deg/s なので、概ね既存値の 1/2〜同等で動くが、要再チューニング。
enum DSource { DSRC_GYRO = 0, DSRC_ERROR = 1 };
DSource dSource = DSRC_GYRO;   // 既定: gyro 直接（CONTROL_STRATEGY_REPORT P0-3 推奨）

// ---- command parser ----
static char cmdBuf[120];
static size_t cmdLen = 0;

// =============================================================
//  helpers
// =============================================================
template<typename T>
void radioPrint(T x)   { RADIO_SERIAL.print(x);   DEBUG_SERIAL.print(x); }
template<typename T>
void radioPrintln(T x) { RADIO_SERIAL.println(x); DEBUG_SERIAL.println(x); }
void radioPrintln()    { RADIO_SERIAL.println();  DEBUG_SERIAL.println(); }

static bool iequals(const char* a, const char* b) {
  if (!a || !b) return false;
  while (*a && *b) {
    if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return false;
    a++; b++;
  }
  return *a == 0 && *b == 0;
}

static char* nextToken(char*& p) {
  if (!p) return nullptr;
  while (*p && isspace((unsigned char)*p)) p++;
  if (!*p) return nullptr;
  char* tok = p;
  while (*p && !isspace((unsigned char)*p)) p++;
  if (*p) { *p = 0; p++; }
  return tok;
}

static bool parseFloat(const char* s, float* out) {
  if (!s || !out) return false;
  char* endp = nullptr;
  float v = strtof(s, &endp);
  if (endp == s) return false;
  *out = v;
  return true;
}

static int parseAxis(const char* s) {
  if (!s) return -1;
  if (s[0] == '0' || iequals(s, "r") || iequals(s, "roll"))  return 0;
  if (s[0] == '1' || iequals(s, "p") || iequals(s, "pitch")) return 1;
  if (s[0] == '2' || iequals(s, "y") || iequals(s, "yaw"))   return 2;
  return -1;
}

static float clipf(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// 論理舵角 (deg, 中立=0) → サーボパルス幅 (µs)。
//   center を 0°、+90°→max、-90°→min に「左右別の傾き」で線形写像する
//   (= 非対称な可動域を表現)。最終パルスは設定した両端で必ずクランプし、
//   リンケージが機械端に突き当たってサーボが stall するのを防ぐ。
static int servoLogicalToUs(int ch, float logicalDeg) {
  logicalDeg = clipf(logicalDeg, -90.0f, 90.0f);
  float us;
  if (logicalDeg >= 0.0f)
    us = servoCenterUs[ch] + (logicalDeg / 90.0f) * (float)(servoMaxUs[ch] - servoCenterUs[ch]);
  else
    us = servoCenterUs[ch] + (logicalDeg / 90.0f) * (float)(servoCenterUs[ch] - servoMinUs[ch]);
  // min/max の大小が逆でも安全なように両端を整列してからクランプ
  int lo = servoMinUs[ch] < servoMaxUs[ch] ? servoMinUs[ch] : servoMaxUs[ch];
  int hi = servoMinUs[ch] < servoMaxUs[ch] ? servoMaxUs[ch] : servoMinUs[ch];
  return (int)lroundf(clipf(us, (float)lo, (float)hi));
}

// =============================================================
//  Flight phase machine — transition helper
// =============================================================
//   フェーズ切替時に必ず通すための一元化された遷移関数。
//   役割:
//     - 内部カウンタ (launchHighGCount) のリセット
//     - PID 状態 (integralE, dFilt, prevE) のクリーンスタート
//     - baseMode / autoSub の自動セット
//     - tiltSafeguardTriggered の解除
//     - 進入メッセージの送出
static void phaseTransition(FlightPhase newPhase) {
  static const char* PN[] = {"DISARMED", "PRELAUNCH", "LAUNCH", "GLIDE", "LANDED", "WINDTUNNEL"};
  if (newPhase == phase) return;  // 自己遷移は無視
  phase = newPhase;
  phaseStartMs = millis();
  launchHighGCount = 0;

  // モード/PID 状態をフェーズに合わせて初期化
  for (int i = 0; i < 3; i++) {
    integralE[i] = 0.0f;
    dFilt[i] = 0.0f;
    prevE[i] = 0.0f;
  }
  clearServoJog();  // フェーズが変わったら較正ジョグは必ず解除（飛行中に保持しない）

  switch (newPhase) {
    case PHASE_DISARMED:
    case PHASE_PRELAUNCH:
      // MANUAL ホールド (PRELAUNCH は LAUNCH 検出まで MANUAL のまま)
      baseMode = MODE_MANUAL;
      break;
    case PHASE_LAUNCH:
    case PHASE_GLIDE:
      // 自律 PID 開始 (LAUNCH 直後の grace は別ロジックで PID 出力ゼロホールド)
      baseMode = MODE_AUTO;
      autoSub  = SUB_PID;
      tiltSafeguardTriggered = false;
      break;
    // PHASE_LANDED は削除 (DISARMED と機能的に同じため統合)
    case PHASE_WINDTUNNEL:
      // 風洞: PID 即起動。target[] (ユーザ設定値) で動かす。tilt safeguard /
      //       failsafe / climb_ff はすべて他箇所で抑制される。
      baseMode = MODE_AUTO;
      autoSub  = SUB_PID;
      tiltSafeguardTriggered = false;
      break;
  }

  char buf[80];
  snprintf(buf, sizeof(buf), "[PHASE] -> %s", PN[(int)newPhase]);
  radioPrintln(buf);
}

// 現在フェーズに応じた目標 pitch を返す（roll/yaw は target[] のまま）
static float currentTargetPitch() {
  switch (phase) {
    case PHASE_LAUNCH: return climbTargetPitch;
    case PHASE_GLIDE:  return glideTargetPitch;
    default:           return target[1];  // ユーザ設定値
  }
}

// 現在フェーズに応じたエレベータ feed-forward (deg)
static float currentElevatorFF() {
  return (phase == PHASE_LAUNCH) ? climbElevatorFF : 0.0f;
}

// =============================================================
//  watchdog (nRF52840 internal WDT)
// =============================================================
#if ENABLE_WDT
static void wdtBegin() {
  // すでに走っていれば何もしない（再起動後にライセンスはロックされる）
  if (NRF_WDT->RUNSTATUS) return;
  NRF_WDT->CONFIG = (WDT_CONFIG_HALT_Pause << WDT_CONFIG_HALT_Pos)
                  | (WDT_CONFIG_SLEEP_Run  << WDT_CONFIG_SLEEP_Pos);
  NRF_WDT->CRV  = (uint32_t)(32768UL * WDT_TIMEOUT_S - 1);
  NRF_WDT->RREN = (WDT_RREN_RR0_Enabled << WDT_RREN_RR0_Pos);
  NRF_WDT->TASKS_START = 1;
}
static inline void wdtKick() {
  NRF_WDT->RR[0] = WDT_RR_RR_Reload;
}
#else
static inline void wdtBegin() {}
static inline void wdtKick() {}
#endif

// =============================================================
//  status / help
// =============================================================
static void printStatus() {
  char buf[200];
  snprintf(buf, sizeof(buf),
    "[STATUS] base=%s sub=%d Kp=[%.3f,%.3f,%.3f] Ki=[%.3f,%.3f,%.3f] Kd=[%.3f,%.3f,%.3f]",
    baseMode == MODE_AUTO ? "AUTO" : "MANUAL",
    (int)autoSub,
    Kp[0], Kp[1], Kp[2], Ki[0], Ki[1], Ki[2], Kd[0], Kd[1], Kd[2]);
  radioPrintln(buf);
  snprintf(buf, sizeof(buf),
    "[STATUS] target=[%.2f,%.2f,%.2f] trim=[%.1f,%.1f,%.1f] mixL=%.2f mixR=%.2f tlm=%s",
    target[0], target[1], target[2], trimDeg[0], trimDeg[1], trimDeg[2],
    aileronMixL, aileronMixR, telemetryOn ? "on" : "off");
  radioPrintln(buf);
  snprintf(buf, sizeof(buf),
    "[STATUS] failsafe=%lums active=%s wdt=%s",
    (unsigned long)failsafeTimeoutMs,
    failsafeActive ? "YES" : "no",
#if ENABLE_WDT
    "on"
#else
    "off"
#endif
  );
  radioPrintln(buf);
  snprintf(buf, sizeof(buf),
    "[STATUS] safe_angle=%.1fdeg tripped=%s dfilter=%.3f",
    tiltSafeguardDeg, tiltSafeguardTriggered ? "YES" : "no", dFilterAlpha);
  radioPrintln(buf);
  snprintf(buf, sizeof(buf),
    "[STATUS] zero=%s offset=[%.2f,%.2f,%.2f]",
    attitudeOffsetActive ? "ACTIVE" : "off",
    attitudeOffset[0], attitudeOffset[1], attitudeOffset[2]);
  radioPrintln(buf);
  static const char* PHASE_NAMES[] = {"DISARMED", "PRELAUNCH", "LAUNCH", "GLIDE", "LANDED", "WINDTUNNEL"};
  snprintf(buf, sizeof(buf),
    "[STATUS] phase=%s launch_g=%.2f climb_ms=%lu climb_pitch=%.1f glide_pitch=%.1f",
    PHASE_NAMES[(int)phase], launchAccelG,
    (unsigned long)climbMs, climbTargetPitch, glideTargetPitch);
  radioPrintln(buf);
  snprintf(buf, sizeof(buf),
    "[STATUS] climb_ff_elev=%.1f d_source=%s landed=manual",
    climbElevatorFF, dSource == DSRC_GYRO ? "GYRO" : "ERROR");
  radioPrintln(buf);
  // サーボ較正 (subtrim + エンドポイント, µs)。ch 0=右エルロン/1=左エルロン/2=エレベータ
  for (int i = 0; i < 3; i++) {
    snprintf(buf, sizeof(buf),
      "[STATUS] servo%d min=%d mid=%d max=%d rev=%d",
      i, servoMinUs[i], servoCenterUs[i], servoMaxUs[i], servoReverse[i] ? 1 : 0);
    radioPrintln(buf);
  }
}

static void printHelp() {
  radioPrintln("[INFO] === glider_nRF52840 (D0=Right Aileron / D1=Left Aileron / D2=Elevator) ===");
  radioPrintln("[INFO] Modes:");
  radioPrintln("[INFO]   m / manual         -> MANUAL (servos = trim)");
  radioPrintln("[INFO]   a / auto           -> AUTO (PID + mixing)");
  radioPrintln("[INFO]   1 / 2 / 3          -> P / PD / PID");
  radioPrintln("[INFO] Gain commands (axis = 0/1/2 or r/p/y):");
  radioPrintln("[INFO]   kp <axis> <value>");
  radioPrintln("[INFO]   ki <axis> <value>");
  radioPrintln("[INFO]   kd <axis> <value>");
  radioPrintln("[INFO]   target <axis> <value>");
  radioPrintln("[INFO] Servo trim (deg, -90..+90):");
  radioPrintln("[INFO]   s0 <v>  (D0 right aileron)");
  radioPrintln("[INFO]   s1 <v>  (D1 left  aileron)");
  radioPrintln("[INFO]   s2 <v>  (D2 elevator)");
  radioPrintln("[INFO] Servo calibration (subtrim + endpoints, us):");
  radioPrintln("[INFO]   smid <ch 0..2> <us>   neutral/subtrim pulse (logical 0deg)");
  radioPrintln("[INFO]   smax <ch 0..2> <us>   endpoint at logical +90deg");
  radioPrintln("[INFO]   smin <ch 0..2> <us>   endpoint at logical -90deg");
  radioPrintln("[INFO]   srev <ch 0..2> <0|1>  output reverse (mounting)");
  radioPrintln("[INFO]   sjog <ch 0..2> <us|off>  jog servo to raw us (DISARMED only, for calibration)");
  radioPrintln("[INFO]   (ch: 0=R aileron / 1=L aileron / 2=elevator, us 500..2500)");
  radioPrintln("[INFO] Other:");
  radioPrintln("[INFO]   status / help / tlm on / tlm off");
  radioPrintln("[INFO]   ping               heartbeat (silent, keeps uplink alive)");
  radioPrintln("[INFO]   failsafe <ms>      uplink-loss timeout (0 = disabled)");
  radioPrintln("[INFO]   safe_angle <deg>   tilt-safeguard threshold (0 or >=180 = disabled)");
  radioPrintln("[INFO]   dfilter <alpha>    D-term LPF coefficient 0..0.99 (0 = raw, 0.85 default)");
  radioPrintln("[INFO]   zero               capture current attitude as 0deg reference");
  radioPrintln("[INFO]   unzero             clear zero offset (use raw IMU)");
  radioPrintln("[INFO] Flight Phase Machine (autonomous glide):");
  radioPrintln("[INFO]   arm                  PRELAUNCH (wait throw, MANUAL hold)");
  radioPrintln("[INFO]   disarm               back to DISARMED (cancel flight)");
  radioPrintln("[INFO]   land                 MANUAL LANDED transition (the only LANDED path)");
  radioPrintln("[INFO]   phase                show current phase only");
  radioPrintln("[INFO]   launch_g <g>         throw-detect accel threshold (default 2.5)");
  radioPrintln("[INFO]   climb_ms <ms>        LAUNCH phase duration (default 1500)");
  radioPrintln("[INFO]   climb_pitch <deg>    LAUNCH target pitch (default +15)");
  radioPrintln("[INFO]   glide_pitch <deg>    GLIDE target pitch (default +3)");
  radioPrintln("[INFO]   climb_ff <deg>       LAUNCH elevator feed-forward (default +5)");
  radioPrintln("[INFO]   d_source <gyro|err>  D-term source: gyro (default) or err (legacy)");
  radioPrintln("[INFO]   (NOTE: auto-LANDED detection removed; flight ends only on `land` or `disarm`)");
  radioPrintln("[INFO] Wind tunnel test mode:");
  radioPrintln("[INFO]   wt                   enter WINDTUNNEL (PID on, no safeguards, no FF)");
  radioPrintln("[INFO]   disarm               leave WINDTUNNEL (back to DISARMED)");
  radioPrintln("[INFO]   target p <deg>       sweep pitch setpoint during WT");
  radioPrintln("[INFO]   target r <deg>       sweep roll setpoint during WT");
}

// =============================================================
//  command processing
// =============================================================
static void handleCommandLine(char* line) {
  if (!line) return;
  while (*line && isspace((unsigned char)*line)) line++;
  if (!*line) return;

  // ignore CSV echo
  if ((isdigit((unsigned char)*line) || *line == '-' || *line == '+')
      && strchr(line, ',') != NULL) return;
  if (*line == '[') return;

  char* p = line;
  char* cmd = nextToken(p);
  if (!cmd) return;

  if (iequals(cmd, "m") || iequals(cmd, "manual")) {
    baseMode = MODE_MANUAL;
    radioPrintln("[MODE] MANUAL");
    return;
  }
  if (iequals(cmd, "a") || iequals(cmd, "auto")) {
    baseMode = MODE_AUTO;
    tiltSafeguardTriggered = false;  // 再武装
    radioPrintln("[MODE] AUTO");
    return;
  }
  if (iequals(cmd, "help") || iequals(cmd, "?")) { printHelp(); return; }
  if (iequals(cmd, "status")) { printStatus(); return; }

  // ハートビート: 何も返さず lastUplinkMs だけ更新 (pollSerialCommands で更新済)
  // failsafe を発火させないために WebUI が ~750ms 毎に送る無害な ping。
  if (iequals(cmd, "ping")) {
    return;
  }

  if (iequals(cmd, "tlm")) {
    char* arg = nextToken(p);
    if (!arg) { radioPrintln("[INFO] usage: tlm on|off"); return; }
    telemetryOn = iequals(arg, "on");
    radioPrint("[INFO] tlm "); radioPrintln(telemetryOn ? "on" : "off");
    return;
  }

  if (iequals(cmd, "1")) { autoSub = SUB_P;   baseMode = MODE_AUTO; tiltSafeguardTriggered = false; radioPrintln("[MODE] AUTO/P");   return; }
  if (iequals(cmd, "2")) { autoSub = SUB_PD;  baseMode = MODE_AUTO; tiltSafeguardTriggered = false; radioPrintln("[MODE] AUTO/PD");  return; }
  if (iequals(cmd, "3")) { autoSub = SUB_PID; baseMode = MODE_AUTO; tiltSafeguardTriggered = false; radioPrintln("[MODE] AUTO/PID"); return; }

  if (iequals(cmd, "s0") || iequals(cmd, "s1") || iequals(cmd, "s2")) {
    int idx = cmd[1] - '0';
    char* arg = nextToken(p);
    float v;
    if (!arg || !parseFloat(arg, &v)) { radioPrintln("[INFO] usage: sN <deg>"); return; }
    trimDeg[idx] = clipf(v, -90.0f, 90.0f);
    char buf[64];
    snprintf(buf, sizeof(buf), "[PARAM] s%d trim=%.2f", idx, trimDeg[idx]);
    radioPrintln(buf);
    return;
  }

  if (iequals(cmd, "kp") || iequals(cmd, "ki") || iequals(cmd, "kd") || iequals(cmd, "target")) {
    char* axisTok = nextToken(p);
    char* valTok  = nextToken(p);
    int axis = parseAxis(axisTok);
    float v;
    if (axis < 0 || !valTok || !parseFloat(valTok, &v)) {
      radioPrintln("[INFO] usage: kp|ki|kd|target <axis 0/1/2|r/p/y> <value>");
      return;
    }
    if (iequals(cmd, "kp")) Kp[axis] = v;
    else if (iequals(cmd, "ki")) Ki[axis] = v;
    else if (iequals(cmd, "kd")) Kd[axis] = v;
    else target[axis] = v;
    char buf[80];
    snprintf(buf, sizeof(buf), "[PARAM] %s axis=%d value=%.4f", cmd, axis, v);
    radioPrintln(buf);
    return;
  }

  // ミキシング係数調整（オプション、組立時の物理位相補正用）
  if (iequals(cmd, "mixl") || iequals(cmd, "mixr")) {
    char* arg = nextToken(p);
    float v;
    if (!arg || !parseFloat(arg, &v)) { radioPrintln("[INFO] usage: mixL|mixR <coef>"); return; }
    if (iequals(cmd, "mixl")) aileronMixL = v;
    else aileronMixR = v;
    char buf[64];
    snprintf(buf, sizeof(buf), "[PARAM] %s = %.3f", cmd, v);
    radioPrintln(buf);
    return;
  }

  // フェイルセーフ・タイムアウト設定
  if (iequals(cmd, "failsafe")) {
    char* arg = nextToken(p);
    float v;
    if (!arg || !parseFloat(arg, &v) || v < 0) {
      radioPrintln("[INFO] usage: failsafe <ms>  (0 disables)");
      return;
    }
    failsafeTimeoutMs = (uint32_t)v;
    char buf[64];
    snprintf(buf, sizeof(buf), "[PARAM] failsafe=%lums", (unsigned long)failsafeTimeoutMs);
    radioPrintln(buf);
    return;
  }

  // 姿勢角ゼロ点キャリブレーション
  if (iequals(cmd, "zero")) {
    // 生 Madgwick 出力を取り直してオフセットに保存
    // (Q[] は補正後の値を持っているので、フィルタから読み直す)
    float r = filter.getRoll();
    float p = filter.getPitch();
    float y = filter.getYaw();
    attitudeOffset[0] = r;
    attitudeOffset[1] = p;
    attitudeOffset[2] = y;
    attitudeOffsetActive = true;
    // 補正適用で過去の I/D 状態は無効になるのでクリア (急な指令変化を防ぐ)
    for (int i = 0; i < 3; i++) {
      integralE[i] = 0.0f;
      dFilt[i] = 0.0f;
      prevE[i] = 0.0f;
    }
    char buf[96];
    snprintf(buf, sizeof(buf),
      "[PARAM] zero set: roll=%.2f pitch=%.2f yaw=%.2f", r, p, y);
    radioPrintln(buf);
    return;
  }

  if (iequals(cmd, "unzero")) {
    attitudeOffset[0] = attitudeOffset[1] = attitudeOffset[2] = 0.0f;
    attitudeOffsetActive = false;
    for (int i = 0; i < 3; i++) {
      integralE[i] = 0.0f;
      dFilt[i] = 0.0f;
      prevE[i] = 0.0f;
    }
    radioPrintln("[PARAM] zero cleared");
    return;
  }

  // D 項 LPF 係数の設定 (PID チューニング用)
  if (iequals(cmd, "dfilter")) {
    char* arg = nextToken(p);
    float v;
    if (!arg || !parseFloat(arg, &v) || v < 0.0f || v >= 1.0f) {
      radioPrintln("[INFO] usage: dfilter <alpha 0..0.99>  (0 = raw, 0.85 default)");
      return;
    }
    dFilterAlpha = v;
    // フィルタ内部状態も初期化 (急な係数変更で過去状態を引きずらせない)
    for (int i = 0; i < 3; i++) dFilt[i] = 0.0f;
    char buf[64];
    snprintf(buf, sizeof(buf), "[PARAM] dfilter=%.3f", dFilterAlpha);
    radioPrintln(buf);
    return;
  }

  // ---- フェーズマシン (autonomous glide) ----
  //   `arm` → PRELAUNCH、`disarm` → DISARMED。フェーズ遷移は phaseTransition() を通す
  //   ことで I/D 状態と各種カウンタを一貫してクリアする。
  if (iequals(cmd, "arm")) {
    phaseTransition(PHASE_PRELAUNCH);
    return;
  }
  if (iequals(cmd, "disarm")) {
    phaseTransition(PHASE_DISARMED);
    return;
  }
  // `land`: 飛行終了処理。trim を 0 にリセットしてから DISARMED へ遷移。
  //   旧 PHASE_LANDED は DISARMED と機能的に重複していたため統合。
  //   `disarm` との違いは「trim リセットの有無」:
  //     - `land`   = 飛行終了 (trim=0 にする → 次の地上テスト前にニュートラル)
  //     - `disarm` = 中止 / 脱出 (trim を保持 → PRELAUNCH キャンセル時に設定値を守る)
  if (iequals(cmd, "land")) {
    trimDeg[0] = trimDeg[1] = trimDeg[2] = 0.0f;
    phaseTransition(PHASE_DISARMED);
    return;
  }
  // 風洞試験モード: PHASE_WINDTUNNEL に遷移。`disarm` で抜ける。
  //   tilt safeguard / failsafe / climb_ff は WT 中すべて抑制される。
  //   target_pitch / target_roll をユーザが手動操作して PID 応答を計測する。
  if (iequals(cmd, "wt") || iequals(cmd, "wt_mode") || iequals(cmd, "windtunnel")) {
    phaseTransition(PHASE_WINDTUNNEL);
    return;
  }
  if (iequals(cmd, "phase")) {
    static const char* PN[] = {"DISARMED","PRELAUNCH","LAUNCH","GLIDE","LANDED","WINDTUNNEL"};
    char buf[64];
    snprintf(buf, sizeof(buf), "[PHASE] %s (in %lums)",
      PN[(int)phase], (unsigned long)(millis() - phaseStartMs));
    radioPrintln(buf);
    return;
  }
  if (iequals(cmd, "launch_g")) {
    char* arg = nextToken(p);
    float v;
    if (!arg || !parseFloat(arg, &v) || v < 1.0f || v > 8.0f) {
      radioPrintln("[INFO] usage: launch_g <g 1.0..8.0>  (default 2.5)");
      return;
    }
    launchAccelG = v;
    char buf[64];
    snprintf(buf, sizeof(buf), "[PARAM] launch_g=%.2fg", launchAccelG);
    radioPrintln(buf);
    return;
  }
  // フェーズ毎の挙動チューニング (LANDED 自動検出は削除済、手動 `land` のみ)
  if (iequals(cmd, "climb_ms") || iequals(cmd, "climb_pitch") ||
      iequals(cmd, "climb_ff") || iequals(cmd, "glide_pitch")) {
    char* arg = nextToken(p);
    float v;
    if (!arg || !parseFloat(arg, &v)) {
      radioPrintln("[INFO] usage: <param> <value>");
      return;
    }
    char buf[80];
    if (iequals(cmd, "climb_ms")) {
      if (v < 200 || v > 10000) { radioPrintln("[INFO] climb_ms range 200..10000"); return; }
      climbMs = (uint32_t)v;
      snprintf(buf, sizeof(buf), "[PARAM] climb_ms=%lu", (unsigned long)climbMs);
    } else if (iequals(cmd, "climb_pitch")) {
      if (v < -45 || v > 60) { radioPrintln("[INFO] climb_pitch range -45..60"); return; }
      climbTargetPitch = v;
      snprintf(buf, sizeof(buf), "[PARAM] climb_pitch=%.1f", climbTargetPitch);
    } else if (iequals(cmd, "climb_ff")) {
      if (v < -30 || v > 30) { radioPrintln("[INFO] climb_ff range -30..30"); return; }
      climbElevatorFF = v;
      snprintf(buf, sizeof(buf), "[PARAM] climb_ff=%.1f", climbElevatorFF);
    } else { // glide_pitch
      if (v < -20 || v > 30) { radioPrintln("[INFO] glide_pitch range -20..30"); return; }
      glideTargetPitch = v;
      snprintf(buf, sizeof(buf), "[PARAM] glide_pitch=%.1f", glideTargetPitch);
    }
    radioPrintln(buf);
    return;
  }
  // 削除された旧コマンド: 互換のため受理してメッセージだけ返す（無視される）
  if (iequals(cmd, "landed_g") || iequals(cmd, "landed_ms") ||
      iequals(cmd, "landed_gyro") || iequals(cmd, "landed_impact_g") ||
      iequals(cmd, "glide_timeout")) {
    radioPrintln("[INFO] auto-LANDED removed. Use `land` (manual) or 🛬 Land button.");
    return;
  }
  // D 項ソース切替
  if (iequals(cmd, "d_source")) {
    char* arg = nextToken(p);
    if (!arg) { radioPrintln("[INFO] usage: d_source <gyro|error>"); return; }
    if (iequals(arg, "gyro") || iequals(arg, "g")) dSource = DSRC_GYRO;
    else if (iequals(arg, "error") || iequals(arg, "err") || iequals(arg, "e")) dSource = DSRC_ERROR;
    else { radioPrintln("[INFO] usage: d_source <gyro|error>"); return; }
    // ソース切替時は D 状態をクリア
    for (int i = 0; i < 3; i++) { dFilt[i] = 0.0f; prevE[i] = 0.0f; }
    char buf[40];
    snprintf(buf, sizeof(buf), "[PARAM] d_source=%s",
      dSource == DSRC_GYRO ? "GYRO" : "ERROR");
    radioPrintln(buf);
    return;
  }

  // 姿勢角しきい値安全装置の設定（`tilt_limit` も別名で受ける）
  if (iequals(cmd, "safe_angle") || iequals(cmd, "tilt_limit")) {
    char* arg = nextToken(p);
    float v;
    if (!arg || !parseFloat(arg, &v) || v < 0.0f || v > 180.0f) {
      radioPrintln("[INFO] usage: safe_angle <deg 0..180>  (0 disables)");
      return;
    }
    tiltSafeguardDeg = v;
    tiltSafeguardTriggered = false;  // しきい値変更時はラッチも解除
    char buf[64];
    snprintf(buf, sizeof(buf), "[PARAM] safe_angle=%.1fdeg", tiltSafeguardDeg);
    radioPrintln(buf);
    return;
  }

  // ---- 物理サーボ較正 (subtrim + エンドポイント, µs) ----
  //   smin/smid/smax <ch 0..2> <us>  : 各サーボの 下端/中立/上端 パルス幅
  //   srev <ch 0..2> <0|1>           : 出力反転 (取付向き)
  //   ch: 0=右エルロン(D0) / 1=左エルロン(D1) / 2=エレベータ(D2)
  if (iequals(cmd, "smin") || iequals(cmd, "smid") || iequals(cmd, "smax")) {
    char* chTok  = nextToken(p);
    char* valTok = nextToken(p);
    float chF, vF;
    if (!chTok || !parseFloat(chTok, &chF) || chF < 0 || chF > 2
        || !valTok || !parseFloat(valTok, &vF)) {
      radioPrintln("[INFO] usage: smin|smid|smax <ch 0..2> <us 500..2500>");
      return;
    }
    int ch = (int)chF;
    int us = (int)clipf(vF, (float)SERVO_US_ABS_MIN, (float)SERVO_US_ABS_MAX);
    if (iequals(cmd, "smin"))      servoMinUs[ch]    = us;
    else if (iequals(cmd, "smid")) servoCenterUs[ch] = us;
    else                            servoMaxUs[ch]    = us;
    char buf[80];
    snprintf(buf, sizeof(buf), "[PARAM] %s ch=%d us=%d", cmd, ch, us);
    radioPrintln(buf);
    return;
  }
  if (iequals(cmd, "srev")) {
    char* chTok  = nextToken(p);
    char* valTok = nextToken(p);
    float chF, vF;
    if (!chTok || !parseFloat(chTok, &chF) || chF < 0 || chF > 2
        || !valTok || !parseFloat(valTok, &vF)) {
      radioPrintln("[INFO] usage: srev <ch 0..2> <0|1>");
      return;
    }
    int ch = (int)chF;
    servoReverse[ch] = (vF != 0.0f);
    char buf[64];
    snprintf(buf, sizeof(buf), "[PARAM] srev ch=%d rev=%d", ch, servoReverse[ch] ? 1 : 0);
    radioPrintln(buf);
    return;
  }

  // ---- サーボ・ジョグ (エンドポイント較正用): DISARMED 時のみ生µsで直接駆動 ----
  //   `sjog <ch 0..2> <us 500..2500|off>`。MANUAL に落としつつ最終出力を上書きする。
  //   WebUI のドラッグ/「端へ」テストで、舵を実際に動かして可動域を確認するために使う。
  if (iequals(cmd, "sjog")) {
    char* chTok  = nextToken(p);
    char* valTok = nextToken(p);
    float chF;
    if (!chTok || !parseFloat(chTok, &chF) || chF < 0 || chF > 2 || !valTok) {
      radioPrintln("[INFO] usage: sjog <ch 0..2> <us 500..2500|off>");
      return;
    }
    if (phase != PHASE_DISARMED) {
      radioPrintln("[INFO] sjog: DISARMED 時のみ可 (先に disarm/land)");
      return;
    }
    int ch = (int)chF;
    char buf[48];
    if (iequals(valTok, "off")) {
      servoJogUs[ch] = -1;
      snprintf(buf, sizeof(buf), "[PARAM] sjog ch=%d off", ch);
    } else {
      float v;
      if (!parseFloat(valTok, &v)) {
        radioPrintln("[INFO] usage: sjog <ch 0..2> <us 500..2500|off>");
        return;
      }
      baseMode = MODE_MANUAL;  // 較正中は PID を止める（出力は jog で上書き）
      servoJogUs[ch] = (int)clipf(v, (float)SERVO_US_ABS_MIN, (float)SERVO_US_ABS_MAX);
      servoJogMs = millis();
      snprintf(buf, sizeof(buf), "[PARAM] sjog ch=%d us=%d", ch, servoJogUs[ch]);
    }
    radioPrintln(buf);
    return;
  }

  radioPrintln("[INFO] unknown command (type 'help')");
}

static void pollSerialCommands() {
  // 1回の loop() で処理するバイト上限。UART 大量流入で PID/サーボ出力が飢餓になるのを防ぐ。
  uint8_t budget = 128;
  while (budget-- && RADIO_SERIAL.available()) {
    int c = RADIO_SERIAL.read();
    if (c < 0) break;

    if (c == '\r') continue;
    if (c == '\n') {
      cmdBuf[cmdLen] = 0;
      if (cmdLen > 0) {
        // どんな受信行でも「リンクは生きている」とみなす
        lastUplinkMs = millis();
        if (failsafeActive) {
          failsafeActive = false;
          radioPrintln("[FAILSAFE] cleared (uplink resumed)");
        }
        handleCommandLine(cmdBuf);
      }
      cmdLen = 0;
      continue;
    }
    if (c == 0x08 || c == 0x7F) {
      if (cmdLen > 0) cmdLen--;
      continue;
    }
    if (cmdLen + 1 < sizeof(cmdBuf)) {
      cmdBuf[cmdLen++] = (char)c;
    } else {
      cmdLen = 0;
    }
  }
}

// =============================================================
//  setup / loop
// =============================================================
void setup() {
  RADIO_SERIAL.begin(115200);
  DEBUG_SERIAL.begin(115200);

  // WDT は IMU 初期化が長引いた場合に備えて先に起動・キックを差し挟む
  wdtBegin();
  wdtKick();

  // attach は µs 出力できるよう広めの可動域 (ABS_MIN..ABS_MAX) で確保する。
  // 実際の駆動範囲は servoMinUs/MaxUs（較正値）で制限される。
  servo[0].attach(SERVO_PIN_0, SERVO_US_ABS_MIN, SERVO_US_ABS_MAX);
  servo[1].attach(SERVO_PIN_1, SERVO_US_ABS_MIN, SERVO_US_ABS_MAX);
  servo[2].attach(SERVO_PIN_2, SERVO_US_ABS_MIN, SERVO_US_ABS_MAX);
  servo[0].writeMicroseconds(servoCenterUs[0]);
  servo[1].writeMicroseconds(servoCenterUs[1]);
  servo[2].writeMicroseconds(servoCenterUs[2]);

  IMU.settings.gyroRange = 2000;
  IMU.settings.accelRange = 4;
  // IMU が応答しないままだと WDT で再起動する設計（無限待ちは入れない）
  for (int tries = 0; tries < 10 && IMU.begin() != 0; ++tries) {
    delay(200);
    wdtKick();
  }
  IMU.writeRegister(LSM6DS3_ACC_GYRO_CTRL2_G, 0x8C);
  IMU.writeRegister(LSM6DS3_ACC_GYRO_CTRL1_XL, 0x8A);
  IMU.writeRegister(LSM6DS3_ACC_GYRO_CTRL7_G, 0x00);
  IMU.writeRegister(LSM6DS3_ACC_GYRO_CTRL8_XL, 0x09);
  filter.begin(MEASURING_FREQ);

  // Madgwick beta tuning (CONTROL_STRATEGY_REPORT P1-2):
  //   ライブラリ既定 0.1f は 9軸 (magnetometer 込) 想定で大きい。6軸構成では
  //   論文推奨 0.033 が望ましい (収束を抑えてジャイロ積分に寄せ、加速時の accel
  //   外乱を持ち込みにくくする)。本機は射出時に accel が騙される条件にあるため特に。
  //   `MadgwickAHRS` (arduino-libraries) は beta を private で持つため、外部から
  //   直接設定不能。Adafruit_AHRS への移行 or ライブラリ patch が将来課題。
  //   暫定で beta を効果的に下げるには、updateIMU を低レート (=lessen integration)
  //   で呼ぶ手があるが、本機は 30Hz 固定なので適用不可。**TODO**: beta 設定機能。

  prevUs = micros();
  // 起動直後は受信履歴ゼロ → 即フェイルセーフ発動を防ぐため初期化
  lastUplinkMs = millis();

  radioPrintln("[READY] glider_nRF52840 booted (aileron mixing: D0=R / D1=L / D2=Elev)");
  printHelp();
  printStatus();
}

void loop() {
  // 絶対時刻ベースの周期計時。loop 本体が変動 (radio TX 等で時々長くなる) しても
  // 平均周期は 1/MEASURING_FREQ に保たれる。
  const uint32_t kLoopPeriodUs = 1000000UL / MEASURING_FREQ;
  uint32_t loopStartUs = micros();

  wdtKick();
  pollSerialCommands();

  // サーボ jog の無操作自動解除 (端で stall を残さない安全装置)
  if ((servoJogUs[0] >= 0 || servoJogUs[1] >= 0 || servoJogUs[2] >= 0)
      && (uint32_t)(millis() - servoJogMs) > SERVO_JOG_TIMEOUT_MS) {
    clearServoJog();
    radioPrintln("[INFO] sjog auto-released (timeout)");
  }

  // ---- フェイルセーフ判定 ----
  //   PHASE_DISARMED （= 地上テスト中、つまり通常の地上局運用）でのみ有効。
  //   PRELAUNCH/LAUNCH/GLIDE/LANDED/WINDTUNNEL 中は地上局通信が無くても運用を継続
  //   させたい（飛行中の uplink loss / 風洞中の測定者離席）。`disarm` で抜ける。
  if (phase == PHASE_DISARMED && failsafeTimeoutMs > 0
      && (uint32_t)(millis() - lastUplinkMs) > failsafeTimeoutMs) {
    if (!failsafeActive) {
      failsafeActive = true;
      baseMode = MODE_MANUAL;
      // trim を中立に戻し、I 項もクリアして次の手動操作で滑らかに復帰
      trimDeg[0] = trimDeg[1] = trimDeg[2] = 0.0f;
      for (int i = 0; i < 3; i++) integralE[i] = 0.0f;
      clearServoJog();  // アップリンク途絶時は較正ジョグも解除（端で stall させない）
      radioPrintln("[FAILSAFE] uplink lost -> MANUAL + trim=0");
    }
  }

  // dt
  uint32_t nowUs = micros();
  float dt = (nowUs - prevUs) / 1000000.0f;
  if (dt <= 0.0f) dt = 1.0f / (float)MEASURING_FREQ;
  prevUs = nowUs;
  uint32_t dt_ms = (uint32_t)(dt * 1000.0f + 0.5f);

  // sensing
  float ax = IMU.readFloatAccelX();
  float ay = IMU.readFloatAccelY();
  float az = IMU.readFloatAccelZ();
  float gx = IMU.readFloatGyroX();
  float gy = IMU.readFloatGyroY();
  float gz = IMU.readFloatGyroZ();
  filter.updateIMU(gx, gy, gz, ax, ay, az);

  float Q[3];
  Q[0] = filter.getRoll();
  Q[1] = filter.getPitch();
  Q[2] = filter.getYaw();

  // ---- フェーズマシン step ----
  //   PRELAUNCH → LAUNCH → GLIDE → LANDED の遷移を判定する。
  //   遷移はすべて phaseTransition() 経由なので、I/D 状態のクリアと
  //   モード設定が一貫して走る。
  float aMag = sqrtf(ax*ax + ay*ay + az*az);
  switch (phase) {
    case PHASE_PRELAUNCH: {
      // |a| > launch_g を LAUNCH_TRIGGER_FRAMES 連続で検出 → LAUNCH へ
      if (aMag > launchAccelG) {
        if (++launchHighGCount >= LAUNCH_TRIGGER_FRAMES) {
          char buf[64];
          snprintf(buf, sizeof(buf), "[LAUNCH] detected |a|=%.2fg", aMag);
          radioPrintln(buf);
          phaseTransition(PHASE_LAUNCH);
        }
      } else {
        launchHighGCount = 0;
      }
    } break;
    case PHASE_LAUNCH: {
      // climb_ms 経過で GLIDE へ
      if ((uint32_t)(millis() - phaseStartMs) >= climbMs) {
        phaseTransition(PHASE_GLIDE);
      }
    } break;
    case PHASE_GLIDE:
      // 自動 LANDED 検出は実装しない。`land` コマンド / UI ボタンで手動遷移する設計。
      // 飛行中の安定滑空 (|a|≈1g + 一瞬の低 gyro) で誤発火しないことを保証するため。
      break;
    default:
      // DISARMED / LANDED / WINDTUNNEL は遷移なし（手動 disarm/arm/wt 操作で抜ける）
      break;
  }

  // ---- attitude zero offset 補正 ----
  //   `zero` コマンドで保存した取付角オフセットを差し引く。
  //   roll/yaw は ±180 へ、pitch は ±90 へ正規化。
  //   この補正後の Q[] が safeguard / PID / テレメトリ すべてに使われる。
  if (attitudeOffsetActive) {
    for (int i = 0; i < 3; i++) {
      Q[i] -= attitudeOffset[i];
    }
    // roll, yaw: -180..+180 wrap
    for (int i = 0; i < 3; i += 2) {
      if (Q[i] >  180.0f) Q[i] -= 360.0f;
      if (Q[i] < -180.0f) Q[i] += 360.0f;
    }
    // pitch: clamp to -90..+90 (本来 Madgwick の pitch も同範囲。
    // 差分で 90 を超えた場合は ±90 でクランプして発散を防ぐ)
    if (Q[1] >  90.0f) Q[1] =  90.0f;
    if (Q[1] < -90.0f) Q[1] = -90.0f;
  }

  // ---- attitude safeguard 判定 ----
  //   AUTO 中に |roll| または |pitch| がしきい値を超えたら強制 MANUAL + trim=0。
  //   ラッチ式 (tiltSafeguardTriggered) のため、メッセージは 1回だけ送出。
  //   再武装は AUTO 系コマンド受信時。
  //
  //   注意: tiltSafeguardDeg が 180 以上のときは「無効」として扱う。
  //   Madgwick の roll 出力は [-180,+180] のため |roll| は最大 180、
  //   浮動小数誤差で 180.0000xf が出る場合があり、`> 180` 比較が境界で
  //   誤動作する可能性があるため、しきい値は厳密に (0, 180) の範囲でのみ有効。
  // 風洞 (PHASE_WINDTUNNEL) では支柱固定で角度が大きくなる場合があるため
  // tilt safeguard は抑制する。
  if (tiltSafeguardDeg > 0.0f && tiltSafeguardDeg < 180.0f
      && baseMode == MODE_AUTO && !tiltSafeguardTriggered
      && phase != PHASE_WINDTUNNEL) {
    float ar = fabsf(Q[0]);
    float ap = fabsf(Q[1]);
    float tiltMax = ar > ap ? ar : ap;
    if (tiltMax > tiltSafeguardDeg) {
      tiltSafeguardTriggered = true;
      baseMode = MODE_MANUAL;
      trimDeg[0] = trimDeg[1] = trimDeg[2] = 0.0f;
      for (int i = 0; i < 3; i++) integralE[i] = 0.0f;
      char sbuf[96];
      snprintf(sbuf, sizeof(sbuf),
        "[SAFEGUARD] tilt %.1fdeg > %.1fdeg -> MANUAL + trim=0",
        tiltMax, tiltSafeguardDeg);
      radioPrintln(sbuf);
    }
  }

  // mode transition: reset I/D state
  if (baseMode != prevBase || autoSub != prevSub) {
    for (int i = 0; i < 3; i++) {
      prevE[i] = target[i] - Q[i];
      if (autoSub != SUB_PID) integralE[i] = 0.0f;
      dFilt[i] = 0.0f;  // フィルタ状態も古いので破棄
    }
    prevBase = baseMode;
    prevSub  = autoSub;
  }

  // ---- 投擲後 grace 期間判定 ----
  //   LAUNCH 突入直後の launchGraceMs は PID 出力をゼロホールド (= MANUAL 相当)。
  //   投擲時の高G/高レート転位で Madgwick が一時的にズレるため、姿勢推定が
  //   安定するまで舵を打たない方が安全。grace 経過後に PID 制御を開始。
  bool inLaunchGrace = (phase == PHASE_LAUNCH)
      && (uint32_t)(millis() - phaseStartMs) < launchGraceMs;

  // フェーズに応じた実効目標角を作る (pitch のみ動的化)
  float effectiveTarget[3] = { target[0], currentTargetPitch(), target[2] };

  // 角速度ベクトル (deg/s)。gyro 直接 D 項 (d_source GYRO) で使う。
  // ※ 取付方向によって符号が変わる可能性あり (今は LSM6DS3 標準: gx=roll rate)
  float gyroRate[3] = { gx, gy, gz };

  // 3軸 PID 計算（roll=0, pitch=1, yaw=2）。yaw は K=0 既定で実質ゼロ。
  // back-calculation anti-windup: u を OUTPUT_SAT で飽和させ、飽和分だけ
  // I 項を巻き戻して暴走を防ぐ。Ki=0 のときは無効化。
  float u[3] = {0.0f, 0.0f, 0.0f};
  for (int i = 0; i < 3; i++) {
    float e = effectiveTarget[i] - Q[i];

    // LAUNCH grace 中は PID 出力ゼロホールド（後段で u[i]=0）。ここで積分も
    // 進めてしまうと anti-windup も効かないまま I 項が溜まり、grace 明けに
    // エレベータ/エルロンへ段差として一気に乗る。grace 中は 0 ホールドする。
    if (baseMode == MODE_AUTO && autoSub == SUB_PID && !inLaunchGrace) {
      integralE[i] += e * dt;
      integralE[i] = clipf(integralE[i], -integralLimit, integralLimit);
    } else {
      integralE[i] = 0.0f;
    }

    // ---- D 項計算 ----
    //   d_source = GYRO  : de = -gyroRate[i] （角速度の逆符号、Lesson17 流）
    //   d_source = ERROR : de = LPF((e - prevE)/dt) （従来方式、dfilter で平滑）
    float de = 0.0f;
    if (baseMode == MODE_AUTO && (autoSub == SUB_PD || autoSub == SUB_PID)) {
      if (dSource == DSRC_GYRO) {
        // 角速度は (dQ/dt) なので de = -dQ/dt。ジャイロから直接読む = 位相遅れ最小。
        de = -gyroRate[i];
        dFilt[i] = de;  // 表示用にコピー
      } else {
        float deRaw = (e - prevE[i]) / dt;
        dFilt[i] = dFilterAlpha * dFilt[i] + (1.0f - dFilterAlpha) * deRaw;
        de = dFilt[i];
      }
    }
    prevE[i] = e;

    if (baseMode == MODE_AUTO && !inLaunchGrace) {
      float u_raw;
      if (autoSub == SUB_P)        u_raw = Kp[i] * e;
      else if (autoSub == SUB_PD)  u_raw = Kp[i] * e + Kd[i] * de;
      else                          u_raw = Kp[i] * e + Ki[i] * integralE[i] + Kd[i] * de;

      // back-calculation anti-windup: u が OUTPUT_SAT に張り付いている間、
      // I 項が更にそちらへ伸びるのを抑える。Ki>0 のときだけ意味がある。
      float u_clip = clipf(u_raw, -OUTPUT_SAT, OUTPUT_SAT);
      if (autoSub == SUB_PID && Ki[i] > 1e-6f && u_raw != u_clip) {
        // 飽和差分だけ integralE を巻き戻す
        integralE[i] -= (u_raw - u_clip) / Ki[i];
        integralE[i] = clipf(integralE[i], -integralLimit, integralLimit);
      }
      u[i] = u_clip;
    }
    // (inLaunchGrace 中は u[i] = 0 のまま、サーボはトリム位置を保持)
  }

  // ---- サーボミキシング ----
  //   u_roll  -> 右エルロン D0 (+方向)、左エルロン D1 (反転)
  //   u_pitch -> エレベータ D2 (+ feed-forward オフセット)
  //   u_yaw   -> 未使用
  //   feed-forward: LAUNCH 中は機首上げを補助するため、PID 出力に climb_ff を加算。
  //                 inLaunchGrace 中は u[1]=0 だが FF は適用 → 高G中もエレベータが上げ位置を保つ。
  float u_roll  = u[0];
  float u_pitch = u[1] + currentElevatorFF();

  float angle_R = trimDeg[0] + aileronMixR * u_roll;             // D0 right aileron
  float angle_L = trimDeg[1] + aileronMixL * u_roll;             // D1 left  aileron
  float angle_E = trimDeg[2] + u_pitch;                          // D2 elevator

  angle_R = clipf(angle_R, -90.0f, 90.0f);
  angle_L = clipf(angle_L, -90.0f, 90.0f);
  angle_E = clipf(angle_E, -90.0f, 90.0f);

  // 論理舵角（中立=0）。servoReverse[] で取付向きの出力反転を吸収。
  //   2026-06-19: エルロン2舵 + エレベータの出力方向を反転（既定 reverse[]={R,_,E}）。
  float logical[3];
  logical[0] = servoReverse[0] ? -angle_R : angle_R;  // D0: 右エルロン
  logical[1] = servoReverse[1] ? -angle_L : angle_L;  // D1: 左エルロン
  logical[2] = servoReverse[2] ? -angle_E : angle_E;  // D2: エレベータ

  // ---- 実出力: サーボ較正(center/min/max µs)で論理角をパルス幅へ写像 ----
  // 値に変化がある時だけ writeMicroseconds() を呼ぶ。
  // 理由: mbed-enabled nRF52840 の Servo ライブラリは内部で PwmOut::pulsewidth_us
  // を呼ぶが、毎回タイマー値を更新する実装になっており、同じ値でも PWM パルス幅に
  // µs オーダの微小ジッタが乗る。これがサーボ「ぴくぴく」の主因。
  // MANUAL モードで trim 一定なら出力 µs は決定的なので 1度書けば十分。
  // PWM ハードウェアは値を保持し続けるため、書かなくても出力は維持される。
  static int lastServoUs[3] = {-1, -1, -1};  // 初回必ず書くため -1
  for (int i = 0; i < 3; i++) {
    // 較正ジョグ中(servoJogUs>=0)は生µsで直接駆動。それ以外は通常の論理角→µs写像。
    int us = (servoJogUs[i] >= 0) ? servoJogUs[i] : servoLogicalToUs(i, logical[i]);
    if (us != lastServoUs[i]) {
      servo[i].writeMicroseconds(us);
      lastServoUs[i] = us;
    }
  }

  // テレメトリ用の servo 値は従来の 0..180 表現（90=中立）を維持し、既存ビューア
  // (ServoBars / TrimSetupPanel / Python viewer 等) との後方互換を保つ。
  // = 旧式 servoAngle[i] = logical[i] + 90。実出力 µs とは独立した「表示用の論理角」。
  int servoAngle[3];
  for (int i = 0; i < 3; i++) {
    servoAngle[i] = (int)clipf(lroundf(logical[i] + 90.0f), 0.0f, 180.0f);
  }

  // telemetry (17-field CSV)
  //   後方互換: 前 15 列は従来通り。末尾に phase (int 0..4) と accel_g (|a|) を追加。
  //   旧 viewer (15 列固定パーサ) では 17 列で reject されるため、付属の
  //   Python/WebUI パーサを下位互換 (受け取り側で >=15 を許容) に更新済み。
  if (telemetryOn) {
    uint32_t t_ms = millis();
    char buf[256];
    snprintf(buf, sizeof(buf),
      "%lu,%lu,%lu,%.3f,%.3f,%.3f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%d,%d,%d,%d,%.3f",
      (unsigned long)srcSeq, (unsigned long)t_ms, (unsigned long)dt_ms,
      ax, ay, az,
      gx, gy, gz,
      Q[0], Q[1], Q[2],
      servoAngle[0], servoAngle[1], servoAngle[2],
      (int)phase, aMag);
    radioPrintln(buf);
  }

  srcSeq++;

  // 周期合わせ: loop 開始時刻からの経過 µs を見て、不足分だけ sleep する。
  // 本体が周期を超過した場合は即次ループへ (キャッチアップせず単に遅れたままに)。
  uint32_t elapsedUs = micros() - loopStartUs;
  if (elapsedUs < kLoopPeriodUs) {
    delayMicroseconds(kLoopPeriodUs - elapsedUs);
  }
}
