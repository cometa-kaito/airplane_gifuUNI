# 環境構築手順

## 1. Arduino IDE 環境

### 1-1. ボードマネージャ URL 追加

Arduino IDE → **ファイル** → **環境設定** → **追加のボードマネージャの URL** に以下を改行区切りで追加：

```
https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

### 1-2. ボードパッケージのインストール

**ツール → ボード → ボードマネージャ** で以下を検索・インストール：

| パッケージ名 | 用途 |
|---|---|
| **Seeed nRF52 mbed-enabled Boards** | XIAO nRF52840 Sense 用（mbed なし版ではなく **mbed-enabled** 側） |
| **esp32 by Espressif Systems** | XIAO ESP32-C3 用 |

### 1-3. ライブラリのインストール

**スケッチ → ライブラリをインクルード → ライブラリを管理** で：

| ライブラリ | 検索キーワード | 用途 |
|---|---|---|
| Seeed Arduino LSM6DS3 | `LSM6DS3` | IMU 読み取り |
| Madgwick | `Madgwick` | 姿勢推定 |
| Servo | `Servo` | サーボ制御（多くの場合既に標準で入っている） |

### 1-4. LSM6DS3 ライブラリの mbed 互換修正

mbed-enabled の nRF52840 で `Seeed_Arduino_LSM6DS3` を使うとコンパイルエラーが出る既知の問題に対処：

ファイル：`C:\Users\<ユーザー>\Documents\Arduino\libraries\Seeed_Arduino_LSM6DS3\LSM6DS3.cpp`
108 行目付近を編集：

```cpp
#ifdef ESP32
            SPI.setBitOrder(SPI_MSBFIRST);
#elif defined(ARDUINO_XIAO_RA4M1)
            // noting
#elif defined(ARDUINO_ARCH_NRF52840) || defined(ARDUINO_ARCH_MBED) || defined(ARDUINO_ARCH_MBED_NRF52840)
            // MbedSPI has no setBitOrder; default is MSB first
#else
            SPI.setBitOrder(MSBFIRST);
#endif
```

`#elif defined(ARDUINO_ARCH_NRF52840) ...` の 2 行を追加することで、SPI モード使用時のみ呼ばれる関数のコンパイルを回避。Lesson16 などは I2C モードで使うので機能には影響なし。

### 1-5. ボード選択

書き込むスケッチに応じて：

| スケッチ | ボード設定 |
|---|---|
| `glider_nRF52840.ino` | **Seeed nRF52 mbed-enabled Boards → Seeed XIAO nRF52840 Sense** |
| `glider_ESP32C3_aircraft.ino` | **esp32 → XIAO_ESP32C3** |
| `glider_ESP32C3_ground.ino` | **esp32 → XIAO_ESP32C3** |

## 2. Python ビューア環境

### 2-1. Python 3.10 以上をインストール

[python.org](https://www.python.org/downloads/) から Python 3.10+ をインストール。インストール時に **「Add Python to PATH」にチェック**。

### 2-2. 仮想環境作成

PowerShell で：

```powershell
# 演習プログラムフォルダに移動
cd "C:\Users\20051\Desktop\岐阜大学航空授業資料\クラスの資料_202604101029\制御系サンプルプログラム等\30_演習プログラム"

# 仮想環境を作成（初回のみ）
python -m venv .venv

# 有効化
.\.venv\Scripts\activate
```

⚠️ 「スクリプトの実行が無効になっている」エラーが出たら：
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### 2-3. 依存パッケージのインストール

```powershell
pip install -r ..\自作\python_viewer\requirements.txt
```

または公式版：
```powershell
pip install -r 40_GraphAndViewer\requirements.txt
```

主要パッケージ：
- `pyserial` 3.5（USB シリアル）
- `matplotlib` 3.10+（2D グラフ）
- `PyOpenGL` 3.1+（3D 描画）

### 2-4. ビューア起動例

```powershell
# 高機能 3D ビューア
python ..\自作\python_viewer\glider_viewer3d.py --port COM12

# 機体テンプレート切り替え
python ..\自作\python_viewer\glider_viewer3d.py --port COM12 --preset swept

# シンプルな 2D 標準ビューア
python ..\自作\python_viewer\viewer_serialsend.py --port COM12

# CSV ログ保存しながら
python ..\自作\python_viewer\viewer_serialsend.py --port COM12 --save flight.csv
```

`COM12` は地上側 ESP32-C3 #1 の COM 番号。Arduino IDE のシリアルポートメニューで確認。

## 3. 文字化け対策

すべてのファイルは **UTF-8（BOM なし）** で保存。Windows のメモ帳で開いて保存し直すと BOM が付くことがあるので、Visual Studio Code や Notepad++ などのエディタを使う。

Arduino IDE 2.x は UTF-8 を扱える。
Python 3 はデフォルトで UTF-8。スクリプト先頭に `# -*- coding: utf-8 -*-` を入れておくと旧バージョンでも安全。

## 4. トラブルシューティング

| 症状 | 対処 |
|---|---|
| ESP32-C3 が「NO BOARDS FOUND」 | ボードを手動で **XIAO_ESP32C3** に設定。BOOT ボタンを押しながら USB 接続でブートローダモード |
| 書き込み時 `port is busy` | シリアルモニタ・他の Python プロセス・PuTTY などを閉じる |
| LSM6DS3 で SPI 関連コンパイルエラー | §1-4 の修正を適用 |
| Python `Could not open port` | Arduino IDE シリアルモニタを閉じる |
| 3D ビューアが `freeglut.dll not found` | `pip install freeglut` または freeglut.dll を Python フォルダへ手動配置 |
| 文字化け | エディタで UTF-8 として再保存。BOM なしを推奨 |
