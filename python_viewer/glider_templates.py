# -*- coding: utf-8 -*-
"""
グライダー形状テンプレート集

PlaneSpec を編集／追加することで機体形状をカスタマイズできます。
viewer の起動時に --preset <名前> で選択。

座標系:
  +X = 右翼方向（右が正）
  +Y = 上方向
  +Z = 機首方向（前が正）
  寸法は viewer 内で使う「単位」（実機センチくらいの感覚）
"""

from dataclasses import dataclass, field


@dataclass
class PlaneSpec:
    name: str = "untitled"

    # === 胴体 ===
    fuselage_length: float = 30.0      # 全長
    fuselage_width: float  = 2.5       # 幅
    fuselage_height: float = 2.5       # 高さ
    fuselage_color: tuple  = (0.85, 0.85, 0.90)

    # === 機首コーン ===
    nose_length: float = 6.0           # 機首先端の長さ（0で省略）
    nose_color: tuple  = (0.95, 0.95, 1.0)

    # === 主翼 ===
    wing_enabled: bool = True
    wing_span: float        = 50.0      # 翼幅
    wing_chord_root: float  = 8.0       # 翼根弦長
    wing_chord_tip: float   = 8.0       # 翼端弦長（=root なら矩形翼）
    wing_sweep_deg: float   = 0.0       # 前縁後退角 [deg]（+で後退）
    wing_dihedral_deg: float = 0.0      # 上反角 [deg]
    wing_position_z: float  = 0.0       # 前後位置（+で前寄り）
    wing_position_y: float  = 1.0       # 上下位置（+で胴体上面）
    wing_color: tuple       = (1.0, 0.85, 0.20)

    # === 副主翼（複葉用、None なら無し） ===
    wing2_enabled: bool = False
    wing2_offset_y: float = -6.0        # 主翼との上下差
    wing2_offset_z: float = -2.0        # 主翼との前後差

    # === 水平尾翼 ===
    htail_enabled: bool = True
    htail_span: float       = 15.0
    htail_chord: float      = 4.0
    htail_sweep_deg: float  = 0.0
    htail_position_z: float = -14.0     # 通常はマイナス（後ろ）
    htail_position_y: float = 0.5
    htail_color: tuple      = (1.0, 0.5, 0.10)

    # === 垂直尾翼 ===
    vtail_enabled: bool = True
    vtail_height: float     = 5.0
    vtail_chord: float      = 4.0
    vtail_position_z: float = -14.0
    vtail_position_y: float = 1.5
    vtail_color: tuple      = (0.95, 0.30, 0.10)

    # === カナード（前翼）===
    canard_enabled: bool = False
    canard_span: float       = 12.0
    canard_chord: float      = 3.0
    canard_position_z: float = 12.0     # 前方
    canard_position_y: float = 1.0
    canard_color: tuple      = (0.4, 1.0, 0.4)


# ============================================================
#  プリセット（ここに追加していけば --preset で選べる）
# ============================================================

# ---- 1. 標準ビギナーグライダー ----
DEFAULT_GLIDER = PlaneSpec(
    name="default",
    wing_span=50.0,
    wing_chord_root=10.0,
    wing_chord_tip=10.0,
    wing_dihedral_deg=5.0,        # 設計仕様の上反角5°を反映
    wing_color=(1.0, 0.85, 0.20),
)

# ---- 2. 高アスペクト比（競技用グライダー風）----
HIGH_ASPECT_RATIO = PlaneSpec(
    name="high_ar",
    wing_span=80.0,
    wing_chord_root=6.0,
    wing_chord_tip=3.0,            # テーパー強め
    wing_sweep_deg=0.0,
    wing_dihedral_deg=3.0,
    wing_color=(0.4, 0.7, 1.0),    # 青系
    fuselage_length=35.0,
    htail_span=12.0,
    htail_chord=3.0,
)

# ---- 3. 後退翼（高速機風）----
SWEPT_WING = PlaneSpec(
    name="swept",
    wing_span=45.0,
    wing_chord_root=10.0,
    wing_chord_tip=4.0,
    wing_sweep_deg=25.0,           # 強い後退
    wing_dihedral_deg=2.0,
    wing_color=(0.7, 0.7, 0.9),
    htail_sweep_deg=20.0,
    htail_span=12.0,
    nose_length=8.0,
)

# ---- 4. デルタ翼（無尾翼に近い）----
DELTA_WING = PlaneSpec(
    name="delta",
    wing_span=40.0,
    wing_chord_root=20.0,           # 翼根が長い三角形
    wing_chord_tip=2.0,
    wing_sweep_deg=45.0,
    wing_dihedral_deg=0.0,
    wing_color=(0.9, 0.3, 0.3),
    htail_enabled=False,            # 水平尾翼なし
    fuselage_length=24.0,
    nose_length=10.0,
)

# ---- 5. カナード機 ----
CANARD = PlaneSpec(
    name="canard",
    wing_span=45.0,
    wing_chord_root=8.0,
    wing_chord_tip=5.0,
    wing_sweep_deg=10.0,
    wing_position_z=-3.0,           # 主翼を後ろ寄りに
    wing_color=(1.0, 0.7, 0.0),
    htail_enabled=False,            # 水平尾翼の代わりにカナード
    canard_enabled=True,
    canard_span=18.0,
    canard_chord=4.0,
    canard_position_z=14.0,
    canard_color=(0.4, 1.0, 0.4),
)

# ---- 6. 全翼機（フライング・ウィング）----
FLYING_WING = PlaneSpec(
    name="flying_wing",
    fuselage_length=10.0,           # ほぼ胴体無し
    fuselage_width=4.0,
    fuselage_height=2.0,
    nose_length=2.0,
    wing_span=60.0,
    wing_chord_root=18.0,
    wing_chord_tip=4.0,
    wing_sweep_deg=30.0,
    wing_dihedral_deg=2.0,
    wing_position_z=0.0,
    wing_position_y=0.0,
    wing_color=(0.6, 0.4, 0.8),
    htail_enabled=False,
    vtail_enabled=False,             # 垂直尾翼もなし（実機は翼端ウィングレット）
)

# ---- 7. 複葉機 ----
BIPLANE = PlaneSpec(
    name="biplane",
    wing_span=45.0,
    wing_chord_root=8.0,
    wing_chord_tip=8.0,
    wing_color=(0.95, 0.7, 0.3),
    wing2_enabled=True,
    wing2_offset_y=-7.0,             # 主翼の下に2枚目
    wing2_offset_z=2.0,
    fuselage_length=28.0,
    fuselage_width=3.0,
    fuselage_height=4.0,
)

# ---- 8. 上反角強め（V字翼）----
HIGH_DIHEDRAL = PlaneSpec(
    name="high_dihedral",
    wing_span=50.0,
    wing_chord_root=8.0,
    wing_chord_tip=8.0,
    wing_dihedral_deg=15.0,          # かなり強い
    wing_color=(0.5, 0.9, 0.5),
)


# プリセット辞書
PRESETS = {
    "default":       DEFAULT_GLIDER,
    "high_ar":       HIGH_ASPECT_RATIO,
    "swept":         SWEPT_WING,
    "delta":         DELTA_WING,
    "canard":        CANARD,
    "flying_wing":   FLYING_WING,
    "biplane":       BIPLANE,
    "high_dihedral": HIGH_DIHEDRAL,
}


def get_preset(name: str) -> PlaneSpec:
    if name not in PRESETS:
        avail = ", ".join(PRESETS.keys())
        raise ValueError(f"unknown preset '{name}'. available: {avail}")
    return PRESETS[name]


def list_presets() -> str:
    lines = ["Available presets:"]
    for k, v in PRESETS.items():
        lines.append(f"  {k:<14}  span={v.wing_span:.0f}  sweep={v.wing_sweep_deg:.0f}deg  dihedral={v.wing_dihedral_deg:.0f}deg")
    return "\n".join(lines)
