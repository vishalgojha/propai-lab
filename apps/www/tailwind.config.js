/** @type {import('tailwindcss').Config} */
// Brand tokens - mirrored from app/design-tokens.ts for consistency
// Smoothest approach: keep both files updated in sync, divergence flagged.
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
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}