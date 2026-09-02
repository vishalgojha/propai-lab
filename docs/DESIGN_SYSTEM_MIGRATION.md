# PropAI internal app design-system migration

## Scope

The authenticated app keeps its approved composition: dark sidebar and top
navigation, light workspace content, and one green accent. This document records
the implementation boundary and the remaining legacy debt.

## Tokens

The authoritative token source is
`frontend/src/styles/unified-tokens.css`, imported by
`frontend/src/app/globals.css` from the root app layout.

The contract is split into:

- `--zone-dark-*`: sidebar, top tabs, and connection/status chrome only.
- `--zone-light-*`: page canvas, cards, panels, borders, and workspace text.
- `--accent-*`: primary actions and emphasis only.
- `--status-*`: success, warning, error, and informational states.
- `--radius-*`: quiet application geometry, with sharp 2px cards and controls.

The primary light and dark text pairings are documented with their measured
contrast targets in the token file. Muted text is reserved for captions and
secondary metadata, never for controls.

## Migration boundary

`frontend/src/app/globals.css` owns the shell contract. It forces
`.propai-sidebar`, `.workspace-tab-strip`, and `.propai-status-rail` to the
dark token set, and `.propai-page-stage` plus its reusable content surfaces to
the light token set. Legacy dark surface utility classes inside the page stage
are translated to light surfaces at the boundary so old routes cannot repaint
the workspace green or black.

Shared `Card`, `Button`, and `Badge` primitives now default to the light-zone
contract. Primary buttons use the dark forest accent; cards and controls use
light surfaces.

## Enforcement

`scripts/check-design-tokens.mjs` runs as `npm run design:check` from the
frontend package. It checks newly staged frontend/public UI lines for literal
hex values and common raw Tailwind color utilities outside token files. This
keeps new work from adding debt while the existing route migration is completed.

## Audit findings and replacements

The baseline audit found 1,018 literal color occurrences and 271 distinct
literal values across 167 frontend source files. The principal replacements in
this pass are:

- `frontend/src/components/ui/card.tsx`: card surface, border, foreground,
  and radius now use light-zone tokens.
- `frontend/src/components/ui/button.tsx`: button variants now use semantic
  accent/light-zone tokens and the shared control radius.
- `frontend/src/components/ui/badge.tsx`: badge geometry now uses the shared
  control radius.
- `frontend/src/app/globals.css`: shell, page stage, legacy dark surface
  translation, inputs, buttons, borders, text pairings, and status tones now
  resolve through the zone tokens.

The remaining literal-color matches in older route source are intentionally
not hidden by this report; they are the next mechanical cleanup queue. The
boundary rules prevent them from producing wrong-zone surfaces at runtime, and
the staged-line checker prevents new occurrences.

## Verification

- `git diff --check` passes for the migration files.
- `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co
  NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npm run build` passes all 74 routes.
- Full visual verification still requires deploying the internal app service
  `propai-lab:main-app`; deployment is intentionally not performed by this
  change.
