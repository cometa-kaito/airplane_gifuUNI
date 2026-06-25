#!/usr/bin/env python3
"""
build-firmware-zip.py — 配布用ファーム zip を生成する。

  入力 : <repo>/arduino/  フォルダ一式
  出力 : <repo>/webui/public/firmware/glider_firmware.zip
  zip 内トップ階層は "arduino/"（展開すると arduino/glider_ESP32C3_ground/... になる）

除外:
  - secrets.h            … ESP-NOW 実鍵を含むため絶対に同梱しない（secrets.example.h は残す）
  - arduino/arduino/     … 過去のネスト重複コピー
  - *.zip                … 紛れ込んだバックアップ zip
  - build / __pycache__ / .vs … ビルド中間物

使い方:
  webui/ から  `npm run build:firmware`
  もしくは     `python webui/scripts/build-firmware-zip.py`

ファームを更新したら本スクリプトを再実行 → 再デプロイで配布物が更新される。
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))  # webui/scripts -> webui -> repo root
ARDUINO = os.path.join(REPO_ROOT, "arduino")
OUT_DIR = os.path.join(REPO_ROOT, "webui", "public", "firmware")
OUT = os.path.join(OUT_DIR, "glider_firmware.zip")

SKIP_DIRS = {"arduino", "build", "__pycache__", ".vs", ".git"}  # "arduino" = ネスト重複
SKIP_FILE_NAMES = {"secrets.h"}
SKIP_EXTS = {".zip"}

README = """Glider Firmware (arduino フォルダ一式 / WebSerial 公開版)
======================================================
含まれるもの (arduino/):
  glider_ESP32C3_ground/    地上機ブリッジ (PC USB <-> ESP-NOW)
  glider_ESP32C3_aircraft/  機体ブリッジ  (ESP-NOW <-> nRF52840 UART)
  glider_nRF52840/          フライトコントローラ (IMU + PID + サーボ)

※ secrets.h は配布に含めません（ESP-NOW の実鍵のため）。
  各 ESP32-C3 で secrets.example.h を secrets.h にコピーして使ってください。

セットアップ:
  1. Arduino IDE で 3 スケッチを各ボードへ書き込む。
  2. secrets.example.h を secrets.h にコピーし、PMK / LMK を
     地上機・機体で「同じ値」に書き換える (openssl rand -hex 16 等)。
  3. 各 ESP32-C3 を USB 接続し /mac で自分の MAC を確認。
  4. /setpeer AA:BB:CC:DD:EE:FF で相手の MAC を設定 (地上機<->機体の双方向)。
     ※ NVS 保存後に自動再起動。USB(WebSerial) は一旦切れるので再接続する。
  5. 地上機を PC に USB 接続し、Web UI の Connect Device で接続。

ローカルコマンド (ESP32-C3, USB シリアル経由):
  /mac /stat /help /setpeer <MAC> /unpair /channel <1-13>
"""


def main() -> int:
    if not os.path.isdir(ARDUINO):
        print(f"[ERR] arduino folder not found: {ARDUINO}", file=sys.stderr)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)

    count = 0
    leaked = []
    examples = []
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("arduino/README.txt", README)
        for dirpath, dirnames, filenames in os.walk(ARDUINO):
            # ネスト重複 arduino/arduino/ やビルド物を辿らない
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                ext = os.path.splitext(fn)[1].lower()
                if fn in SKIP_FILE_NAMES or ext in SKIP_EXTS:
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, ARDUINO).replace("\\", "/")
                arc = "arduino/" + rel
                z.write(full, arc)
                count += 1
                if fn == "secrets.h":
                    leaked.append(arc)
                if fn == "secrets.example.h":
                    examples.append(arc)

    size_kb = round(os.path.getsize(OUT) / 1024, 1)
    print(f"[OK] {os.path.relpath(OUT, REPO_ROOT)}  ({size_kb} KB, {count} files)")
    if leaked:
        print(f"[FATAL] secrets.h leaked into zip: {leaked}", file=sys.stderr)
        return 2
    print(f"[OK] secrets.h excluded; secrets.example.h kept: {len(examples)} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
