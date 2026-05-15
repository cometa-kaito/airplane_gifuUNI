import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        glider: {
          bg:        "#060912",
          surface:   "#0b1018",
          panel:     "#131922",
          panelHi:   "#1a212d",
          border:    "#232b39",
          borderHi:  "#2e3849",
          text:      "#f1f5f9",
          textDim:   "#94a3b8",
          textMute:  "#64748b",
          accent:    "#38bdf8",
          accentDim: "#0284c7",
          ok:        "#22c55e",
          warn:      "#f59e0b",
          err:       "#ef4444",
          roll:      "#ff5d6c",
          pitch:     "#3ddc97",
          yaw:       "#5cc8ff",
          servo0:    "#ff922b",
          servo1:    "#ffd43b",
          servo2:    "#a9e34b",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Consolas", "Menlo", "monospace"],
        display: ["Inter", "Noto Sans JP", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px rgba(0,0,0,0.25)",
        glow: "0 0 0 1px rgba(56,189,248,0.5) inset, 0 0 18px rgba(56,189,248,0.25)",
        glowOk: "0 0 0 1px rgba(34,197,94,0.5) inset, 0 0 18px rgba(34,197,94,0.25)",
        glowErr: "0 0 0 1px rgba(239,68,68,0.5) inset, 0 0 18px rgba(239,68,68,0.25)",
      },
      animation: {
        pulseLive: "pulseLive 1.6s ease-out infinite",
        pulseWarn: "pulseWarn 1.2s ease-out infinite",
        fadeIn: "fadeIn 0.4s ease-out",
      },
      keyframes: {
        pulseLive: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(34,197,94,0.7)" },
          "50%":     { boxShadow: "0 0 0 6px rgba(34,197,94,0)" },
        },
        pulseWarn: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(239,68,68,0.7)" },
          "50%":     { boxShadow: "0 0 0 6px rgba(239,68,68,0)" },
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
