#!/usr/bin/env python3
# =============================================================
#  glider_model.py — 機体諸元から空力パラメータと最適化初期値を計算
# =============================================================
#  目的:
#    翼面積・アスペクト比・翼型から、この機体固有の
#      - 最良滑空 CL / 最小沈下 CL (距離最大点 vs 滞空時間最大点)
#      - 理論滑空比 L/D_max (= 距離のポテンシャル)
#      - **de-bias 角** = 滞空時間最適 → 距離最適 への glide_pitch 補正量
#      - glide_optimizer.py に渡す探索初期値
#    を出す。glide_optimizer は滞空時間しか測れない (距離センサ無し) ため、
#    「時間最適 → 距離最適」の最後のジャンプだけは物理モデルに頼る。
#    その補正量がこの機体では既定 1.5° ではなく ~5° である、というのが要点。
#
#  依存なし (標準 math のみ)。
#  使い方:
#    python tools/glider_model.py                      # この機体の既定諸元
#    python tools/glider_model.py --mass 0.25          # 質量を与えて速度/Re も
#    python tools/glider_model.py --tail-arm 0.85      # 尾翼モーメント長で静安定
#    python tools/glider_model.py --cd0 0.04           # 寄生抗力の仮定を変える
# =============================================================

import argparse
import math

RHO = 1.225        # 空気密度 [kg/m^3]
NU = 1.5e-5        # 動粘性 [m^2/s]
G = 9.81

# Clark Y 翼型の代表値 (低〜中 Re)
CLARK_Y = {
    "a0_deg": 0.10,      # 2次元揚力傾斜 [1/deg]
    "alpha_L0_deg": -5.0,  # ゼロ揚力迎角 [deg]
    "clmax": 1.3,        # 最大揚力係数 (Re 10^5 域では 1.2〜1.4)
    "thickness": 0.117,  # 最大翼厚比
}


def wing_lift_slope_deg(AR, a0_deg=0.10, e0=0.95):
    """有限翼の3次元揚力傾斜 [1/deg]。低ARで傾斜が寝る効果を含む。"""
    a0 = a0_deg * 57.2958  # -> 1/rad
    a = a0 / (1.0 + a0 / (math.pi * e0 * AR))
    return a / 57.2958      # -> 1/deg


def analyze(geom, mass=None, tail_arm=None, cd0=0.035, e_ind=0.7):
    b = geom["span"]
    c = geom["chord"]
    S = b * c
    AR = b * b / S
    mac = c   # 矩形翼なので MAC = 弦長

    a_w = wing_lift_slope_deg(AR, CLARK_Y["a0_deg"])

    # 放物線ポーラー CD = CD0 + k*CL^2,  k = 1/(pi e AR)
    k = 1.0 / (math.pi * e_ind * AR)
    cl_bg = math.sqrt(cd0 / k)               # 最良滑空 (距離最大)
    cl_ms = math.sqrt(3.0) * cl_bg           # 最小沈下 (滞空時間最大)
    ld_max = 1.0 / (2.0 * math.sqrt(cd0 * k))
    ld_ms = ld_max * (math.sqrt(3.0) / 2.0)  # 最小沈下点での L/D (≈0.866*max)

    # 迎角・経路角・機体ピッチ姿勢 (Clark Y のゼロ揚力線基準)
    aL0 = CLARK_Y["alpha_L0_deg"]
    aoa_bg = aL0 + cl_bg / a_w
    aoa_ms = aL0 + cl_ms / a_w
    gam_bg = math.degrees(math.atan(1.0 / ld_max))   # 降下角 (正の値)
    gam_ms = math.degrees(math.atan(1.0 / ld_ms))
    # ピッチ姿勢 theta = -gamma + AoA (降下中は経路が下向き)
    theta_bg = -gam_bg + aoa_bg
    theta_ms = -gam_ms + aoa_ms
    # de-bias: 時間最適(最小沈下)から距離最適(最良滑空)への姿勢差 (負=機首下げ)
    debias = theta_ms - theta_bg   # >0。glide_pitch をこの分 下げる

    out = {
        "S": S, "AR": AR, "b": b, "c": c, "mac": mac,
        "a_w_deg": a_w, "cd0": cd0, "e_ind": e_ind, "k": k,
        "cl_bg": cl_bg, "cl_ms": cl_ms, "ld_max": ld_max, "ld_ms": ld_ms,
        "aoa_bg": aoa_bg, "aoa_ms": aoa_ms,
        "gam_bg": gam_bg, "gam_ms": gam_ms,
        "theta_bg": theta_bg, "theta_ms": theta_ms, "debias": debias,
    }

    if mass is not None:
        W = mass * G
        # 速度 V = sqrt(2 W / (rho S CL))
        v_bg = math.sqrt(2 * W / (RHO * S * cl_bg))
        v_ms = math.sqrt(2 * W / (RHO * S * cl_ms))
        vz_bg = v_bg / ld_max      # 沈下率
        vz_ms = v_ms / ld_ms
        Re_bg = v_bg * c / NU
        wing_load = W / S          # 翼面荷重 [N/m^2]
        out.update({
            "mass": mass, "wing_load": wing_load,
            "v_bg": v_bg, "v_ms": v_ms, "vz_bg": vz_bg, "vz_ms": vz_ms,
            "Re_bg": Re_bg,
        })

    # 尾翼容積 (水平尾翼)。tail_arm = 主翼AC〜水平尾翼AC の距離 [m]
    ht = geom.get("htail")
    if ht and tail_arm is not None:
        S_t = ht["span"] * ht["chord"]
        VH = (S_t * tail_arm) / (S * mac)
        AR_t = ht["span"] ** 2 / S_t
        a_t = wing_lift_slope_deg(AR_t, CLARK_Y["a0_deg"])
        deps = 0.35                 # 吹き下ろし勾配 (概算)
        x_np = 0.25 + VH * (a_t / a_w) * (1.0 - deps)   # 中立点 [MAC比]
        cg = geom.get("cg_frac", None)
        out.update({
            "S_t": S_t, "AR_t": AR_t, "VH": VH, "x_np": x_np,
            "static_margin": (x_np - cg) if cg is not None else None,
        })
    return out


def emit_optimizer_flags(r):
    """glide_optimizer.py に渡す推奨フラグを返す。"""
    # 最小沈下姿勢を中心に、絶対値の不確かさ (±3°) を見込んで広めの粗グリッド。
    center = round(r["theta_ms"])
    grid = [center - 4, center - 1, center + 2, center + 5]
    debias = round(r["debias"] * 2) / 2.0   # 0.5 刻み
    return grid, debias


def main():
    ap = argparse.ArgumentParser(description="機体諸元 → 空力/最適化初期値")
    ap.add_argument("--span", type=float, default=1.00, help="主翼スパン [m]")
    ap.add_argument("--chord", type=float, default=0.30, help="主翼弦長 [m]")
    ap.add_argument("--cg", type=float, default=0.40,
                    help="重心位置 [MAC比] (前縁120mm/弦300mm=0.40)")
    ap.add_argument("--mass", type=float, default=None, help="全備質量 [kg]")
    ap.add_argument("--tail-arm", dest="tail_arm", type=float, default=None,
                    help="主翼AC〜水平尾翼AC 距離 [m]")
    ap.add_argument("--htail-span", dest="ht_span", type=float, default=0.34)
    ap.add_argument("--htail-chord", dest="ht_chord", type=float, default=0.17)
    ap.add_argument("--cd0", type=float, default=0.035,
                    help="寄生抗力係数の仮定 (低Re機体で 0.03〜0.05)")
    ap.add_argument("--e", type=float, default=0.7, help="Oswald 効率 (矩形翼~0.7)")
    args = ap.parse_args()

    geom = {
        "span": args.span, "chord": args.chord, "cg_frac": args.cg,
        "htail": {"span": args.ht_span, "chord": args.ht_chord},
    }
    r = analyze(geom, mass=args.mass, tail_arm=args.tail_arm,
                cd0=args.cd0, e_ind=args.e)

    print("=" * 56)
    print(" 機体空力モデル (Clark Y)")
    print("=" * 56)
    print(f" 翼面積 S      = {r['S']:.3f} m^2")
    print(f" アスペクト比  = {r['AR']:.2f}   (低AR = 誘導抗力大 / L/D 控えめ)")
    print(f" 3D揚力傾斜    = {r['a_w_deg']:.4f} /deg")
    print(f" 仮定: CD0={r['cd0']:.3f}  e={r['e_ind']:.2f}")
    print("-" * 56)
    print(f" 最良滑空 (距離最大):  CL={r['cl_bg']:.2f}  L/D={r['ld_max']:.1f}"
          f"  経路角 -{r['gam_bg']:.1f}°")
    print(f" 最小沈下 (時間最大):  CL={r['cl_ms']:.2f}  L/D={r['ld_ms']:.1f}"
          f"  経路角 -{r['gam_ms']:.1f}°")
    print(f" 機体ピッチ姿勢: 最良滑空 {r['theta_bg']:+.1f}°  "
          f"最小沈下 {r['theta_ms']:+.1f}°  (ゼロ揚力線基準・相対値が確か)")
    print("-" * 56)
    print(f" ★ de-bias = {r['debias']:.1f}°  "
          f"(滞空時間最適から glide_pitch をこれだけ下げると距離最適)")
    print(f"   現行 optimizer 既定 1.5° は大幅な過小補正 → {r['debias']:.1f}° 相当へ")
    if "mass" in r:
        print("-" * 56)
        print(f" 質量 {r['mass']*1000:.0f}g / 翼面荷重 {r['wing_load']:.1f} N/m^2")
        print(f" 速度  最良滑空 {r['v_bg']:.1f} m/s  最小沈下 {r['v_ms']:.1f} m/s")
        print(f" 沈下率 最良滑空 {r['vz_bg']:.2f} m/s  最小沈下 {r['vz_ms']:.2f} m/s")
        print(f" Reynolds ~ {r['Re_bg']:,.0f}  (低Re: CD0 はやや高め寄り)")
        print(f" 参考: 頂点高度 h なら 距離 ~ h × {r['ld_max']:.1f}")
    if "VH" in r:
        print("-" * 56)
        print(f" 水平尾翼容積 VH = {r['VH']:.2f}  中立点 {r['x_np']*100:.0f}% MAC")
        if r["static_margin"] is not None:
            sm = r["static_margin"] * 100
            note = "健全" if 0.08 <= r["static_margin"] <= 0.18 else \
                   ("後方=敏感/不安定寄り" if r["static_margin"] < 0.08 else "前方=安定だが要引き起こし")
            print(f" 静安定余裕 (CG {args.cg*100:.0f}%): {sm:+.0f}% MAC  → {note}")
    print("=" * 56)
    grid, debias = emit_optimizer_flags(r)
    grid_str = " ".join(f"{x:g}" for x in grid)
    print(" glide_optimizer.py 推奨フラグ:")
    print(f"   --gp-grid {grid_str} --debias {debias:g}")
    print("=" * 56)


if __name__ == "__main__":
    main()
