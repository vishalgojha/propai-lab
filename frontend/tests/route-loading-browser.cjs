// Run after a production build with the two dummy public Supabase values:
// NEXT_PUBLIC_SUPABASE_URL=https://test.supabase.co
// NEXT_PUBLIC_SUPABASE_ANON_KEY=local-test-placeholder
// Requires playwright-core and local Chrome. No network account is used.
// APP_ROOT selects another built frontend; EXPECT_OLD=1 checks the old bug.
const assert = require('node:assert/strict');
const {chromium} = require('playwright-core');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.APP_ROOT || path.resolve(__dirname,'..');
const old = process.env.EXPECT_OLD === '1';
const port = 3092;
const origin = `http://localhost:${port}`;
const server = spawn('node',['node_modules/next/dist/bin/next','start','--port',String(port)],{cwd:root,stdio:['ignore','ignore','pipe']});
const user = {id:'local-user-a',email:'fixture@example.invalid',aud:'authenticated',role:'authenticated',user_metadata:{full_name:'Local review'},app_metadata:{provider:'email'},created_at:'2026-01-01T00:00:00Z'};
const phone = {id:1,organization_id:'local-tenant',phone_number:'Fixture phone',connected:true,connection_state:'open',live_status_available:true,broker_id:'local-fixture',is_active:true};
const emptyGroups={groups:[],cap:100,selected_count:0,remaining:100,opted_out_count:0,tier:'fixture'};
let browser;
function pageChunk(route) {
 const ctx={};vm.runInNewContext(fs.readFileSync(path.join(root,`.next/server/app/${route}/page_client-reference-manifest.js`),'utf8'),ctx);
 const modules=ctx.__RSC_MANIFEST[`/${route}/page`].clientModules;
 const page=modules[`[project]/src/app/${route}/page.tsx`];
 const layout=modules['[project]/src/app/layout.tsx'];
 const unique=page.chunks.filter(c=>!layout.chunks.includes(c));
 assert(unique.length,'must hold a page-only chunk, never auth/layout');
 return unique.at(-1);
}
async function fixture({route='connections',signedIn=true,rejectUser=false,hold=true}={}) {
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
 const page=await context.newPage();
 const now=Math.floor(Date.now()/1000);
 const token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,aud:'authenticated',exp:now+3600})).toString('base64url'),'fixture-signature'].join('.');
 await page.addInitScript(({user,token,now,signedIn})=>{if(signedIn)localStorage.setItem('sb-test-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture-only',expires_at:now+3600,expires_in:3600,token_type:'bearer',user}));},{user,token,now,signedIn});
 let release;const gate=new Promise(r=>release=r);let held=false;const calls=[];const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://test.supabase.co/**',r=>{
  if(r.request().url().includes('/user'))return r.fulfill(rejectUser?{status:401,json:{message:'fixture unauthorized',status:401,code:'bad_jwt'}}:{json:user});
  return r.fulfill({status:204,body:''});
 });
 await page.route('**/api/**',r=>{
  const p=new URL(r.request().url()).pathname;calls.push(p);
  if(p==='/api/auth/me')return r.fulfill({json:{authenticated:true,user,active_tenant:'local-tenant',organizations:[{id:'local-tenant'}],is_super_admin:false}});
  if(p==='/api/phones')return r.fulfill({json:{phones:[phone]}});
  if(p==='/api/dashboard/whatsapp-status')return r.fulfill({json:{state:'open',connected:true}});
  if(p==='/api/orgs/current')return r.fulfill({json:{id:'local-tenant',name:'Local fixture'}});
  if(p==='/api/onboarding/groups')return r.fulfill({json:emptyGroups});
  if(p==='/api/phone-directory')return r.fulfill({json:[]});
  return r.fulfill({json:{}});
 });
 const chunk=pageChunk(route);
 if(hold)await page.route(`**${chunk}`,async r=>{held=true;await gate;await r.continue()});
 await page.goto(`${origin}/${route}${route==='whatsapp'?'?tab=groups':''}`,{waitUntil:'domcontentloaded'});
 return {page,context,calls,errors,release,held:()=>held,chunk};
}
(async()=>{
 for(let i=0;i<80;i++){try{await fetch(`${origin}/auth/login`);break}catch{await new Promise(r=>setTimeout(r,100))}}
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const route of ['connections','whatsapp']){
  const f=await fixture({route});
  if(old){
   await f.page.waitForTimeout(6500);
   assert(f.held());assert((await f.page.locator('body').innerText()).includes('Loading session...'));
   assert(f.calls.filter(p=>p==='/api/auth/me').length>=2,'auth completed despite old session pixels');
   console.log(`BASELINE REPRO ${route}: page-only chunk held >5s; auth/me completed twice; session splash remains`);
  }else{
   await f.page.getByRole('heading',{name:'Loading WhatsApp page...',exact:true}).waitFor();
   assert(f.held());assert(!(await f.page.locator('body').innerText()).includes('Loading session...'));
   await f.page.getByRole('button',{name:'Reload page',exact:true}).waitFor({timeout:15000});
   // A real menu action must remain usable before the blocked route resolves.
   assert(await f.page.getByRole('link',{name:'Account',exact:true}).first().isVisible());
   await f.page.screenshot({path:`/downloads/propai-route-${route}-held.png`});
   console.log(`PASS ${route}: shell commits during held page-only chunk; 10s recovery shown`);
  }
  f.release();
  await f.page.getByRole('heading',{name:'WhatsApp',exact:true}).waitFor();
  await f.page.getByRole('button',{name:'Reload page',exact:true}).waitFor({state:'detached'});
  assert(!f.errors.length,JSON.stringify(f.errors));
  if(!old)await f.page.screenshot({path:`/downloads/propai-route-${route}-ready.png`});
  console.log(`PASS ${route}: releasing same chunk loads actual page without reauth`);
  await f.context.close();
 }
 if(!old){
  const navigation=await fixture({route:'whatsapp'});
  await navigation.page.getByRole('heading',{name:'Loading WhatsApp page...',exact:true}).waitFor();
  await navigation.page.getByRole('link',{name:'Account',exact:true}).first().click();
  await navigation.page.waitForURL(/\/account/,{timeout:10000,waitUntil:'commit'});
  navigation.release();await navigation.context.close();
  console.log('PASS navigation away via real Account menu while WhatsApp chunk remains held');
  for(const options of [{signedIn:false},{rejectUser:true}]){
   const f=await fixture({...options,route:'whatsapp'});
   await f.page.waitForURL(/\/auth\/login/,{timeout:10000,waitUntil:'commit'});
   assert(!(await f.page.locator('body').innerText()).includes('Your workspace is open.'));
   if(!options.signedIn&&!options.rejectUser)assert.equal(f.calls.filter(p=>p==='/api/phones').length,0);
   f.release();await f.context.close();
   console.log(`PASS auth gate while page chunk held: ${options.rejectUser?'explicit 401':'no saved session'}`);
  }
 }
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();server.kill('SIGTERM')});
