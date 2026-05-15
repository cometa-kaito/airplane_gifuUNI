# -*- coding: utf-8 -*-
"""
ground_station.py
自律滑空機 地上局メインアプリ

役割:
  - 地上側 ESP32-C3 の USB シリアルを所有
  - PyQt6 + pyqtgraph で操作 UI・高速グラフ・3D 姿勢ビューを表示
  - WebSocket サーバとしてテレメトリを JSON ブロードキャスト
  - WS クライアントからのコマンド受信（既定 OFF、UI チェックボックス or トークンで許可）

使い方:
  python ground_station.py --port COM12 [--ws-port 8765] [--ws-host 127.0.0.1] [--ws-token <secret>]

依存:
  pip install PyQt6 pyqtgraph pyserial websockets PyOpenGL
"""

import argparse
import asyncio
import json
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

import pyqtgraph as pg
import pyqtgraph.opengl as gl
from PyQt6 import QtCore, QtGui, QtWidgets
from serial import Serial, SerialException

import websockets

# ------------------------------------------------------------------
# シリアル受信 & 送信スレッド
# ------------------------------------------------------------------
# 旧 15 列形式 (互換確保用)。新ファームは末尾に phase, accel_g を追加した 17 列を送る。
TELEMETRY_FIELDS_CORE = [
    "seq", "t_ms", "dt_ms",
    "ax", "ay", "az",
    "gx", "gy", "gz",
    "roll", "pitch", "yaw",
    "s0", "s1", "s2",
]
# 拡張列 (firmware 17列対応)
TELEMETRY_FIELDS_EXT = ["phase", "accel_g"]
TELEMETRY_FIELDS = TELEMETRY_FIELDS_CORE + TELEMETRY_FIELDS_EXT
TELEMETRY_INT_FIELDS = {"seq", "t_ms", "dt_ms", "s0", "s1", "s2", "phase"}
PHASE_NAMES = ["DISARMED", "PRELAUNCH", "LAUNCH", "GLIDE", "LANDED", "WINDTUNNEL"]


class SerialIO(QtCore.QObject):
    """非同期シリアル I/O。受信は Qt シグナルで UI に通知する。"""

    new_telemetry = QtCore.pyqtSignal(dict)
    new_info = QtCore.pyqtSignal(str)
    link_status = QtCore.pyqtSignal(bool)

    def __init__(self, port: str, baud: int = 115200, log_dir: Path | None = None):
        super().__init__()
        self.port = port
        self.baud = baud
        self._ser = None
        self._stop = threading.Event()
        self._tx_lock = threading.Lock()
        self._rx_count = 0
        self._bad_count = 0

        # ---- CSV 自動保存 ----
        #   起動と同時に logs/flight_YYYYMMDD_HHMMSS.csv へ書き込み開始する。
        #   ヘッダは TELEMETRY_FIELDS + wall_ms。フライトログ取り忘れを防ぐ。
        #   log_dir=None でディスク書き込み無効。
        self._log_lock = threading.Lock()
        self._log_file: Path | None = None
        self._log_handle = None
        if log_dir is not None:
            try:
                log_dir.mkdir(parents=True, exist_ok=True)
                self._log_file = log_dir / f"flight_{datetime.now():%Y%m%d_%H%M%S}.csv"
                self._log_handle = open(self._log_file, "w", encoding="utf-8", buffering=1)
                self._log_handle.write(",".join(TELEMETRY_FIELDS + ["wall_ms"]) + "\n")
            except Exception:
                # ディスク書き込み失敗時はサイレントに無効化（飛行を妨げない）
                self._log_file = None
                self._log_handle = None

    def start(self):
        try:
            self._ser = Serial(self.port, self.baud, timeout=0.1)
            self.new_info.emit(f"[INFO] Opened {self.port} @ {self.baud}")
        except Exception as e:
            self.new_info.emit(f"[ERROR] cannot open serial: {e}")
            return False
        threading.Thread(target=self._reader_loop, daemon=True).start()
        return True

    def stop(self):
        self._stop.set()
        if self._ser:
            try:
                self._ser.close()
            except Exception:
                pass
        # CSV 出力をフラッシュ＆クローズ
        with self._log_lock:
            if self._log_handle is not None:
                try:
                    self._log_handle.flush()
                    self._log_handle.close()
                except Exception:
                    pass
                self._log_handle = None

    def _write_log(self, rec: dict):
        """テレメトリ 1 行を CSV にフラッシュする。失敗してもサイレントに続行。"""
        h = self._log_handle
        if h is None:
            return
        try:
            cells = []
            for k in TELEMETRY_FIELDS:
                v = rec.get(k, "")
                if isinstance(v, float):
                    cells.append(f"{v:.6g}")
                else:
                    cells.append(str(v))
            cells.append(str(int(time.time() * 1000)))
            with self._log_lock:
                if self._log_handle is not None:
                    self._log_handle.write(",".join(cells) + "\n")
        except Exception:
            pass

    def send_command(self, cmd: str):
        if self._ser is None:
            return
        try:
            with self._tx_lock:
                self._ser.write((cmd.strip() + "\n").encode("utf-8"))
        except Exception as e:
            self.new_info.emit(f"[ERROR] send: {e}")

    def _reader_loop(self):
        last_rx = time.time()
        while not self._stop.is_set():
            try:
                raw = self._ser.readline()
                if not raw:
                    if time.time() - last_rx > 1.0:
                        self.link_status.emit(False)
                    continue
                line = raw.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue
                if line.startswith("[") or line.startswith("#"):
                    self.new_info.emit(line[:200])
                    continue
                parts = line.split(",")
                # 下位互換: 旧 15 列も新 17 列も受理する。
                # 不足分 (phase, accel_g 等) は欠損として 0 / 0.0 を入れる。
                if len(parts) < len(TELEMETRY_FIELDS_CORE):
                    self._bad_count += 1
                    continue
                try:
                    rec = {}
                    for idx, name in enumerate(TELEMETRY_FIELDS):
                        if idx < len(parts):
                            raw_v = parts[idx]
                            rec[name] = int(raw_v) if name in TELEMETRY_INT_FIELDS else float(raw_v)
                        else:
                            # 拡張列が無い旧 firmware からの受信時のフォールバック
                            rec[name] = 0 if name in TELEMETRY_INT_FIELDS else 0.0
                except ValueError:
                    self._bad_count += 1
                    continue
                self._rx_count += 1
                rec["_rx_count"] = self._rx_count
                rec["_bad_count"] = self._bad_count
                last_rx = time.time()
                # CSV へ自動保存 (UI 描画と独立、I/O は短い)
                self._write_log(rec)
                self.link_status.emit(True)
                self.new_telemetry.emit(rec)
            except SerialException:
                time.sleep(0.1)
            except Exception:
                time.sleep(0.05)


# ------------------------------------------------------------------
# WebSocket ブロードキャスタ + コマンド受信
# ------------------------------------------------------------------
class WebSocketServer:
    """別スレッドで asyncio loop を回し、テレメトリ JSON を全クライアントへ送信する。
    クライアントから {"cmd": "..."} を受信したらコールバックでシリアルへ転送する。
    認可は (a) UI のチェックボックス (b) 必須トークン の AND で行う。
    """

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8765,
        token: str | None = None,
        on_command=None,
    ):
        self.host = host
        self.port = port
        self.token = token  # None なら認証なし
        self.on_command = on_command  # callable(cmd: str)
        self.allow_commands = False  # UI 側から動的に切り替える
        self._clients: set = set()
        self._authed: set = set()
        self._loop = None
        self._lock = threading.Lock()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._serve())

    async def _serve(self):
        async with websockets.serve(self._handle, self.host, self.port):
            print(f"[WS] listening on ws://{self.host}:{self.port}"
                  f"  token={'required' if self.token else 'none'}")
            await asyncio.Future()  # keep running

    async def _handle(self, websocket):
        with self._lock:
            self._clients.add(websocket)
        # 認証なしの場合は最初から authed
        if self.token is None:
            self._authed.add(websocket)
        try:
            async for raw in websocket:
                await self._on_message(websocket, raw)
        except Exception:
            pass
        finally:
            with self._lock:
                self._clients.discard(websocket)
                self._authed.discard(websocket)

    async def _on_message(self, websocket, raw):
        try:
            msg = json.loads(raw)
        except Exception:
            return

        # 認証
        if "auth" in msg and self.token is not None:
            if str(msg["auth"]) == self.token:
                self._authed.add(websocket)
                await websocket.send(json.dumps({"ok": True, "authed": True}))
            else:
                await websocket.send(json.dumps({"ok": False, "error": "bad token"}))
            return

        # コマンド
        cmd = msg.get("cmd")
        if not cmd:
            return
        if websocket not in self._authed:
            await websocket.send(json.dumps({"ok": False, "error": "auth required"}))
            return
        if not self.allow_commands:
            await websocket.send(json.dumps({"ok": False, "error": "commands disabled by server"}))
            return
        if self.on_command:
            try:
                self.on_command(str(cmd))
                await websocket.send(json.dumps({"ok": True, "cmd": cmd}))
            except Exception as e:
                await websocket.send(json.dumps({"ok": False, "error": str(e)}))

    def broadcast(self, payload: dict):
        if self._loop is None:
            return
        msg = json.dumps(payload)
        with self._lock:
            clients = list(self._clients)

        async def _send_all():
            for ws in clients:
                try:
                    await ws.send(msg)
                except Exception:
                    pass

        asyncio.run_coroutine_threadsafe(_send_all(), self._loop)


# ------------------------------------------------------------------
# 3D 姿勢ペイン（pyqtgraph.opengl ベース）
# ------------------------------------------------------------------
class Glider3DPane(gl.GLViewWidget):
    """簡素な機体モデル（胴体+主翼+尾翼）を roll/pitch/yaw に応じて回転表示する。
    座標系: +Y=前進方向, +X=右翼方向, +Z=上方向（pyqtgraph.opengl の既定 Z-up）。
    """

    def __init__(self):
        super().__init__()
        # カメラを機体の前方やや上から見下ろす標準角度に固定
        self.setCameraPosition(distance=8.5, elevation=22, azimuth=-65)
        self.opts["fov"] = 50
        self.setBackgroundColor((22, 26, 32))

        # 地面グリッド（x-y 平面、Z=-1.0 に降ろして機体と被らないように）
        grid = gl.GLGridItem()
        grid.setSize(20, 20)
        grid.setSpacing(2, 2)
        grid.setColor((110, 120, 135, 200))
        grid.translate(0, 0, -1.0)
        self.addItem(grid)

        # 機軸を示す参照矢印
        try:
            ax_x = gl.GLLinePlotItem(
                pos=[[0, 0, -1.0], [3, 0, -1.0]],
                color=(1.0, 0.4, 0.4, 0.8), width=2, antialias=True,
            )
            ax_y = gl.GLLinePlotItem(
                pos=[[0, 0, -1.0], [0, 3, -1.0]],
                color=(0.4, 1.0, 0.4, 0.8), width=2, antialias=True,
            )
            self.addItem(ax_x)
            self.addItem(ax_y)
        except Exception:
            pass

        # 機体パーツ（meshdata は Y+ 前進、X+ 右翼、Z+ 上）
        self._parts = []
        self._make_body()

        # 共有 transform（毎フレーム置き換える）
        self._cur_attitude = (0.0, 0.0, 0.0)

    def _add_box(self, sx, sy, sz, color, offset=(0, 0, 0)):
        """中心原点の単位 cube を引数サイズに拡大、offset 平行移動して追加。"""
        verts, faces = _unit_cube_mesh()
        md = gl.MeshData(vertexes=verts, faces=faces)
        item = gl.GLMeshItem(
            meshdata=md,
            smooth=False,
            color=color,
            shader="shaded",
            glOptions="opaque",
        )
        item.scale(sx, sy, sz)
        item.translate(offset[0], offset[1], offset[2])
        self.addItem(item)
        self._parts.append((item, sx, sy, sz, offset))
        return item

    def _make_body(self):
        # 胴体: 細長い箱、Y 方向に長い
        self._add_box(0.25, 3.0, 0.25, (0.85, 0.86, 0.90, 1.0))
        # 主翼: 左右に広い箱（X 方向に span）
        self._add_box(5.0, 0.8, 0.06, (1.0, 0.85, 0.20, 1.0), offset=(0, 0.2, 0.05))
        # 水平尾翼
        self._add_box(1.5, 0.4, 0.04, (1.0, 0.55, 0.15, 1.0), offset=(0, -1.3, 0.05))
        # 垂直尾翼
        self._add_box(0.04, 0.5, 0.5, (0.88, 0.20, 0.20, 1.0), offset=(0, -1.3, 0.30))
        # ノーズ（球）
        try:
            md = gl.MeshData.sphere(rows=8, cols=12, radius=0.18)
            nose = gl.GLMeshItem(meshdata=md, smooth=True,
                                 color=(0.95, 0.95, 0.98, 1.0),
                                 shader="shaded", glOptions="opaque")
            nose.translate(0, 1.5, 0)
            self.addItem(nose)
            self._parts.append((nose, 1.0, 1.0, 1.0, (0, 1.5, 0)))
        except Exception:
            pass

    def update_attitude(self, roll_deg: float, pitch_deg: float, yaw_deg: float):
        """全パーツに同じ回転変換を適用する。"""
        # Z-up 座標で yaw -> Z, pitch -> X, roll -> Y の順
        t = QtGui.QMatrix4x4()
        t.rotate(yaw_deg, 0, 0, 1)
        t.rotate(pitch_deg, 1, 0, 0)
        t.rotate(roll_deg, 0, 1, 0)
        for item, sx, sy, sz, off in self._parts:
            local = QtGui.QMatrix4x4()
            local.translate(off[0], off[1], off[2])
            local.scale(sx, sy, sz)
            item.setTransform(t * local)
        self._cur_attitude = (roll_deg, pitch_deg, yaw_deg)


def _unit_cube_mesh():
    """中心原点の 1×1×1 cube の頂点と三角形面を返す。"""
    import numpy as np
    v = np.array([
        [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5],  [0.5, -0.5, 0.5],  [0.5, 0.5, 0.5],  [-0.5, 0.5, 0.5],
    ])
    f = np.array([
        [0, 1, 2], [0, 2, 3],   # 底
        [4, 6, 5], [4, 7, 6],   # 上
        [0, 5, 1], [0, 4, 5],   # -Y
        [2, 6, 7], [2, 7, 3],   # +Y
        [1, 5, 6], [1, 6, 2],   # +X
        [0, 3, 7], [0, 7, 4],   # -X
    ])
    return v, f


# ------------------------------------------------------------------
# メインウィンドウ
# ------------------------------------------------------------------
HISTORY = 300


class MainWindow(QtWidgets.QMainWindow):
    def __init__(
        self,
        port: str,
        ws_port: int,
        ws_host: str = "127.0.0.1",
        ws_token: str | None = None,
        log_dir: Path | None = None,
    ):
        super().__init__()
        self.setWindowTitle("Glider Ground Station")
        self.resize(1280, 800)
        self.setMinimumSize(720, 480)  # 全画面・縮小いずれも崩れない最小サイズ

        # MANUAL 操作の状態
        self.step_size = 10            # 1ボタン押下あたりの偏舵量 [deg]
        self.current_mode_text = "?"   # 機体側から [MODE] で受け取った文字列

        # データバッファ
        self.history = {f: deque(maxlen=HISTORY) for f in TELEMETRY_FIELDS}
        self.history["wall_t"] = deque(maxlen=HISTORY)

        # シリアル（WS のコマンドコールバックから参照する都合上、先に作る）
        self.serial_io = SerialIO(port, log_dir=log_dir)
        self.serial_io.new_telemetry.connect(self.on_telemetry)
        self.serial_io.new_info.connect(self.on_info)
        self.serial_io.link_status.connect(self.on_link_status)

        # WebSocket（コマンド受信は UI のチェックボックスで gating）
        self.ws = WebSocketServer(
            host=ws_host,
            port=ws_port,
            token=ws_token,
            on_command=self._on_ws_command,
        )
        self.ws.start()

        # UI 構築
        self._build_ui()

        # 起動
        if not self.serial_io.start():
            QtWidgets.QMessageBox.critical(self, "Error", f"Cannot open {port}")
            sys.exit(1)

    def _on_ws_command(self, cmd: str):
        """WebSocket クライアントから受け取ったコマンドをシリアルへ転送（UI スレッド経由）。"""
        # 別スレッド（asyncio）から呼ばれるので、Qt スレッドへキューイング
        QtCore.QMetaObject.invokeMethod(
            self,
            "_dispatch_ws_command",
            QtCore.Qt.ConnectionType.QueuedConnection,
            QtCore.Q_ARG(str, cmd),
        )

    @QtCore.pyqtSlot(str)
    def _dispatch_ws_command(self, cmd: str):
        self.serial_io.send_command(cmd)
        self.log.appendPlainText(f"[WS] > {cmd}")

    # =========================================================
    # UI ビルド
    # =========================================================
    def _build_ui(self):
        central = QtWidgets.QWidget()
        outer = QtWidgets.QVBoxLayout(central)
        outer.setContentsMargins(8, 8, 8, 8)
        outer.setSpacing(6)

        # ステータス行（固定高さ）
        outer.addWidget(self._build_status_bar())
        # 大きい数値読み取りパネル（瞬時把握用）
        outer.addWidget(self._build_big_readout())

        # 縦 Splitter で 上段（プロット+3D） / 操作 / ログ を可変分割
        splitter = QtWidgets.QSplitter(QtCore.Qt.Orientation.Vertical)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(6)

        # 上段は横 Splitter にして左=プロット / 右=3D
        top = QtWidgets.QSplitter(QtCore.Qt.Orientation.Horizontal)
        top.setChildrenCollapsible(False)
        top.setHandleWidth(6)
        top.addWidget(self._build_plots())
        self.pane3d = Glider3DPane()
        top.addWidget(self.pane3d)
        top.setStretchFactor(0, 3)
        top.setStretchFactor(1, 2)
        top.setSizes([720, 480])

        splitter.addWidget(top)
        splitter.addWidget(self._build_controls_scroll())
        splitter.addWidget(self._build_log())

        # 初期サイズ比 (top : controls : log = 7 : 4 : 1)
        splitter.setStretchFactor(0, 7)
        splitter.setStretchFactor(1, 4)
        splitter.setStretchFactor(2, 1)
        splitter.setSizes([460, 280, 80])

        outer.addWidget(splitter, 1)
        self.setCentralWidget(central)

        # キーボードショートカット（Quick Manual Control 用）
        self._install_shortcuts()

        # 描画タイマ（30fps）
        self.timer = QtCore.QTimer()
        self.timer.timeout.connect(self._refresh_plots)
        self.timer.start(33)

    # ---- キーボードショートカット ----
    def _install_shortcuts(self):
        from PyQt6.QtGui import QKeySequence, QShortcut

        sc = lambda key, fn: QShortcut(QKeySequence(key), self, activated=fn)
        sc("Up",    self._cmd_pitch_up)
        sc("Down",  self._cmd_pitch_dn)
        sc("Left",  self._cmd_roll_l)
        sc("Right", self._cmd_roll_r)
        sc("Space", self._cmd_center)
        # 数字キーでモード切替
        sc("M",     lambda: self._send_and_log("manual"))
        # A キーは AUTO/PID (= 3) を送る。`auto` 単体だと autoSub が SUB_P のままになる
        sc("A",     lambda: self._send_and_log("3"))
        sc("1",     lambda: self._send_and_log("1"))
        sc("2",     lambda: self._send_and_log("2"))
        sc("3",     lambda: self._send_and_log("3"))

    # ---- ステータス行 ----
    def _build_status_bar(self) -> QtWidgets.QWidget:
        wrap = QtWidgets.QFrame()
        wrap.setFrameShape(QtWidgets.QFrame.Shape.NoFrame)
        wrap.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Fixed,
        )
        row = QtWidgets.QHBoxLayout(wrap)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(8)

        self.lbl_link = QtWidgets.QLabel("LINK: ?")
        self.lbl_link.setStyleSheet("font-weight: bold; padding: 4px 8px;")
        self.lbl_rx = QtWidgets.QLabel("RX: 0  bad: 0")
        self.lbl_seq = QtWidgets.QLabel("seq: -")
        self.lbl_dt = QtWidgets.QLabel("dt: - ms")
        self.lbl_ws = QtWidgets.QLabel(f"WS: ws://{self.ws.host}:{self.ws.port}")

        # WS からのコマンド受信を許可するゲート（既定 OFF）
        self.chk_ws_cmd = QtWidgets.QCheckBox("Accept WS commands")
        self.chk_ws_cmd.setChecked(False)
        self.chk_ws_cmd.toggled.connect(
            lambda checked: setattr(self.ws, "allow_commands", checked)
        )

        for w in (self.lbl_link, self.lbl_rx, self.lbl_seq, self.lbl_dt, self.lbl_ws,
                  self.chk_ws_cmd):
            row.addWidget(w)
        row.addStretch(1)
        return wrap

    # ---- 大きい数値読み取り（瞬時把握用） ----
    def _build_big_readout(self) -> QtWidgets.QWidget:
        wrap = QtWidgets.QFrame()
        wrap.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Fixed,
        )
        wrap.setStyleSheet(
            "QFrame { background: #14171c; border-radius: 4px; }"
        )
        row = QtWidgets.QHBoxLayout(wrap)
        row.setContentsMargins(8, 6, 8, 6)
        row.setSpacing(14)

        def cell(name: str, color: str, unit: str = "°"):
            v = QtWidgets.QVBoxLayout()
            v.setSpacing(0)
            v.setContentsMargins(0, 0, 0, 0)
            lbl_name = QtWidgets.QLabel(name)
            lbl_name.setStyleSheet(f"color: {color}; font-size: 11px;")
            lbl_val = QtWidgets.QLabel("--")
            lbl_val.setStyleSheet(
                f"color: {color}; font-family: Consolas, monospace; "
                f"font-size: 22px; font-weight: bold;"
            )
            lbl_val.setMinimumWidth(110)
            v.addWidget(lbl_name)
            v.addWidget(lbl_val)
            wrap_inner = QtWidgets.QWidget()
            wrap_inner.setLayout(v)
            row.addWidget(wrap_inner)
            return lbl_val, unit

        self.big_roll,  _ = cell("ROLL",  "#ff6b6b")
        self.big_pitch, _ = cell("PITCH", "#51cf66")
        self.big_yaw,   _ = cell("YAW",   "#4dabf7")

        # 区切り
        sep = QtWidgets.QFrame()
        sep.setFrameShape(QtWidgets.QFrame.Shape.VLine)
        sep.setStyleSheet("color: #333;")
        row.addWidget(sep)

        self.big_s0, _ = cell("S0 (R Aileron)", "#ff922b")
        self.big_s1, _ = cell("S1 (L Aileron)", "#ffd43b")
        self.big_s2, _ = cell("S2 (Elevator)",  "#a9e34b")

        # MODE 表示
        sep2 = QtWidgets.QFrame()
        sep2.setFrameShape(QtWidgets.QFrame.Shape.VLine)
        sep2.setStyleSheet("color: #333;")
        row.addWidget(sep2)

        v = QtWidgets.QVBoxLayout()
        v.setSpacing(0)
        v.setContentsMargins(0, 0, 0, 0)
        lbl_name = QtWidgets.QLabel("MODE")
        lbl_name.setStyleSheet("color: #c0c8d4; font-size: 11px;")
        self.big_mode = QtWidgets.QLabel("?")
        self.big_mode.setStyleSheet(
            "color: #ffffff; font-family: Consolas, monospace; "
            "font-size: 22px; font-weight: bold;"
        )
        self.big_mode.setMinimumWidth(140)
        v.addWidget(lbl_name)
        v.addWidget(self.big_mode)
        wrap_inner = QtWidgets.QWidget()
        wrap_inner.setLayout(v)
        row.addWidget(wrap_inner)

        # PHASE 表示 (フライトフェーズマシン状態)
        sep3 = QtWidgets.QFrame()
        sep3.setFrameShape(QtWidgets.QFrame.Shape.VLine)
        sep3.setStyleSheet("color: #333;")
        row.addWidget(sep3)

        v = QtWidgets.QVBoxLayout()
        v.setSpacing(0)
        v.setContentsMargins(0, 0, 0, 0)
        lbl_name = QtWidgets.QLabel("PHASE")
        lbl_name.setStyleSheet("color: #c0c8d4; font-size: 11px;")
        self.big_phase = QtWidgets.QLabel("DISARMED")
        # 色はフェーズに応じて _refresh_plots で書き換える
        self.big_phase.setStyleSheet(
            "color: #888888; font-family: Consolas, monospace; "
            "font-size: 18px; font-weight: bold;"
        )
        self.big_phase.setMinimumWidth(140)
        v.addWidget(lbl_name)
        v.addWidget(self.big_phase)
        wrap_inner = QtWidgets.QWidget()
        wrap_inner.setLayout(v)
        row.addWidget(wrap_inner)

        # |a| 表示 (投擲しきい値の目安)
        sep4 = QtWidgets.QFrame()
        sep4.setFrameShape(QtWidgets.QFrame.Shape.VLine)
        sep4.setStyleSheet("color: #333;")
        row.addWidget(sep4)

        v = QtWidgets.QVBoxLayout()
        v.setSpacing(0)
        v.setContentsMargins(0, 0, 0, 0)
        lbl_name = QtWidgets.QLabel("|a|")
        lbl_name.setStyleSheet("color: #c0c8d4; font-size: 11px;")
        self.big_accel = QtWidgets.QLabel("--")
        self.big_accel.setStyleSheet(
            "color: #ffffff; font-family: Consolas, monospace; "
            "font-size: 18px; font-weight: bold;"
        )
        self.big_accel.setMinimumWidth(90)
        v.addWidget(lbl_name)
        v.addWidget(self.big_accel)
        wrap_inner = QtWidgets.QWidget()
        wrap_inner.setLayout(v)
        row.addWidget(wrap_inner)

        row.addStretch(1)
        return wrap

    # ---- プロット群 ----
    def _build_plots(self) -> QtWidgets.QWidget:
        pg.setConfigOptions(antialias=True, background="#1a1d22", foreground="#cfd5dc")
        plots = pg.GraphicsLayoutWidget()
        plots.setMinimumHeight(220)
        plots.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Expanding,
        )

        # 共通スタイル：タイトルを小さくして縦スペースを稼ぐ
        title_style = {"color": "#cfd5dc", "size": "10pt"}

        self.plot_attitude = plots.addPlot(row=0, col=0)
        self.plot_attitude.setTitle("Attitude (deg)", **title_style)
        self.plot_attitude.addLegend(offset=(8, 4), labelTextSize="9pt")
        self.plot_attitude.setYRange(-200, 200)
        self.plot_attitude.showGrid(x=True, y=True, alpha=0.18)
        self.curve_roll  = self.plot_attitude.plot(pen=pg.mkPen("#ff6b6b", width=2), name="roll")
        self.curve_pitch = self.plot_attitude.plot(pen=pg.mkPen("#51cf66", width=2), name="pitch")
        self.curve_yaw   = self.plot_attitude.plot(pen=pg.mkPen("#4dabf7", width=2), name="yaw")

        self.plot_servo = plots.addPlot(row=0, col=1)
        self.plot_servo.setTitle("Servo (deg)  s0=R / s1=L / s2=Elev", **title_style)
        self.plot_servo.addLegend(offset=(8, 4), labelTextSize="9pt")
        self.plot_servo.setYRange(0, 180)
        self.plot_servo.showGrid(x=True, y=True, alpha=0.18)
        self.curve_s0 = self.plot_servo.plot(pen=pg.mkPen("#ff922b", width=2), name="s0")
        self.curve_s1 = self.plot_servo.plot(pen=pg.mkPen("#ffd43b", width=2), name="s1")
        self.curve_s2 = self.plot_servo.plot(pen=pg.mkPen("#a9e34b", width=2), name="s2")

        self.plot_accel = plots.addPlot(row=1, col=0)
        self.plot_accel.setTitle("Accel (g)", **title_style)
        self.plot_accel.addLegend(offset=(8, 4), labelTextSize="9pt")
        self.plot_accel.setYRange(-2, 2)
        self.plot_accel.showGrid(x=True, y=True, alpha=0.18)
        self.curve_ax = self.plot_accel.plot(pen=pg.mkPen("#ff6b6b", width=1.5), name="ax")
        self.curve_ay = self.plot_accel.plot(pen=pg.mkPen("#51cf66", width=1.5), name="ay")
        self.curve_az = self.plot_accel.plot(pen=pg.mkPen("#4dabf7", width=1.5), name="az")

        self.plot_gyro = plots.addPlot(row=1, col=1)
        self.plot_gyro.setTitle("Gyro (deg/s)", **title_style)
        self.plot_gyro.addLegend(offset=(8, 4), labelTextSize="9pt")
        self.plot_gyro.showGrid(x=True, y=True, alpha=0.18)
        self.curve_gx = self.plot_gyro.plot(pen=pg.mkPen("#ff6b6b", width=1.5), name="gx")
        self.curve_gy = self.plot_gyro.plot(pen=pg.mkPen("#51cf66", width=1.5), name="gy")
        self.curve_gz = self.plot_gyro.plot(pen=pg.mkPen("#4dabf7", width=1.5), name="gz")

        # 4 ペインの最小高さを確保してタイトル切れを防ぐ
        for p in (self.plot_attitude, self.plot_servo, self.plot_accel, self.plot_gyro):
            p.setMinimumHeight(110)

        return plots

    # ---- 操作パネル（QScrollArea でラップ） ----
    def _build_controls_scroll(self) -> QtWidgets.QWidget:
        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QtWidgets.QFrame.Shape.NoFrame)
        scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(QtCore.Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setMinimumHeight(120)
        scroll.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Expanding,
        )

        # 複数 GroupBox を縦に並べるコンテナ
        container = QtWidgets.QWidget()
        v = QtWidgets.QVBoxLayout(container)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(8)

        # 上：Quick Manual Control（プロミネント）
        v.addWidget(self._build_quick_manual_control())
        # 下：詳細 Control（PID ゲイン、trim、raw コマンド）
        v.addWidget(self._build_controls())
        v.addStretch(1)

        scroll.setWidget(container)
        return scroll

    # ---- Quick Manual Control （ボタンで直感操作） ----
    def _build_quick_manual_control(self) -> QtWidgets.QWidget:
        box = QtWidgets.QGroupBox("Quick Manual Control")
        box.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Preferred,
        )
        outer = QtWidgets.QVBoxLayout(box)
        outer.setContentsMargins(8, 12, 8, 8)
        outer.setSpacing(6)

        # 状態表示行
        self.lbl_quick_status = QtWidgets.QLabel("MODE: ?    Aileron R: 0°   L: 0°   Elevator: 0°")
        self.lbl_quick_status.setStyleSheet(
            "font-family: Consolas, monospace; font-size: 12px; "
            "padding: 6px 8px; background: #14171c; color: #c0c8d4; border-radius: 4px;"
        )
        outer.addWidget(self.lbl_quick_status)

        # ヒント
        hint = QtWidgets.QLabel(
            "MANUAL: ボタンが直接サーボを動かす  /  AUTO: PID 出力に対するトリム"
            "    キーボード: ↑↓←→ で操舵, Space で中央, M/A でモード切替"
        )
        hint.setStyleSheet("color: #7a8088; font-size: 11px;")
        hint.setWordWrap(True)
        outer.addWidget(hint)

        # ステップサイズ選択
        step_row = QtWidgets.QHBoxLayout()
        step_row.addWidget(QtWidgets.QLabel("Step:"))
        self.step_btn_group = QtWidgets.QButtonGroup(self)
        for v in [5, 10, 20]:
            rb = QtWidgets.QRadioButton(f"{v}°")
            rb.setChecked(v == self.step_size)
            rb.toggled.connect(lambda checked, vv=v: checked and setattr(self, "step_size", vv))
            self.step_btn_group.addButton(rb)
            step_row.addWidget(rb)
        step_row.addStretch(1)
        outer.addLayout(step_row)

        # D-pad ボタン
        grid = QtWidgets.QGridLayout()
        grid.setHorizontalSpacing(6)
        grid.setVerticalSpacing(6)

        def make_btn(text: str, slot, color: str = "#2c3036") -> QtWidgets.QPushButton:
            b = QtWidgets.QPushButton(text)
            b.setMinimumHeight(38)
            b.setMinimumWidth(88)
            b.setStyleSheet(
                f"QPushButton {{ font-size: 12px; font-weight: bold; "
                f"background: {color}; color: #f0f0f0; border-radius: 4px; "
                f"padding: 2px 6px; }} "
                f"QPushButton:hover {{ background: #3d434c; }} "
                f"QPushButton:pressed {{ background: #1a1d22; }}"
            )
            b.clicked.connect(slot)
            return b

        btn_pitch_up = make_btn("↑ Pitch Up",   self._cmd_pitch_up)
        btn_pitch_dn = make_btn("↓ Pitch Dn",   self._cmd_pitch_dn)
        btn_roll_l   = make_btn("← Roll L",     self._cmd_roll_l)
        btn_roll_r   = make_btn("Roll R →",     self._cmd_roll_r)
        btn_center   = make_btn("⊙ Center",     self._cmd_center, color="#2b6e3a")

        # D-pad layout (3x3, 中央 col=1 を使う)
        grid.addWidget(btn_pitch_up, 0, 1)
        grid.addWidget(btn_roll_l,   1, 0)
        grid.addWidget(btn_center,   1, 1)
        grid.addWidget(btn_roll_r,   1, 2)
        grid.addWidget(btn_pitch_dn, 2, 1)
        # 右側に余白を入れて左寄せ
        grid.setColumnStretch(0, 0)
        grid.setColumnStretch(1, 0)
        grid.setColumnStretch(2, 0)
        grid.setColumnStretch(3, 1)

        outer.addLayout(grid)
        return box

    def _build_controls(self) -> QtWidgets.QWidget:
        ctl = QtWidgets.QGroupBox("Control")
        ctl.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Preferred,
        )
        ctl_layout = QtWidgets.QGridLayout(ctl)
        ctl_layout.setContentsMargins(8, 12, 8, 8)
        ctl_layout.setHorizontalSpacing(6)
        ctl_layout.setVerticalSpacing(4)

        # 列幅を一律にして、リサイズ時のがたつきを軽減
        for col in range(7):
            ctl_layout.setColumnStretch(col, 1)
        # ラベル列は伸縮させない
        ctl_layout.setColumnStretch(0, 0)

        # ---- モードボタン ----
        # 注意: AUTO ボタンは `3` (= MODE_AUTO + SUB_PID) を送信する。
        # firmware の `auto` 単体だと autoSub が前回値 (boot 時は SUB_P) のままで、
        # ユーザが「PID で動かしているつもり」が P 制御のままになる事故を防止。
        row = 0
        ctl_layout.addWidget(QtWidgets.QLabel("Mode:"), row, 0)
        for col, (label, cmd) in enumerate([
            ("MANUAL", "manual"), ("AUTO/PID", "3"),
            ("P", "1"), ("PD", "2"), ("PID", "3"),
        ]):
            btn = QtWidgets.QPushButton(label)
            btn.setMinimumWidth(60)
            btn.clicked.connect(lambda _, c=cmd: self.serial_io.send_command(c))
            ctl_layout.addWidget(btn, row, col + 1)

        # ---- 投擲検知 (Launch / autonomous glide) ----
        #   Arm: MANUAL ホールド + 投擲待機。|a|>launch_g 連続検出 → AUTO/PID 自動遷移。
        #   armed 中は failsafe 抑制（地上局接続不要で飛行可能）。
        row += 1
        ctl_layout.addWidget(QtWidgets.QLabel("Launch:"), row, 0)
        btn_arm = QtWidgets.QPushButton("🚀 Arm")
        btn_arm.setMinimumWidth(60)
        btn_arm.setToolTip("投擲待機モード開始（機体は MANUAL のまま待機）")
        btn_arm.clicked.connect(lambda: self.serial_io.send_command("arm"))
        ctl_layout.addWidget(btn_arm, row, 1)

        btn_land = QtWidgets.QPushButton("🛬 Land")
        btn_land.setMinimumWidth(60)
        btn_land.setToolTip("強制 LANDED 遷移（GLIDE で詰まった時 / 安全停止）")
        btn_land.clicked.connect(lambda: self.serial_io.send_command("land"))
        ctl_layout.addWidget(btn_land, row, 2)

        btn_disarm = QtWidgets.QPushButton("Disarm")
        btn_disarm.setMinimumWidth(60)
        btn_disarm.setToolTip("武装解除（地上テスト用 / LANDED からの復帰）")
        btn_disarm.clicked.connect(lambda: self.serial_io.send_command("disarm"))
        ctl_layout.addWidget(btn_disarm, row, 3)

        # 風洞試験モード: PHASE_WINDTUNNEL へ遷移。PID 常時 ON、safeguards 抑制。
        btn_wt = QtWidgets.QPushButton("🌬 Wind Tunnel")
        btn_wt.setMinimumWidth(110)
        btn_wt.setToolTip(
            "風洞試験モード（PID 常時 ON、tilt safeguard / failsafe 抑制）。"
            "target_pitch/roll を手動操作して応答測定する用。"
        )
        btn_wt.setStyleSheet(
            "QPushButton { background: #5b21b6; color: #f0f0f0; "
            "border-radius: 4px; font-weight: bold; padding: 4px 8px; } "
            "QPushButton:hover { background: #7c3aed; }"
        )
        btn_wt.clicked.connect(lambda: self.serial_io.send_command("wt"))
        ctl_layout.addWidget(btn_wt, row, 4)

        ctl_layout.addWidget(QtWidgets.QLabel("launch_g:"), row, 5)
        self.spin_launch_g = QtWidgets.QDoubleSpinBox()
        self.spin_launch_g.setRange(1.0, 8.0)
        self.spin_launch_g.setSingleStep(0.1)
        self.spin_launch_g.setDecimals(1)
        self.spin_launch_g.setValue(2.5)
        self.spin_launch_g.setSuffix(" g")
        self.spin_launch_g.setMinimumWidth(70)
        self.spin_launch_g.setToolTip("投擲判定の加速度しきい値 (既定 2.5g)")
        self.spin_launch_g.editingFinished.connect(
            lambda: self.serial_io.send_command(f"launch_g {self.spin_launch_g.value():.2f}")
        )
        ctl_layout.addWidget(self.spin_launch_g, row, 6)

        # ---- PID ゲイン ヘッダー ----
        row += 1
        ctl_layout.addWidget(QtWidgets.QLabel("PID gains:"), row, 0)
        ctl_layout.addWidget(QtWidgets.QLabel("Kp"), row, 1)
        ctl_layout.addWidget(QtWidgets.QLabel("Ki"), row, 2)
        ctl_layout.addWidget(QtWidgets.QLabel("Kd"), row, 3)
        ctl_layout.addWidget(QtWidgets.QLabel("Target"), row, 4)

        for axis_name in ["roll(r)", "pitch(p)", "yaw(y)"]:
            row += 1
            ctl_layout.addWidget(QtWidgets.QLabel(axis_name), row, 0)
            for col_idx, (gain, default, step, lo, hi) in enumerate([
                ("kp", 1.0, 0.1, 0, 10),
                ("ki", 0.2, 0.05, 0, 5),
                ("kd", 0.02, 0.01, 0, 2),
                ("target", 0.0, 1.0, -90, 90),
            ]):
                spin = QtWidgets.QDoubleSpinBox()
                spin.setRange(lo, hi)
                spin.setSingleStep(step)
                spin.setDecimals(3)
                spin.setValue(default)
                spin.setMinimumWidth(70)
                axis_letter = axis_name[0]  # r/p/y
                spin.editingFinished.connect(
                    lambda g=gain, a=axis_letter, sp=spin:
                    self.serial_io.send_command(f"{g} {a} {sp.value()}")
                )
                ctl_layout.addWidget(spin, row, col_idx + 1)

        # ---- サーボ trim ----
        row += 1
        ctl_layout.addWidget(QtWidgets.QLabel("Servo trim:"), row, 0)
        servo_labels = ["s0 (R aileron)", "s1 (L aileron)", "s2 (Elevator)"]
        self.s_spins: list[QtWidgets.QDoubleSpinBox] = []
        for i in range(3):
            spin = QtWidgets.QDoubleSpinBox()
            spin.setRange(-90, 90)
            spin.setSingleStep(1)
            spin.setDecimals(0)
            spin.setValue(0)
            spin.setSuffix(" deg")
            spin.setMinimumWidth(80)
            spin.editingFinished.connect(
                lambda idx=i, sp=spin:
                self.serial_io.send_command(f"s{idx} {int(sp.value())}")
            )
            lbl = QtWidgets.QLabel(servo_labels[i])
            lbl.setMinimumWidth(60)
            ctl_layout.addWidget(lbl, row, 1 + i * 2)
            ctl_layout.addWidget(spin, row, 2 + i * 2)
            self.s_spins.append(spin)

        # ---- 直接コマンド ----
        row += 1
        ctl_layout.addWidget(QtWidgets.QLabel("Raw cmd:"), row, 0)
        self.txt_raw = QtWidgets.QLineEdit()
        self.txt_raw.setPlaceholderText("kp p 1.5  /  status  /  help ...")
        self.txt_raw.returnPressed.connect(self._on_raw_send)
        ctl_layout.addWidget(self.txt_raw, row, 1, 1, 4)
        btn_send = QtWidgets.QPushButton("Send")
        btn_send.clicked.connect(self._on_raw_send)
        ctl_layout.addWidget(btn_send, row, 5)

        return ctl

    # ---- ログ領域 ----
    def _build_log(self) -> QtWidgets.QWidget:
        self.log = QtWidgets.QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(1000)
        self.log.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Expanding,
        )
        self.log.setMinimumHeight(80)
        self.log.setStyleSheet(
            "QPlainTextEdit { font-family: Consolas, 'Courier New', monospace; "
            "font-size: 11px; background: #14171c; color: #c0c8d4; }"
        )
        return self.log

    def _on_raw_send(self):
        cmd = self.txt_raw.text().strip()
        if cmd:
            self._send_and_log(cmd)
            self.txt_raw.clear()

    # =========================================================
    # Quick Manual Control コマンドハンドラ
    # =========================================================
    def _send_and_log(self, cmd: str):
        """コマンド送信 + ログ表示"""
        self.serial_io.send_command(cmd)
        self.log.appendPlainText(f"> {cmd}")

    def _set_servo_trim(self, idx: int, value: float):
        """サーボ trim 値を更新（spin box にも反映 + コマンド送信）"""
        v = max(-90.0, min(90.0, value))
        spin = self.s_spins[idx]
        # 既存ハンドラを誤発火させないよう block しつつ表示更新
        spin.blockSignals(True)
        spin.setValue(v)
        spin.blockSignals(False)
        self._send_and_log(f"s{idx} {int(v)}")

    def _cmd_pitch_up(self):
        cur = self.s_spins[2].value()
        self._set_servo_trim(2, cur + self.step_size)
        self._refresh_quick_status()

    def _cmd_pitch_dn(self):
        cur = self.s_spins[2].value()
        self._set_servo_trim(2, cur - self.step_size)
        self._refresh_quick_status()

    def _cmd_roll_l(self):
        # 左ロール: 右エルロン下げ (-) / 左エルロン上げ (+)
        d = self.step_size
        self._set_servo_trim(0, self.s_spins[0].value() - d)
        self._set_servo_trim(1, self.s_spins[1].value() + d)
        self._refresh_quick_status()

    def _cmd_roll_r(self):
        # 右ロール: 右エルロン上げ (+) / 左エルロン下げ (-)
        d = self.step_size
        self._set_servo_trim(0, self.s_spins[0].value() + d)
        self._set_servo_trim(1, self.s_spins[1].value() - d)
        self._refresh_quick_status()

    def _cmd_center(self):
        for i in range(3):
            self._set_servo_trim(i, 0.0)
        self._refresh_quick_status()

    def _refresh_quick_status(self):
        """Quick Manual Control のステータス表示を更新"""
        if not hasattr(self, "lbl_quick_status"):
            return
        s0 = int(self.s_spins[0].value())
        s1 = int(self.s_spins[1].value())
        s2 = int(self.s_spins[2].value())
        self.lbl_quick_status.setText(
            f"MODE: {self.current_mode_text}    "
            f"Aileron R: {s0:+d}°   L: {s1:+d}°   Elevator: {s2:+d}°"
        )

    # ---------- データ更新 ----------
    @QtCore.pyqtSlot(dict)
    def on_telemetry(self, rec: dict):
        self.history["wall_t"].append(time.time())
        for k in TELEMETRY_FIELDS:
            self.history[k].append(rec[k])

        self.lbl_rx.setText(f"RX: {rec['_rx_count']}  bad: {rec['_bad_count']}")
        self.lbl_seq.setText(f"seq: {rec['seq']}")
        self.lbl_dt.setText(f"dt: {rec['dt_ms']} ms")

        # 大きい数値読み取り更新
        if hasattr(self, "big_roll"):
            self.big_roll.setText(f"{rec['roll']:+7.1f}°")
            self.big_pitch.setText(f"{rec['pitch']:+7.1f}°")
            self.big_yaw.setText(f"{rec['yaw']:+7.1f}°")
            self.big_s0.setText(f"{rec['s0']:>3d}°")
            self.big_s1.setText(f"{rec['s1']:>3d}°")
            self.big_s2.setText(f"{rec['s2']:>3d}°")

        # フェーズ表示 (firmware 17 列対応分)
        if hasattr(self, "big_phase"):
            ph_idx = int(rec.get("phase", 0))
            ph_name = PHASE_NAMES[ph_idx] if 0 <= ph_idx < len(PHASE_NAMES) else f"?{ph_idx}"
            # フェーズに応じた色
            ph_color = {
                0: "#888888",  # DISARMED   gray
                1: "#f59f00",  # PRELAUNCH  amber
                2: "#fa5252",  # LAUNCH     red (alert)
                3: "#37b24d",  # GLIDE      green
                4: "#5c7cfa",  # LANDED     blue
                5: "#a855f7",  # WINDTUNNEL purple
            }.get(ph_idx, "#ffffff")
            self.big_phase.setText(ph_name)
            self.big_phase.setStyleSheet(
                f"color: {ph_color}; font-family: Consolas, monospace; "
                "font-size: 18px; font-weight: bold;"
            )
        if hasattr(self, "big_accel"):
            ag = float(rec.get("accel_g", 0.0))
            self.big_accel.setText(f"{ag:>4.2f}g")
            # 投擲しきい値接近で警告色
            try:
                thr = float(self.spin_launch_g.value())
            except Exception:
                thr = 2.5
            if ag >= thr:
                self.big_accel.setStyleSheet(
                    "color: #fa5252; font-family: Consolas, monospace; "
                    "font-size: 18px; font-weight: bold;")
            elif ag > thr * 0.7:
                self.big_accel.setStyleSheet(
                    "color: #f59f00; font-family: Consolas, monospace; "
                    "font-size: 18px; font-weight: bold;")
            else:
                self.big_accel.setStyleSheet(
                    "color: #ffffff; font-family: Consolas, monospace; "
                    "font-size: 18px; font-weight: bold;")

        # 3D ペイン更新
        if hasattr(self, "pane3d"):
            self.pane3d.update_attitude(rec["roll"], rec["pitch"], rec["yaw"])

        # WebSocket 配信
        out = {k: rec[k] for k in TELEMETRY_FIELDS}
        out["wall_ms"] = int(time.time() * 1000)
        self.ws.broadcast(out)

    @QtCore.pyqtSlot(str)
    def on_info(self, line: str):
        self.log.appendPlainText(line)
        # [MODE] xxx を解析して Quick Manual Control / 大読みパネルを更新
        if line.startswith("[MODE]"):
            tokens = line.split(maxsplit=1)
            if len(tokens) >= 2:
                self.current_mode_text = tokens[1].strip()
                self._refresh_quick_status()
                if hasattr(self, "big_mode"):
                    self.big_mode.setText(self.current_mode_text)

    @QtCore.pyqtSlot(bool)
    def on_link_status(self, online: bool):
        if online:
            self.lbl_link.setText("LINK: ONLINE")
            self.lbl_link.setStyleSheet(
                "font-weight: bold; padding: 4px 8px; "
                "background: #2b8a3e; color: white;")
        else:
            self.lbl_link.setText("LINK: STALE")
            self.lbl_link.setStyleSheet(
                "font-weight: bold; padding: 4px 8px; "
                "background: #c92a2a; color: white;")

    def _refresh_plots(self):
        if not self.history["seq"]:
            return
        # X 軸はサンプル番号（簡易）
        x = list(range(len(self.history["seq"])))

        self.curve_roll.setData(x, list(self.history["roll"]))
        self.curve_pitch.setData(x, list(self.history["pitch"]))
        self.curve_yaw.setData(x, list(self.history["yaw"]))

        self.curve_s0.setData(x, list(self.history["s0"]))
        self.curve_s1.setData(x, list(self.history["s1"]))
        self.curve_s2.setData(x, list(self.history["s2"]))

        self.curve_ax.setData(x, list(self.history["ax"]))
        self.curve_ay.setData(x, list(self.history["ay"]))
        self.curve_az.setData(x, list(self.history["az"]))

        self.curve_gx.setData(x, list(self.history["gx"]))
        self.curve_gy.setData(x, list(self.history["gy"]))
        self.curve_gz.setData(x, list(self.history["gz"]))

    def closeEvent(self, ev):
        self.serial_io.stop()
        super().closeEvent(ev)


def main():
    parser = argparse.ArgumentParser(description="Glider Ground Station")
    parser.add_argument("--port", required=True, help="シリアルポート (例: COM12)")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--ws-port", type=int, default=8765, help="WebSocket ポート")
    parser.add_argument("--ws-host", default="127.0.0.1",
                        help="WebSocket バインド先 (LAN 公開時のみ 0.0.0.0)")
    parser.add_argument("--ws-token", default=None,
                        help="WS コマンド送信時に必須となるトークン（既定: 認証なし）")
    # CSV 自動保存 (P2-2 改善方針)
    default_log_dir = (Path(__file__).resolve().parent.parent / "logs").resolve()
    parser.add_argument("--log-dir", default=str(default_log_dir),
                        help=f"CSV 自動保存先ディレクトリ (既定: {default_log_dir})")
    parser.add_argument("--no-log", action="store_true",
                        help="CSV 自動保存を無効化 (ディスクに何も書かない)")
    args = parser.parse_args()

    log_dir = None if args.no_log else Path(args.log_dir)
    if log_dir is not None:
        print(f"[LOG] auto-save -> {log_dir}")

    app = QtWidgets.QApplication(sys.argv)
    win = MainWindow(
        port=args.port,
        ws_port=args.ws_port,
        ws_host=args.ws_host,
        ws_token=args.ws_token,
        log_dir=log_dir,
    )
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
