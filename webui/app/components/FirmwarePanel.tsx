"use client";

/**
 * FirmwarePanel — ファームの入手先（GitHub）案内と、機体ペアリングの手順。
 *
 * 公開版（WebSerial 専用 UI）向け。ファーム配布は GitHub の公開リポジトリへ一本化し、
 * Web ページからの zip 配布は廃止。各自が
 *   1. GitHub から取得（git clone / Download ZIP）して 3 スケッチを書き込み
 *   2. secrets.h を用意（PMK/LMK を両機で一致させる）
 *   3. ESP-NOW の相手 MAC を `/setpeer` で指定（地上機・機体の双方）
 * すれば自分の機体で使えるようになる。`/mac` 読取ボタンのみ補助。
 */

const REPO_URL = "https://github.com/cometa-kaito/airplane_gifuUNI";
const ARDUINO_URL = REPO_URL + "/tree/main/arduino";

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
          Firmware · 入手 &amp; 機体ペアリング（初回セットアップ）
        </span>
      </summary>

      <div className="px-5 pb-5 pt-1 space-y-4">
        <p className="text-sm text-slate-600 leading-relaxed">
          ファーム（Arduino スケッチ一式）は <strong>GitHub の公開リポジトリ</strong>で配布しています。
          <code className="font-mono text-slate-800 bg-slate-100 px-1 rounded">git clone</code> または
          GitHub の <strong>Code → Download ZIP</strong> で入手 → 書き込み → ESP-NOW の相手 MAC を{" "}
          <code className="font-mono text-slate-800 bg-slate-100 px-1 rounded">/setpeer</code> で指定します。
          地上機を USB 接続すれば、この画面（WebSerial）から操作できます。
        </p>

        <div className="flex items-center gap-3 flex-wrap">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            GitHub リポジトリを開く
          </a>
          <a
            href={ARDUINO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] text-indigo-600 hover:text-indigo-700 underline"
          >
            arduino/ フォルダを見る →
          </a>
        </div>

        <ol className="text-sm text-slate-600 leading-relaxed list-decimal pl-5 space-y-1.5">
          <li>
            GitHub から取得（<code className="font-mono text-slate-800 bg-slate-100 px-1 rounded">git clone</code> /
            Download ZIP）し、<code className="font-mono text-slate-800 bg-slate-100 px-1 rounded">arduino/</code> 内の
            3 スケッチを各ボードへ書き込む（地上機 ESP32-C3 / 機体 ESP32-C3 / nRF52840）。
          </li>
          <li>
            各 ESP32-C3 の{" "}
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
