import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
function sql(query,args=[]){const r=spawnSync(process.env.MARKET_PYTHON,[process.env.MARKET_SQL_BRIDGE],{input:JSON.stringify({query,args}),encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return JSON.parse(r.stdout);}
const [org,user]=JSON.parse(process.env.MARKET_OWNER);
const reader={id:user,tenant_id:org,broker_id:org};
function builder(table){const eq={};const b={select:()=>b,eq:(k,v)=>{eq[k]=v;return b;},is:()=>b,limit:()=>b,insert:async()=>({error:null}),maybeSingle:async()=>({data:sql('select user_id from broker_market_mcp_reader_grants where organization_id=%s and user_id=%s and revoked_at is null',[eq.organization_id,eq.user_id])[0]||null,error:null})};return b;}
const fake={from:builder,rpc:async(n,p)=>{try{const keys=Object.keys(p);let rows=sql('select * from '+n+'('+keys.map(k=>k+' => %s').join(',')+')',keys.map(k=>k==='p_terms'?JSON.stringify(p[k]):p[k]));return {data:n==='broker_market_take_rate'?rows[0][n]:rows,error:null};}catch(e){return{data:null,error:{message:String(e)}}}}};
process.env.BROKER_PROPERTY_CROSS_SEARCH_ENABLED='true';process.env.BROKER_MARKET_SIGNING_SECRET='realpg-test-fixture';
const real=await import('./supabase.js');mock.module(new URL('./supabase.js',import.meta.url).href,{namedExports:{...real,supabase:fake,recordAssistantSearchSuccess:()=>{}}});
const {createRawBrokerMcpServerWithMarket}=await import('./rawBrokerServer.js');
async function connect(){const s=await createRawBrokerMcpServerWithMarket({user:reader});const[c,t]=InMemoryTransport.createLinkedPair();const client=new Client({name:'realpg-contract',version:'1'});await Promise.all([s.connect(t),client.connect(c)]);return{client,close:async()=>{await client.close();await s.close();}};}
// No silent upgrade without a recorded grant; the new-authorization default inserts it.
let session=await connect();assert(!(await session.client.listTools()).tools.some(x=>x.name==='property_cross_search'),'no grant, no tools');await session.close();
sql('select * from broker_market_default_mcp_reader_grant(%s,%s,%s)',[org,user,user]);
session=await connect();assert((await session.client.listTools()).tools.some(x=>x.name==='property_cross_search'),'default grant at new authorization');
const result=await session.client.callTool({name:'property_cross_search',arguments:{building:'Lodha'}});assert(!result.isError,JSON.stringify(result));let data=result.structuredContent;assert(data.results.length===1,JSON.stringify(data));assert(!JSON.stringify(result).includes('9820056180'));const option=data.results[0].option;
let get=await session.client.callTool({name:'property_option_get',arguments:{option}});assert(!get.isError);
const [sourceOrg,sourceUser]=JSON.parse(process.env.MARKET_SOURCE);sql("select broker_market_set_raw_sources(%s,1,array['123@g.us'],%s,'broker-property-cross-search-v2',false)",[sourceOrg,sourceUser]);get=await session.client.callTool({name:'property_option_get',arguments:{option}});assert(get.isError,JSON.stringify(get));
// Explicit reader disable stops the search immediately.
sql('select * from broker_market_set_mcp_reader_access(%s,%s,false,%s)',[org,user,user]);const denied=await session.client.callTool({name:'property_cross_search',arguments:{building:'Lodha'}});assert(denied.isError);await session.close();
console.log('PASS candidate MCP wrapper + SDK + independent raw SQL + zero-phone/data reader new-authorization default grant + masked search/reread + immediate raw revoke + explicit reader disable');
