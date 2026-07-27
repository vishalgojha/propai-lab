alter table organizations
  drop constraint if exists organizations_privacy_mode_check;

alter table organizations
  alter column privacy_mode set default 'shared_market';

update organizations
set privacy_mode = 'shared_market'
where privacy_mode = 'shared';

alter table organizations
  add column if not exists share_building_intelligence boolean not null default true,
  add column if not exists share_broker_network boolean not null default true,
  add column if not exists share_broker_reputation boolean not null default true,
  add column if not exists share_demand_signals boolean not null default true;

alter table organizations
  add constraint organizations_privacy_mode_check
  check (privacy_mode in ('private', 'shared_market'));

alter table organizations
  alter column share_listings set default true,
  alter column share_requirements set default true,
  alter column share_price_trends set default true,
  alter column share_market_activity set default true,
  alter column share_building_intelligence set default true,
  alter column share_broker_network set default true,
  alter column share_broker_reputation set default true,
  alter column share_demand_signals set default true;
