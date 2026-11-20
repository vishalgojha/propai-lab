// Actual production Next build, mocked external auth/API boundaries only.
// The raw-sharing component, selection state, handlers and rendered CSS are real.
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {spawn}=require('node:child_process');
const path=require('node:path');
const root=process.env.APP_ROOT||path.resolve(__dirname,'..');
const port=3096,origin=`http://localhost:${port}`;
const server=spawn('node',['node_modules/next/dist/bin/next','start','--port',String(port)],{cwd:root,stdio:['ignore','ignore','pipe']});
const user={id:'local-user-a',email:'fixture@example.invalid',aud:'authenticated',role:'authenticated',user_metadata:{full_name:'Local review'},app_metadata:{provider:'email'},created_at:'2026-01-01T00:00:00Z'};
const phone={id:225,organization_id:'local-tenant',phone_number:'12025550123',connected:true,connection_state:'open',live_status_available:true,broker_id:'local-fixture',is_active:true};
const groups=Array.from({length:137},(_,i)=>({group_jid:`${1000+i}@g.us`,group_name:i===0?'Property Alpha':i===1?'Social Beta':`Directory group ${i+1}`,participants:10,connected:false,opted_out:false,selectable:true}));
const consent='Allow other authenticated PropAI brokers to search the message text in these named groups for property requests. DMs are not shared. Remove a group to revoke. Contact numbers stay hidden until a broker chooses one option.';
let browser;
async function fixture(viewport,opts={}){
 const context=await browser.newContext({serviceWorkers:'block',viewport});const page=await context.newPage();
 const now=Math.floor(Date.now()/1000),token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,aud:'authenticated',exp:now+3600})).toString('base64url'),'fixture'].join('.');
 await page.addInitScript(({user,token,now})=>{localStorage.setItem('sb-test-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture',expires_at:now+3600,expires_in:3600,token_type:'bearer',user}));},{user,token,now});
 const calls=[],errors=[];let active=opts.active||[],fail=false,readFail=false,release; let gate=opts.hold?new Promise(r=>release=r):Promise.resolve();
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://test.supabase.co/**',r=>r.fulfill(r.request().url().includes('/user')?{json:user}:{status:204,body:''}));
 await page.route('**/api/**',async r=>{
  const req=r.request(),url=new URL(req.url()),p=url.pathname;calls.push({path:p,method:req.method(),body:req.postDataJSON()});
  if(p==='/api/auth/me')return r.fulfill({json:{authenticated:true,user,active_tenant:'local-tenant',organizations:[{id:'local-tenant'}],is_super_admin:false}});
  if(p==='/api/phones')return r.fulfill({json:{phones:opts.secondPhone?[phone,{...phone,id:226,phone_number:'12025550124'}]:[phone]}});
  if(p==='/api/phones/225'||p==='/api/phones/226')return r.fulfill({json:{...phone,id:Number(p.split('/').at(-1))}});
  if(p==='/api/dashboard/whatsapp-status')return r.fulfill({json:{state:'open',connected:true,status_available:true,status_stale:false}});
  if(p==='/api/orgs/current')return r.fulfill({json:{id:'local-tenant',name:'Local fixture'}});
  if(p==='/api/onboarding/groups')return r.fulfill({json:{groups,cap:null,unlimited:true,selected_count:0,opted_out_count:0,tier:'fixture',extraction_status:'stopped'}});
  if(p.includes('/phone-directory'))return r.fulfill({json:{entries:[]}});
  if(p==='/api/external/v1/market/policy'&&opts.policyFail)return r.fulfill({status:503,json:{detail:'fixture policy failure'}});
  if(p==='/api/external/v1/market/policy')return r.fulfill({json:{enabled:true,consent_version:'broker-property-cross-search-v2',consent_text:consent}});
  if(p==='/api/external/v1/market/raw-sources'){
   if(req.method()==='PUT'){
    if(fail)return r.fulfill({status:503,json:{detail:'local fixture failure'}});
    const b=req.postDataJSON();active=b.enabled?[...active,...groups.filter(g=>b.group_jids.includes(g.group_jid)).map(g=>({...g,confirmed_at:new Date().toISOString()}))]:active.filter(g=>!b.group_jids.includes(g.group_jid));
    return r.fulfill({json:{enabled:b.enabled,changed:b.group_jids.length}});
   }
   if(url.searchParams.get('whatsapp_connection_id')==='226')return r.fulfill({status:503,json:{detail:'second connection unknown'}});
   await gate; if(readFail)return r.fulfill({status:503,json:{detail:'fixture read failure'}});
   return r.fulfill({json:{groups,active_sources:active,consent_version:'broker-property-cross-search-v2',consent_text:consent}});
  }
  return r.fulfill({json:{}});
 });
 await page.goto(origin+'/whatsapp?tab=groups',{waitUntil:'domcontentloaded'});
 try { await page.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).first().waitFor({timeout:15000}); } catch(e) { console.log('FIXTURE_BODY',await page.locator('body').innerText());console.log('CALLS',calls,'ERRORS',errors);await page.screenshot({path:'/downloads/propai-raw-sharing-fixture-block.png'});throw e; }
 return {page,context,calls,errors,fail:v=>fail=v,readFail:v=>readFail=v,release:()=>release?.(),hold:()=>gate=new Promise(r=>release=r)};
}
(async()=>{
 for(let i=0;i<100;i++){try{await fetch(origin+'/auth/login');break}catch{await new Promise(r=>setTimeout(r,100))}}
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]] ){
  const f=await fixture(viewport,{hold:true}); const p=f.page,section=p.locator('section[aria-label="Raw group sharing"]');
  await section.getByRole('status').filter({hasText:'Shared group count is not known yet'}).waitFor();
  assert(!(await section.innerText()).includes('0 groups currently shared'));
  assert(await section.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).isDisabled());
  await section.screenshot({path:`/downloads/propai-load-truth-${name}-loading.png`});
  f.readFail(true);f.release();
  await section.getByRole('status').filter({hasText:'Shared group count is unknown'}).waitFor();
  assert(!(await section.innerText()).includes('0 groups currently shared'));
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
  await section.screenshot({path:`/downloads/propai-load-truth-${name}-unknown-error.png`});
  f.readFail(false);await section.getByRole('button',{name:'Reload sharing state'}).click();
  await section.getByRole('status').filter({hasText:'0 groups currently shared.'}).waitFor();
  assert(await section.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).isEnabled());
  await f.context.close();
  const active=groups.slice(0,134).map(g=>({...g,confirmed_at:'2026-11-20T10:00:00Z'}));
  const g=await fixture(viewport,{active}); const q=g.page,known=q.locator('section[aria-label="Raw group sharing"]');
  await known.getByRole('status').filter({hasText:'134 groups currently shared.'}).waitFor();
  g.hold();await known.getByRole('button',{name:'Reload sharing state'}).click();
  await known.getByRole('status').filter({hasText:'Last verified: 134 groups shared. Checking'}).waitFor();
  assert(!(await known.innerText()).includes('0 groups currently shared'));
  g.readFail(true);g.release();
  await known.getByRole('status').filter({hasText:'Last verified: 134 groups shared. Current sharing state could not be verified.'}).waitFor();
  assert(await known.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).isDisabled());
  assert(await known.getByRole('button',{name:'Remove raw sharing',exact:true}).first().isDisabled());
  assert.equal(g.calls.filter(c=>c.method!=='GET').length,0);
  await known.screenshot({path:`/downloads/propai-load-truth-${name}-known-error.png`});
  g.readFail(false);await known.getByRole('button',{name:'Reload sharing state'}).click();
  await known.getByRole('status').filter({hasText:'134 groups currently shared.'}).waitFor();
  assert.equal(g.calls.filter(c=>c.method!=='GET').length,0);
  await g.context.close();
  const h=await fixture(viewport,{policyFail:true});const unavailable=h.page.locator('section[aria-label="Raw group sharing"]');
  await unavailable.getByRole('status').filter({hasText:'Shared group count is unknown'}).waitFor();
  assert.equal(h.calls.filter(c=>c.method!=='GET').length,0);await h.context.close();
  const dual=await fixture(viewport,{active,secondPhone:true});
  const cards=dual.page.locator('section[aria-label="Raw group sharing"]');await cards.nth(0).getByRole('status').filter({hasText:'134 groups currently shared.'}).waitFor();
  await cards.nth(1).getByRole('status').filter({hasText:'Shared group count is unknown'}).waitFor();
  assert(!(await cards.nth(1).innerText()).includes('134 groups'));assert(!(await cards.nth(1).innerText()).includes('0 groups currently shared'));
  assert.equal(dual.calls.filter(c=>c.method!=='GET').length,0);await dual.context.close();
  console.log('PASS',name,'unknown/loading/error/truezero/134/lastverified/recovery/no writes');
 }
 await browser.close();server.kill();
})().catch(async e=>{console.error(e);await browser?.close();server.kill();process.exitCode=1});
