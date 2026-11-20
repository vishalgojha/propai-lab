// Mount the actual AppShell. Only integration/hooks/child UI boundaries are
// substituted; its async status-loading effect and banner rendering run as-is.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const {JSDOM} = require('jsdom');
const dom = new JSDOM('<div id="root"></div>',{url:'https://test.invalid/whatsapp'});
for(const k of ['window','document','localStorage','sessionStorage','navigator','Event']) Object.defineProperty(global,k,{value:dom.window[k],configurable:true});
dom.window.HTMLElement.prototype.scrollTo = function() {};
global.IS_REACT_ACT_ENVIRONMENT = true;
const focused = process.env.FOCUSED === '1';
const {createRoot} = require('react-dom/client');
const {act} = React;
const root = createRoot(document.getElementById('root'));
const base=process.env.APP_SOURCE || path.resolve(__dirname,'../src');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
let auth={user:{id:'a',email:'a@example.invalid'},loading:false,error:null};
let phoneRequests=[],statusRequests=[];
const api={isLiveWhatsAppConnection:s=>!!(s?.connected||['open','connected'].includes(s?.state)||['open','connected'].includes(s?.connection_state)),getPhones:()=>{const d=deferred();phoneRequests.push(d);return d.promise},getWhatsAppStatus:()=>{const d=deferred();statusRequests.push(d);return d.promise},getBusinessApiConfig:async()=>({}),getAuthMe:async()=>({}),getProfile:async()=>({}),getSoundPreferences:async()=>({}),fetchJSON:async()=>({})};
const empty=()=>null, passthrough=({children})=>children;
const router={replace:()=>{},push:()=>{}};
const layout={drawerOpen:false,setDrawerOpen:()=>{},toggleDrawer:()=>{},setLastTab:()=>{},tabs:[],saveTabScroll:()=>{}};
const sounds=new Proxy({SOUND_LIBRARY:[],getSoundPreferences:()=>({}),loadSoundPreferences:()=>({})},{get:(o,k)=>o[k]||(()=>false)});
const cache={};
function load(file,expose=false){
 if(cache[file]) return cache[file].exports;
 const mod={exports:{}};cache[file]=mod;
 let source=fs.readFileSync(file,'utf8');if(expose)source+='\nexport { AppShell };';
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const req=id=>{
   if(id==='react'||id==='react/jsx-runtime')return require(id);
   if(id==='next/navigation')return {usePathname:()=>focused?'/inbox':'/dashboard',useRouter:()=>router};
   if(id==='next/link')return {__esModule:true,default:({children,prefetch,...props})=>React.createElement('a',props,children)};
   if(id==='lucide-react')return new Proxy({},{get:()=>empty});
   if(id.endsWith('.css'))return {};
   if(id==='@/lib/api')return api;
   if(id==='@/lib/AuthProvider')return {useAuth:()=>auth,AuthProvider:passthrough};
   if(id==='@/hooks/useLayout')return {useLayout:()=>layout,LayoutProvider:passthrough};
   if(id==='@/lib/sounds')return sounds;
   if(id==='@/lib/useEventStream')return {useEventStream:()=>{}};
   if(id==='@/lib/buildInfo')return {getBuildHint:()=>'',getBuildLabel:()=> 'test'};
   if(id==='@/lib/workspaceConnection')return load(path.join(base,'lib/workspaceConnection.ts'));
   if(id.startsWith('@/components/'))return new Proxy({},{get:()=>empty});
   throw Error('unhandled import '+id);
 };
 vm.runInThisContext('(function(require,module,exports){'+code+'\n})',{filename:file})(req,mod,mod.exports);
 return mod.exports;
}
// Use real local loading effects without scheduling recurring work.
const oldInterval=global.setInterval;
global.setInterval=()=>0;window.setInterval=()=>0;
const {AppShell}=load(path.join(base,'app/layout.tsx'),true);
const flush=()=>new Promise(r=>setTimeout(r,5));
const render=async()=>act(async()=>{root.render(React.createElement(AppShell,null,'CHILD'));await flush()});
const text=()=>document.body.textContent;
const phone=(connected,state)=>({id:1,phone_number:'123',connected,connection_state:state,live_status_available:true});
async function settle(index,phones,status){await act(async()=>{phones instanceof Error?phoneRequests[index].reject(phones):phoneRequests[index].resolve({phones});if(!focused){status instanceof Error?statusRequests[index].reject(status):statusRequests[index].resolve(status);}await flush()})}
(async()=>{
 localStorage.setItem('propai_phones:a',JSON.stringify([phone(false,'stopped')]));
 await render();await act(flush);
 assert(!text().includes('Raw capture disconnected'),'cached disconnect must not trigger live alarm');
 await settle(0,new Error('timeout'),{state:'unavailable',connected:false});
 assert(text().includes('Raw capture status unavailable'));
 assert(!text().includes('New group messages are not being received'));
 assert(!text().includes('Raw capture disconnected'));
 // Account A starts another read, then B replaces the account. A must not
 // write a late connected/disconnected result into B or its persistent cache.
 await act(async()=>{window.dispatchEvent(new Event('propai_whatsapp_status_updated'));await flush()});
 auth={...auth,user:{id:'b',email:'b@example.invalid'}};await render();
 await settle(1,[phone(false,'stopped')],{state:'stopped',connected:false});
 assert(!text().includes('Raw capture disconnected'),'late A must not affect B');
 assert.equal(localStorage.getItem('propai_phones:b'),null);
 await settle(2,[phone(false,'stopped')],{state:'stopped',connected:false});
 assert(text().includes('Raw capture disconnected'));
 assert(text().includes('New group messages are not being received'),'confirmed disconnect still prompts');
 // A subsequent failed read removes both stale live proof and its alarm.
 await act(async()=>{window.dispatchEvent(new Event('propai_whatsapp_status_updated'));await flush()});
 await settle(3,new Error('timeout'),new Error('timeout'));
 assert(text().includes('Raw capture status unavailable'));
 assert(!text().includes('New group messages are not being received'));
 // Newer refresh completes before older refresh, older must not win.
 await act(async()=>{window.dispatchEvent(new Event('propai_whatsapp_status_updated'));window.dispatchEvent(new Event('propai_whatsapp_status_updated'));await flush()});
 await settle(5,[phone(true,'open')],{state:'open',connected:true});
 await settle(4,[phone(false,'stopped')],{state:'stopped',connected:false});
 assert(text().includes('Raw capture active'));
 assert(!text().includes('New group messages are not being received'));
 assert.equal(JSON.parse(localStorage.getItem('propai_phones:b'))[0].live_status_available,false);
 await act(async()=>root.unmount());global.setInterval=oldInterval;
 console.log('PASS actual AppShell: cached unknown, unavailable response, failure after disconnect, confirmed disconnect, account-switch late response, refresh out-of-order, identity-only persistence');
})().catch(e=>{console.error(e);process.exitCode=1;root.unmount()});
