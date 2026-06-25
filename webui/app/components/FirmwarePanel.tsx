"use client";

/**
 * FirmwarePanel — ファーム一式のダウンロードと、機体ペアリングの案内。
 *
 * 公開版（誰でも使える WebSerial 専用 UI）向け。各自が
 *   1. ファーム zip を落として 3 スケッチを書き込み
 *   2. secrets.h を用意（PMK/LMK を両機で一致させる）
 *   3. ESP-NOW の相手 MAC を `/setpeer` で指定（地上機・機体の双方）
 * すれば自分の機体で使えるようになる。凝ったペアリング UI は持たず、
 * ダウンロード＋手順＋（安全な）`/mac` 読取ボタンのみ。`/setpeer` は再起動を
 * 伴うため手順として提示し、下の Advanced 生コマンド欄から打ってもらう。
 */

const FIRMWARE_ZIP = "/firmware/glider_firmware.zip";

export function FirmwarePanel({
  onSend,
  enabled,
}: {
  onSend: (cmd: string) => Promise<void>;
  enabled: boolean;
}) {
  return (
    <details className="rounded-xl bg-white shadow-card ring-1 ring-slate-200/60">
      <summary className="px-5 py-4 cursor-pointer select-none text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors">
        <span className="inline-flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Firmware · 書き込み &amp; 機体ペアリング（初回セットアップ）
        </span>
      </summary>

      <div className="px-5 pb-5 pt-1 space-y-4">
        <p className="text-sm text-slate-600 leading-relaxed">
          自分の機体で使うには、まずファーム一式を書き込み、ESP-NOW の相手 MAC を{" "}
          <code className="font-mono text-slate-800 bg-slate-100 px-1 rounded">/setpeer</code>{" "}
          で指定します。地上機を USB 接続するだけで、この画面（WebSerial）から操作できます。
        </p>

        <div className="flex items-center gap-3 flex-wrap">
          <a
            href={FIRMWARE_ZIP}
            download
            className="btn-primary inline-flex items-center gap-2"
          >
            ⬇ ファーム一式をダウンロード (.zip)
          </a>
          <span className="text-[11px] text-slate-500">
            3 スケッチ（地上機 / 機体 ESP32-C3 / nRF52840）＋ secrets.example.h を含む
          </span>
        </div>

        <ol className="text-sm text-slate-600 leading-relaxed list-decimal pl-5 space-y-1.5">
          <li>
            zip を展開し、Arduino IDE で 3 スケッチを各ボードへ書き込む
            （地上機 ESP32-C3 / 機体 ESP32-C3 / nRF52840）。
          </li>
          <li>
            <code className="font-mono text-slate-800 bg-slate-100 px-1 rounded">secrets.example.h</code>{" "}
            を{" "}
            <code className="font-mono text-slate-800 bg-slate-100 px-1 rounded">secrets.h</code>{" "}
            にコピーし、PMK / LMK を<strong>地上機・機体で同じ値</strong>に書き換える
            （<code className="font-mono">openssl rand -hex 16</code> 等で生成）。
          </li>
          <li>
            各 ESP32-C3 を USB 接続し{" "}
            <code className="font-mono text-slate-800 bg-slate-100 px-1 rounded">/mac</code>{" "}
            を送って<strong>自分の MAC</strong> を控える（地上機・機体それぞれ）。
          </li>
          <li>
            相手の MAC を{" "}
            <code className="font-mono text-slate-800 bg-slate-100 px-1 rounded">
              /setpeer AA:BB:CC:DD:EE:FF
            </code>{" "}
            で設定する。
            <span className="text-slate-500">
              {" "}地上機には<strong>機体の MAC</strong>を、機体には<strong>地上機の MAC</strong>を
              （双方向に必要）。NVS 保存後に自動再起動します。
            </span>
          </li>
          <li>
            地上機をこの PC に USB 接続して、上部の{" "}
            <strong>▶ Connect Device</strong> で接続。
          </li>
        </ol>

        <div className="text-[12px] leading-snug rounded-md border border-amber-300 bg-amber-50 text-amber-800 px-3 py-2">
          ⚠{" "}
          <code className="font-mono">/setpeer</code> ・{" "}
          <code className="font-mono">/channel</code> ・{" "}
          <code className="font-mono">/unpair</code>{" "}
          は地上機を再起動するため、USB（WebSerial）が一旦切れます。数秒後に
          <strong> ■ Disconnect → ▶ Connect Device</strong> で再接続してください。
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => void onSend("/mac").catch(() => {})}
            disabled={!enabled}
            className="btn-ghost text-xs"
            title="接続中の地上機の self / peer MAC・チャネルを表示（下の Device ログに出ます）"
          >
            /mac を送って MAC を確認
          </button>
          <span className="text-[11px] text-slate-500">
            結果は下の <strong>Advanced · デバイスログ</strong> に{" "}
            <code className="font-mono">[MAC] self=… peer=… ch=…</code> として表示。
            <code className="font-mono">/setpeer</code> 等は同じく Advanced の生コマンド欄から。
          </span>
        </div>
      </div>
    </details>
  );
}
