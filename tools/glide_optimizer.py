#!/usr/bin/env python3
# =============================================================
#  glide_optimizer.py — 飛行距離の自動最適化ループ (地上側)
# =============================================================
#  人がやること: 「同じ引き量で射出して、機体を回収する」だけ。
#  それ以外 (計測・記録・パラメータ探索・保存) はすべて自動。
#
#  仕組み:
#    1. 本スクリプトが glide_pitch / climb_ms / climb_pitch を設定して arm
#    2. 人が射出 → 機体ファームが着地衝撃を自動検出して [REPORT] を無線送信
#       (t_flight, t_glide, v0=射出初速, stall, pitch_rms, roll_rms, srv_act)
#    3. スクリプトが目的関数 (滞空時間、オプションで v0 正規化) を計算し、
#       グリッド逐次細分化で次の条件を決定 → 2 へ
#    4. 全ステージ終了後、time-proxy の min-sink バイアスを補正するため
#       glide_pitch を --debias 度下げて確認投 (距離競技向けの最良滑空側へ)
#    5. 最良パラメータを機体へ設定し `save` でフラッシュ永続化
#
#  注意 (time-proxy の理論限界):
#    滞空時間の最大化は「最小沈下」に収束し、「最良滑空 (距離最大)」より
#    ~13% 遅い側にずれる。手順 4 の補正はその近似補正であり、真の距離を
#    測るセンサが無い以上、最終 5〜10% は原理的に検証不能。
#
#  使い方:
#    python tools/glide_optimizer.py --port COM12            # 本番 (実射出)
#    python tools/glide_optimizer.py --port COM12 --test     # ベンチ動作確認
#    python tools/glide_optimizer.py --port COM12 --norm v0  # 射出強度で正規化
# =============================================================

import argparse
import csv
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import serial

# Windows コンソール (cp932) で絵文字等により落ちないようにする
for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(errors="replace")
    except Exception:
        pass

CSV_RE = re.compile(r"^[\d\-+]\d*,\d+,\d+,")   # テレメトリ行 (捨てる)
KV_RE = re.compile(r"(\w+)=([-\d.]+)")


class Link:
    """地上機 (COM12) との回線。DTR/RTS は絶対に触らない (ESP32-C3 が
    ダウンロードモードに落ちるため)。ping keepalive で failsafe を抑える。"""

    def __init__(self, port: str, baud: int = 115200):
        self.ser = serial.Serial()
        self.ser.port = port
        self.ser.baudrate = baud
        self.ser.timeout = 0.15
        self.ser.dtr = False
        self.ser.rts = False
        self.ser.open()
        self._last_ping = 0.0
        time.sleep(0.4)
        self.ser.reset_input_buffer()

    def close(self):
        self.ser.close()

    def _ping(self):
        now = time.monotonic()
        if now - self._last_ping > 0.7:
            self.ser.write(b"ping\n")
            self._last_ping = now

    def read_lines(self, duration: float, keepalive: bool = True):
        """duration 秒のあいだ受信し、テレメトリ以外の行を返す。"""
        out = []
        t_end = time.monotonic() + duration
        buf = b""
        while time.monotonic() < t_end:
            if keepalive:
                self._ping()
            chunk = self.ser.read(4096)
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("utf-8", errors="replace").strip()
                if line and not CSV_RE.match(line):
                    out.append(line)
        return out

    def send(self, cmd: str, expect: str, tries: int = 3, wait: float = 1.5):
        """コマンド送信 + 応答確認。無線ロスに備えてリトライする。"""
        for _ in range(tries):
            self.ser.write((cmd + "\n").encode())
            lines = self.read_lines(wait)
            for ln in lines:
                if expect in ln:
                    return lines
        raise RuntimeError(f"応答なし: `{cmd}` (期待: {expect})")


def parse_report(lines):
    """[REPORT] 行 (2 行) を dict にまとめる。データ不足なら None。"""
    d = {}
    for ln in lines:
        if ln.startswith("[REPORT]"):
            if "no flight data" in ln:
                continue
            for k, v in KV_RE.findall(ln):
                d[k] = float(v)
    if "t_flight" in d and "pitch_rms" in d:
        return d
    return None


class Session:
    def __init__(self, args):
        self.args = args
        self.link = Link(args.port)
        self.throws = []          # 全投擲の記録
        self.n = 0
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_path = Path("logs") / f"optimizer_{stamp}.csv"
        self.log_path.parent.mkdir(exist_ok=True)
        self._csv = open(self.log_path, "w", newline="", encoding="utf-8")
        self._w = csv.writer(self._csv)
        self._w.writerow(["n", "stage", "glide_pitch", "climb_ms", "climb_pitch",
                          "t_flight", "t_glide", "v0", "stall", "impact_g",
                          "pitch_rms", "roll_rms", "srv_act", "objective"])

    # ---- 機体操作 ----------------------------------------------------
    def set_params(self, gp=None, cms=None, cp=None):
        if gp is not None:
            self.link.send(f"glide_pitch {gp:.1f}", "[PARAM]")
        if cms is not None:
            self.link.send(f"climb_ms {int(cms)}", "[PARAM]")
        if cp is not None:
            self.link.send(f"climb_pitch {cp:.1f}", "[PARAM]")

    def objective(self, rep):
        t = rep["t_flight"]
        v0 = rep.get("v0", 0.0)
        if self.args.norm == "v0" and v0 >= 3.0:
            return t / v0
        if self.args.norm == "v02" and v0 >= 3.0:
            return t / (v0 * v0)
        return t

    def ensure_disarm(self):
        """disarm を確実に通す。機体が無線範囲外なら回収を待って再試行。
        (arm/disarm は既フェーズと同じでも configSave が走り [SAVE] を返すので、
        エコー確認は [SAVE] を使う — 自己遷移では [PHASE] 行が出ないため)"""
        while True:
            try:
                self.link.send("disarm", "[SAVE]", tries=3)
                return
            except RuntimeError:
                print("   [!] disarm が届きません (無線範囲外?)。機体を回収してから"
                      " Enter を押してください:")
                input("   > ")

    def throw(self, stage, gp, cms, cp):
        """1 投。実射出 or --test ではソフト射出。レポート dict を返す。"""
        self.n += 1
        self.set_params(gp, cms, cp)
        self.link.send("arm", "[SAVE]")

        rep = None
        if self.args.test:
            self.link.send("launch_now", "[PHASE] -> LAUNCH")
            lines = self.link.read_lines(4.0)          # 疑似滑空
            lines += self.link.send("report", "[REPORT]")
            rep = parse_report(lines)
        else:
            print(f"\n>> 投擲 #{self.n} [{stage}] glide_pitch={gp} climb_ms={cms} "
                  f"climb_pitch={cp}")
            print("   → 同じ引き量で射出してください (着地は自動検出します)…")
            t_end = time.monotonic() + self.args.timeout
            pending = []
            while time.monotonic() < t_end and rep is None:
                pending += self.link.read_lines(2.0)
                rep = parse_report(pending)
            if rep is None:
                print("   [!] 着地を自動検出できませんでした。着地済みなら Enter を"
                      " (レポートを手動取得します)。スキップは s + Enter:")
                ans = input("   > ").strip().lower()
                if ans != "s":
                    lines = self.link.send("report", "[REPORT]")
                    rep = parse_report(lines)

        self.ensure_disarm()
        if rep is None:
            print("   NG: データなし (この投擲はスキップ)")
            return None

        obj = self.objective(rep)
        row = [self.n, stage, gp, cms, cp,
               rep.get("t_flight"), rep.get("t_glide"), rep.get("v0"),
               int(rep.get("stall", 0)), rep.get("impact_g"),
               rep.get("pitch_rms"), rep.get("roll_rms"), rep.get("srv_act"), obj]
        self._w.writerow(row)
        self._csv.flush()
        self.throws.append({"stage": stage, "gp": gp, "cms": cms, "cp": cp,
                            "rep": rep, "obj": obj})
        flags = []
        if rep.get("stall"):
            flags.append("[!]失速")
        v0s = [t["rep"].get("v0", 0) for t in self.throws if t["rep"].get("v0", 0) >= 3]
        if len(v0s) >= 2 and rep.get("v0", 0) >= 3:
            med = sorted(v0s)[len(v0s) // 2]
            if abs(rep["v0"] - med) > 0.15 * med:
                flags.append("[!]射出強度が他と15%以上違う (引き量を確認)")
        print(f"   OK: t={rep['t_flight']:.2f}s v0={rep.get('v0', 0):.1f}m/s "
              f"pitch_rms={rep.get('pitch_rms', 0):.1f} obj={obj:.3f} "
              + " ".join(flags))
        return {"obj": obj, "rep": rep}

    def best_of(self, stage, conds):
        """条件リスト conds = [(gp,cms,cp), ...] を試して最良を返す。"""
        results = []
        for gp, cms, cp in conds:
            r = None
            for _ in range(self.args.throws):
                r1 = self.throw(stage, gp, cms, cp)
                if r1 and (r is None or r1["obj"] > r["obj"]):
                    r = r1                     # 同条件複数投は最良値を採用
            if r:
                results.append(((gp, cms, cp), r["obj"], r["rep"]))
        if not results:
            raise RuntimeError(f"ステージ {stage}: 有効データなし")
        results.sort(key=lambda x: -x[1])
        return results[0]

    # ---- 最適化本体 --------------------------------------------------
    def run(self):
        a = self.args
        gp, cms, cp = a.gp0, a.cms0, a.cp0
        print(f"=== 距離最適化セッション開始 (log: {self.log_path}) ===")
        print(f"初期値: glide_pitch={gp} climb_ms={cms} climb_pitch={cp}")
        print("毎回、印を付けた同じ引き量で射出してください。\n")

        # Stage A: glide_pitch 粗グリッド → 最良点の周りを細分化
        (best, _, _) = self.best_of("A:glide粗", [(g, cms, cp) for g in a.gp_grid])
        gp = best[0]
        fine = [round(gp - 0.7, 1), round(gp + 0.7, 1)]
        fine = [g for g in fine if a.gp_min <= g <= a.gp_max and g not in a.gp_grid]
        if fine:
            self.best_of("A:glide細", [(g, cms, cp) for g in fine])
        best_a = max((t for t in self.throws if t["stage"].startswith("A")),
                     key=lambda t: t["obj"])
        gp = best_a["gp"]
        print(f"\n→ glide_pitch 暫定最良: {gp}\n")

        # Stage B: climb_ms
        (best, _, _) = self.best_of("B:climb_ms", [(gp, c, cp) for c in a.cms_grid])
        cms = best[1]
        print(f"\n→ climb_ms 最良: {cms}\n")

        # Stage C: climb_pitch
        (best, _, _) = self.best_of("C:climb_pitch", [(gp, cms, c) for c in a.cp_grid])
        cp = best[2]
        print(f"\n→ climb_pitch 最良: {cp}\n")

        # Stage D: min-sink バイアス補正 (距離競技向けに最良滑空側へ)
        gp_fast = max(a.gp_min, round(gp - a.debias, 1))
        print(f"[de-bias] 滞空時間最適 ≠ 距離最適のため glide_pitch を "
              f"{gp} → {gp_fast} に下げて確認します (時間が 1〜2 割落ちるのは正常)")
        r = self.throw("D:debias", gp_fast, cms, cp)
        best_t = max(t["obj"] for t in self.throws if t["stage"].startswith(("A", "B", "C")))
        if r and not r["rep"].get("stall") and r["obj"] >= 0.6 * best_t:
            gp = gp_fast
            print(f"→ 採用: glide_pitch={gp}")
        else:
            gp_half = max(a.gp_min, round(gp - a.debias / 2, 1))
            print(f"→ 大幅悪化/失速のため補正を半分に: glide_pitch={gp_half}")
            gp = gp_half

        # 最終設定を書き込み + 永続化
        self.set_params(gp, cms, cp)
        self.link.send("save", "[SAVE]")
        print("\n=== 最適化完了 (フラッシュ保存済み) ===")
        print(f"  glide_pitch = {gp}")
        print(f"  climb_ms    = {cms}")
        print(f"  climb_pitch = {cp}")
        print(f"  投擲数: {self.n}  ログ: {self.log_path}")

    def run_test(self):
        """ベンチ動作確認: ソフト射出 1 回でループ全体を検証する。"""
        print("=== テストモード (launch_now による疑似フライト 1 回) ===")
        r = self.throw("TEST", self.args.gp0, self.args.cms0, self.args.cp0)
        if r:
            print("\nテスト成功 — レポート解析・記録・disarm まで動作確認できました。")
            print(f"ログ: {self.log_path}")
        else:
            print("\nテスト失敗 — 機体との通信を確認してください。")
            sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description="飛行距離の自動最適化 (投げるだけ)")
    ap.add_argument("--port", required=True, help="地上機の COM ポート (例 COM12)")
    ap.add_argument("--test", action="store_true", help="ベンチ動作確認 (launch_now)")
    ap.add_argument("--norm", choices=["none", "v0", "v02"], default="none",
                    help="目的関数の射出強度正規化 (既定 none: 引き量を固定できるなら生の滞空時間が最も低ノイズ)")
    ap.add_argument("--throws", type=int, default=1, help="条件あたり投擲数 (既定 1)")
    ap.add_argument("--timeout", type=float, default=120, help="着地待ち秒数")
    ap.add_argument("--debias", type=float, default=1.5,
                    help="最終段で glide_pitch を下げる量 [deg] (時間最適→距離最適の補正)")
    ap.add_argument("--gp0", type=float, default=3.0)
    ap.add_argument("--cms0", type=int, default=1200)
    ap.add_argument("--cp0", type=float, default=15.0)
    ap.add_argument("--gp-grid", dest="gp_grid", type=float, nargs="+",
                    default=[1.5, 3.0, 4.5, 6.0])
    ap.add_argument("--cms-grid", dest="cms_grid", type=int, nargs="+",
                    default=[1000, 1400, 1800])
    ap.add_argument("--cp-grid", dest="cp_grid", type=float, nargs="+",
                    default=[12.0, 18.0, 24.0])
    ap.add_argument("--gp-min", dest="gp_min", type=float, default=0.5)
    ap.add_argument("--gp-max", dest="gp_max", type=float, default=8.0)
    args = ap.parse_args()

    s = Session(args)
    try:
        if args.test:
            s.run_test()
        else:
            s.run()
    except KeyboardInterrupt:
        print("\n中断 — ここまでの記録は保存済み:", s.log_path)
    finally:
        try:
            s.link.send("disarm", "[SAVE]", tries=1)
        except Exception:
            pass
        s.link.close()


if __name__ == "__main__":
    main()
