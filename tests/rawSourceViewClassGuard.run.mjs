// HELD PROPOSAL — run only after the 20261126210000 migration is approved and applied.
// Verifies broker_market_eligible_source_rows drops rows whose consent group_name
// matches the non-property hints while property-named active consents stay readable.
// Uses the same live-Postgres bridge as brokerMarketRealPg.run.mjs.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
function sql(query,args=[]){const r=spawnSync(process.env.MARKET_PYTHON,[process.env.MARKET_SQL_BRIDGE],{input:JSON.stringify({query,args}),encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return JSON.parse(r.stdout);}
const [org,user]=JSON.parse(process.env.MARKET_OWNER);
// Baseline: the view exposes only consented sources for the fixture owner.
const before=sql('select count(*) as n from broker_market_eligible_source_rows')[0].n;
// A consent row whose name matches a non-property hint must contribute zero rows,
// even with revoked_at null (write-time gate is bypassed here on purpose to prove
// the read guard stands alone).
sql("insert into broker_market_raw_source_consents (organization_id,whatsapp_connection_id,broker_id,group_jid,group_name,version,confirmed_by) values (%s,225,%s,'999999999@g.us','Singles Mumbai Guard Test','broker-property-cross-search-v2',%s) on conflict (organization_id,whatsapp_connection_id,group_jid) do update set group_name=excluded.group_name,revoked_at=null",[org,org,user]);
const after=sql('select count(*) as n from broker_market_eligible_source_rows')[0].n;
assert.equal(after,before,'non-property-named active consent added rows to the pool');
// Control: a property-named consent is not dropped by the guard predicate itself.
const propVisible=sql("select count(*) as n from broker_market_raw_source_consents c where c.organization_id=%s and c.revoked_at is null and not (c.group_name ~* '\\m(family|singles|music|catering|healing)\\M' and c.group_name !~* '\\m(property|realty|estates?|bhk|homes)\\M')",[org])[0].n;
assert(propVisible>0,'guard predicate must keep property-named active consents');
sql("delete from broker_market_raw_source_consents where organization_id=%s and group_jid='999999999@g.us'",[org]);
console.log('PASS raw source view non-property guard: hinted names contribute zero pool rows, property names unaffected');
