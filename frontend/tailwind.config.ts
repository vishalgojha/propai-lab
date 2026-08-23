import type { Config } from "tailwindcss";

const config: Config = {
  theme: {
    extend: {
      colors: {
        ink: "#12211A",
        "ink-2": "#1A2E22",
        parchment: "#F3EEE1",
        "parchment-dim": "#E9E2D0",
        signal: "#4FA678",
        "signal-dim": "#3E8F5F",
        // Legacy emerald utilities are still present across older workspace
        // screens. Keep them on PropAI's signal ramp instead of Tailwind's
        // mint ramp so old and new components share the same action color.
        emerald: {
          100: "#D7E6D9",
          200: "#A9C9B0",
          300: "#4FA678",
          400: "#3E8F5F",
          500: "#286B45",
          600: "#286B45",
          700: "#1F5336",
          800: "#173D29",
          900: "#12211A",
        },
        amber: "#D89B3C",
        brokerGrey: "#93A399",
        line: "rgba(243, 238, 225, 0.14)",
        "line-on-light": "rgba(18, 33, 26, 0.12)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "SFMono-Regular", "Consolas", "monospace"],
        voice: ["Instrument Serif", "Georgia", "serif"],
      },
    },
  },
};

export default config;
