import type { Config } from "tailwindcss";

/**
 * Glider WebUI — Light, modern, minimalist design system
 *
 * 設計原則 (ユーザ要件):
 *   - クリーンな白基調、ホワイトスペースを多く取る
 *   - テキストは slate-800 (#1e293b)、真の黒は避ける
 *   - プライマリアクセントは indigo 1 色のみ
 *   - 角丸は rounded-md 〜 rounded-lg
 *   - 区切りは濃い border でなく shadow-sm or 微妙な背景差
 *   - 見出し/本文/補足のサイズ・太さで階層を明示
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        glider: {
          // Surfaces (light theme)
          bg:        "#f8fafc", // slate-50  — page background
          surface:   "#ffffff", // white      — card background
          panel:     "#ffffff", // alias
          panelHi:   "#f1f5f9", // slate-100  — sunken / recessed
          border:    "#e2e8f0", // slate-200  — subtle border (使うのは控えめに)
          borderHi:  "#cbd5e1", // slate-300  — slightly stronger
          // Text hierarchy (avoid pure black)
          text:      "#1e293b", // slate-800  — primary text
          textDim:   "#475569", // slate-600  — supporting
          textMute:  "#94a3b8", // slate-400  — tertiary / hints
          // Single primary accent (indigo) — 主要アクション専用
          accent:    "#4f46e5", // indigo-600
          accentDim: "#4338ca", // indigo-700 (hover)
          // Semantic states (主要アクセントとは別軸、控えめに)
          ok:        "#059669", // emerald-600
          warn:      "#d97706", // amber-600
          err:       "#dc2626", // red-600
          // Identity colors for axes / servos (chart/3D viewer のみで使用)
          roll:      "#e11d48", // rose-600
          pitch:     "#059669", // emerald-600
          yaw:       "#0284c7", // sky-600
          servo0:    "#ea580c", // orange-600
          servo1:    "#ca8a04", // yellow-600
          servo2:    "#65a30d", // lime-600
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Consolas", "Menlo", "monospace"],
        display: ["Inter", "Noto Sans JP", "system-ui", "sans-serif"],
      },
      boxShadow: {
        // 階層は薄いシャドウで表現 (border の代替)
        card:   "0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)",
        cardHi: "0 4px 6px -1px rgb(15 23 42 / 0.07), 0 2px 4px -2px rgb(15 23 42 / 0.05)",
        glow:    "0 0 0 3px rgba(79,70,229,0.12)",
        glowOk:  "0 0 0 3px rgba(5,150,105,0.12)",
        glowErr: "0 0 0 3px rgba(220,38,38,0.12)",
      },
      animation: {
        pulseLive: "pulseLive 1.8s ease-out infinite",
        pulseWarn: "pulseWarn 1.4s ease-out infinite",
        fadeIn: "fadeIn 0.4s ease-out",
      },
      keyframes: {
        pulseLive: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(5,150,105,0.4)" },
          "50%":     { boxShadow: "0 0 0 8px rgba(5,150,105,0)" },
        },
        pulseWarn: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(220,38,38,0.4)" },
          "50%":     { boxShadow: "0 0 0 8px rgba(220,38,38,0)" },
        },
        fadeIn: {
          "0%":   { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
