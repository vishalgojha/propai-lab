-- ============================================================================
-- Move pgvector out of public
-- ============================================================================
-- Keeps vector type/opclass objects out of the exposed public schema.
-- PostgreSQL only allows this for relocatable extensions.
-- ============================================================================

create schema if not exists extensions;

alter extension vector set schema extensions;
