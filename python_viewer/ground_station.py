# -*- coding: utf-8 -*-
"""
ground_station.py
自律滑空機 地上局メインアプリ

役割:
  - 地上側 ESP32-C3 #1 の USB シリアルを所有
  - PyQt6 + pyqtgraph で操作 UI（ボタン・スライダ）と高速グラフを表示
  - WebSocket サーバとしてテレメトリを JSON ブロードキャスト
    -> Next.js 等の表示専用クライアントが接続可能

使い方:
  python ground_station.py --port COM12 [--ws-port 8765]

依存:
  pip install PyQt6 pyqtgraph pyserial websockets
"""

import argparse
import asyncio
import json
import sys
import threading
import time
from collections import deque

import pyqtgraph as pg
from PyQt6 import QtCore, QtGui, QtWidgets
from serial import Serial, SerialException

import websockets

# ------------------------------------------------------------------
# シリアル受信 & 送信スレッド
# ------------------------------------------------------------------
TELEMETRY_FIELDS = [
    "seq", "t_ms", "dt_ms",
    "ax", "ay", "az",
    "gx", "gy", "gz",
    "roll", "pitch", "yaw",
    "s0", "s1", "s2",
]


class SerialIO(QtCore.QObject):
    """非同期シリアル I/O。受信は Qt シグナルで UI に通知する。"""

    new_telemetry = QtCore.pyqtSignal(dict)
    new_info = QtCore.pyqtSignal(str)
    link_status = QtCore.pyqtSignal(bool)

    def __init__(self, port: str, baud: int = 115200):
        super().__init__()
        self.port = port
        self.baud = baud
        self._ser = None
        self._stop = threading.Event()
        self._tx_lock = threading.Lock()
        self._rx_count = 0
        self._bad_count = 0

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
                if len(parts) != len(TELEMETRY_FIELDS):
                    self._bad_count += 1
                    continue
                try:
                    rec = {
                        name: (int(v) if name in ("seq", "t_ms", "dt_ms", "s0", "s1", "s2")
                               else float(v))
                        for name, v in zip(TELEMETRY_FIELDS, parts)
                    }
                except ValueError:
                    self._bad_count += 1
                    continue
                self._rx_count += 1
                rec["_rx_count"] = self._rx_count
                rec["_bad_count"] = self._bad_count
                last_rx = time.time()
                self.link_status.emit(True)
                self.new_telemetry.emit(rec)
            except SerialException:
                time.sleep(0.1)
            except Exception:
                time.sleep(0.05)


# ------------------------------------------------------------------
# WebSocket ブロードキャスタ
# ------------------------------------------------------------------
class WebSocketBroadcaster:
    """別スレッドで asyncio loop を回し、テレメトリ JSON を全クライアントへ送信。"""

    def __init__(self, host: str = "0.0.0.0", port: int = 8765):
        self.host = host
        self.port = port
        self._clients: set = set()
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
            print(f"[WS] listening on ws://{self.host}:{self.port}")
            await asyncio.Future()  # keep running

    async def _handle(self, websocket):
        with self._lock:
            self._clients.add(websocket)
        try:
            async for _ in websocket:
                pass  # 受信は無視（表示専用クライアントを想定）
        except Exception:
            pass
        finally:
            with self._lock:
                self._clients.discard(websocket)

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
# メインウィンドウ
# ------------------------------------------------------------------
HISTORY = 300


class MainWindow(QtWidgets.QMainWindow):
    def __init__(self, port: str, ws_port: int):
        super().__init__()
        self.setWindowTitle("Glider Ground Station")
        self.resize(1280, 800)
        self.setMinimumSize(720, 480)  # 全画面・縮小いずれも崩れない最小サイズ

        # データバッファ
        self.history = {f: deque(maxlen=HISTORY) for f in TELEMETRY_FIELDS}
        self.history["wall_t"] = deque(maxlen=HISTORY)

        # WebSocket
        self.ws = WebSocketBroadcaster(port=ws_port)
        self.ws.start()

        # シリアル
        self.serial_io = SerialIO(port)
        self.serial_io.new_telemetry.connect(self.on_telemetry)
        self.serial_io.new_info.connect(self.on_info)
        self.serial_io.link_status.connect(self.on_link_status)

        # UI 構築
        self._build_ui()

        # 起動
        if not self.serial_io.start():
            QtWidgets.QMessageBox.critical(self, "Error", f"Cannot open {port}")
            sys.exit(1)

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

        # 縦 Splitter で プロット / 操作 / ログ を可変分割
        splitter = QtWidgets.QSplitter(QtCore.Qt.Orientation.Vertical)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(6)

        splitter.addWidget(self._build_plots())
        splitter.addWidget(self._build_controls_scroll())
        splitter.addWidget(self._build_log())

        # 初期サイズ比 (plots : controls : log = 5 : 3 : 2)
        splitter.setStretchFactor(0, 5)
        splitter.setStretchFactor(1, 3)
        splitter.setStretchFactor(2, 2)
        splitter.setSizes([520, 240, 120])

        outer.addWidget(splitter, 1)
        self.setCentralWidget(central)

        # 描画タイマ（30fps）
        self.timer = QtCore.QTimer()
        self.timer.timeout.connect(self._refresh_plots)
        self.timer.start(33)

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
        self.lbl_ws = QtWidgets.QLabel(f"WS: ws://localhost:{self.ws.port}")

        for w in (self.lbl_link, self.lbl_rx, self.lbl_seq, self.lbl_dt, self.lbl_ws):
            row.addWidget(w)
        row.addStretch(1)
        return wrap

    # ---- プロット群 ----
    def _build_plots(self) -> QtWidgets.QWidget:
        pg.setConfigOptions(antialias=True, background="#1a1d22", foreground="#e0e6ed")
        plots = pg.GraphicsLayoutWidget()
        plots.setMinimumHeight(280)
        plots.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Expanding,
        )

        self.plot_attitude = plots.addPlot(title="Attitude (deg)", row=0, col=0)
        self.plot_attitude.addLegend()
        self.plot_attitude.setYRange(-180, 180)
        self.curve_roll  = self.plot_attitude.plot(pen=pg.mkPen("#ff6b6b", width=2), name="roll")
        self.curve_pitch = self.plot_attitude.plot(pen=pg.mkPen("#51cf66", width=2), name="pitch")
        self.curve_yaw   = self.plot_attitude.plot(pen=pg.mkPen("#4dabf7", width=2), name="yaw")

        self.plot_servo = plots.addPlot(
            title="Servo (deg, 0-180)  D0=R Aileron / D1=L Aileron / D2=Elevator",
            row=0, col=1,
        )
        self.plot_servo.addLegend()
        self.plot_servo.setYRange(0, 180)
        self.curve_s0 = self.plot_servo.plot(pen=pg.mkPen("#ff922b", width=2), name="s0 (R aileron)")
        self.curve_s1 = self.plot_servo.plot(pen=pg.mkPen("#ffd43b", width=2), name="s1 (L aileron)")
        self.curve_s2 = self.plot_servo.plot(pen=pg.mkPen("#a9e34b", width=2), name="s2 (Elevator)")

        self.plot_accel = plots.addPlot(title="Accel (g)", row=1, col=0)
        self.plot_accel.addLegend()
        self.plot_accel.setYRange(-2, 2)
        self.curve_ax = self.plot_accel.plot(pen=pg.mkPen("#ff6b6b", width=1.5), name="ax")
        self.curve_ay = self.plot_accel.plot(pen=pg.mkPen("#51cf66", width=1.5), name="ay")
        self.curve_az = self.plot_accel.plot(pen=pg.mkPen("#4dabf7", width=1.5), name="az")

        self.plot_gyro = plots.addPlot(title="Gyro (deg/s)", row=1, col=1)
        self.plot_gyro.addLegend()
        self.curve_gx = self.plot_gyro.plot(pen=pg.mkPen("#ff6b6b", width=1.5), name="gx")
        self.curve_gy = self.plot_gyro.plot(pen=pg.mkPen("#51cf66", width=1.5), name="gy")
        self.curve_gz = self.plot_gyro.plot(pen=pg.mkPen("#4dabf7", width=1.5), name="gz")

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
        scroll.setWidget(self._build_controls())
        return scroll

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
        row = 0
        ctl_layout.addWidget(QtWidgets.QLabel("Mode:"), row, 0)
        for col, (label, cmd) in enumerate([
            ("MANUAL", "manual"), ("AUTO", "auto"),
            ("P", "1"), ("PD", "2"), ("PID", "3"),
        ]):
            btn = QtWidgets.QPushButton(label)
            btn.setMinimumWidth(60)
            btn.clicked.connect(lambda _, c=cmd: self.serial_io.send_command(c))
            ctl_layout.addWidget(btn, row, col + 1)

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
            self.serial_io.send_command(cmd)
            self.log.appendPlainText(f"> {cmd}")
            self.txt_raw.clear()

    # ---------- データ更新 ----------
    @QtCore.pyqtSlot(dict)
    def on_telemetry(self, rec: dict):
        self.history["wall_t"].append(time.time())
        for k in TELEMETRY_FIELDS:
            self.history[k].append(rec[k])

        self.lbl_rx.setText(f"RX: {rec['_rx_count']}  bad: {rec['_bad_count']}")
        self.lbl_seq.setText(f"seq: {rec['seq']}")
        self.lbl_dt.setText(f"dt: {rec['dt_ms']} ms")

        # WebSocket 配信
        out = {k: rec[k] for k in TELEMETRY_FIELDS}
        out["wall_ms"] = int(time.time() * 1000)
        self.ws.broadcast(out)

    @QtCore.pyqtSlot(str)
    def on_info(self, line: str):
        self.log.appendPlainText(line)

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
    args = parser.parse_args()

    app = QtWidgets.QApplication(sys.argv)
    win = MainWindow(port=args.port, ws_port=args.ws_port)
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
