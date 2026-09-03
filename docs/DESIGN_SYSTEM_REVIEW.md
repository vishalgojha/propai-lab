# PropAI interface review checklist

Use this checklist for every new route or shared component.

- [ ] Uses the shared tokens in `frontend/src/styles/unified-tokens.css`.
- [ ] Keeps navigation in `#344E41` / `#3A5A40` and workspace surfaces light.
- [ ] Uses a shared `Card`, `Panel`, `DataTable`, `EmptyState`, `Skeleton`, or status primitive where applicable.
- [ ] Includes populated, loading, empty, error, disabled, and success states when the route has async data.
- [ ] All labels, values, controls, and recovery actions remain readable at WCAG AA contrast.
- [ ] No fabricated listings, counters, brokers, locations, or pipeline state.
- [ ] Mobile behavior is verified at 390px; tables scroll or stack without clipping.
- [ ] Destructive actions have confirmation and a distinct status treatment.
- [ ] Dynamic public pages remain server-rendered and preserve privacy rules.
- [ ] `npm run design:check`, lint, typecheck/build, and relevant tests pass.
