// Connect approval flow with the new broker_market:read scope: truthful label,
// Allow not hard-blocked, approve POSTs the workspace, unknown scope still blocks.
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {spawn}=require('node:child_process');
const path=require('node:path');
const root=process.env.APP_ROOT||path.resolve(__dirname,'..');
const port=3099,origin=`http://localhost:${port}`;
const server=spawn('node',['node_modules/next/dist/bin/next','start','--port',String(port)],{cwd:root,stdio:['ignore','ignore','pipe']});
const user={id:'local-user-a',email:'fixture@example.invalid',aud:'authenticated',role:'authenticated',user_metadata:{full_name:'Local review'},app_metadata:{provider:'email'},created_at:'2026-01-01T00:00:00Z'};
const baseScopes=['inventory:read','requirements:read','matches:read','standing_searches:read','automatch:read','workspace:attention','followups:read','raw_messages:read'];
let browser;
async function fixture(screenshot){
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:1250}});const page=await context.newPage();
 const now=Math.floor(Date.now()/1000),token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,aud:'authenticated',exp:now+3600})).toString('base64url'),'fixture'].join('.');
 await page.addInitScript(({user,token,now})=>{localStorage.setItem('sb-test-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture',expires_at:now+3600,expires_in:3600,token_type:'bearer',user}));},{user,token,now});
 const errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://test.supabase.co/**',r=>r.fulfill(r.request().url().includes('/user')?{json:user}:{status:204,body:''}));
 await page.route('**/api/**',async r=>{
  const req=r.request(),url=new URL(req.url()),p=url.pathname;calls.push({path:p,method:req.method(),body:req.postDataJSON()});
  if(p==='/api/auth/me')return r.fulfill({json:{authenticated:true,user,active_tenant:'local-tenant',organizations:[{id:'local-tenant'}],is_super_admin:false}});
  if(p==='/api/orgs/current')return r.fulfill({json:{id:'local-tenant',name:'Local fixture'}});
  if(p==='/api/external/v1/connect/sessions/by-code/ABCD-2345')return r.fulfill({json:{label:'Instinct',write_access:false,scopes:baseScopes.concat(['broker_market:read']),workspace_id:'local-tenant',status:'pending'}});
  if(p==='/api/external/v1/connect/sessions/by-code/WXYZ-6789')return r.fulfill({json:{label:'Instinct',write_access:false,scopes:baseScopes.concat(['teleport:read']),workspace_id:'local-tenant',status:'pending'}});
  if(p.endsWith('/approve'))return r.fulfill({json:{status:'approved'}});
  if(p.endsWith('/deny'))return r.fulfill({json:{status:'denied'}});
  return r.fulfill({json:{}});
 });
 return {page,context,calls,errors,screenshot};
}
(async()=>{
 for(let i=0;i<100;i++){try{await fetch(origin+'/auth/login');break}catch{await new Promise(r=>setTimeout(r,100))}}
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 // Case 1: new default scope set incl. broker_market:read — labelled, Allow works end to end.
 {
  const {page,context,calls,errors}=await fixture();
  await page.goto(origin+'/connect?code=abcd-2345',{waitUntil:'domcontentloaded'});
  const allow=page.getByRole('button',{name:'Allow',exact:true});
  await allow.waitFor({timeout:15000});
  await page.getByText('Read the shared broker market pool (property-group messages other brokers explicitly chose to share). Read-only; never shares this account\'s own groups.',{exact:true}).waitFor();
  await page.getByText('Cannot send messages or share your groups. Reads only what other brokers explicitly shared to the market pool.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Unrecognized access:',{exact:false}).count(),0,'no scope left undescribed');
  const alerts=await page.getByRole('alert').allInnerTexts();
  assert.deepEqual(alerts.filter(t=>t.includes('We could not fully describe')),[],'no block alert for the new default scope set; alerts present: '+JSON.stringify(alerts));
  assert.ok(await allow.isEnabled(),'Allow must not be hard-blocked for the new default scope set');
  await page.screenshot({path:'/downloads/propai-connect-approval-broker-market.png'});
  await allow.click();
  await page.getByText('Access allowed. Finish in your chat.',{exact:false}).waitFor();
  const approve=calls.find(c=>c.path.endsWith('/approve'));
  assert.ok(approve,'approve POST issued');
  assert.equal(approve.method,'POST');
  assert.deepEqual(approve.body,{workspace_id:'local-tenant'});
  assert.deepEqual(errors,[]);
  await context.close();
 }
 // Case 2: an actually-unknown scope still hard-blocks — the safety check itself is intact.
 {
  const {page,context,errors}=await fixture();
  await page.goto(origin+'/connect?code=wxyz-6789',{waitUntil:'domcontentloaded'});
  const allow=page.getByRole('button',{name:'Allow',exact:true});
  await allow.waitFor({timeout:15000});
  await page.getByText('Unrecognized access: teleport:read',{exact:true}).waitFor();
  await page.getByRole('alert').filter({hasText:'We could not fully describe the requested access.'}).waitFor();
  assert.ok(!(await allow.isEnabled()),'Allow must stay disabled for an unknown scope');
  assert.deepEqual(errors,[]);
  await context.close();
 }
 console.log('connect approval browser test passed');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{try{await browser?.close()}catch{}server.kill()});
