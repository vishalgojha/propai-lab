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
async function fixture(viewport){
 const context=await browser.newContext({serviceWorkers:'block',viewport});const page=await context.newPage();
 const now=Math.floor(Date.now()/1000),token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,aud:'authenticated',exp:now+3600})).toString('base64url'),'fixture'].join('.');
 await page.addInitScript(({user,token,now})=>{localStorage.setItem('sb-test-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture',expires_at:now+3600,expires_in:3600,token_type:'bearer',user}));},{user,token,now});
 const calls=[],errors=[];let active=[],fail=false;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://test.supabase.co/**',r=>r.fulfill(r.request().url().includes('/user')?{json:user}:{status:204,body:''}));
 await page.route('**/api/**',async r=>{
  const req=r.request(),url=new URL(req.url()),p=url.pathname;calls.push({path:p,method:req.method(),body:req.postDataJSON()});
  if(p==='/api/auth/me')return r.fulfill({json:{authenticated:true,user,active_tenant:'local-tenant',organizations:[{id:'local-tenant'}],is_super_admin:false}});
  if(p==='/api/phones')return r.fulfill({json:{phones:[phone]}});
  if(p==='/api/phones/225')return r.fulfill({json:phone});
  if(p==='/api/dashboard/whatsapp-status')return r.fulfill({json:{state:'open',connected:true,status_available:true,status_stale:false}});
  if(p==='/api/orgs/current')return r.fulfill({json:{id:'local-tenant',name:'Local fixture'}});
  if(p==='/api/onboarding/groups')return r.fulfill({json:{groups,cap:null,unlimited:true,selected_count:0,opted_out_count:0,tier:'fixture',extraction_status:'stopped'}});
  if(p.includes('/phone-directory'))return r.fulfill({json:{entries:[]}});
  if(p==='/api/external/v1/market/policy')return r.fulfill({json:{enabled:true,consent_version:'broker-property-cross-search-v2',consent_text:consent}});
  if(p==='/api/external/v1/market/raw-sources'){
   if(req.method()==='PUT'){
    if(fail)return r.fulfill({status:503,json:{detail:'local fixture failure'}});
    const b=req.postDataJSON();active=b.enabled?[...active,...groups.filter(g=>b.group_jids.includes(g.group_jid)).map(g=>({...g,confirmed_at:new Date().toISOString()}))]:active.filter(g=>!b.group_jids.includes(g.group_jid));
    return r.fulfill({json:{enabled:b.enabled,changed:b.group_jids.length}});
   }
   return r.fulfill({json:{groups,active_sources:active,consent_version:'broker-property-cross-search-v2',consent_text:consent}});
  }
  return r.fulfill({json:{}});
 });
 await page.goto(origin+'/whatsapp?tab=groups',{waitUntil:'domcontentloaded'});
 try { await page.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).waitFor({timeout:15000}); } catch(e) { console.log('FIXTURE_BODY',await page.locator('body').innerText());console.log('CALLS',calls,'ERRORS',errors);await page.screenshot({path:'/downloads/propai-raw-sharing-fixture-block.png'});throw e; }
 return {page,context,calls,errors,fail:v=>fail=v};
}
(async()=>{
 for(let i=0;i<100;i++){try{await fetch(origin+'/auth/login');break}catch{await new Promise(r=>setTimeout(r,100))}}
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  const f=await fixture(viewport),p=f.page;
  await p.getByText('137 groups are checked locally',{exact:false}).waitFor();
  await p.getByRole('status').filter({hasText:'0 groups currently shared.'}).waitFor();
  await p.getByText('Which groups should I share?',{exact:true}).click();
  const guidance=p.locator('details').filter({hasText:'Which groups should I share?'});
  assert((await guidance.innerText()).includes("Sharing includes other members' messages"));
  assert((await guidance.innerText()).includes('not a guarantee'));
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
  await guidance.evaluate(el=>el.scrollIntoView({block:'center'}));
  await guidance.screenshot({path:`/downloads/propai-group-guidance-${name}.png`});
  await p.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).click();
  const d=p.getByRole('dialog',{name:'Choose exact groups for raw sharing'});
  assert.equal(await d.locator('input[type=checkbox]:checked').count(),0);
  assert(await d.getByRole('button',{name:'Share 0 named groups'}).isDisabled());
  await p.screenshot({path:`/downloads/propai-raw-sharing-v2-${name}-empty.png`});
  await d.locator('label').filter({hasText:'Property Alpha'}).locator('input').check();
  assert.equal(await d.locator('input[type=checkbox]:checked').count(),1);
  assert((await d.getByRole('list',{name:'Groups to share'}).innerText()).includes('Property Alpha (1000@g.us)'));
  assert(!(await d.getByRole('list',{name:'Groups to share'}).innerText()).includes('Social Beta'));
  await d.getByRole('checkbox',{name:'Confirm authority for named raw-sharing groups'}).check();
  await p.screenshot({path:`/downloads/propai-raw-sharing-v2-${name}-named.png`});
  f.fail(true);await d.getByRole('button',{name:'Share 1 named groups'}).click();
  await p.getByRole('alert').filter({hasText:'Raw sharing was not verified'}).waitFor();
  assert(await d.getByRole('button',{name:'Share 1 named groups'}).isDisabled());
  assert(!(await p.locator('body').innerText()).includes('Raw sharing saved for the named groups'));
  await p.screenshot({path:`/downloads/propai-raw-sharing-v2-${name}-error.png`});
  f.fail(false);await d.getByRole('button',{name:'Cancel'}).click();await p.getByRole('button',{name:'Reload sharing state'}).click();await p.getByRole('status').filter({hasText:'0 groups currently shared.'}).waitFor();await p.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).click();await d.locator('label').filter({hasText:'Property Alpha'}).locator('input').check();await d.getByRole('checkbox',{name:'Confirm authority for named raw-sharing groups'}).check();
  await d.getByRole('button',{name:'Share 1 named groups'}).click();
  await p.getByRole('status').filter({hasText:'Raw sharing saved for the named groups'}).waitFor();
  const puts=f.calls.filter(c=>c.method==='PUT');assert(puts.length===2);
  for(const c of puts){assert.equal(c.path,'/api/external/v1/market/raw-sources');assert.deepEqual(c.body.group_jids,['1000@g.us']);assert(c.body.enabled);}
  assert(!f.calls.some(c=>c.method!=='GET'&&(c.path.includes('/groups/select')||c.path.endsWith('/source-consent')||c.path.includes('/extraction/'))));
  await p.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).click();
  assert.equal(await p.getByRole('dialog').locator('input[type=checkbox]:checked').count(),0);
  await p.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();
  p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'Remove raw sharing',exact:true}).click();
  await p.getByRole('status').filter({hasText:'Raw sharing removed for Property Alpha'}).waitFor();
  const revoke=f.calls.filter(c=>c.method==='PUT').at(-1);assert(!revoke.body.enabled&&!revoke.body.confirmed);assert.deepEqual(revoke.body.group_jids,['1000@g.us']);
  // Explicitly pick every displayed group, not an inherited select-all default.
  await p.getByRole('button',{name:'Choose groups for raw sharing',exact:true}).click();
  const allDialog=p.getByRole('dialog');
  for(let i=0;i<137;i++) await allDialog.locator('label input[type=checkbox]').nth(i).check();
  assert.equal(await allDialog.getByRole('list',{name:'Groups to share'}).locator('li').count(),137);
  assert(await allDialog.getByRole('button',{name:'Share 137 named groups'}).isDisabled());
  await allDialog.getByRole('checkbox',{name:'Confirm authority for named raw-sharing groups'}).check();
  await p.screenshot({path:`/downloads/propai-raw-sharing-v3-${name}-137.png`});
  await allDialog.getByRole('button',{name:'Share 137 named groups'}).click();
  await p.getByRole('status').filter({hasText:'Raw sharing saved for the named groups'}).waitFor();
  const allPut=f.calls.filter(c=>c.method==='PUT').at(-1);assert.equal(allPut.body.group_jids.length,137);assert.equal(new Set(allPut.body.group_jids).size,137);
  // Legacy extraction confirmation still names all effects, but never submits here.
  await p.getByRole('button',{name:'Review 137 extraction groups'}).click();
  const legacy=p.getByRole('dialog',{name:'Confirm group selection'});
  assert((await legacy.innerText()).includes('typed-listing publication, including existing typed listings'));
  assert((await legacy.innerText()).includes('Property Alpha (1000@g.us)'));
  await p.screenshot({path:`/downloads/propai-raw-sharing-v3-${name}-legacy.png`});
  await legacy.getByRole('button',{name:'Cancel'}).click();
  assert.equal(f.errors.length,0,JSON.stringify(f.errors));
  console.log(`PASS ${name}: 137 extraction defaults do not select raw sources; exact names/count, failed-save truth, independent grant/revoke, reopen empty, no extraction/legacy calls`);
  await f.context.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();server.kill('SIGTERM')});
