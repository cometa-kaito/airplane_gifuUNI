// =============================================================
//  secrets.example.h
//  ESP-NOW 暗号化に使う鍵 (16バイトずつ)。
//
//  使い方:
//    1. このファイルを secrets.h にコピー
//    2. PMK / LMK を機体ペアごとに自分で生成した値に書き換える
//       （openssl rand -hex 16  などで生成可）
//    3. 機体側 / 地上側の secrets.h は **完全に同じ値** にする
//
//  secrets.h は .gitignore で除外しているので Git に上がらない。
// =============================================================
#pragma once

#include <stdint.h>

// 通信全体の暗号化鍵 (Primary Master Key)
static const uint8_t ESPNOW_PMK[16] = {
  'C','H','A','N','G','E','_','M','E','_','P','M','K','!','!','!'
};

// ペアごとの個別鍵 (Local Master Key)
static const uint8_t ESPNOW_LMK[16] = {
  'C','H','A','N','G','E','_','M','E','_','L','M','K','!','!','!'
};
