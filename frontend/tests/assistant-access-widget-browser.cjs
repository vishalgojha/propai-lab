// Actual production Next build, mocked external auth/API boundaries only.
// The widget component, panel rendering, dismissal persistence and CSS are real.
// NEXT_PUBLIC_SUPABASE_URL=https://test.supabase.co
// NEXT_PUBLIC_SUPABASE_ANON_KEY=local-test-placeholder
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {spawn}=require('node:child_process');
const path=require('node:path');
const root=process.env.APP_ROOT||path.resolve(__dirname,'..');
const port=3097,origin=`http://localhost:${port}`;
const server=spawn('node',['node_modules/next/dist/bin/next','start','--port',String(port)],{cwd:root,stdio:['ignore','ignore','pipe']});
const user={id:'local-user-a',email:'fixture@example.invalid',aud:'authenticated',role:'authenticated',user_metadata:{full_name:'Local review'},app_metadata:{provider:'email'},created_at:'2026-01-01T00:00:00Z'};
const phone={id:225,organization_id:'local-tenant',phone_number:'12025550123',connected:true,connection_state:'open',live_status_available:true,broker_id:'local-fixture',is_active:true};
const connectionStatus={dm_consent_enabled:true,dm_consented_at:'2026-11-20T10:00:00Z',connection:{label:'Instinct',key_id:'key-1',key_prefix:'pk_live_abc',key_revoked:false,scopes:['raw_messages:read','properties:write'],can_read_groups:true,can_read_dms:false,can_write_private_crm:true,last_used_at:'2026-11-21T08:00:00Z'},unbound_active_keys:3};
const sharedSources=[{group_jid:'1111@g.us',group_name:'Property Alpha',confirmed_at:'2026-11-01T00:00:00Z'},{group_jid:'2222@g.us',group_name:'Buyers West',confirmed_at:'2026-11-02T00:00:00Z'}];
let browser;
async function fixture(viewport,opts={}){
 const context=await browser.newContext({serviceWorkers:'block',viewport});const page=await context.newPage();
 const now=Math.floor(Date.now()/1000),token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,aud:'authenticated',exp:now+3600})).toString('base64url'),'fixture'].join('.');
 await page.addInitScript(({user,token,now})=>{localStorage.setItem('sb-test-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture',expires_at:now+3600,expires_in:3600,token_type:'bearer',user}));},{user,token,now});
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://test.supabase.co/**',r=>r.fulfill(r.request().url().includes('/user')?{json:user}:{status:204,body:''}));
 await page.route('**/api/**',async r=>{
  const req=r.request(),url=new URL(req.url()),p=url.pathname;
  if(p==='/api/auth/me')return r.fulfill({json:{authenticated:true,user,active_tenant:'local-tenant',organizations:[{id:'local-tenant'}],is_super_admin:false}});
  if(p==='/api/phones'||p.startsWith('/api/phones?'))return r.fulfill({json:{phones:[phone]}});
  if(p==='/api/dashboard/whatsapp-status')return r.fulfill({json:{state:'open',connected:true,status_available:true,status_stale:false}});
  if(p==='/api/orgs/current')return r.fulfill({json:{id:'local-tenant',name:'Local fixture'}});
  if(p==='/api/onboarding/groups')return r.fulfill({json:{groups:[],cap:null,unlimited:true,selected_count:0,opted_out_count:0,tier:'fixture',extraction_status:'stopped'}});
  if(p.includes('/phone-directory'))return r.fulfill({json:{entries:[]}});
  if(p==='/api/external/v1/connection-status'){
   if(opts.statusFail)return r.fulfill({status:404,json:{detail:'not found'}});
   return r.fulfill({json:connectionStatus});
  }
  if(p==='/api/external/v1/market/policy')return r.fulfill({json:{enabled:true,consent_version:'v2',consent_text:'fixture'}});
  if(p==='/api/external/v1/market/raw-sources')return r.fulfill({json:{groups:[],active_sources:sharedSources,consent_version:'v2',consent_text:'fixture'}});
  return r.fulfill({json:{}});
 });
 await page.goto(origin+'/workspace/instinct',{waitUntil:'domcontentloaded'});
 try{await page.getByRole('button',{name:'Open assistant access',exact:true}).waitFor({timeout:20000});}catch(e){console.log('FIXTURE_BODY',await page.locator('body').innerText());console.log('ERRORS',errors);throw e;}
 return {page,context,errors};
}
(async()=>{
 for(let i=0;i<100;i++){try{await fetch(origin+'/auth/login');break}catch{await new Promise(r=>setTimeout(r,100))}}
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
 const viewports=[{name:'320',width:320,height:720},{name:'390',width:390,height:844},{name:'1280',width:1280,height:900}];
 for(const vp of viewports){
  const {page,context,errors}=await fixture({width:vp.width,height:vp.height});
  await page.getByRole('button',{name:'Open assistant access',exact:true}).click();
  const panel=page.getByRole('region',{name:'Assistant access'});
  await panel.waitFor({timeout:10000});
  await page.getByText('Needs DM permission on the key',{exact:true}).waitFor({timeout:10000});
  const text=await panel.innerText();
  assert.match(text,/Group messages/,`groups row missing at ${vp.name}`);
  assert.match(text,/\bOn\b[\s\S]*?Private CRM writes|Private CRM writes[\s\S]*?\bOn\b/,`status text missing at ${vp.name}`);
  assert.match(text,/Needs DM permission on the key/,`DM pending state missing at ${vp.name}`);
  assert.match(text,/2 groups shared/,`pooled count missing at ${vp.name}`);
  assert.match(text,/3 other active manual API keys exist/,`unbound key note missing at ${vp.name}`);
  assert.match(text,/saved contact names are shown instead/,`DM benefit copy missing at ${vp.name}`);
  await page.screenshot({path:`/downloads/propai-widget-${vp.name}.png`,fullPage:false});
  assert.deepEqual(errors,[],`page errors at ${vp.name}: ${errors.join('|')}`);
  if(vp.name==='390'){
   await page.getByRole('button',{name:'Hide this widget',exact:true}).click();
   await assert.rejects(page.getByRole('button',{name:'Open assistant access',exact:true}).waitFor({timeout:3000}),'widget still visible after dismissal');
   await page.reload({waitUntil:'domcontentloaded'});
   await assert.rejects(page.getByRole('button',{name:'Open assistant access',exact:true}).waitFor({timeout:5000}),'dismissal did not persist across reload');
   const reshow=page.getByRole('button',{name:'Show the floating Assistant access widget again',exact:true});
   await reshow.waitFor({timeout:10000});
   await reshow.click();
   await page.getByRole('button',{name:'Open assistant access',exact:true}).waitFor({timeout:10000});
   await page.screenshot({path:'/downloads/propai-widget-390-reshown.png',fullPage:false});
  }
  await context.close();
 }
 // Unavailable-endpoint honesty: no optimistic aggregate fallback
 {
  const {page,context,errors}=await fixture({width:390,height:844},{statusFail:true});
  await page.getByRole('button',{name:'Open assistant access',exact:true}).click();
  await page.getByText(/Current access status could not be verified/).waitFor({timeout:10000});
  const panelText=await page.getByRole('region',{name:'Assistant access'}).innerText();
  assert.doesNotMatch(panelText,/Needs DM permission|groups shared/,'unavailable state leaked guessed statuses');
  await page.screenshot({path:'/downloads/propai-widget-unavailable.png',fullPage:false});
  assert.deepEqual(errors,[],`page errors in unavailable fixture: ${errors.join('|')}`);
  await context.close();
 }
 console.log('assistant-access-widget-browser: all assertions passed');
 await browser.close();
 server.kill();
 process.exit(0);
})().catch(e=>{console.error(e);try{server.kill()}catch{}process.exit(1)});
