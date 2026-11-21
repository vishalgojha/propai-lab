const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
 const results=[];
 for(const width of [320,390,1280]){
  const ctx=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,serviceWorkers:'block'});
  const exp=Math.floor(Date.now()/1000)+86400,b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const user={id:'u1',aud:'authenticated',role:'authenticated',email:'fixture@example.invalid',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'};
  const session={access_token:`${b64({alg:'HS256',typ:'JWT'})}.${b64({sub:'u1',exp,aud:'authenticated',role:'authenticated'})}.sig`,refresh_token:'fixture',token_type:'bearer',expires_in:86400,expires_at:exp,user};
  await ctx.addInitScript(s=>localStorage.setItem('sb-test-auth-token',JSON.stringify(s)),session);
  const page=await ctx.newPage();let state='pending',write=false,mismatch=false,evilReturn=false,postFails=false,scopeOverride=null,posts=[];const errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/*',async r=>{
   const u=new URL(r.request().url()),p=u.pathname.replace(/^\/api/,'');
   
   const json=(v,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(v)});
   if(u.hostname==='test.supabase.co')return json(user);
   if(u.hostname!=='localhost')return r.abort();
   if(u.pathname.startsWith('/api/')){
    if(r.request().method()==='POST'){posts.push({path:p,body:r.request().postData()});return postFails?json({detail:'fixture failure'},503):json({ok:true,approved:!p.endsWith('/deny')});}
    if(p==='/auth/me')return json({authenticated:true,user,organizations:[{id:'t1',name:'Demo Brokers'}],active_tenant:'t1'});
    if(p==='/orgs/current')return json({id:mismatch?'t2':'t1',name:'Demo Brokers'});
    if(p.includes('/connect/sessions/by-code/'))return json({label:'Instinct',write_access:write,scopes:scopeOverride||['raw_messages:read','inventory:read','requirements:read','matches:read','standing_searches:read','automatch:read','workspace:attention','followups:read',...(write?['inventory:write','requirements:write','standing_searches:write','followups:write']:[])],status:state,workspace_id:'t1',return_url:evilReturn?'https://evil.invalid/return':'https://wa.me/16508702892'});
    if(p==='/phones')return json({phones:[]});
    if(p.includes('/api-keys'))return json({keys:[]});
    return json({});
   }
   return r.continue();
  });
  async function snap(name){await page.screenshot({path:`/downloads/propai-simple-${name}-${width}.png`,fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' horizontal overflow');}
  // Merged-with-live expectation: the LIVE Instinct page (guidance, manual
  // fallback, walkthrough video, assistant-access widget) is preserved. The
  // candidate's gated coming-soon redesign is deferred pending the ungate
  // decision, so this page asserts the live content, not the gate.
  await page.goto('http://localhost:3123/workspace/instinct');await page.getByRole('heading',{name:'Connect Instinct'}).waitFor();
  const main=page.locator('main');assert(await page.getByText('ask your assistant to connect to PropAI',{exact:false}).count()>=1);
  assert(await page.getByText('PROPAI_API_KEY',{exact:false}).count()>=1);
  await page.getByRole('link',{name:'Create a token manually on the Integrations page'}).waitFor();
  await page.getByRole('button',{name:'Open assistant access'}).waitFor();
  await snap('start');await page.getByRole('heading',{name:'Watch the connection walkthrough'}).scrollIntoViewIfNeeded();await snap('start-lower');
  await page.goto('http://localhost:3123/connect?code=ABCD-2345');try{await page.getByRole('button',{name:'Allow',exact:true}).waitFor({timeout:10000});}catch(e){await page.screenshot({path:'/downloads/propai-simple-debug.png',fullPage:true});console.log(await page.locator('body').innerText(),page.url());throw e;}await snap('allow');
  await page.getByRole('button',{name:'Allow',exact:true}).click();await page.getByRole('heading',{name:'Access allowed. Finish in your chat.'}).waitFor();await snap('approved');
  assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].body),{workspace_id:'t1'});assert.equal(new URL(page.url()).pathname,'/connect');
  assert.equal(await page.getByRole('link',{name:'Return to Instinct'}).getAttribute('href'),'https://wa.me/16508702892');
  state='connected';await page.reload();await page.getByText('Your assistant has collected the connection details.',{exact:false}).waitFor();await snap('collected');
  assert(!(await page.locator('body').innerText()).includes('Connected successfully'));
  state='pending';write=true;await page.reload();await page.getByText('Save private inventory.',{exact:false}).waitFor();await snap('write-request');
  assert(!(await page.locator('body').innerText()).includes('Compare this approval code'));
  scopeOverride=['inventory:read'];await page.reload();await page.getByText('Read listings in this account.',{exact:true}).waitFor();assert.equal(await page.getByText('Read captured group messages in this account.',{exact:true}).count(),0);assert.equal(await page.getByText('Save private inventory.',{exact:false}).count(),0);
  scopeOverride=['unknown:write'];await page.reload();await page.getByText('We could not fully describe',{exact:false}).waitFor();assert(await page.getByRole('button',{name:'Allow',exact:true}).isDisabled());await snap('unknown-scope');
  scopeOverride=[];await page.reload();await page.getByText('We could not fully describe',{exact:false}).waitFor();assert(await page.getByRole('button',{name:'Allow',exact:true}).isDisabled());scopeOverride=null;
  mismatch=true;await page.reload();await page.locator('p[role=alert]').waitFor();await snap('account-error');assert.equal(await page.getByRole('button',{name:'Allow',exact:true}).count(),0);
  mismatch=false;write=false;state='pending';await page.reload();await page.getByRole('button',{name:'Not now',exact:true}).click();await page.getByText('Not allowed.',{exact:false}).waitFor();assert(posts.at(-1).path.endsWith('/deny'));
  state='collected';evilReturn=true;await page.reload();await page.getByText('Your assistant has collected the connection details.',{exact:false}).waitFor();assert.equal(await page.getByRole('link',{name:'Return to Instinct'}).count(),0);evilReturn=false;
  state='pending';postFails=true;await page.reload();await page.getByRole('button',{name:'Allow',exact:true}).click();await page.locator('p[role=alert]').waitFor();await snap('save-error');assert.equal(await page.getByRole('button',{name:'Allow',exact:true}).count(),0);postFails=false;
  state='denied';await page.reload();await page.getByText('Not allowed.',{exact:false}).waitFor();
  state='expired';await page.reload();await page.getByText('This approval link has expired.',{exact:false}).waitFor();
  state='revoked';await page.reload();await page.getByText("This assistant's access was removed.",{exact:false}).waitFor();
  await page.goto('http://localhost:3123/connect?code=INVALID');await page.locator('p[role=alert]').waitFor();assert.equal(await page.getByRole('button',{name:'Allow',exact:true}).count(),0);
  results.push({width,states:16,posts:posts.length,errors});assert.deepEqual(errors,[]);await ctx.close();
 }
 await browser.close();fs.writeFileSync('/downloads/propai-simple-ui-tests.json',JSON.stringify({fixtureOnly:true,results},null,2));console.log(JSON.stringify(results));
})().catch(e=>{console.error(e);process.exit(1)});
