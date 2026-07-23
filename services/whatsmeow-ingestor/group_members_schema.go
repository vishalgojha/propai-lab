package main

import "database/sql"

const groupMembersDDL = `
CREATE TABLE IF NOT EXISTS public.group_members (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	tenant_id UUID NOT NULL,
	group_id TEXT NOT NULL,
	member_jid TEXT NOT NULL,
	member_phone TEXT,
	display_name TEXT,
	is_admin BOOLEAN DEFAULT FALSE,
	first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE (tenant_id, group_id, member_jid)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group
	ON public.group_members (tenant_id, group_id);

CREATE INDEX IF NOT EXISTS idx_group_members_phone
	ON public.group_members (tenant_id, member_phone);
`

func ensureGroupMembersTable(dbExecutor interface {
	Exec(query string, args ...any) (sql.Result, error)
}) error {
	_, err := dbExecutor.Exec(groupMembersDDL)
	return err
}
