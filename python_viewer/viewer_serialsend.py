#!/usr/bin/env python3
"""
viewer_serialsend.py - line passthrough viewer for imu_control telemetry
"""
from __future__ import annotations

import argparse
import csv
import threading
import time
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path
from queue import Empty, Queue

try:
    import serial
except Exception:
    raise

import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation

TELEMETRY_FIELDS = [
    "seq", "t_ms", "dt_ms", "ax", "ay", "az", "gx", "gy", "gz",
    "roll", "pitch", "yaw", "s0", "s1", "s2",
]
PLOT_CANDIDATES = ["roll", "pitch", "yaw", "s0", "s1", "s2", "ax", "ay", "az"]
SENSOR_FIELDS = {"ax", "ay", "az", "gx", "gy", "gz"}

class DataPoint:
    def __init__(self, values: dict[str, float]):
        self.values = values
        self.src_seq = int(values["seq"])
        self.t_ms = float(values["t_ms"])

class SerialReader(threading.Thread):
    def __init__(self, port: str, baud: int, out_queue: Queue, save_csv: str | None = None, reconnect: bool = True):
        super().__init__(daemon=True)
        self.port = port
        self.baud = baud
        self.out_queue = out_queue
        self.reconnect = reconnect
        self._stop = threading.Event()
        self._ser = None
        self._csv_file = None
        self._csv_writer = None

        if save_csv:
            p = Path(save_csv)
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            final_path = p.with_name(f"{p.stem}_{timestamp}{p.suffix}")
            final_path.parent.mkdir(parents=True, exist_ok=True)
            self._csv_file = open(str(final_path), "w", newline="", encoding="utf-8")
            self._csv_writer = csv.writer(self._csv_file)
            self._csv_writer.writerow(TELEMETRY_FIELDS)
            print(f"[LOG] Saving CSV to: {final_path}")

    def stop(self):
        self._stop.set()
        if self._ser:
            self._ser.close()
        if self._csv_file:
            self._csv_file.close()

    def write_line(self, text: str):
        if not self._ser or not self._ser.is_open:
            return
        payload = (text.rstrip("\r\n") + "\n").encode("utf-8")
        try:
            self._ser.write(payload)
            print(f"[CMD] Sent: {text}")
        except Exception as e:
            print(f"[ERR] Write failed: {e}")

    def run(self):
        while not self._stop.is_set():
            try:
                if self._ser is None or not self._ser.is_open:
                    self._ser = serial.Serial(self.port, self.baud, timeout=1)
                    print(f"[LOG] Connected to {self.port}")

                if self._ser.in_waiting <= 0:
                    time.sleep(0.01)
                    continue

                line = self._ser.readline().decode("utf-8", errors="ignore").strip()
                if not line:
                    continue

                dp = self._parse_telemetry(line)
                if dp is not None:
                    self._log_csv(dp)
                    self.out_queue.put(("DAT", dp))
                else:
                    self.out_queue.put(("LOG", line))

            except Exception as e:
                print(f"[ERR] Serial: {e}")
                if self._ser:
                    self._ser.close()
                    self._ser = None
                if not self.reconnect:
                    break
                time.sleep(2)

    def _parse_telemetry(self, line: str) -> DataPoint | None:
        parts = line.split(",")
        if len(parts) != len(TELEMETRY_FIELDS):
            return None
        try:
            values = {name: float(raw) for name, raw in zip(TELEMETRY_FIELDS, parts)}
        except ValueError:
            return None
        return DataPoint(values)

    def _log_csv(self, dp: DataPoint):
        if self._csv_writer:
            self._csv_writer.writerow([dp.values[name] for name in TELEMETRY_FIELDS])


def run_viewer(args):
    q: Queue = Queue()
    reader = SerialReader(args.port, args.baud, q, args.save)
    reader.start()

    plt.style.use("dark_background")
    fig, ax1 = plt.subplots(figsize=(12, 7))
    plt.subplots_adjust(bottom=0.25)
    ax2 = ax1.twinx()

    ax1.set_title(f"Line Telemetry Viewer: {args.port}")
    ax1.grid(True, linestyle="--", alpha=0.3)
    ax1.set_ylabel("Angle / Servo")
    ax2.set_ylabel("Sensor")

    max_pts = args.max_points
    times = deque(maxlen=max_pts)
    series = defaultdict(lambda: deque(maxlen=max_pts))
    plot_lines = {}
    target_fields = [x.strip() for x in args.plot.split(",")] if args.plot else PLOT_CANDIDATES
    t0 = None

    status_text = ax1.text(
        0.02, 0.95, "WAITING...", transform=ax1.transAxes,
        fontsize=14, color="yellow",
        bbox=dict(facecolor="black", alpha=0.7, edgecolor="gray")
    )
    info_text = plt.figtext(
        0.02, 0.02, "Info: waiting...",
        fontsize=11, family="monospace", color="cyan",
        bbox=dict(facecolor="#111", alpha=0.8, edgecolor="cyan")
    )
    help_text = (
        "CONTROLS:\n[A]uto [M]anual [C]enter\n"
        "Pitch:[p/P][d/D][i/I] Roll:[x/X][y/Y][z/Z]\n"
        "Trim:[l/L][r/R][e/E] Goal:[g/G]\n"
        "Save:[s/S] Reset:[h/H]"
    )
    plt.figtext(0.75, 0.02, help_text, fontsize=9, color="gray", family="monospace")

    colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]
    for i, field in enumerate(target_fields):
        color = colors[i % len(colors)]
        if field in SENSOR_FIELDS:
            plot_lines[field], = ax2.plot([], [], label=field, linestyle=":", linewidth=1.5, color=color)
        else:
            plot_lines[field], = ax1.plot([], [], label=field, linestyle="-", linewidth=2.0, color=color)
    lines1, labels1 = ax1.get_legend_handles_labels()
    lines2, labels2 = ax2.get_legend_handles_labels()
    ax1.legend(lines1 + lines2, labels1 + labels2, loc="upper right")

    def update(_):
        nonlocal t0
        need_draw = False
        while True:
            try:
                kind, payload = q.get_nowait()
            except Empty:
                break

            if kind == "DAT":
                if t0 is None:
                    t0 = payload.t_ms / 1000.0
                rel_t = payload.t_ms / 1000.0 - t0
                times.append(rel_t)
                for field in target_fields:
                    series[field].append(payload.values[field])
                need_draw = True
            else:
                print(f"[LINE] {payload}")
                if payload.startswith("[MODE]"):
                    status_text.set_text(payload)
                    status_text.set_color("#00FFAA")
                elif payload.startswith("[PARAM]") or payload.startswith("[SCHEMA]") or payload.startswith("[EVENT]") or payload.startswith("[INFO]") or payload.startswith("[READY]"):
                    info_text.set_text(payload)

        if need_draw and len(times) > 1:
            t_curr = list(times)
            for field in target_fields:
                vals = list(series[field])
                if len(vals) == len(t_curr):
                    plot_lines[field].set_data(t_curr, vals)

            t_min = max(0, t_curr[-1] - args.window)
            t_max = t_curr[-1] + 0.1
            ax1.set_xlim(t_min, t_max)
            ax2.set_xlim(t_min, t_max)

            vals1 = []
            vals2 = []
            for field in target_fields:
                recent = list(series[field])[-30:]
                if field in SENSOR_FIELDS:
                    vals2.extend(recent)
                else:
                    vals1.extend(recent)

            if vals1:
                ymin, ymax = min(vals1), max(vals1)
                pad = max(1.0, (ymax - ymin) * 0.1)
                ax1.set_ylim(ymin - pad, ymax + pad)
            if vals2:
                ymin, ymax = min(vals2), max(vals2)
                pad = max(0.1, (ymax - ymin) * 0.1)
                ax2.set_ylim(ymin - pad, ymax + pad)

    ani = FuncAnimation(fig, update, interval=50)

    def on_key(event):
        if not event.key:
            return
        k = event.key
        cmd = None
        if k in {"a", "m", "p", "d", "i", "x", "y", "z", "g", "l", "r", "e", "h", "s"}:
            cmd = k
        elif k in {"A", "M", "P", "D", "I", "X", "Y", "Z", "G", "L", "R", "E", "C", "S", "H"}:
            cmd = k
        elif k == "c":
            cmd = "c"
        if cmd:
            reader.write_line(cmd)

    fig.canvas.mpl_connect("key_press_event", on_key)
    try:
        plt.show()
    except KeyboardInterrupt:
        pass
    finally:
        reader.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--save", type=str, default=None)
    parser.add_argument("--window", type=float, default=10.0)
    parser.add_argument("--max-points", type=int, default=1000)
    parser.add_argument("--plot", type=str, default=",".join(PLOT_CANDIDATES))
    args = parser.parse_args()
    run_viewer(args)
