# 自律滑空機 自作プログラム集

岐阜大学 機械工学概論II「自律滑空機」プロジェクト用に作成した、機体制御プログラム・地上 UI・ドキュメント一式です。
機体（nRF52840）で姿勢推定（Madgwick）＋3軸 PID 制御を行い、ESP-NOW 無線で地上 PC と接続。
ブラウザ（**WebSerial**）から設定・チューニング・監視ができます。

🌐 **Web UI（公開・インストール不要）**: <https://webui-self.vercel.app>
　Chrome / Edge で開き、地上機を USB 接続して使用します（Python 等のサーバ不要）。

📦 **ファーム**は本リポジトリ `arduino/` を `git clone` または GitHub の **Code → Download ZIP** で入手。

## ディレクトリ構成

```
自作/
├── README.md                              ← このファイル（全体案内）
├── arduino/                               ファーム（Arduino スケッチ 3 種）
│   ├── glider_nRF52840/                   nRF52840 Sense（機体制御: IMU + PID + サーボ）
│   ├── glider_ESP32C3_aircraft/           機体側 ESP32-C3（ESP-NOW ↔ UART）
│   └── glider_ESP32C3_ground/             地上側 ESP32-C3（USB ↔ ESP-NOW）
│       （各 ESP32: espnow_uart_bridge / uart_line_protocol / secrets.example.h）
├── webui/                                 Web UI（Next.js + Tailwind + R3F）。WebSerial 専用。本番は Vercel
├── python_viewer/                         PyQt 3D ビューア等（任意・オフライン解析）
│   ├── glider_viewer3d.py                 高機能 3D ビューア（HUD・ミニグラフ付）
│   ├── glider_templates.py                機体形状テンプレート集
│   ├── paperplane_glider.py               シンプル 3D 紙飛行機ビューア
│   ├── viewer_serialsend.py               標準 2D ビューア
│   └── requirements.txt / PROTOCOL_original.md
├── sim/                                   オートチューンの数値シミュレーション検証
├── archive/websocket/                     旧 WebSocket 経路（ground_station.py 等を退避）
└── docs/
    ├── HARDWARE_MAC.md                    MAC アドレス・ハードウェア構成
    ├── WIRING.md                          配線ガイド
    ├── COMMANDS.md                        無線コマンド一覧
    ├── SETUP.md                           環境構築手順
    └── CONTROL_STRATEGY_REPORT.md         制御方針レポート
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

### 3. Web UI を開いて操作（WebSerial）

ブラウザ（**Chrome / Edge**）から操作します。Python 等のサーバは不要です。

- 公開版（インストール不要）: <https://webui-self.vercel.app>
- ローカルで動かす場合:
  ```powershell
  cd webui
  npm install
  npm run dev      # http://localhost:3000 （WebSerial は localhost でも動作）
  ```

地上機を USB 接続して **▶ Connect Device** → 画面を上から順に設定します。

### 4.（任意）オフライン解析: PyQt 3D ビューア
```powershell
.\.venv\Scripts\activate          # 初回のみ作成（docs/SETUP.md）
python python_viewer\glider_viewer3d.py --port COM12 --preset default   # 3D ビューア
python python_viewer\viewer_serialsend.py --port COM12                  # 標準 2D ビューア
```
> 旧 WebSocket 経路（`ground_station.py` による「PyQt + WebSocket サーバ」運用）は、Web UI の
> WebSerial 専用化に伴い `archive/websocket/` へ退避しました。復元手順は同フォルダの README を参照。

## 詳細ドキュメント

| ドキュメント | 内容 |
|---|---|
| `docs/HARDWARE_MAC.md` | 各ボードの MAC アドレス、役割分担 |
| `docs/WIRING.md` | サーボ・Serial1 の配線 |
| `docs/COMMANDS.md` | 無線で送れるコマンド一覧 |
| `docs/SETUP.md` | Arduino IDE / Python 環境構築手順 |

## 飛行までの操作フロー（Pre-flight Workflow）

Web UI は **上から順に触る** ように UI が並んでいます:

```
Connect              Chrome / Edge で地上機を USB 接続（▶ Connect Device）
Step 0   Servo Cal          機械的中立 (center) + 可動域 min/max（µs）をドラッグ＋ライブジョグで較正
Step 0b  Flight Trim        飛行微調整トリム（度）。通常は 0。真っすぐ合わせは Step 0 の中立で行う
Step 1   Calibration        機体を水平に置いて Zero Now
Step 2   Safety             姿勢角しきい値 + Failsafe を設定
Step 3   Manual Check       MANUAL で D-Pad / 矢印キーで舵の効きを確認
Step 4   PID Gains          プリセット or 個別調整（D 項 LPF 含む）
Step 5   Launch             Phase Machine を Arm → 機体を投げる
Step 5b  Wind Tunnel        風洞でステップ応答測定（代替）
Step 5c  Full Auto Tune     Ziegler-Nichols 限界感度法で PID を自動算出・適用
```

### Flight Phase Machine (Step 5)

機体側ファームウェアには `docs/CONTROL_STRATEGY_REPORT.md` の P0-1/P0-2 方針に従ったフェーズマシンを実装してあります:

```
DISARMED → (arm) → PRELAUNCH → (|a|>launch_g) → LAUNCH (climb-out)
                                              → (climb_ms 経過) → GLIDE
                                              → (`land` / 🛬 Land ボタン) → DISARMED (trim=0)
                                              → (`disarm`)                → DISARMED (trim 維持)
```

| Phase | 制御 | 目標 pitch | サーボ |
|---|---|---|---|
| DISARMED / PRELAUNCH | MANUAL | - | trim |
| LAUNCH (初頭 500ms) | PID ゼロホールド | - | trim + climb_ff |
| LAUNCH (残り) | AUTO/PID | climb_pitch (+15°) | PID 出力 + climb_ff |
| GLIDE | AUTO/PID | glide_pitch (+3°) | PID 出力 |

旧 `PHASE_LANDED` (フェーズ 4) は DISARMED と機能的に同じため統合済 (`land` コマンドが trim=0 リセット付きで DISARMED に戻す形に変更)。`disarm` は trim を維持して DISARMED へ。

- **armed 中 (DISARMED 以外) は failsafe 抑制** — 地上局接続が落ちても飛行を継続できます。
- **LAUNCH 直後の 500ms は PID 出力ゼロホールド** — Madgwick が投擲ショックから復帰する猶予。
- **LAUNCH 中のエレベータ feed-forward** — `climb_ff` (既定 +5°) を加算し機首上げを補助。
- **飛行終了は手動のみ** — `land` (trim リセット付き) / `disarm` (trim 維持) を手動で押す。
  飛行中の安定滑空でも |a|≈1g + 一瞬の静止で誤発火するリスクがあるため、自動着地検出は**意図的に実装していない**。
  GLIDE フェーズは時間制限なし。地上から回収するタイミングで人が判断して Land or Disarm を押す運用。
- **`land` と `disarm` の違い** — 機能的には同じ DISARMED フェーズに戻るが、`land` は trim を 0 にリセット (飛行終了の意味)、`disarm` は trim を維持 (PRELAUNCH キャンセル時にユーザ設定値を守る)。

### 風洞試験モード (Step 5b)

風洞で機体を支柱固定して PID 応答を測定する場合、通常のフェーズマシン（投擲検知付き）ではなく独立した `PHASE_WINDTUNNEL` モードを使います。

WebUI: Step 5 の下の **「▸ 5b · Wind Tunnel · 風洞試験モード（代替）」** を展開。

| 抑制される機能 | 理由 |
|---|---|
| tilt safeguard | 支柱で大角度に固定する場合があるため |
| failsafe | 測定中の地上局離席を許容 |
| climb_ff (feed-forward) | 純粋な PID 応答が見たい |
| 自動フェーズ遷移 (LAUNCH/LANDED) | 風洞では不要 |

操作: 「🌬 Enter Wind Tunnel」→ target_pitch / target_roll をスイープ → CSV ログを取得 → 「Exit (Disarm)」。
クイックボタン (±5°、±10°) でステップ応答を素早く取れます。

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
