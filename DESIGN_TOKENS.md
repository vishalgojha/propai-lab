/* ═══════════════════════════════════════════════════════════════
   PropAI Design Tokens → Tailwind Mapping Reference
   ════════════════════════════════════════════════════════════════

   SPACING (8pt grid): 
   1 = 4px, 2 = 8px, 3 = 12px, 4 = 16px, 5 = 20px, 6 = 24px, 8 = 32px, 10 = 40px, 12 = 48px, 16 = 64px, 20 = 80px, 24 = 96px
   
   OFF-GRID VALUES TO REPLACE:
   - 0.5 (2px) → use 1 (4px) or drop
   - 1.5 (6px) → use 2 (8px) or 1 (4px)
   - 2.5 (10px) → use 2 (8px) or 3 (12px)
   - 3.5 (14px) → use 4 (16px)
   
   TYPOGRAPHY SCALE (stop at 12px/Caption):
   - Display: 32px/700 (text-display)
   - Page Title: 28px/700 (text-page-title)
   - Section: 20px/600 (text-section-title)
   - Card: 16px/600 (text-card-title)
   - Body: 15px/400 (text-body / base)
   - Secondary: 13px/400 (text-secondary)
   - Caption: 12px/400 (text-caption)
   
   NO text-[10px], text-[11px] - use text-caption (12px) or text-secondary (13px)

   COLORS - Use semantic tokens, not raw palette:
   --color-propai-green: #3EE88A
   --color-propai-green-dark: #2DC96E
   --color-blue: #3b82f6
   --color-red: #ef4444
   --color-orange: #f59e0b
   --color-green: #3EE88A
   
   BADGES - use semantic classes:
   .badge-green, .badge-red, .badge-yellow, .badge-blue, .badge-purple, .badge-orange, .badge-gray
   
   SURFACES:
   --color-bg-base: #000000
   --color-bg-surface: #0a0a0a
   --color-bg-elevated: #111111
   --color-bg-hover: #1a1a1a
   
   TEXT:
   --color-text-primary: #ffffff
   --color-text-secondary: #a1a1aa
   --color-text-muted: #52525b
   
   BORDERS:
   --color-border: rgba(255,255,255,0.06)
   --color-border-strong: rgba(255,255,255,0.12)
   
   SHADOWS:
   --shadow-card: 0 0 0 1px rgba(255,255,255,0.06)
   --shadow-elevated: 0 0 0 1px rgba(255,255,255,0.08), 0 4px 24px rgba(0,0,0,0.4)
   --shadow-popover: 0 0 0 1px rgba(255,255,255,0.1), 0 8px 32px rgba(0,0,0,0.5)
   
   RADIUS:
   - Cards: 12px (rounded-xl)
   - Inputs: 8px (rounded-lg)
   - Badges: 6px (rounded)
   - Full: 9999px (rounded-full)

═════════════════════════════════════════════════════════════════ */