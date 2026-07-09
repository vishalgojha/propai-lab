-- Add additional privacy sharing columns to organizations
-- These support the granular Shared Market controls

alter table organizations
  add column if not exists share_building_intelligence boolean not null default false,
  add column if not exists share_broker_network boolean not null default false,
  add column if not exists share_broker_reputation boolean not null default false,
  add column if not exists share_demand_signals boolean not null default false;

-- Update existing organizations with default values
update organizations
set
  share_building_intelligence = false,
  share_broker_network = false,
  share_broker_reputation = false,
  share_demand_signals = false
where
  share_building_intelligence is null
  or share_broker_network is null
  or share_broker_reputation is null
  or share_demand_signals is null;