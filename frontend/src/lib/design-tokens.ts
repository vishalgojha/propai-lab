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
  },
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
    fast: '150ms ease',
    normal: '200ms ease',
    slow: '300ms ease',
  },
} as const;

export type DesignTokens = typeof designTokens;