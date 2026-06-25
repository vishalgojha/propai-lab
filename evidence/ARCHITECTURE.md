# Evidence Engine Architecture

## Why

Registry v1 answers "what buildings exist." The Evidence Engine answers "what is happening in those buildings right now."

The shift is from a **static directory** to a **temporal intelligence platform**. Every data point is a time-stamped observation appended to a building's history. Intelligence is computed on-the-fly from this history — never pre-stored.

## Location Graph

Before observations can be linked to buildings, the physical geography must be mapped. PropAI uses a hierarchical location graph:

```
City (Mumbai)
  └─ Zone (South Mumbai, Western Suburbs, ...)
       └─ Micro Market (Bandra West, Worli, ...)
            └─ Landmark (Mount Mary Church, High Street Phoenix, ...)
                 └─ Street (Hill Road, Linking Road, ...)
                      └─ Building (Elco Residency, ...)
                           └─ Wing (A Wing, B Wing, ...)
                                └─ Unit (Flat 101, Shop 2, ...)
```

The **landmark registry** (58 landmarks, 2,850 building-landmark links) sits between micro markets and streets in the hierarchy. This matches Mumbai broker vocabulary — brokers reference landmarks (malls, hospitals, stations) far more often than street names.

The **street registry** (68 streets, 3,265 building-street pairs) bridges the gap between landmarks and individual buildings.

## Design Principles

1. **Registry is frozen, evidence is append-only.** Never modify canonical buildings. Never overwrite observations.
2. **Landmark and Street registries are first-class canonical entities** alongside buildings, with their own ID schemes (LM-XXX, ST-XXX).
3. **Identity before intelligence.** BuildingID must be resolved before an observation is valuable. Unresolved observations are queued, not discarded.
4. **Time is a first-class citizen.** Every observation has an `observed_at`. Queries always have a time range.
5. **Intelligence is derived.** No pre-computed metrics. No aggregation tables. Every number is computed from raw observations at query time.
6. **Every source enriches, never recreates.** Future scrapers feed observations into the pipeline — they never rebuild the registry.

## Location Graph

```
                    ┌──────────────┐
                    │    City      │
                    │   Mumbai     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │    Zone      │  (5: South Mumbai, Western Suburbs,
                    │              │       Eastern Suburbs, Navi Mumbai, Thane)
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ Micro Market │  (92: Bandra West, Worli, Powai, ...)
                    │              │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Landmark   │  (58: Mount Mary Church, High Street
                    │              │       Phoenix, Lilavati Hospital, ...)
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Street     │  (68: Hill Road, Linking Road, ...)
                    │              │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Building    │  (4,459 canonical)
                    │              │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │    Wing      │  (future)
                    │              │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │    Unit      │  (future)
                    │              │
                    └──────────────┘
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      DATA SOURCES                            │
│  Housing  MagicBricks  99acres  MahaRERA  IGR  WhatsApp     │
└──────────┬───────────────────────────────────────────┬───────┘
           │                                           │
           ▼                                           ▼
┌──────────────────────┐              ┌──────────────────────────┐
│   Source Adapters     │              │   Manual Entry / CSV     │
│   (normalize raw      │              │   (one-off imports)      │
│    → canonical dict)  │              │                          │
└──────────┬────────────┘              └──────────┬───────────────┘
           │                                      │
           ▼                                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                    INGESTION PIPELINE                            │
│                                                                  │
│   1. Normalize  →  2. Validate  →  3. Resolve BuildingID        │
│                                                                  │
│   Resolution strategies (in order):                              │
│     a. Exact match on canonical_name                             │
│     b. Alias match (known variant → building_id)                 │
│     c. Normalized match (apply knowledge base strategies)        │
│     d. Landmark match (name → landmark → nearby buildings)       │
│     e. Broker parse → landmark match (with spatial relations)    │
│     f. Street match (name → street registry → buildings)         │
│     g. Fuzzy match (name similarity + area/developer)            │
│     h. FAIL → unresolved_observations (no auto-create)           │
│                                                                  │
│   Street resolver also supports:                                 │
│     resolve_by_street("Hill Road") → [list of building IDs]      │
│     resolve("near Linking Road") → first building on that street │
│                                                                  │
└──────────────────────────┬───────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│  building_observations   │  │  unresolved_observations │
│  (resolved, append-only) │  │  (queued for resolution) │
└──────────┬──────────────┘  └──────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    INTELLIGENCE ENGINE                           │
│                                                                  │
│   Queries temporal observation store to compute:                 │
│     - Supply/Demand Ratio                                        │
│     - Price Trends (MoM, YoY)                                    │
│     - Inventory Velocity (days on market)                        │
│     - Broker Activity Index                                      │
│     - Rental Yield (by building, micro market)                   │
│     - Market Temperature (composite score 0-100)                 │
│     - Liquidity Score (how fast can you buy/sell)                │
│                                                                  │
│   All results are ephemeral. Cache by query, never store.        │
└──────────────────────────────────────────────────────────────────┘
```

## Data Flow: End to End

```
Raw Scraper Output
  │
  ▼
Source Adapter (housing_adapter.py, igr_adapter.py, etc.)
  │  Normalizes field names, extracts payloads
  ▼
Pipeline (pipeline.py)
  │  1. Apply normalizers, validators
  │  2. Call resolver.resolve(building_name, area, developer)
  │  3. building_id > 0 → building_observations.csv
  │  4. building_id == 0 → unresolved_observations.csv
  ▼
Observations → Intelligence Engine (intelligence.py)
  │  Query time: compute metrics from observation store
  │  Never persist computed values
  ▼
API / CLI / (future UI)
```

## File Map

| Path | Purpose |
|---|---|
| `evidence/models.py` | Observation data classes, type enums |
| `evidence/schema.sql` | Full PostgreSQL schema (DDL, incl. streets) |
| `evidence/pipeline.py` | Ingestion pipeline orchestrator |
| `evidence/resolver.py` | BuildingID + Street resolution engine |
| `evidence/intelligence.py` | Intelligence computation (stubs) |
| `evidence/example_observations.py` | One example per source + type |
| `evidence/enrich_maharera.py` | MahaRERA enrichment pipeline |
| `evidence/resolver_report.py` | Diagnostic report: categorizes every resolution attempt |
| `evidence/parsers.py` | Broker vocabulary parser (spatial relations, suffix patterns, keyword hints) |
| `evidence/coverage.py` | Evidence coverage report (density, source diversity, time span) |
| `evidence/adapters/__init__.py` | Adapter protocol |
| `evidence/adapters/housing_adapter.py` | Housing.com → Observation |
| `evidence/adapters/magicbricks_adapter.py` | MagicBricks → Observation |
| `evidence/adapters/maharera_adapter.py` | MahaRERA → Observation |
| `evidence/adapters/igr_adapter.py` | IGR → Observation |
| `evidence/adapters/whatsapp_adapter.py` | WhatsApp → Observation |
| `evidence/enrich_maharera.py` | MahaRERA enrichment pipeline (normalize → resolve → registries → observations) |
| `registry/street.py` | Street registry builder |
| `registry/landmarks.py` | Landmark registry builder (seeds + proximity computation) |
| `registry/location_graph.py` | Location graph builder (City→Zone→MM→Landmark→Street→Building) |

## Observation Model

```
Observation {
  observation_id:   UUID          (unique, generated at ingest)
  building_id:      int           (0 if unresolved)
  observation_type: str           (SALE_LISTING, RENT_LISTING, ...)
  source:           str           (HOUSING, MAGICBRICKS, IGR, ...)
  observed_at:      ISO date      (when the event occurred)
  payload:          JSONB         (flexible, varies by type)
  confidence:       float 0-1     (reliability of this observation)
  source_reference: str           (URL, deed number, message ID)
  created_at:       ISO datetime  (when ingested into PropAI)
}
```

## Resolution Strategy Details

| Priority | Strategy | Confidence | Example |
|---|---|---|---|---|
| 1 | Exact match | 1.0 | "Lodha Belvedere" → building_id=42 |
| 2 | Alias match | 0.98 | "Belvedere" → building_id=42 (via aliases) |
| 3 | Normalized | 0.95 | "lodha belvedere, worli" → 42 (via normalization) |
| 4 | Landmark exact/alias | 0.88 | "Bandra Station" → LM-008 → building_id=840 |
| 5 | Broker → landmark | 0.88-0.93 | "near High Street Phoenix" → LM-014 → building_id=2662 |
| 6 | Street match | 0.75-0.85 | "Hill Road" → building_ids on Hill Road |
| 7 | Project name match | 0.85-0.90 | "GREEN CITY 3" → project_id → building_ids |
| 8 | RERA match | 0.95 | "P50500000005" → rera_lookup → building_ids |
| 9 | Developer-narrowed fuzzy | 0.80-0.90 | "Lodha Group" + fuzzy name → dev's buildings only |
| 10 | Full fuzzy + area/dev | 0.80-0.90 | "Lodha Belvadere" + area="Worli" → 42 |
| — | Unresolved | 0.0 | "New Building XYZ" → queued with diagnosis |

Standalone lookups:
- `resolve_by_rera("P50500000005")` → (building_id, "rera:PROJECT_ID")
- `resolve_by_project_name("GREEN CITY 3")` → {project_id, building_ids, ...} or None
- `resolve_by_developer("Lodha Group")` → [list of building IDs]
- `resolve_by_street("Hill Road")` → [list of building IDs]
- `resolve_by_landmark("Mount Mary Church")` → (building_id, confidence, "lm:LM-001")

Canonical entity hierarchy:
```
Developer → Project(s) → Building(s)

Resolution paths:
  Building Name  → BuildingID                       (paths 1, 2, 3, 10)
  Landmark Name  → LandmarkID → nearby BuildingIDs  (paths 4, 5)
  Street Name    → StreetID → BuildingIDs            (path 6)
  Project Name   → ProjectID → BuildingIDs           (path 7)
  RERA Number    → ProjectID → BuildingIDs           (path 8)
  Street        → BuildingIDs                   (path 4)
```

The resolver checks negative knowledge BEFORE returning any fuzzy match.
If a candidate match is on the negative knowledge list, it is rejected.

Landmark resolution supports:
- `resolve_by_landmark("Mount Mary Church")` → (building_id, 0.88, "lm:LM-001")
- `resolve("near High Street Phoenix")` → broker parser strips "near", matches landmark LM-014, returns nearest building
- Spatial relation patterns: opposite, behind, near, walkable, off, on, at
- Station/road/lane/circle/naka suffix patterns
- Keyword hints: mall, hospital, temple, church → treat as landmark (weak signal)

Street resolution supports:
- `resolve_by_street("Hill Road")` → all BuildingIDs on that street
- `resolve("near Linking Road")` → landmark/strip query, falls through to street match

## Intelligence Metrics

All metrics share a common shape:
```
{
  "query": { "building_id": int, "micro_market": str, "days": int },
  "result": { ... },
  "data_quality": "high" | "medium" | "low",
  "caveat": "interpretation note if data is sparse"
}
```

Data quality thresholds:
- **high**: ≥ 50 observations, ≥ 3 sources, span ≥ 60 days
- **medium**: ≥ 10 observations, ≥ 2 sources, span ≥ 30 days
- **low**: < 10 observations (result is unreliable)

## Evidence Coverage

The primary metric is not "how many records were scraped" but **evidence density**:

```
How many buildings have ≥1 observation?
How many have ≥3 independent sources?
How many have ≥90 days of history?
What is the average observations per building?
```

Run daily: `python3 evidence/coverage.py`

```
  Coverage Status: CRITICAL (14/4459 buildings have observations)
  Next priority: Fill observation gaps
```

Target:
| Metric | Current | Target |
|---|---|---|
| Buildings with ≥1 observation | 14 / 4,459 (0.3%) | 4,000+ (90%) |
| Buildings with ≥3 sources | 0 | 2,000+ (50%) |
| Buildings with ≥90 days history | 0 | 3,000+ (75%) |
| Average evidence density | 1.0 | 10+ |
| Unresolved observations | 36 | < 100 |

## Future Work

- **TypeScript client**: mirror the observation model for frontend consumption
- **API layer**: REST endpoints for each intelligence metric
- **Observation viewer**: CLI dashboard for browsing unresolved observations
- **Auto-resolve retry**: periodic re-attempt for unresolved observations as registry grows
- **Caching layer**: Redis-backed query cache with TTL (not pre-computed storage)
- **Anomaly detection**: flag observations that deviate significantly from building history
- **Coverage dashboard**: time-series tracking of evidence density metrics
