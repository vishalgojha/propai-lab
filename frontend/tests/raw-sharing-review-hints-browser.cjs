// Review hints on shared sources: activity-counter labels only, never
// auto-uncheck and never phrased as removal recommendations.
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {spawn}=require('node:child_process');
const path=require('node:path');
const root=process.env.APP_ROOT||path.resolve(__dirname,'..');
const port=3098,origin=`http://localhost:${port}`;
const server=spawn('node',['node_modules/next/dist/bin/next','start','--port',String(port)],{cwd:root,stdio:['ignore','ignore','pipe']});
const user={id:'local-user-a',email:'fixture@example.invalid',aud:'authenticated',role:'authenticated',user_metadata:{full_name:'Local review'},app_metadata:{provider:'email'},created_at:'2026-01-01T00:00:00Z'};
const phone={id:225,organization_id:'local-tenant',phone_number:'12025550123',connected:true,connection_state:'open',live_status_available:true,broker_id:'local-fixture',is_active:true};
const staleDays=200;
const staleIso=new Date(Date.now()-staleDays*86400000).toISOString();
const freshIso=new Date(Date.now()-86400000).toISOString();
const active=[
 {group_jid:'1000@g.us',group_name:'Property Alpha',confirmed_at:'2026-11-01T10:00:00Z',message_count:3,last_message_at:staleIso},
 {group_jid:'1001@g.us',group_name:'Social Beta',confirmed_at:'2026-11-01T10:00:00Z',message_count:41,last_message_at:freshIso},
 {group_jid:'1002@g.us',group_name:'Gamma Listings',confirmed_at:'2026-11-01T10:00:00Z',message_count:0,last_message_at:null}];
let browser;
(async()=>{
 for(let i=0;i<100;i++){try{await fetch(origin+'/auth/login');break}catch{await new Promise(r=>setTimeout(r,100))}}
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
 const now=Math.floor(Date.now()/1000),token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,aud:'authenticated',exp:now+3600})).toString('base64url'),'fixture'].join('.');
 await page.addInitScript(({user,token,now})=>{localStorage.setItem('sb-test-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture',expires_at:now+3600,expires_in:3600,token_type:'bearer',user}));},{user,token,now});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://test.supabase.co/**',r=>r.fulfill(r.request().url().includes('/user')?{json:user}:{status:204,body:''}));
 await page.route('**/api/**',async r=>{
  const url=new URL(r.request().url()),p=url.pathname;
  if(p==='/api/auth/me')return r.fulfill({json:{authenticated:true,user,active_tenant:'local-tenant',organizations:[{id:'local-tenant'}],is_super_admin:false}});
  if(p==='/api/phones')return r.fulfill({json:{phones:[phone]}});
  if(p==='/api/phones/225')return r.fulfill({json:phone});
  if(p==='/api/dashboard/whatsapp-status')return r.fulfill({json:{state:'open',connected:true,status_available:true,status_stale:false}});
  if(p==='/api/orgs/current')return r.fulfill({json:{id:'local-tenant',name:'Local fixture'}});
  if(p==='/api/onboarding/groups')return r.fulfill({json:{groups:[],cap:null,unlimited:true,selected_count:0,opted_out_count:0,tier:'fixture',extraction_status:'stopped'}});
  if(p==='/api/external/v1/market/policy')return r.fulfill({json:{enabled:true,consent_version:'broker-property-cross-search-v2',consent_text:'fixture consent'}});
  if(p==='/api/external/v1/market/raw-sources')return r.fulfill({json:{groups:[],active_sources:active,consent_version:'broker-property-cross-search-v2',consent_text:'fixture consent'}});
  return r.fulfill({json:{}});
 });
 await page.goto(origin+'/whatsapp?tab=groups',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).waitFor({timeout:15000});
 // Header disclaimer always visible when any source is shared.
 await page.getByText('Review hints use activity counters only; they are not recommendations to remove sharing.',{exact:true}).waitFor();
 const li=g=>page.locator('li').filter({hasText:g}).first();
 // Stale group gets a quiet-days hint that still leaves the judgment to the owner.
 const staleText=await li('Property Alpha').innerText();
 assert.match(staleText,new RegExp(`Review hint: Quiet for ${staleDays-1}|Quiet for ${staleDays}`));
 assert.ok(staleText.includes('Remove only if you judge the group not property-related.'),'hint keeps owner judgment explicit');
 // Fresh group gets no hint at all.
 const freshText=await li('Social Beta').innerText();
 assert.ok(!freshText.includes('Review hint'),'fresh group must not be nudged');
 // Never-active group reports missing data honestly instead of implying staleness.
 const neverText=await li('Gamma Listings').innerText();
 assert.ok(neverText.includes('Review hint: No group activity recorded yet.'),'null activity labelled as unknown');
 // Nothing was unchecked or removed automatically: all three sources still listed with their Remove buttons.
 assert.equal(await page.getByRole('button',{name:'Remove raw sharing',exact:true}).count(),3);
 const first=li('Property Alpha');await first.scrollIntoViewIfNeeded();
 await page.screenshot({path:'/downloads/propai-review-hints.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('raw-sharing review-hints browser test passed');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{try{await browser?.close()}catch{}server.kill()});
