// Run from frontend: node scripts/check-retired-deals.cjs
const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript'),assert=require('node:assert/strict');
const old=Module.prototype.require;
Module.prototype.require=function(name){if(name==='next/navigation')return {redirect:href=>{throw {redirect:href}},usePathname:()=>'/dashboard',useRouter:()=>({push:()=>{}})};return old.call(this,name)};
function load(path,extra=''){const m=new Module(__filename);m.paths=Module._nodeModulePaths(process.cwd());m._compile(ts.transpileModule(fs.readFileSync(path,'utf8')+extra,{compilerOptions:{jsx:4,module:1,target:9}}).outputText,__filename);return m.exports;}
try {
  for(const path of ['deals','mydeals','clients','clients/[id]','leads'])assert.throws(()=>load(`src/app/${path}/page.tsx`).default(),e=>e.redirect==='/dashboard');
  const {normalizeTabs}=load('src/hooks/useLayout.tsx','\nexport { normalizeTabs };');
  const tabs=normalizeTabs([{id:'old',href:'/deals',title:'My Deals',closable:true},{id:'alias',href:'/mydeals?x=1',title:'My Deals',closable:true},{id:'client',href:'/clients/24',title:'Client',closable:true},{id:'lead',href:'/leads',title:'Follow-ups',closable:true},{id:'other',href:'/crm',title:'Inventory',closable:true}]);
  assert.deepEqual(tabs.map(t=>t.href),['/inbox','/crm']);
  assert.ok(!fs.readFileSync('src/components/layout/WorkspaceModuleMenu.tsx','utf8').includes('"/deals"'));
  assert.ok(!fs.readFileSync('src/components/VoiceAssistant.tsx','utf8').includes('My Deals'));
  const inbox=fs.readFileSync('src/app/inbox/page.tsx','utf8');
  assert.ok(!inbox.includes('Save to client'));assert.ok(!inbox.includes('openClientPicker'));assert.ok(inbox.includes('startContactQueue'));
  console.log('PASS: both old routes redirect to Home; retired cached tabs removed; unrelated tabs retained; no module/voice guidance to retired UI.');
} finally {Module.prototype.require=old;}
