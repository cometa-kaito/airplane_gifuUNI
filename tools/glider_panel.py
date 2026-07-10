#!/usr/bin/env python3
# =============================================================
#  glider_panel.py — 最小 Python コントロールパネル + 自動距離最適化
# =============================================================
#  壊れやすい WebUI を使わず、直接シリアル(地上 ESP COM12)で機体を操作する
#  最小 GUI。tkinter (標準) + pyserial のみ。追加インストール不要。
#
#  できること:
#    - 接続 / テレメトリ表示 (phase・roll・pitch・|a|・サーボ)
#    - 手動ボタン: Arm / Disarm / Land / Launch(now) / Zero / リンク再起動
#    - [REPORT] 自動表示 (着地ごとの飛行時間・射出速度・失速・滑空品質)
#    - ★ 自動距離最適化: 「投げるだけ」で glide_pitch → climb_ff(%) → climb_ms を
#      山登り法で調整 (飛行時間を代理指標に、常に best を保持=悪化しても戻す)
#
#  堅牢化:
#    - DTR/RTS は false 固定 (ESP32-C3 のダウンロードモード落ちを回避)
#    - ping keepalive で failsafe 抑制
#    - テレメトリが途絶えたら自動で /channel 1 (リプレイ復旧、地上 ESP 再起動)
#
#  使い方:  python tools/glider_panel.py            (COM ポートは GUI で選択)
#           python tools/glider_panel.py --port COM12
# =============================================================

import argparse
import re
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

try:
    import serial
    import serial.tools.list_ports as list_ports
except ImportError:
    print("pyserial が必要です:  pip install pyserial")
    sys.exit(1)

import tkinter as tk
from tkinter import ttk, scrolledtext

CSV_RE = re.compile(r"^[\d\-+]\d*,\d+,\d+,")
KV_RE = re.compile(r"(\w+)=([-\d.]+)")
SERVO_RE = re.compile(r"servo(\d)\s+min=(\d+)\s+mid=(\d+)\s+max=(\d+)\s+rev=(\d)")
TRIM_RE = re.compile(r"trim=\[([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\]")
PHASE_NAMES = {0: "DISARMED", 1: "PRELAUNCH", 2: "LAUNCH", 3: "GLIDE", 5: "WINDTUNNEL"}
PHASE_COLORS = {0: "#64748b", 1: "#eab308", 2: "#f97316", 3: "#3ddc97", 5: "#a855f7"}


def parse_report(lines):
    d = {}
    for ln in lines:
        if ln.startswith("[REPORT]"):
            if "no flight data" in ln:
                continue
            for k, v in KV_RE.findall(ln):
                d[k] = float(v)
    return d if ("t_flight" in d and "pitch_rms" in d) else None


# =============================================================
#  シリアルリンク (バックグラウンド読み取りスレッド)
# =============================================================
class Link:
    def __init__(self, port, baud=115200):
        self.ser = serial.Serial()
        self.ser.port = port
        self.ser.baudrate = baud
        self.ser.timeout = 0.1
        self.ser.dtr = False           # ★ ESP32-C3 ダウンロードモード落ち回避
        self.ser.rts = False
        self.ser.open()

        self._wlock = threading.Lock()
        self._stop = threading.Event()
        self._buf = b""
        self.lock = threading.Lock()   # 共有状態の保護

        self.telem = None              # 最新テレメトリ dict
        self.messages = deque(maxlen=1000)
        self.new_messages = deque()    # GUI がまだ拾っていない行
        self.last_report = None
        self.report_seq = 0            # 着地レポートが来るたび +1
        self._report_lines = []

        self.trim = [0.0, 0.0, 0.0]                 # status から取得したトリム [deg]
        self.scal = {0: None, 1: None, 2: None}     # {ch: {min,mid,max,rev}}
        self.cal_seq = 0                            # トリム/較正が更新されるたび +1

        self._last_telem = time.monotonic()
        self._last_ping = 0.0
        self._last_relink = 0.0
        self.telem_alive = False

        self._reader = threading.Thread(target=self._loop, daemon=True)
        self._reader.start()
        time.sleep(0.3)
        try:
            self.ser.reset_input_buffer()
        except Exception:
            pass

    def send(self, cmd):
        with self._wlock:
            try:
                self.ser.write((cmd + "\n").encode())
            except Exception:
                pass

    def close(self):
        self._stop.set()
        time.sleep(0.15)
        try:
            self.ser.close()
        except Exception:
            pass

    def _loop(self):
        while not self._stop.is_set():
            now = time.monotonic()
            if now - self._last_ping > 0.7:
                self.send("ping")
                self._last_ping = now
            # リプレイ復旧: テレメトリが 6s 途絶えたら地上 ESP を再起動 (最短 15s 間隔)
            self.telem_alive = (now - self._last_telem) < 3.0
            if now - self._last_telem > 6.0 and now - self._last_relink > 15.0:
                self.send("/channel 1")
                self._last_relink = now
                self._push_msg("[panel] テレメトリ途絶 → /channel 1 で復旧試行")
            try:
                chunk = self.ser.read(4096)
            except Exception:
                chunk = b""
            if not chunk:
                continue
            self._buf += chunk
            while b"\n" in self._buf:
                raw, self._buf = self._buf.split(b"\n", 1)
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    self._handle(line)

    def _push_msg(self, line):
        with self.lock:
            self.messages.append(line)
            self.new_messages.append(line)

    def _handle(self, line):
        if CSV_RE.match(line):
            f = line.split(",")
            if len(f) >= 17:
                try:
                    t = {
                        "phase": int(f[15]), "roll": float(f[9]), "pitch": float(f[10]),
                        "s0": int(f[12]), "s1": int(f[13]), "s2": int(f[14]),
                        "a": float(f[16]),
                    }
                    with self.lock:
                        self.telem = t
                    self._last_telem = time.monotonic()
                except Exception:
                    pass
            return
        self._push_msg(line)
        ms = SERVO_RE.search(line)
        if ms:
            ch = int(ms.group(1))
            if ch in self.scal:
                with self.lock:
                    self.scal[ch] = {"min": int(ms.group(2)), "mid": int(ms.group(3)),
                                     "max": int(ms.group(4)), "rev": int(ms.group(5))}
                    self.cal_seq += 1
        mt = TRIM_RE.search(line)
        if mt:
            with self.lock:
                self.trim = [float(mt.group(1)), float(mt.group(2)), float(mt.group(3))]
                self.cal_seq += 1
        if line.startswith("[REPORT]"):
            self._report_lines.append(line)
            rep = parse_report(self._report_lines)
            if rep:
                with self.lock:
                    self.last_report = rep
                    self.report_seq += 1
                self._report_lines = []
            elif len(self._report_lines) > 4:
                self._report_lines = self._report_lines[-2:]

    # ---- GUI/optimizer 用アクセサ ----
    def snapshot(self):
        with self.lock:
            t = dict(self.telem) if self.telem else None
            rep = dict(self.last_report) if self.last_report else None
            return t, rep, self.report_seq, self.telem_alive

    def drain_messages(self):
        out = []
        with self.lock:
            while self.new_messages:
                out.append(self.new_messages.popleft())
        return out

    def request_status(self):
        self.send("status")

    def cal_snapshot(self):
        with self.lock:
            return (list(self.trim),
                    {k: (dict(v) if v else None) for k, v in self.scal.items()},
                    self.cal_seq)


# =============================================================
#  自動距離最適化 (山登り法 / 別スレッド)
# =============================================================
#   飛行時間を代理指標に、glide_pitch → climb_ff(%) → climb_ms を順に調整する。
#   常に best を保持し、悪化した投擲は元へ戻す (どんな投擲数でも損しない)。
#   ※ 飛行時間最大 ≒ 最小沈下。距離最大へは best 収束後 glide_pitch を少し下げる
#     (de-bias) と良い (機体モデル上 ~5°、UI の "de-bias" ボタン参照)。
class Optimizer:
    # (name, cmd, step, lo, hi, decimals)
    PARAMS = [
        ("glide_pitch", "glide_pitch", 2.0, -12.0, 12.0, 1),
        ("climb_ff",    "climb_ff",    8.0, -80.0,  0.0, 0),  # 負=機首上げズーム
        ("climb_ms",    "climb_ms",  200.0, 600.0, 2500.0, 0),
    ]

    def __init__(self, link, start, on_state, throw_timeout=120.0):
        self.link = link
        self.cur = dict(start)               # {name: value}
        self.best = dict(start)
        self.best_obj = None
        self.on_state = on_state             # コールバック(dict) → GUI 表示
        self.throw_timeout = throw_timeout
        self._stop = threading.Event()
        self._pi = 0                         # 調整中パラメータ index
        self._dir = {p[0]: +1 for p in self.PARAMS}
        self.n = 0
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_path = Path("logs") / f"panel_opt_{stamp}.csv"
        self.log_path.parent.mkdir(exist_ok=True)
        self._log = open(self.log_path, "w", encoding="utf-8")
        self._log.write("n,phase,glide_pitch,climb_ff,climb_ms,t_flight,v0,stall,obj,accepted\n")

    def stop(self):
        self._stop.set()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _apply(self, settings):
        self.link.send(f"glide_pitch {settings['glide_pitch']:.1f}")
        time.sleep(0.1)
        self.link.send(f"climb_ff {settings['climb_ff']:.0f}")
        time.sleep(0.1)
        self.link.send(f"climb_ms {int(settings['climb_ms'])}")
        time.sleep(0.15)

    def _objective(self, rep):
        if rep.get("stall"):
            return -1.0                       # 失速は不採用
        return rep.get("t_flight", 0.0)

    def _one_throw(self, settings, phase_label):
        """1 投: 設定 → arm → 投擲待ち → レポート取得。obj か None。"""
        self.n += 1
        self._apply(settings)
        _, _, seq0, _ = self.link.snapshot()
        self.link.send("arm")
        self.on_state({"mode": "THROW", "phase": phase_label, "n": self.n,
                       "settings": dict(settings),
                       "best": dict(self.best), "best_obj": self.best_obj})
        # 新しいレポートを待つ
        t_end = time.monotonic() + self.throw_timeout
        rep = None
        while time.monotonic() < t_end and not self._stop.is_set():
            _, r, seq, _ = self.link.snapshot()
            if seq > seq0 and r is not None:
                rep = r
                break
            self.on_state({"mode": "WAIT", "phase": phase_label, "n": self.n,
                           "settings": dict(settings),
                           "best": dict(self.best), "best_obj": self.best_obj})
            time.sleep(0.3)
        self.link.send("disarm")
        time.sleep(0.4)
        if rep is None:
            return None
        obj = self._objective(rep)
        self._log.write("{},{},{:.1f},{:.0f},{},{:.2f},{:.1f},{},{:.3f},".format(
            self.n, phase_label, settings["glide_pitch"], settings["climb_ff"],
            int(settings["climb_ms"]), rep.get("t_flight", 0), rep.get("v0", 0),
            int(rep.get("stall", 0)), obj))
        return obj, rep

    def _run(self):
        # 1) 現設定でベースライン
        r = self._one_throw(self.cur, "baseline")
        if r is None:
            self._finish("ベースライン取得失敗 (レポート未着)")
            return
        self.best_obj = r[0]
        self.best = dict(self.cur)
        self._log.write("baseline\n"); self._log.flush()

        # 2) 座標山登り: 各パラメータを順に ±step、良ければ採用し同方向継続
        while not self._stop.is_set():
            name, cmd, step, lo, hi, dec = self.PARAMS[self._pi]
            trial = dict(self.best)
            trial[name] = max(lo, min(hi, self.best[name] + step * self._dir[name]))
            if trial[name] == self.best[name]:      # 端に張り付き → 方向反転して次へ
                self._dir[name] *= -1
                self._pi = (self._pi + 1) % len(self.PARAMS)
                continue
            r = self._one_throw(trial, f"tune:{name}")
            if r is None:
                self._log.write("no-report\n"); self._log.flush()
                self.on_state({"mode": "NOREP", "phase": f"tune:{name}"})
                continue
            obj = r[0]
            accepted = obj > self.best_obj
            self._log.write(f"{1 if accepted else 0}\n"); self._log.flush()
            if accepted:
                self.best = dict(trial)
                self.best_obj = obj
                self.link.send("save")              # best をフラッシュへ即保存
                # 同方向を継続 (同じ pi のまま)
            else:
                self._dir[name] *= -1                # 方向反転して次パラメータへ
                self._pi = (self._pi + 1) % len(self.PARAMS)
            self.on_state({"mode": "RESULT", "phase": f"tune:{name}", "n": self.n,
                           "obj": obj, "accepted": accepted,
                           "best": dict(self.best), "best_obj": self.best_obj})
        self._finish("停止しました")

    def _finish(self, msg):
        try:
            self._apply(self.best)
            self.link.send("save")
        except Exception:
            pass
        self.on_state({"mode": "DONE", "msg": msg, "best": dict(self.best),
                       "best_obj": self.best_obj})
        try:
            self._log.close()
        except Exception:
            pass


# =============================================================
#  GUI (tkinter, メインスレッド)
# =============================================================
class Panel:
    def __init__(self, root, default_port=None):
        self.root = root
        self.link = None
        self.opt = None
        root.title("Glider Panel — 最小コントロール + 自動距離最適化")
        root.configure(bg="#0f172a")

        top = tk.Frame(root, bg="#0f172a"); top.pack(fill="x", padx=8, pady=6)
        tk.Label(top, text="COM:", fg="#cbd5e1", bg="#0f172a").pack(side="left")
        self.port_var = tk.StringVar(value=default_port or "")
        ports = [p.device for p in list_ports.comports()]
        self.port_cb = ttk.Combobox(top, textvariable=self.port_var, values=ports, width=10)
        if default_port and default_port in ports:
            self.port_cb.set(default_port)
        elif ports:
            self.port_cb.set(ports[0])
        self.port_cb.pack(side="left", padx=4)
        self.btn_conn = tk.Button(top, text="接続", width=8, command=self.toggle_conn)
        self.btn_conn.pack(side="left", padx=4)
        self.link_lbl = tk.Label(top, text="未接続", fg="#f87171", bg="#0f172a", font=("", 10, "bold"))
        self.link_lbl.pack(side="left", padx=8)

        # 大きな phase 表示
        self.phase_lbl = tk.Label(root, text="—", fg="#fff", bg="#334155",
                                  font=("", 22, "bold"), pady=8)
        self.phase_lbl.pack(fill="x", padx=8, pady=4)
        self.telem_lbl = tk.Label(root, text="roll — / pitch — / |a| —  · servo — — —",
                                  fg="#cbd5e1", bg="#0f172a", font=("Consolas", 11))
        self.telem_lbl.pack(fill="x", padx=8)

        # 手動ボタン
        mb = tk.Frame(root, bg="#0f172a"); mb.pack(fill="x", padx=8, pady=6)
        self._mkbtn(mb, "ARM", self.cmd_arm, "#16a34a")
        self._mkbtn(mb, "DISARM", self.cmd_disarm, "#dc2626")
        self._mkbtn(mb, "LAND", lambda: self.send("land"), "#0ea5e9")
        self._mkbtn(mb, "LAUNCH(now)", lambda: self.send("launch_now"), "#f97316")
        self._mkbtn(mb, "ZERO", lambda: self.send("zero"), "#6366f1")
        self._mkbtn(mb, "リンク再起動", lambda: self.send("/channel 1"), "#475569")

        # ---- サーボ設定: 可動域 + 中立(trim)。drive-and-set ----
        #   トリム(deg)の別枠は持たない。ジョグで動かして「中立(trim)に」を押した
        #   位置を、その舵の中立=トリムとする (MID=servoCenterUs に設定し、
        #   trimDeg は 0 にリセット → MID がそのまま真の中立になる)。
        self.SCH_NAMES = ["右エルロン s0", "左エルロン s1", "エレベータ s2"]
        cf = tk.LabelFrame(root, text="サーボ設定 (DISARMED) — ドラッグで動かし 中立/端 をセット",
                           fg="#34d399", bg="#0f172a", padx=6, pady=4)
        cf.pack(fill="x", padx=8, pady=4)
        rr = tk.Frame(cf, bg="#0f172a"); rr.pack(fill="x")
        self.jog_ch = tk.IntVar(value=2)
        for ch in range(3):
            tk.Radiobutton(rr, text=self.SCH_NAMES[ch].split()[0], variable=self.jog_ch,
                           value=ch, fg="#cbd5e1", bg="#0f172a", selectcolor="#1e293b",
                           command=self.on_jog_ch).pack(side="left", padx=4)
        self.cal_now = tk.Label(cf, text="現在: —", fg="#94a3b8", bg="#0f172a",
                                font=("Consolas", 9))
        self.cal_now.pack(anchor="w")
        self.jog = tk.Scale(cf, from_=500, to=2500, orient="horizontal", length=380,
                            bg="#0f172a", fg="#e5e7eb", troughcolor="#1e293b",
                            highlightthickness=0, label="ジョグ µs (ドラッグで実際に動く)")
        self.jog.set(1500)
        self.jog.pack(fill="x")
        self.jog.bind("<ButtonRelease-1>", self.on_jog)
        jr = tk.Frame(cf, bg="#0f172a"); jr.pack(fill="x", pady=2)
        tk.Button(jr, text="ここを 中立(trim) に", command=lambda: self.set_end("smid"),
                  bg="#7c3aed", fg="white", font=("", 9, "bold")).pack(side="left", padx=2)
        tk.Button(jr, text="MIN 端", command=lambda: self.set_end("smin")).pack(side="left", padx=2)
        tk.Button(jr, text="MAX 端", command=lambda: self.set_end("smax")).pack(side="left", padx=2)
        tk.Button(jr, text="反転", command=self.toggle_rev).pack(side="left", padx=6)
        tk.Button(jr, text="ジョグ解除", command=self.jog_off).pack(side="left", padx=2)
        ur = tk.Frame(cf, bg="#0f172a"); ur.pack(fill="x", pady=2)
        tk.Button(ur, text="機体から読込", command=self.read_cal).pack(side="left", padx=2)
        tk.Button(ur, text="💾 保存(flash)", command=lambda: self.send("save"),
                  bg="#065f46", fg="white").pack(side="left", padx=6)

        # 自動最適化
        ob = tk.LabelFrame(root, text="自動距離最適化 (投げるだけ)", fg="#a5b4fc",
                           bg="#0f172a", padx=6, pady=6)
        ob.pack(fill="x", padx=8, pady=6)
        self.opt_btn = tk.Button(ob, text="▶ 最適化 開始", width=16, command=self.toggle_opt,
                                 bg="#4f46e5", fg="white", font=("", 10, "bold"))
        self.opt_btn.pack(side="left", padx=4)
        self.opt_state = tk.Label(ob, text="停止中", fg="#cbd5e1", bg="#0f172a",
                                  font=("", 11, "bold"))
        self.opt_state.pack(side="left", padx=8)
        self.opt_best = tk.Label(ob, text="", fg="#86efac", bg="#0f172a", font=("Consolas", 10))
        self.opt_best.pack(side="left", padx=8)

        # ログ
        self.log = scrolledtext.ScrolledText(root, height=12, width=78, bg="#020617",
                                             fg="#94a3b8", font=("Consolas", 9))
        self.log.pack(fill="both", expand=True, padx=8, pady=6)

        self.opt_msg = None
        self._rev = {0: 0, 1: 0, 2: 0}
        self.root.after(150, self._tick)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def _mkbtn(self, parent, text, cmd, color):
        b = tk.Button(parent, text=text, command=cmd, width=11, bg=color, fg="white",
                      font=("", 10, "bold"), state="disabled")
        b.pack(side="left", padx=3)
        if not hasattr(self, "_manual_btns"):
            self._manual_btns = []
        self._manual_btns.append(b)
        return b

    # ---- 接続 ----
    def toggle_conn(self):
        if self.link:
            self.disconnect()
        else:
            try:
                self.link = Link(self.port_var.get())
                self.link_lbl.config(text="接続済", fg="#4ade80")
                self.btn_conn.config(text="切断")
                for b in self._manual_btns:
                    b.config(state="normal")
                self._logln(f"[panel] {self.port_var.get()} に接続")
            except Exception as e:
                self._logln(f"[panel] 接続失敗: {e}")

    def disconnect(self):
        if self.opt:
            self.opt.stop(); self.opt = None
        if self.link:
            self.link.close(); self.link = None
        self.link_lbl.config(text="未接続", fg="#f87171")
        self.btn_conn.config(text="接続")
        for b in self._manual_btns:
            b.config(state="disabled")

    def send(self, cmd):
        if self.link:
            self.link.send(cmd)
            self._logln(f">>> {cmd}")

    def cmd_arm(self):
        self.send("arm")

    def cmd_disarm(self):
        self.send("disarm")

    # ---- サーボ設定 (drive-and-set) ----
    def read_cal(self):
        if self.link:
            self.link.request_status()

    def on_jog_ch(self):
        if self.link:
            _, scal, _ = self.link.cal_snapshot()
            c = scal.get(self.jog_ch.get())
            if c:
                self.jog.set(c["mid"])

    def on_jog(self, _evt=None):
        self.send(f"sjog {self.jog_ch.get()} {int(self.jog.get())}")

    def set_end(self, cmd):
        ch = self.jog_ch.get()
        us = int(self.jog.get())
        self.send(f"{cmd} {ch} {us}")
        if cmd == "smid":
            # 中立 = MID。トリム(deg)を 0 にリセットして MID を真の中立(trim)にする
            self.send(f"s{ch} 0")
        if self.link:
            self.link.request_status()

    def toggle_rev(self):
        ch = self.jog_ch.get()
        self.send(f"srev {ch} {0 if self._rev.get(ch, 0) else 1}")
        if self.link:
            self.link.request_status()

    def jog_off(self):
        self.send(f"sjog {self.jog_ch.get()} off")

    # ---- 最適化 ----
    def toggle_opt(self):
        if self.opt:
            self.opt.stop(); self.opt = None
            self.opt_btn.config(text="▶ 最適化 開始", bg="#4f46e5")
            self.opt_state.config(text="停止中")
            return
        if not self.link:
            self._logln("[panel] 先に接続してください")
            return
        start = {"glide_pitch": 3.0, "climb_ff": -40.0, "climb_ms": 1200.0}
        self.opt = Optimizer(self.link, start, self._on_opt_state)
        self.opt.start()
        self.opt_btn.config(text="■ 最適化 停止", bg="#b91c1c")
        self._logln(f"[panel] 最適化開始 (log: {self.opt.log_path.name}) — 印を付けた同じ引き量で投げてください")

    def _on_opt_state(self, st):
        self.opt_msg = st        # スレッド → GUI (次の _tick で反映)

    # ---- 周期更新 (メインスレッド) ----
    def _tick(self):
        if self.link:
            t, rep, seq, alive = self.link.snapshot()
            if t:
                ph = t["phase"]
                self.phase_lbl.config(text=PHASE_NAMES.get(ph, f"phase{ph}"),
                                      bg=PHASE_COLORS.get(ph, "#334155"))
                self.telem_lbl.config(
                    text="roll {:+5.1f}  pitch {:+5.1f}  |a| {:.2f}g   ·  servo {} {} {}".format(
                        t["roll"], t["pitch"], t["a"], t["s0"], t["s1"], t["s2"]))
            self.link_lbl.config(text="接続済 · テレメトリOK" if alive else "接続済 · 無信号",
                                 fg="#4ade80" if alive else "#fbbf24")
            # サーボ較正の現在値を表示
            _, scal, _ = self.link.cal_snapshot()
            jch = self.jog_ch.get()
            c = scal.get(jch)
            if c:
                self._rev[jch] = c["rev"]
                self.cal_now.config(
                    text=f"現在 ch{jch}: min={c['min']} mid={c['mid']} max={c['max']} rev={c['rev']}")
            else:
                self.cal_now.config(text=f"現在 ch{jch}: 未取得 (「機体から読込」を押す)")
            for ln in self.link.drain_messages():
                self._logln(ln)
        # 最適化状態
        if self.opt_msg:
            st = self.opt_msg; self.opt_msg = None
            m = st.get("mode")
            if m == "THROW":
                s = st["settings"]
                self.opt_state.config(text=f"▶ 投げて!  #{st['n']}", fg="#fde047")
                self.opt_best.config(
                    text="試: gp{:.0f} ff{:.0f}% ms{}".format(
                        s["glide_pitch"], s["climb_ff"], int(s["climb_ms"])))
            elif m == "WAIT":
                self.opt_state.config(text=f"着地待ち…  #{st['n']}", fg="#93c5fd")
            elif m == "RESULT":
                self.opt_state.config(
                    text=("採用 ✓" if st["accepted"] else "戻す"),
                    fg="#86efac" if st["accepted"] else "#fca5a5")
                b = st["best"]
                self.opt_best.config(text="best: gp{:.0f} ff{:.0f}% ms{}  t={:.2f}s".format(
                    b["glide_pitch"], b["climb_ff"], int(b["climb_ms"]),
                    st.get("best_obj") or 0))
            elif m == "NOREP":
                self.opt_state.config(text="レポート未着 (再試行)", fg="#fca5a5")
            elif m == "DONE":
                self.opt_state.config(text="完了", fg="#86efac")
                b = st.get("best", {})
                if b:
                    self._logln("[panel] 最良: gp{:.0f} ff{:.0f}% ms{}  (保存済)".format(
                        b.get("glide_pitch", 0), b.get("climb_ff", 0), int(b.get("climb_ms", 0))))
        self.root.after(150, self._tick)

    def _logln(self, s):
        self.log.insert("end", s + "\n")
        self.log.see("end")
        # 行数を制限
        if int(self.log.index("end-1c").split(".")[0]) > 400:
            self.log.delete("1.0", "100.0")

    def on_close(self):
        self.disconnect()
        self.root.destroy()


def main():
    ap = argparse.ArgumentParser(description="Glider 最小コントロールパネル")
    ap.add_argument("--port", default=None, help="地上 ESP の COM ポート (例 COM12)")
    args = ap.parse_args()
    root = tk.Tk()
    Panel(root, default_port=args.port)
    root.mainloop()


if __name__ == "__main__":
    main()
