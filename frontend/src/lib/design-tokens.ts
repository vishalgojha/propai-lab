export const designTokens = {
  colors: {
    background: '#000000',
    backgroundElevated: '#0d1117',
    textPrimary: '#ffffff',
    textSecondary: '#a1a1aa',
    textMuted: '#71717a',
    accent: '#3EE88A',
    accentHover: '#2ed87a',
    border: 'rgba(255,255,255,0.06)',
    borderStrong: 'rgba(255,255,255,0.12)',
    cardBg: '#0d1117',
    inputBg: '#18181b',
    error: '#ef4444',
    // Data-viz palette (Phase 0): for charts/graphs only — never for buttons/links
    dataviz1: '#F59E0B',  // amber
    dataviz2: '#8B5CF6',  // violet
    dataviz3: '#F43F5E',  // rose
    dataviz4: '#06B6D4',  // cyan
    dataviz5: '#84CC16',  // lime
  },
  // Categorical palette for charts/graphs (Phase 4): ordered sequence seeded
  // from the 5 dataviz tokens, extended with harmonising hues so category
  // plots (e.g. NetworkMap localities) stay distinguishable. Charts only.
  datavizCategorical: [
    '#F59E0B', '#8B5CF6', '#F43F5E', '#06B6D4', '#84CC16',
    '#6366F1', '#14B8A6', '#FB923C', '#A855F7', '#22D3EE',
    '#FACC15', '#D946EF', '#4ADE80', '#F87171', '#818CF8',
    '#0EA5E9', '#E879F9', '#A3E635', '#FB7185', '#38BDF8',
  ],
  // Single-series accent for line/area charts (Phase 4).
  datavizSeries: '#06B6D4', // cyan
  typography: {
    display: { size: '32px', weight: '700', lineHeight: '1.1' },
    section: { size: '20px', weight: '600', lineHeight: '1.3' },
    body: { size: '15px', weight: '400', lineHeight: '1.6' },
    caption: { size: '12px', weight: '400', lineHeight: '1.5' },
  },
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
    xxl: '48px',
  },
  radius: {
    card: '12px',
    input: '8px',
    button: '10px',
  },
  shadows: {
    card: '0 4px 24px rgba(0,0,0,0.3)',
    dropdown: '0 8px 32px rgba(0,0,0,0.4)',
  },
  transitions: {
    fast: '150ms cubic-bezier(0.4, 0, 0.2, 1)',
    base: '250ms cubic-bezier(0.4, 0, 0.2, 1)',
    slow: '400ms cubic-bezier(0.4, 0, 0.2, 1)',
    expressive: '250ms cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
} as const;

export type DesignTokens = typeof designTokens;