// PGlite acceptance for the broker_usage_events migration. Disposable DB,
// synthetic data only, no connection to any production system.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const mig = fs.readFileSync(process.argv[2], 'utf8');
const db = await PGlite.create();
for (const r of ['anon','authenticated','service_role']) await db.exec(`create role ${r} nologin`);
await db.exec('alter role service_role bypassrls');
let pass = 0, fail = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); ok ? pass++ : fail++; };

await db.exec(mig);

// columns
const cols = await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='broker_usage_events' order by ordinal_position`);
check('columns: workspace,surface,action,origin,created_at',
  JSON.stringify(cols.rows.map(r=>r.column_name)) ===
  JSON.stringify(['id','tenant_id','surface','action','origin','created_at']));

// Identity columns are absent, not merely null.
check('no user/key identity columns', !cols.rows.some(r => /user_id|api_key_id/.test(r.column_name)));

// no query/content column exists
const content = cols.rows.some(r => /query|text|message|filter|result/i.test(r.column_name));
check('no content columns', !content);

// RLS enabled
const rls = await db.query(`select relrowsecurity from pg_class where relname='broker_usage_events'`);
check('RLS enabled', rls.rows[0].relrowsecurity === true);

// policy: service_role only
const pol = await db.query(`select policyname, roles, cmd from pg_policies where tablename='broker_usage_events'`);
check('one service_role ALL policy', pol.rows.length === 1 && JSON.stringify(pol.rows[0].roles) === JSON.stringify(['service_role']) && pol.rows[0].cmd === 'ALL');

// indexes
const idx = await db.query(`select indexname from pg_indexes where tablename='broker_usage_events' order by 1`);
check('only tenant+created index plus primary key', idx.rows.length === 2);

// behavior: service_role inserts, anon cannot select or insert
await db.exec(`set role service_role`);
await db.query(`insert into public.broker_usage_events (tenant_id, surface, action, origin) values ('11111111-1111-1111-1111-111111111111','app','search','app')`);
const got = await db.query(`select tenant_id, origin from public.broker_usage_events`);
check('service_role insert+select', got.rows.length === 1 && got.rows[0].origin === 'app');
await db.exec(`reset role`);

await db.exec(`grant select, insert on public.broker_usage_events to anon, authenticated`); // even with grants...
await db.exec(`set role anon`);
let denied = false;
try { await db.query(`insert into public.broker_usage_events (tenant_id, surface, action, origin) values ('11111111-1111-1111-1111-111111111111','app','search','app')`); } catch { denied = true; }
const sel = await db.query(`select * from public.broker_usage_events`);
check('anon blocked by RLS (insert denied, select empty)', denied && sel.rows.length === 0);
await db.exec(`reset role`);

// origin constraint rejects junk
let badOrigin = false;
try { await db.query(`insert into public.broker_usage_events (tenant_id, surface, action, origin) values ('11111111-1111-1111-1111-111111111111','app','search','human')`); } catch { badOrigin = true; }
check('origin check rejects unknown value', badOrigin);

console.log(`RESULT ${fail === 0 ? 'ALL PASS' : 'FAILURES'} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
