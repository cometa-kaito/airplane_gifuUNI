# 自律滑空機 自作プログラム集

岐阜大学 機械工学概論II「自律滑空機」プロジェクト用に作成した、機体制御プログラム・地上ビューア・ドキュメント一式です。

## ディレクトリ構成

```
自作/
├── README.md                              ← このファイル（全体案内）
├── arduino/
│   ├── glider_nRF52840/                   nRF52840 Sense（機体制御）
│   │   └── glider_nRF52840.ino
│   ├── glider_ESP32C3_aircraft/           機体側 ESP32-C3（無線中継）
│   │   ├── glider_ESP32C3_aircraft.ino
│   │   ├── espnow_uart_bridge.h/.cpp
│   │   └── uart_line_protocol.h/.cpp
│   └── glider_ESP32C3_ground/             地上側 ESP32-C3（無線中継）
│       ├── glider_ESP32C3_ground.ino
│       ├── espnow_uart_bridge.h/.cpp
│       └── uart_line_protocol.h/.cpp
├── python_viewer/
│   ├── glider_viewer3d.py                 高機能 3D ビューア（HUD・ミニグラフ付）
│   ├── glider_templates.py                機体形状テンプレート集
│   ├── paperplane_glider.py               シンプル 3D 紙飛行機ビューア
│   ├── viewer_serialsend.py               標準 2D ビューア（公式版コピー）
│   ├── requirements.txt                   Python 依存パッケージ
│   └── PROTOCOL_original.md               公式プロトコル仕様
└── docs/
    ├── HARDWARE_MAC.md                    MAC アドレス・ハードウェア構成
    ├── WIRING.md                          配線ガイド
    ├── COMMANDS.md                        無線コマンド一覧
    └── SETUP.md                           環境構築手順
```

## 全体システム構成

```
[XIAO nRF52840 Sense]              [XIAO ESP32-C3 #2]              [XIAO ESP32-C3 #1]      [PC]
  IMU + Madgwick                    Serial1 <-> ESP-NOW             ESP-NOW <-> USB         シリアルモニタ
  3軸 PID 制御                                                                              + Python ビューア
  サーボ D0/D1/D2
   |
   | Serial1 (D6 TX / D7 RX)
   v
  機体側 UART  ── 無線(ESP-NOW 2.4GHz) ──→  地上側 UART  ── USB ──→  PC
```

## クイックスタート

### 1. Arduino IDE で 3 つのスケッチを書き込む
- `arduino/glider_nRF52840/glider_nRF52840.ino` → nRF52840 Sense
- `arduino/glider_ESP32C3_aircraft/glider_ESP32C3_aircraft.ino` → 機体側 ESP32-C3
- `arduino/glider_ESP32C3_ground/glider_ESP32C3_ground.ino` → 地上側 ESP32-C3

書き込み前に各 ESP32 スケッチフォルダの `secrets.example.h` を `secrets.h` にコピーし、PMK / LMK を自分で生成した値に書き換える（機体・地上で同じ値）。

### 2. ペアリング（初回のみ）
両 ESP32-C3 をシリアルモニタに繋ぎ、`/mac` で MAC を確認。  
それぞれで `/setpeer XX:XX:XX:XX:XX:XX`（相手の MAC）を打つと NVS に保存され自動再起動する。

### 3. Python 地上局を起動
```powershell
# 仮想環境を有効化（初回のみ作成、詳細は docs/SETUP.md）
.\.venv\Scripts\activate

# 地上局（PyQt UI + 3D ペイン + WebSocket サーバ。WebUI からの操作も可能）
python python_viewer\ground_station.py --port COM12

# 3D ビューア単独版（テレメトリ閲覧のみ）
python python_viewer\glider_viewer3d.py --port COM12 --preset default

# 標準 2D ビューア（生データ可視化）
python python_viewer\viewer_serialsend.py --port COM12
```

### 4. （任意）WebUI を立ち上げる
```powershell
cd webui
npm install
npm run dev
# ブラウザで http://localhost:3000
```
WebSocket モードでコマンド操作したい場合は ground_station 側で **「Accept WS commands」** チェックボックスを ON にする。

## 詳細ドキュメント

| ドキュメント | 内容 |
|---|---|
| `docs/HARDWARE_MAC.md` | 各ボードの MAC アドレス、役割分担 |
| `docs/WIRING.md` | サーボ・Serial1 の配線 |
| `docs/COMMANDS.md` | 無線で送れるコマンド一覧 |
| `docs/SETUP.md` | Arduino IDE / Python 環境構築手順 |

## 飛行までの操作フロー（Pre-flight Workflow）

WebUI / Python 地上局のいずれも、**上から順に触る** ように UI が並んでいます:

```
Step 0  Connect            USB or WebSocket でデバイス接続
Step 1  Calibration        機体を水平に置いて Zero Now
Step 2  Safety             姿勢角しきい値 + Failsafe を設定
Step 3  Trim & Mode        D-Pad / 矢印キーで MANUAL トリム調整
Step 4  PID Gains          Soft / Default / Responsive プリセット or 個別調整
Step 5  Launch             Phase Machine を Arm → 機体を投げる
```

### Flight Phase Machine (Step 5)

機体側ファームウェアには `docs/CONTROL_STRATEGY_REPORT.md` の P0-1/P0-2 方針に従ったフェーズマシンを実装してあります:

```
DISARMED → (arm) → PRELAUNCH → (|a|>launch_g) → LAUNCH (climb-out)
                                              → (climb_ms 経過) → GLIDE
                                              → (|az|<landed_g 持続) → LANDED → (disarm) → DISARMED
```

| Phase | 制御 | 目標 pitch | サーボ |
|---|---|---|---|
| DISARMED / PRELAUNCH | MANUAL | - | trim |
| LAUNCH (初頭 500ms) | PID ゼロホールド | - | trim + climb_ff |
| LAUNCH (残り) | AUTO/PID | climb_pitch (+15°) | PID 出力 + climb_ff |
| GLIDE | AUTO/PID | glide_pitch (+3°) | PID 出力 |
| LANDED | MANUAL + trim=0 | - | 中立 |

- **armed 中 (DISARMED 以外) は failsafe 抑制** — 地上局接続が落ちても飛行を継続できます。
- **LAUNCH 直後の 500ms は PID 出力ゼロホールド** — Madgwick が投擲ショックから復帰する猶予。
- **LAUNCH 中のエレベータ feed-forward** — `climb_ff` (既定 +5°) を加算し機首上げを補助。
- **LANDED 自動検出** — `|az|<landed_g` が `landed_ms` 連続したらサーボ中立で停止。

### D 項のソース (P0-3)

`d_source` コマンドで切替可能:

- `d_source gyro` (**既定**) — ジャイロ生値を直接 D 項に使う (Lesson17 推奨方式)。Madgwick の積分出力を経由しない分、位相遅れとノイズ増幅が小さい。`dfilter` 不要。
- `d_source error` — 従来の `(e - prevE)/dt + dfilter LPF`。後方互換用。

ジャイロ直接モードでは Kd の単位が同じ deg/s のままなので、既存ゲインから始めて微調整可能。

## 開発履歴サマリ

- **Lesson01〜04**：LED・Serial 基礎
- **Lesson16**：単軸 PID 制御 + IMU + サーボ
- **example03 読解**：3軸モード管理付き機体制御
- **Lesson12〜14**：ESP-NOW 無線通信構築（MAC 確認・1行通信・サーボ遠隔操作）
- **Exercise05+**：3軸独立 PID + 拡張テレメトリ + 個別サーボ操作（本リポジトリ収録版）
- **Python ビューア**：2D/3D 両方、機体テンプレート切替対応
- **自律飛行モード**: 投擲検知 (`arm`/`launch_g`) + PID anti-windup + Pre-flight Workflow UI
