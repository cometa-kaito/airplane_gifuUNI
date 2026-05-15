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
//  CSV テレメトリ (15 列):
//    seq, t_ms, dt_ms, ax, ay, az, gx, gy, gz,
//    roll, pitch, yaw, s0(右エルロン), s1(左エルロン), s2(エレベータ)
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
//    status / help / tlm on / tlm off
//    failsafe <ms>      アップリンク途絶でフェイルセーフ発動するまでの ms (0 で無効)
// =============================================================

#include <LSM6DS3.h>
#include <Wire.h>
#include <MadgwickAHRS.h>
#include <Servo.h>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// nRF52840 内蔵ウォッチドッグ（ループブロック時の暴走防止）
#define ENABLE_WDT 1
#if ENABLE_WDT
  // 32.768 kHz LFCLK 基準。WDT_TIMEOUT_S 秒で reset。
  #define WDT_TIMEOUT_S 3
#endif

#define MEASURING_FREQ 50
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

float integralE[3] = {0, 0, 0};
float prevE[3] = {0, 0, 0};
const float integralLimit = 200.0f;

// ---- D-term low-pass filter ----
//   D 項は de = (e - prevE) / dt で計算するため、dt=20ms (50Hz) では
//   IMU 雑音が約 50倍に増幅され、サーボがバタつく (ぴくぴく) 主因になる。
//   1次 IIR LPF を掛けて高周波ノイズだけ落とす:
//     dFilt[i] = α * dFilt[i] + (1-α) * de_raw
//   既定 α=0.7 で時定数 ~67ms (≈ 2.4Hz cutoff)。
//   `dfilter <alpha>` コマンドで動的調整、0 で従来の生 D 動作。
float dFilterAlpha = 0.7f;
float dFilt[3] = {0.0f, 0.0f, 0.0f};

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
  radioPrintln("[INFO] Other:");
  radioPrintln("[INFO]   status / help / tlm on / tlm off");
  radioPrintln("[INFO]   ping               heartbeat (silent, keeps uplink alive)");
  radioPrintln("[INFO]   failsafe <ms>      uplink-loss timeout (0 = disabled)");
  radioPrintln("[INFO]   safe_angle <deg>   tilt-safeguard threshold (0 or >=180 = disabled)");
  radioPrintln("[INFO]   dfilter <alpha>    D-term LPF coefficient 0..0.99 (0 = raw, 0.7 default)");
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

  // D 項 LPF 係数の設定 (PID チューニング用)
  if (iequals(cmd, "dfilter")) {
    char* arg = nextToken(p);
    float v;
    if (!arg || !parseFloat(arg, &v) || v < 0.0f || v >= 1.0f) {
      radioPrintln("[INFO] usage: dfilter <alpha 0..0.99>  (0 = raw, 0.7 default)");
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

  radioPrintln("[INFO] unknown command (type 'help')");
}

static void pollSerialCommands() {
  while (RADIO_SERIAL.available()) {
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

  servo[0].attach(SERVO_PIN_0);
  servo[1].attach(SERVO_PIN_1);
  servo[2].attach(SERVO_PIN_2);
  servo[0].write(90);
  servo[1].write(90);
  servo[2].write(90);

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

  prevUs = micros();
  // 起動直後は受信履歴ゼロ → 即フェイルセーフ発動を防ぐため初期化
  lastUplinkMs = millis();

  radioPrintln("[READY] glider_nRF52840 booted (aileron mixing: D0=R / D1=L / D2=Elev)");
  printHelp();
  printStatus();
}

void loop() {
  wdtKick();
  pollSerialCommands();

  // ---- フェイルセーフ判定 ----
  if (failsafeTimeoutMs > 0
      && (uint32_t)(millis() - lastUplinkMs) > failsafeTimeoutMs) {
    if (!failsafeActive) {
      failsafeActive = true;
      baseMode = MODE_MANUAL;
      // trim を中立に戻し、I 項もクリアして次の手動操作で滑らかに復帰
      trimDeg[0] = trimDeg[1] = trimDeg[2] = 0.0f;
      for (int i = 0; i < 3; i++) integralE[i] = 0.0f;
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

  // ---- attitude safeguard 判定 ----
  //   AUTO 中に |roll| または |pitch| がしきい値を超えたら強制 MANUAL + trim=0。
  //   ラッチ式 (tiltSafeguardTriggered) のため、メッセージは 1回だけ送出。
  //   再武装は AUTO 系コマンド受信時。
  //
  //   注意: tiltSafeguardDeg が 180 以上のときは「無効」として扱う。
  //   Madgwick の roll 出力は [-180,+180] のため |roll| は最大 180、
  //   浮動小数誤差で 180.0000xf が出る場合があり、`> 180` 比較が境界で
  //   誤動作する可能性があるため、しきい値は厳密に (0, 180) の範囲でのみ有効。
  if (tiltSafeguardDeg > 0.0f && tiltSafeguardDeg < 180.0f
      && baseMode == MODE_AUTO && !tiltSafeguardTriggered) {
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

  // 3軸 PID 計算（roll=0, pitch=1, yaw=2）。yaw は K=0 既定で実質ゼロ。
  float u[3] = {0.0f, 0.0f, 0.0f};
  for (int i = 0; i < 3; i++) {
    float e = target[i] - Q[i];

    if (baseMode == MODE_AUTO && autoSub == SUB_PID) {
      integralE[i] += e * dt;
      integralE[i] = clipf(integralE[i], -integralLimit, integralLimit);
    } else {
      integralE[i] = 0.0f;
    }

    float de = 0.0f;
    if (baseMode == MODE_AUTO && (autoSub == SUB_PD || autoSub == SUB_PID)) {
      float deRaw = (e - prevE[i]) / dt;
      // 1次 IIR LPF: dFilt = α·dFilt + (1-α)·deRaw
      // α=0 で従来通り (生 D), α が大きいほど滑らか。
      dFilt[i] = dFilterAlpha * dFilt[i] + (1.0f - dFilterAlpha) * deRaw;
      de = dFilt[i];
    }
    prevE[i] = e;

    if (baseMode == MODE_AUTO) {
      if (autoSub == SUB_P)        u[i] = Kp[i] * e;
      else if (autoSub == SUB_PD)  u[i] = Kp[i] * e + Kd[i] * de;
      else                          u[i] = Kp[i] * e + Ki[i] * integralE[i] + Kd[i] * de;
    }
  }

  // ---- サーボミキシング ----
  //   u_roll  -> 右エルロン D0 (+方向)、左エルロン D1 (反転)
  //   u_pitch -> エレベータ D2
  //   u_yaw   -> 未使用
  float u_roll  = u[0];
  float u_pitch = u[1];

  float angle_R = trimDeg[0] + aileronMixR * u_roll;             // D0 right aileron
  float angle_L = trimDeg[1] + aileronMixL * u_roll;             // D1 left  aileron
  float angle_E = trimDeg[2] + u_pitch;                          // D2 elevator

  angle_R = clipf(angle_R, -90.0f, 90.0f);
  angle_L = clipf(angle_L, -90.0f, 90.0f);
  angle_E = clipf(angle_E, -90.0f, 90.0f);

  int servoAngle[3];
  servoAngle[0] = (int)lroundf(angle_R + 90.0f);
  servoAngle[1] = (int)lroundf(angle_L + 90.0f);
  servoAngle[2] = (int)lroundf(angle_E + 90.0f);

  // 値に変化がある時だけ servo.write() を呼ぶ。
  // 理由: mbed-enabled nRF52840 の Servo ライブラリは内部で PwmOut::pulsewidth_us
  // を呼ぶが、毎回タイマー値を更新する実装になっており、同じ値の write でも
  // PWM パルス幅に µs オーダの微小ジッタが乗る。これがサーボ「ぴくぴく」の主因。
  // MANUAL モードで trim 一定なら servoAngle は決定的なので 1度書けば十分。
  // PWM ハードウェアは値を保持し続けるため、書かなくても出力は維持される。
  static int lastServoAngle[3] = {-1, -1, -1};  // 初回必ず書くため -1
  for (int i = 0; i < 3; i++) {
    servoAngle[i] = (int)clipf((float)servoAngle[i], 0.0f, 180.0f);
    if (servoAngle[i] != lastServoAngle[i]) {
      servo[i].write(servoAngle[i]);
      lastServoAngle[i] = servoAngle[i];
    }
  }

  // telemetry (15-field CSV, viewer compatible)
  if (telemetryOn) {
    uint32_t t_ms = millis();
    char buf[256];
    snprintf(buf, sizeof(buf),
      "%lu,%lu,%lu,%.3f,%.3f,%.3f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%d,%d,%d",
      (unsigned long)srcSeq, (unsigned long)t_ms, (unsigned long)dt_ms,
      ax, ay, az,
      gx, gy, gz,
      Q[0], Q[1], Q[2],
      servoAngle[0], servoAngle[1], servoAngle[2]);
    radioPrintln(buf);
  }

  srcSeq++;
  delay(1000 / MEASURING_FREQ);
}
