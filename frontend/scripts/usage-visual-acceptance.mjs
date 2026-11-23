// Local fixture acceptance. Run with a built frontend, PLAYWRIGHT_MODULE
// pointing to playwright-core, CHROME_PATH to Chrome, and EVIDENCE_DIR set.
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.EVIDENCE_DIR || '/tmp/propai-usage-evidence';

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
fs.mkdirSync(evidence,{recursive:true});
const server=spawn('node',['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','3137'],{cwd:root,stdio:['ignore',fs.openSync('/tmp/usage-ui-server.log','w'),fs.openSync('/tmp/usage-ui-server.err','w')]});
let browser;
const now=new Date().toISOString();
const block=(n)=>({searches_last_7_days:n,last_at:n?now:null});
const tenant=(id,name,n,stage)=>({tenant_id:id,org_name:name,setup_stage:stage,last_real_search_at:n?now:null,searches_last_7_days:n,days_with_real_search_last_30_days:n?3:0,assistant_unlabeled:block(7),automation:block(23)});
const data={generated_at:now,partial:false,notes:[],tenants:[tenant('workspace-alpha','Alpha Realty',5,'returning'),tenant('workspace-beta','Beta Estates',0,'whatsapp_connected')]};
let state='ok';
try {
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:3137/admin/usage')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  for(const width of [1280,390,320]){
    const page=await browser.newPage({serviceWorkers:"block",viewport:{width,height:1000}});
    const user={id:'fixture-user',email:'fixture@example.invalid',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{}};
    await page.addInitScript(({user})=>{
      const payload=btoa(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+36000,aud:'authenticated'}));
      localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:'eyJhbGciOiJIUzI1NiJ9.'+payload+'.fixture',refresh_token:'fixture-only',expires_at:Math.floor(Date.now()/1000)+36000,expires_in:36000,token_type:'bearer',user}));
    },{user});
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.port==='3137'&&!url.pathname.startsWith('/api/'))return route.continue();
      if(url.pathname.startsWith('/auth/v1/user'))return route.fulfill({json:user});
      if(url.pathname==='/api/admin/usage/brokers'){
        if(state==='error')return route.fulfill({status:403,json:{detail:'Super admin access required'}});
        if(state==='empty')return route.fulfill({json:{...data,tenants:[]}});
        return route.fulfill({json:data});
      }
      if(url.pathname==='/api/auth/me')return route.fulfill({json:{user,is_super_admin:true,active_tenant:'fixture-org'}});
      if(url.pathname.includes('/profile'))return route.fulfill({json:{auth_user_id:user.id,first_name:'Fixture',phone:''}});
      if(url.pathname.includes('/whatsapp/status'))return route.fulfill({json:{connections:[],phones:[]}});
      return route.fulfill({json:[]});
    });
    await page.goto('http://127.0.0.1:3137/admin/usage');
    await page.getByRole('heading',{name:'Broker usage',exact:true}).waitFor();
    await page.getByRole('heading',{name:'Alpha Realty',exact:true}).waitFor();
    assert.equal(await page.locator('article').count(),2);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`${evidence}/propai-usage-${width}.png`,fullPage:true});
    await page.getByPlaceholder('Name or workspace ID').fill('Beta');
    assert.equal(await page.locator('article').count(),1);
    await page.getByPlaceholder('Name or workspace ID').fill('');
    if(width===390){
      await page.getByRole('heading',{name:'Beta Estates',exact:true}).scrollIntoViewIfNeeded();
      await page.screenshot({path:`${evidence}/propai-usage-lower-390.png`,fullPage:true});
      await page.getByRole('heading',{name:'Broker usage',exact:true}).scrollIntoViewIfNeeded();
      state='error';await page.getByRole('button',{name:'Refresh',exact:true}).click();
      await page.getByRole('alert').waitFor();assert.equal(await page.locator('article').count(),0);
      await page.screenshot({path:`${evidence}/propai-usage-error-390.png`,fullPage:true});
      state='empty';await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('No workspaces were returned.').waitFor();
      await page.screenshot({path:`${evidence}/propai-usage-empty-390.png`,fullPage:true});
      state='ok';
    }
    await page.close();
  }
  console.log('PASS actual production page at 1280/390/320: separate categories, workspace filter, no horizontal overflow; 403 clears stale data, retry, empty state. Fixture API and fixture session only.');
} finally {await browser?.close();server.kill('SIGTERM');}
