import type { Config } from "tailwindcss";

const config: Config = {
  theme: {
    extend: {
      colors: {
        asphalt: "#16252B",
        "monsoon-teal": "#287D82",
        mist: "#DDE8E5",
        "signal-lime": "#8BCB68",
        "taxi-amber": "#E0A52B",
        "alert-vermilion": "#C94B3F",
        ink: "#16252B",
        "ink-2": "#20343A",
        parchment: "#DDE8E5",
        "parchment-dim": "#C9D9D5",
        signal: "#8BCB68",
        "signal-dim": "#287D82",
        // Legacy emerald utilities are still present across older workspace
        // screens. Keep them on PropAI's signal ramp instead of Tailwind's
        // mint ramp so old and new components share the same action color.
        emerald: {
          100: "#CFE4D0",
          200: "#A5DD83",
          300: "#8BCB68",
          400: "#287D82",
          500: "#23666A",
          600: "#23666A",
          700: "#1B4D50",
          800: "#163B3E",
          900: "#16252B",
        },
        amber: "#E0A52B",
        brokerGrey: "#AFC1BD",
        line: "rgba(221, 232, 229, 0.16)",
        "line-on-light": "rgba(22, 37, 43, 0.16)",
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
