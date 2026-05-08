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
// =============================================================

#include <LSM6DS3.h>
#include <Wire.h>
#include <MadgwickAHRS.h>
#include <Servo.h>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

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

// ---- telemetry ----
uint32_t srcSeq = 0;
uint32_t prevUs = 0;
bool telemetryOn = true;

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
    radioPrintln("[MODE] AUTO");
    return;
  }
  if (iequals(cmd, "help") || iequals(cmd, "?")) { printHelp(); return; }
  if (iequals(cmd, "status")) { printStatus(); return; }

  if (iequals(cmd, "tlm")) {
    char* arg = nextToken(p);
    if (!arg) { radioPrintln("[INFO] usage: tlm on|off"); return; }
    telemetryOn = iequals(arg, "on");
    radioPrint("[INFO] tlm "); radioPrintln(telemetryOn ? "on" : "off");
    return;
  }

  if (iequals(cmd, "1")) { autoSub = SUB_P;   baseMode = MODE_AUTO; radioPrintln("[MODE] AUTO/P");   return; }
  if (iequals(cmd, "2")) { autoSub = SUB_PD;  baseMode = MODE_AUTO; radioPrintln("[MODE] AUTO/PD");  return; }
  if (iequals(cmd, "3")) { autoSub = SUB_PID; baseMode = MODE_AUTO; radioPrintln("[MODE] AUTO/PID"); return; }

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

  radioPrintln("[INFO] unknown command (type 'help')");
}

static void pollSerialCommands() {
  while (RADIO_SERIAL.available()) {
    int c = RADIO_SERIAL.read();
    if (c < 0) break;

    if (c == '\r') continue;
    if (c == '\n') {
      cmdBuf[cmdLen] = 0;
      if (cmdLen > 0) handleCommandLine(cmdBuf);
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

  servo[0].attach(SERVO_PIN_0);
  servo[1].attach(SERVO_PIN_1);
  servo[2].attach(SERVO_PIN_2);
  servo[0].write(90);
  servo[1].write(90);
  servo[2].write(90);

  IMU.settings.gyroRange = 2000;
  IMU.settings.accelRange = 4;
  while (IMU.begin() != 0) { delay(200); }
  IMU.writeRegister(LSM6DS3_ACC_GYRO_CTRL2_G, 0x8C);
  IMU.writeRegister(LSM6DS3_ACC_GYRO_CTRL1_XL, 0x8A);
  IMU.writeRegister(LSM6DS3_ACC_GYRO_CTRL7_G, 0x00);
  IMU.writeRegister(LSM6DS3_ACC_GYRO_CTRL8_XL, 0x09);
  filter.begin(MEASURING_FREQ);

  prevUs = micros();

  radioPrintln("[READY] glider_nRF52840 booted (aileron mixing: D0=R / D1=L / D2=Elev)");
  printHelp();
  printStatus();
}

void loop() {
  pollSerialCommands();

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

  // mode transition: reset I/D state
  if (baseMode != prevBase || autoSub != prevSub) {
    for (int i = 0; i < 3; i++) {
      prevE[i] = target[i] - Q[i];
      if (autoSub != SUB_PID) integralE[i] = 0.0f;
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
      de = (e - prevE[i]) / dt;
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
  servoAngle[0] = (int)(angle_R + 90.0f);
  servoAngle[1] = (int)(angle_L + 90.0f);
  servoAngle[2] = (int)(angle_E + 90.0f);
  for (int i = 0; i < 3; i++) {
    servoAngle[i] = (int)clipf((float)servoAngle[i], 0.0f, 180.0f);
    servo[i].write(servoAngle[i]);
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
