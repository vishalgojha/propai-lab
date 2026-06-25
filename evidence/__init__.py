"""
PropAI Evidence Engine.

Temporal observation layer that transforms PropAI from a building
directory into a market intelligence platform.

Key modules:
  - models.py:      Observation data classes and type enums
  - schema.sql:     PostgreSQL DDL for evidence store
  - pipeline.py:    Ingestion pipeline orchestrator
  - resolver.py:    BuildingID resolution engine
  - intelligence.py: Market intelligence computation (stubs)
  - example_observations.py: Working examples for every source
  - adapters/       Source adapters (Housing, MagicBricks, MahaRERA, IGR, WhatsApp)
"""
