import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        glider: {
          bg: "#0f1419",
          panel: "#181d24",
          accent: "#4dabf7",
          roll: "#ff6b6b",
          pitch: "#51cf66",
          yaw: "#4dabf7",
          servo0: "#ff922b",
          servo1: "#ffd43b",
          servo2: "#a9e34b",
        },
      },
      fontFamily: {
        mono: ["Consolas", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
