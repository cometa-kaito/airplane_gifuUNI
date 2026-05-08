# -*- coding: utf-8 -*-
"""
高機能 3D グライダービューア（自律滑空機 Exercise05+ 用）

機能:
  - リアルな機体モデル（胴体・主翼・水平尾翼・垂直尾翼）
  - ワールドグリッド + 水平線（地面/空）
  - ライティング（陰影あり）
  - 加速度ベクトル可視化
  - HUD: roll/pitch/yaw, ax/ay/az, gx/gy/gz, s0/s1/s2 リアルタイム表示
  - ミニ時系列グラフ（roll/pitch/yaw, servo）
  - キー入力でマイコンへコマンド送信
  - 視点切替（F1=フロント / F2=サイド / F3=トップ / F4=斜め）

使い方:
  python glider_viewer3d.py --port COM12

依存: pyserial, PyOpenGL, freeglut
"""

import argparse
import math
import sys
import threading
import time
from collections import deque

from serial import Serial, SerialException
from OpenGL.GL import *
from OpenGL.GLU import *
from OpenGL.GLUT import *

from glider_templates import PRESETS, get_preset, list_presets, PlaneSpec

# 機体仕様（main で上書きされる）
spec: PlaneSpec = PRESETS["default"]

# ========== 受信状態 ==========
HISTORY = 200  # ミニグラフのサンプル数

state = {
    "seq": 0, "t_ms": 0, "dt_ms": 0,
    "roll": 0.0, "pitch": 0.0, "yaw": 0.0,
    "ax": 0.0, "ay": 0.0, "az": 1.0,
    "gx": 0.0, "gy": 0.0, "gz": 0.0,
    "s0": 90, "s1": 90, "s2": 90,
    "rx_count": 0, "bad_count": 0,
    "info": "",
    "last_rx_time": 0.0,
}

history = {
    "roll":  deque(maxlen=HISTORY),
    "pitch": deque(maxlen=HISTORY),
    "yaw":   deque(maxlen=HISTORY),
    "s0":    deque(maxlen=HISTORY),
    "s1":    deque(maxlen=HISTORY),
    "s2":    deque(maxlen=HISTORY),
}

# ========== シリアル ==========
ser = None
ser_lock = threading.Lock()


def parse_line(line: str) -> bool:
    line = line.strip()
    if not line:
        return False
    if line.startswith("[") or line.startswith("#"):
        state["info"] = line[:80]
        return False

    parts = line.split(",")
    if len(parts) != 15:
        state["bad_count"] += 1
        return False
    try:
        seq = int(parts[0])
        t_ms = int(parts[1])
        dt_ms = int(parts[2])
        ax = float(parts[3]); ay = float(parts[4]); az = float(parts[5])
        gx = float(parts[6]); gy = float(parts[7]); gz = float(parts[8])
        roll = float(parts[9]); pitch = float(parts[10]); yaw = float(parts[11])
        s0 = int(parts[12]); s1 = int(parts[13]); s2 = int(parts[14])
    except ValueError:
        state["bad_count"] += 1
        return False

    state.update({
        "seq": seq, "t_ms": t_ms, "dt_ms": dt_ms,
        "ax": ax, "ay": ay, "az": az,
        "gx": gx, "gy": gy, "gz": gz,
        "roll": roll, "pitch": pitch, "yaw": yaw,
        "s0": s0, "s1": s1, "s2": s2,
        "rx_count": state["rx_count"] + 1,
        "last_rx_time": time.time(),
    })
    history["roll"].append(roll)
    history["pitch"].append(pitch)
    history["yaw"].append(yaw)
    history["s0"].append(s0)
    history["s1"].append(s1)
    history["s2"].append(s2)
    return True


def serial_reader_thread():
    global ser
    while True:
        try:
            with ser_lock:
                local = ser
            if local is None:
                time.sleep(0.05); continue
            data = local.readline()
            if not data:
                continue
            try:
                line = data.decode("utf-8", errors="ignore")
            except Exception:
                continue
            parse_line(line)
        except SerialException:
            time.sleep(0.1)
        except Exception:
            time.sleep(0.05)


def send_command(cmd: str):
    """コマンドにLF付加して送信"""
    if ser is None:
        return
    try:
        with ser_lock:
            ser.write((cmd + "\n").encode("utf-8"))
    except Exception as e:
        sys.stderr.write(f"[send error] {e}\n")


# ========== カメラ ==========
class Camera:
    def __init__(self):
        self.preset_isometric()

    def preset_isometric(self):
        self.eye = (60.0, 50.0, 60.0); self.up = (0.0, 1.0, 0.0); self.name = "Isometric"
    def preset_front(self):
        self.eye = (0.0, 0.0, 80.0); self.up = (0.0, 1.0, 0.0); self.name = "Front"
    def preset_side(self):
        self.eye = (80.0, 0.0, 0.0); self.up = (0.0, 1.0, 0.0); self.name = "Side"
    def preset_top(self):
        self.eye = (0.0, 80.0, 0.01); self.up = (0.0, 0.0, -1.0); self.name = "Top"

    def apply(self):
        gluLookAt(self.eye[0], self.eye[1], self.eye[2],
                  0.0, 0.0, 0.0,
                  self.up[0], self.up[1], self.up[2])

camera = Camera()


# ========== 描画ヘルパ ==========
def draw_ground_grid(size=80.0, step=10.0, y=-15.0):
    """地面グリッド"""
    glDisable(GL_LIGHTING)
    glColor3f(0.20, 0.30, 0.20)
    glBegin(GL_LINES)
    n = int(size / step)
    for i in range(-n, n + 1):
        x = i * step
        glVertex3f(x, y, -size); glVertex3f(x, y, size)
        glVertex3f(-size, y, x); glVertex3f(size, y, x)
    glEnd()
    # 中央軸を強調
    glColor3f(0.6, 0.2, 0.2)
    glBegin(GL_LINES); glVertex3f(-size, y, 0); glVertex3f(size, y, 0); glEnd()
    glColor3f(0.2, 0.2, 0.6)
    glBegin(GL_LINES); glVertex3f(0, y, -size); glVertex3f(0, y, size); glEnd()
    glEnable(GL_LIGHTING)


def draw_sky_dome():
    """空（背景クリアでカバー、ここでは何もしない）"""
    pass


def draw_axes(length=20.0):
    glDisable(GL_LIGHTING)
    glLineWidth(2.0)
    glBegin(GL_LINES)
    glColor3f(1, 0.3, 0.3); glVertex3f(0,0,0); glVertex3f(length,0,0)  # X
    glColor3f(0.3, 1, 0.3); glVertex3f(0,0,0); glVertex3f(0,length,0)  # Y
    glColor3f(0.3, 0.3, 1); glVertex3f(0,0,0); glVertex3f(0,0,length)  # Z
    glEnd()
    glLineWidth(1.0)
    glEnable(GL_LIGHTING)


def _set_material(rgb, alpha=1.0, specular=(0.25, 0.25, 0.25, 1.0), shininess=20.0):
    glMaterialfv(GL_FRONT_AND_BACK, GL_DIFFUSE, (rgb[0], rgb[1], rgb[2], alpha))
    glMaterialfv(GL_FRONT_AND_BACK, GL_SPECULAR, specular)
    glMaterialf(GL_FRONT_AND_BACK, GL_SHININESS, shininess)


def _draw_wing_panel(span, chord_root, chord_tip, sweep_deg, dihedral_deg, thickness=0.4):
    """テーパー・後退角・上反角のある主翼を描画（左右両側）。
    +Z=機首方向、+X=右翼方向、+Y=上方向。
    """
    half = span / 2.0
    sw_rad = math.radians(sweep_deg)
    dh_rad = math.radians(dihedral_deg)

    horiz = half * math.cos(dh_rad)
    vert  = half * math.sin(dh_rad)
    sweep_off = horiz * math.tan(sw_rad)

    # 翼根の前縁・後縁（z+ = 前）
    rLE = (0.0, 0.0, +chord_root / 2.0)
    rTE = (0.0, 0.0, -chord_root / 2.0)
    # 右翼端
    Rtip_LE = (+horiz,  vert, +chord_root / 2.0 - sweep_off)
    Rtip_TE = (+horiz,  vert, +chord_root / 2.0 - sweep_off - chord_tip)
    # 左翼端（X反転）
    Ltip_LE = (-horiz,  vert, +chord_root / 2.0 - sweep_off)
    Ltip_TE = (-horiz,  vert, +chord_root / 2.0 - sweep_off - chord_tip)

    h = thickness / 2.0

    def draw_half_top_bottom(rLE, rTE, tLE, tTE):
        # 上面
        glBegin(GL_QUADS)
        glNormal3f(0, 1, 0)
        glVertex3f(rLE[0], rLE[1] + h, rLE[2])
        glVertex3f(tLE[0], tLE[1] + h, tLE[2])
        glVertex3f(tTE[0], tTE[1] + h, tTE[2])
        glVertex3f(rTE[0], rTE[1] + h, rTE[2])
        glEnd()
        # 下面
        glBegin(GL_QUADS)
        glNormal3f(0, -1, 0)
        glVertex3f(rTE[0], rTE[1] - h, rTE[2])
        glVertex3f(tTE[0], tTE[1] - h, tTE[2])
        glVertex3f(tLE[0], tLE[1] - h, tLE[2])
        glVertex3f(rLE[0], rLE[1] - h, rLE[2])
        glEnd()

    draw_half_top_bottom(rLE, rTE, Rtip_LE, Rtip_TE)
    draw_half_top_bottom(rLE, rTE, Ltip_LE, Ltip_TE)


def _draw_vtail(height, chord, thickness=0.4):
    """垂直尾翼（垂直に立った薄板）"""
    h = thickness / 2.0
    # 矩形：x=±h, y=0..height, z=±chord/2
    c2 = chord / 2.0
    glBegin(GL_QUADS)
    # 右面
    glNormal3f(1, 0, 0)
    glVertex3f(+h, 0, -c2); glVertex3f(+h, 0, +c2)
    glVertex3f(+h, height, +c2); glVertex3f(+h, height, -c2)
    # 左面
    glNormal3f(-1, 0, 0)
    glVertex3f(-h, 0, +c2); glVertex3f(-h, 0, -c2)
    glVertex3f(-h, height, -c2); glVertex3f(-h, height, +c2)
    glEnd()


def draw_glider():
    """spec に従って機体を描画"""
    s = spec

    # === 胴体 ===
    _set_material(s.fuselage_color)
    glPushMatrix()
    glScalef(s.fuselage_width, s.fuselage_height, s.fuselage_length)
    glutSolidCube(1.0)
    glPopMatrix()

    # === 機首コーン ===
    if s.nose_length > 0:
        _set_material(s.nose_color)
        glPushMatrix()
        glTranslatef(0, 0, s.fuselage_length / 2.0)
        glRotatef(-90, 1, 0, 0)
        glutSolidCone(s.fuselage_width / 2.0, s.nose_length, 16, 4)
        glPopMatrix()

    # === 主翼 ===
    if s.wing_enabled:
        _set_material(s.wing_color)
        glPushMatrix()
        glTranslatef(0, s.wing_position_y, s.wing_position_z)
        _draw_wing_panel(s.wing_span, s.wing_chord_root, s.wing_chord_tip,
                          s.wing_sweep_deg, s.wing_dihedral_deg)
        glPopMatrix()

    # === 副主翼（複葉用） ===
    if s.wing2_enabled:
        _set_material(s.wing_color)
        glPushMatrix()
        glTranslatef(0,
                     s.wing_position_y + s.wing2_offset_y,
                     s.wing_position_z + s.wing2_offset_z)
        _draw_wing_panel(s.wing_span, s.wing_chord_root, s.wing_chord_tip,
                          s.wing_sweep_deg, s.wing_dihedral_deg)
        glPopMatrix()

    # === カナード（前翼） ===
    if s.canard_enabled:
        _set_material(s.canard_color)
        glPushMatrix()
        glTranslatef(0, s.canard_position_y, s.canard_position_z)
        _draw_wing_panel(s.canard_span, s.canard_chord, s.canard_chord, 0.0, 0.0)
        glPopMatrix()

    # === 水平尾翼 ===
    if s.htail_enabled:
        _set_material(s.htail_color)
        glPushMatrix()
        glTranslatef(0, s.htail_position_y, s.htail_position_z)
        _draw_wing_panel(s.htail_span, s.htail_chord, s.htail_chord,
                          s.htail_sweep_deg, 0.0)
        glPopMatrix()

    # === 垂直尾翼 ===
    if s.vtail_enabled:
        _set_material(s.vtail_color)
        glPushMatrix()
        glTranslatef(0, s.vtail_position_y, s.vtail_position_z)
        _draw_vtail(s.vtail_height, s.vtail_chord)
        glPopMatrix()


def draw_accel_vector():
    glDisable(GL_LIGHTING)
    glColor3f(1.0, 1.0, 1.0)
    glLineWidth(2.0)
    s = 25.0
    glBegin(GL_LINES)
    glVertex3f(0, 0, 0)
    glVertex3f(state["ax"] * s, state["ay"] * s, state["az"] * s)
    glEnd()
    glLineWidth(1.0)
    glEnable(GL_LIGHTING)


# ========== HUD（2Dオーバーレイ） ==========
def draw_text(x, y, s, font=None, color=(1, 1, 1)):
    if font is None:
        font = GLUT_BITMAP_HELVETICA_12
    glColor3f(*color)
    glRasterPos2f(x, y)
    for ch in s:
        glutBitmapCharacter(font, ord(ch))


def draw_hud(width: int, height: int):
    glDisable(GL_LIGHTING)
    glDisable(GL_DEPTH_TEST)
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity()
    gluOrtho2D(0, width, 0, height)
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity()

    # --- 左上: 姿勢角 ---
    y = height - 20
    big = GLUT_BITMAP_HELVETICA_18
    sm = GLUT_BITMAP_HELVETICA_12
    draw_text(10, y, "Glider Telemetry", big, (1, 1, 0.3)); y -= 22
    draw_text(10, y, f"roll  : {state['roll']:+7.2f} deg", big, (1, 0.5, 0.5)); y -= 18
    draw_text(10, y, f"pitch : {state['pitch']:+7.2f} deg", big, (0.5, 1, 0.5)); y -= 18
    draw_text(10, y, f"yaw   : {state['yaw']:+7.2f} deg", big, (0.5, 0.7, 1)); y -= 22

    draw_text(10, y, f"servo s0/s1/s2 : {state['s0']:3d} {state['s1']:3d} {state['s2']:3d}", sm); y -= 14
    draw_text(10, y, f"accel  ax/ay/az : {state['ax']:+.3f} {state['ay']:+.3f} {state['az']:+.3f}", sm); y -= 14
    draw_text(10, y, f"gyro   gx/gy/gz : {state['gx']:+.2f} {state['gy']:+.2f} {state['gz']:+.2f}", sm); y -= 14
    draw_text(10, y, f"seq={state['seq']}  t_ms={state['t_ms']}  dt_ms={state['dt_ms']}", sm); y -= 14

    # --- 右上: 通信状態 ---
    age = time.time() - state["last_rx_time"] if state["last_rx_time"] > 0 else 9999
    online = age < 0.5
    color = (0.3, 1, 0.3) if online else (1, 0.3, 0.3)
    draw_text(width - 200, height - 20, f"RX={state['rx_count']}  bad={state['bad_count']}", sm, color)
    draw_text(width - 200, height - 36, f"link={'ONLINE' if online else 'STALE'}", sm, color)
    draw_text(width - 200, height - 52, f"view: {camera.name}", sm)
    draw_text(width - 200, height - 68, f"preset: {spec.name}", sm, (1, 0.9, 0.5))

    # --- 下部: info / コマンドヘルプ ---
    if state["info"]:
        draw_text(10, 28, state["info"], sm, (0.7, 0.9, 1))
    draw_text(10, 12, "Keys: 1/2/3=P/PD/PID  M=Manual  A=Auto  ESC=Quit  F1-F4=View", sm, (0.6, 0.6, 0.6))

    # --- ミニグラフ：右下 ---
    draw_mini_graphs(width, height)

    glMatrixMode(GL_PROJECTION); glPopMatrix()
    glMatrixMode(GL_MODELVIEW); glPopMatrix()
    glEnable(GL_DEPTH_TEST)
    glEnable(GL_LIGHTING)


def draw_mini_graphs(width: int, height: int):
    """右下にミニラインプロット"""
    # スレッド安全のため deque をスナップショット（list 化）
    panels = [
        ("roll",  list(history["roll"]),  (1, 0.5, 0.5), -90, 90),
        ("pitch", list(history["pitch"]), (0.5, 1, 0.5), -90, 90),
        ("yaw",   list(history["yaw"]),   (0.5, 0.7, 1), -180, 180),
    ]
    panel_w, panel_h = 160, 50
    margin = 10
    base_x = width - panel_w - margin
    base_y = margin

    sm = GLUT_BITMAP_HELVETICA_10

    for i, (name, vals, color, vmin, vmax) in enumerate(panels):
        px = base_x
        py = base_y + i * (panel_h + 8)

        # 枠
        glColor3f(0.5, 0.5, 0.5)
        glBegin(GL_LINE_LOOP)
        glVertex2f(px, py); glVertex2f(px + panel_w, py)
        glVertex2f(px + panel_w, py + panel_h); glVertex2f(px, py + panel_h)
        glEnd()

        # ラベル
        if vals:
            cur = vals[-1]
            draw_text(px + 4, py + panel_h - 12, f"{name}: {cur:+.1f}", sm, color)
        else:
            draw_text(px + 4, py + panel_h - 12, f"{name}: --", sm, color)

        # ライン
        if len(vals) >= 2:
            glColor3f(*color)
            glBegin(GL_LINE_STRIP)
            for k, v in enumerate(vals):
                x = px + (k / max(1, HISTORY - 1)) * panel_w
                vc = max(vmin, min(vmax, v))
                y = py + 4 + ((vc - vmin) / (vmax - vmin)) * (panel_h - 18)
                glVertex2f(x, y)
            glEnd()


# ========== ディスプレイ ==========
def display():
    glClearColor(0.05, 0.07, 0.12, 1.0)
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT)

    width = glutGet(GLUT_WINDOW_WIDTH)
    height = glutGet(GLUT_WINDOW_HEIGHT)

    glMatrixMode(GL_PROJECTION); glLoadIdentity()
    gluPerspective(45.0, float(width) / max(1, height), 0.1, 500.0)
    glMatrixMode(GL_MODELVIEW); glLoadIdentity()
    camera.apply()

    # ライトの位置（ワールド固定）
    glLightfv(GL_LIGHT0, GL_POSITION, (50.0, 80.0, 50.0, 1.0))
    glLightfv(GL_LIGHT0, GL_DIFFUSE, (0.9, 0.9, 0.85, 1.0))
    glLightfv(GL_LIGHT0, GL_AMBIENT, (0.3, 0.3, 0.35, 1.0))

    draw_ground_grid()
    draw_axes()

    # 機体姿勢
    glPushMatrix()
    glRotatef(state["yaw"],   0, 1, 0)
    glRotatef(state["pitch"], 1, 0, 0)
    glRotatef(state["roll"],  0, 0, 1)
    draw_glider()
    glPopMatrix()

    # 加速度ベクトル
    draw_accel_vector()

    # HUD
    draw_hud(width, height)

    glutSwapBuffers()


def reshape(width: int, height: int):
    glViewport(0, 0, width, max(1, height))


def idle():
    glutPostRedisplay()
    time.sleep(0.02)  # ~50fps cap


# ========== キーボード ==========
def keyboard(key, x, y):
    try:
        k = key.decode("ascii", errors="ignore")
    except Exception:
        return
    if k == "\x1b":
        sys.exit(0)
    # 1文字コマンドはマイコンへ送信
    if k in ("1", "2", "3", "m", "M", "a", "A", "p", "P", "i", "I", "d", "D",
             "x", "X", "y", "Y", "z", "Z", "g", "G", "s", "S", "h", "H",
             "l", "L", "r", "R", "e", "E", "c", "C"):
        send_command(k)


def special_keys(key, x, y):
    if key == GLUT_KEY_F1: camera.preset_front()
    elif key == GLUT_KEY_F2: camera.preset_side()
    elif key == GLUT_KEY_F3: camera.preset_top()
    elif key == GLUT_KEY_F4: camera.preset_isometric()


# ========== 初期化 ==========
def init_gl():
    glEnable(GL_DEPTH_TEST)
    glEnable(GL_LIGHTING)
    glEnable(GL_LIGHT0)
    glEnable(GL_COLOR_MATERIAL)
    glColorMaterial(GL_FRONT_AND_BACK, GL_AMBIENT_AND_DIFFUSE)
    glShadeModel(GL_SMOOTH)
    glLineWidth(1.5)


def main():
    global ser, spec

    parser = argparse.ArgumentParser(description="Glider 3D telemetry viewer")
    parser.add_argument("--port", help="シリアルポート (例: COM12)")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--width", type=int, default=900)
    parser.add_argument("--height", type=int, default=650)
    parser.add_argument("--preset", default="default",
                        help="機体テンプレート名 (default/high_ar/swept/delta/canard/flying_wing/biplane/high_dihedral)")
    parser.add_argument("--list-presets", action="store_true", help="使えるプリセット一覧を表示して終了")
    args = parser.parse_args()

    if args.list_presets:
        print(list_presets())
        sys.exit(0)

    if not args.port:
        sys.stderr.write("[ERROR] --port が必要です。--list-presets で一覧を見られます。\n")
        sys.exit(1)

    try:
        spec = get_preset(args.preset)
        print(f"[INFO] preset: {spec.name}")
    except ValueError as e:
        sys.stderr.write(f"[ERROR] {e}\n")
        sys.exit(1)

    try:
        ser = Serial(args.port, args.baud, timeout=0.1)
        print(f"[INFO] Opened {args.port} @ {args.baud}")
    except Exception as e:
        sys.stderr.write(f"[ERROR] cannot open serial: {e}\n")
        sys.exit(1)

    th = threading.Thread(target=serial_reader_thread, daemon=True)
    th.start()

    glutInit(sys.argv)
    glutInitDisplayMode(GLUT_RGB | GLUT_DOUBLE | GLUT_DEPTH)
    glutInitWindowSize(args.width, args.height)
    glutInitWindowPosition(100, 50)
    glutCreateWindow(b"Glider 3D Viewer (Exercise05+)")

    init_gl()
    glutDisplayFunc(display)
    glutReshapeFunc(reshape)
    glutIdleFunc(idle)
    glutKeyboardFunc(keyboard)
    glutSpecialFunc(special_keys)

    print("[INFO] ESC to quit, F1-F4 to switch view")
    glutMainLoop()


if __name__ == "__main__":
    main()
