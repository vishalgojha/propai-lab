import type { Config } from "tailwindcss";

const config: Config = {
  theme: {
    extend: {
      colors: {
        asphalt: "#344E41",
        "monsoon-teal": "#588157",
        mist: "#DAD7CD",
        "signal-lime": "#A3B18A",
        "taxi-amber": "#A3B18A",
        "alert-vermilion": "#B94E45",
        ink: "#344E41",
        "ink-2": "#3A5A40",
        parchment: "#DAD7CD",
        "parchment-dim": "#A3B18A",
        signal: "#588157",
        "signal-dim": "#3A5A40",
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
