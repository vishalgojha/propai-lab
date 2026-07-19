/** @type {import('tailwindcss').Config} */
// Brand tokens - mirrored from app/design-tokens.ts for consistency
// Smoothest approach: keep both files updated in sync, divergence flagged.
// Motion tokens (durations/easing) & dataviz palette are synced with frontend/src/lib/design-tokens.ts
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: '#000000',
        'bg-elevated': '#0d1117',
        'text-primary': '#ffffff',
        'text-secondary': '#a1a1aa',
        'text-muted': '#71717a',
        accent: '#3EE88A',
        'accent-hover': '#2ed87a',
        'border-subtle': 'rgba(255,255,255,0.06)',
        'border-strong': 'rgba(255,255,255,0.12)',
        'card-bg': '#0d1117',
        'input-bg': '#18181b',
        // Data-viz palette (Phase 0): for charts/graphs only — never for buttons/links
        'dataviz-1': '#F59E0B',  // amber
        'dataviz-2': '#8B5CF6',  // violet
        'dataviz-3': '#F43F5E',  // rose
        'dataviz-4': '#06B6D4',  // cyan
        'dataviz-5': '#84CC16',  // lime
      },
      transitionDuration: {
        'fast': '150ms',
        'base': '250ms',
        'slow': '400ms',
      },
      transitionTimingFunction: {
        'standard': 'cubic-bezier(0.4, 0, 0.2, 1)',
        'expressive': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}