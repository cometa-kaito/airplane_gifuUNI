# -*- coding: utf-8 -*-
"""
3D 紙飛行機ビューア（自律滑空機 Exercise05+ 用）
- viewer_serialsend 互換 15列 CSV を受信
- 期待されるフィールド順:
  seq, t_ms, dt_ms, ax, ay, az, gx, gy, gz, roll, pitch, yaw, s0, s1, s2

使い方:
    python paperplane_glider.py --port COM12

依存: pyserial, PyOpenGL, freeglut
"""

import argparse
import math
import sys

from serial import Serial
from OpenGL.GL import *
from OpenGL.GLU import *
from OpenGL.GLUT import *

# 受信したテレメトリ
state = {
    "roll": 0.0,
    "pitch": 0.0,
    "yaw": 0.0,
    "ax": 0.0,
    "ay": 0.0,
    "az": 1.0,
}

ser = None
window = None


def parse_telemetry_line(line: str) -> bool:
    """1行の CSV をパースして state を更新。成功なら True。"""
    line = line.strip()
    if not line or line.startswith("[") or line.startswith("#"):
        return False
    parts = line.split(",")
    if len(parts) != 15:
        return False
    try:
        # 0=seq, 1=t_ms, 2=dt_ms, 3=ax, 4=ay, 5=az, 6=gx, 7=gy, 8=gz,
        # 9=roll, 10=pitch, 11=yaw, 12=s0, 13=s1, 14=s2
        ax = float(parts[3]); ay = float(parts[4]); az = float(parts[5])
        roll = float(parts[9]); pitch = float(parts[10]); yaw = float(parts[11])
    except ValueError:
        return False
    state["ax"], state["ay"], state["az"] = ax, ay, az
    state["roll"], state["pitch"], state["yaw"] = roll, pitch, yaw
    return True


def init_gl(width: int, height: int):
    glClearColor(0.05, 0.05, 0.10, 1.0)
    glEnable(GL_DEPTH_TEST)
    glMatrixMode(GL_PROJECTION)
    glLoadIdentity()
    gluPerspective(45.0, float(width) / float(height), 0.1, 100.0)


def draw_paper_plane():
    """紙飛行機モデル（黄色い三角羽根）"""
    glColor3f(1.0, 0.9, 0.2)
    glBegin(GL_TRIANGLES)
    # 左翼
    glVertex3d(0, 0, 0)
    glVertex3d(-30, 0, -40)
    glVertex3d(0, 0, -50)
    # 右翼
    glVertex3d(0, 0, 0)
    glVertex3d(0, 0, -50)
    glVertex3d(30, 0, -40)
    # 中央（垂直部）
    glColor3f(1.0, 0.6, 0.1)
    glVertex3d(0, 0, 0)
    glVertex3d(0, -10, -50)
    glVertex3d(0, 0, -50)
    glEnd()


def draw_axes():
    """ワールド座標軸（赤=X, 緑=Y, 青=Z）"""
    glBegin(GL_LINES)
    glColor3f(1.0, 0.3, 0.3); glVertex3f(0, 0, 0); glVertex3f(50, 0, 0)
    glColor3f(0.3, 1.0, 0.3); glVertex3f(0, 0, 0); glVertex3f(0, 50, 0)
    glColor3f(0.3, 0.3, 1.0); glVertex3f(0, 0, 0); glVertex3f(0, 0, 50)
    glEnd()


def draw_accel_vector():
    """加速度ベクトル（白い線）"""
    glColor3f(1.0, 1.0, 1.0)
    s = 30.0
    glBegin(GL_LINES)
    glVertex3f(0, 0, 0)
    glVertex3f(state["ax"] * s, state["ay"] * s, state["az"] * s)
    glEnd()


def display():
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT)
    glMatrixMode(GL_MODELVIEW)
    glLoadIdentity()
    # 視点
    gluLookAt(60.0, 60.0, 60.0,  0.0, 0.0, 0.0,  0.0, 1.0, 0.0)

    # ワールド軸
    draw_axes()

    # 機体姿勢
    glPushMatrix()
    glRotatef(state["yaw"],   0, 1, 0)   # ヨー（Y軸まわり）
    glRotatef(state["pitch"], 1, 0, 0)   # ピッチ（X軸まわり）
    glRotatef(state["roll"],  0, 0, 1)   # ロール（Z軸まわり）
    draw_paper_plane()
    glPopMatrix()

    # 加速度ベクトル
    draw_accel_vector()

    glutSwapBuffers()


def reshape(width: int, height: int):
    glViewport(0, 0, width, height)
    glMatrixMode(GL_PROJECTION)
    glLoadIdentity()
    gluPerspective(45.0, float(width) / max(1, height), 0.1, 200.0)


def idle():
    """シリアル受信＆描画更新"""
    if ser is None:
        return
    try:
        # 利用可能な分だけまとめて読む
        while ser.in_waiting > 0:
            line_bytes = ser.readline()
            if not line_bytes:
                break
            try:
                line = line_bytes.decode("utf-8", errors="ignore")
            except Exception:
                continue
            if parse_telemetry_line(line):
                # 一番新しい値で再描画
                glutPostRedisplay()
    except Exception as e:
        sys.stderr.write(f"[serial error] {e}\n")


def keyboard(key, x, y):
    """ESC で終了"""
    try:
        k = key.decode("ascii", errors="ignore")
    except Exception:
        return
    if k == "\x1b":  # ESC
        sys.exit(0)


def main():
    global ser, window

    parser = argparse.ArgumentParser(description="3D paper plane viewer for glider telemetry")
    parser.add_argument("--port", required=True, help="シリアルポート (例: COM12)")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--width", type=int, default=600)
    parser.add_argument("--height", type=int, default=600)
    args = parser.parse_args()

    # シリアル接続
    ser = Serial(
        port=args.port,
        baudrate=args.baud,
        bytesize=8, parity="N", stopbits=1,
        timeout=0.05,
    )
    print(f"[INFO] Opened {args.port} @ {args.baud}")
    print("[INFO] ESC to quit")

    glutInit(sys.argv)
    glutInitDisplayMode(GLUT_RGB | GLUT_DOUBLE | GLUT_DEPTH)
    glutInitWindowSize(args.width, args.height)
    glutInitWindowPosition(120, 120)
    window = glutCreateWindow(b"Glider 3D Viewer")
    glutDisplayFunc(display)
    glutReshapeFunc(reshape)
    glutKeyboardFunc(keyboard)
    glutIdleFunc(idle)
    init_gl(args.width, args.height)
    glutMainLoop()


if __name__ == "__main__":
    main()
