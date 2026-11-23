// Actual built page -> native Next rewrite -> real local API -> PostgreSQL.
// Only Supabase session validation and unrelated app-shell calls are fixtures.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const {user,token}=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const evidence=process.argv[3];
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
  for(const width of [1280,390]){
    const page=await browser.newPage({serviceWorkers:'block',viewport:{width,height:1000}});
    await page.addInitScript(({user,token})=>localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'local-fixture-only',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user})),{user,token});
    await page.route('**/*',async route=>{
      const u=new URL(route.request().url());
      if(u.port==='3137' && (!u.pathname.startsWith('/api/') || u.pathname==='/api/admin/usage/brokers'))return route.continue();
      if(u.pathname.startsWith('/auth/v1/user'))return route.fulfill({json:user});
      if(u.pathname==='/api/auth/me')return route.fulfill({json:{user,is_super_admin:true,active_tenant:'11111111-1111-1111-1111-111111111111'}});
      if(u.pathname.includes('/profile'))return route.fulfill({json:{auth_user_id:user.id,first_name:'Fixture',phone:''}});
      if(u.pathname.includes('/whatsapp/status'))return route.fulfill({json:{connections:[],phones:[]}});
      return route.fulfill({json:[]});
    });
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/usage/brokers' && r.status()===200);
    await page.goto('http://127.0.0.1:3137/admin/usage');
    const body=await (await response).json();
    assert.equal(body.tenants.find(t=>t.org_name==='DB Rehearsal Realty').searches_last_7_days,1);
    await page.getByRole('heading',{name:'DB Rehearsal Realty',exact:true}).waitFor();
    // Disable smooth scrolling for deterministic pixel captures, not layout.
    await page.addStyleTag({content:'*{scroll-behavior:auto !important}'});
    const card=page.locator('article').filter({has:page.getByRole('heading',{name:'DB Rehearsal Realty',exact:true})});
    assert.match(await card.locator('section').first().textContent(),/App searches\s*1\s*last 7 days/);
    assert.match(await card.locator('section').nth(1).textContent(),/Assistant \/ API\s*1201/);
    if(width===390){
      await page.getByRole('heading',{name:'Broker usage',exact:true}).scrollIntoViewIfNeeded();
      await page.screenshot({path:`${evidence}/propai-usage-db-top-390.png`,fullPage:true});
    }
    assert.equal(await page.locator('details').count(),0);
    assert.equal(await card.getByText(/22222222-2222-2222-2222-222222222222/).count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(width===390)await card.getByRole('heading',{name:'Assistant / API',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`${evidence}/propai-usage-db-${width}.png`,fullPage:true});
    await page.close();
  }
  console.log('PASS actual built admin page, native API rewrite and live local PostgreSQL summary at desktop/mobile; auth-provider session and unrelated shell endpoints are fixtures, usage response is not intercepted');
}finally{await browser.close();}
