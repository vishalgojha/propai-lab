/** @type {import('tailwindcss').Config} */
// Brand tokens - mirrored from app/design-tokens.ts for consistency
// Smoothest approach: keep both files updated in sync, divergence flagged.
// Motion tokens (durations/easing) & dataviz palette are synced with frontend/src/lib/design-tokens.ts
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: '#FAF7F0',
        'bg-alt-section': '#F3EEE3',
        'bg-inverted': '#2E2A22',
        'bg-elevated': '#FFFDF8',
        'text-primary': '#2E2A22',
        'text-secondary': '#6B6455',
        'text-muted': '#877D6B',
        accent: '#6B8E63',
        'accent-hover': '#56744F',
        'accent-soft': '#D8E3D0',
        'accent-forest': '#3F5A3A',
        'price-highlight': '#B5762C',
        'border-subtle': '#DDD4C0',
        'border-strong': '#C9BEA7',
        'card-bg': '#FFFDF8',
        'input-bg': '#FFFFFF',
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
        'expressive': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
