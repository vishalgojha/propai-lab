// Real frontend API module: deselectOnboardingGroup request shape, success
// parse, and backend-error propagation. Mirrors the established vm harness in
// frontend_read_singleflight_test.cjs (real api.ts, mocked auth + fetch).
const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),ts=require('../frontend/node_modules/typescript');
let token='account-a',tenant='tenant-a',calls=[],pending=[];
const context={exports:{},require:(id)=>{assert.equal(id,'@/lib/auth');return{getAccessToken:async()=>token,forceRefreshToken:async()=>token}},window:{localStorage:{getItem:()=>tenant}},Headers,structuredClone,AbortController,DOMException,setTimeout,clearTimeout,fetch:(url,init)=>{calls.push({url,init});return new Promise((resolve,reject)=>pending.push({resolve,reject}))}};
vm.createContext(context);
vm.runInContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname,'../frontend/src/lib/api.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
const api=context.exports;const tick=()=>new Promise(r=>setTimeout(r,5));
(async()=>{
// Request shape: POST /onboarding/groups/deselect with connection id + jid only.
let p=api.deselectOnboardingGroup(225,'120363183836984796@g.us');await tick();
assert.equal(calls.length,1);
let call=calls[0];
assert(call.url.endsWith('/onboarding/groups/deselect'),call.url);
assert.equal(call.init.method,'POST');
assert.equal(call.init.headers.Authorization,'Bearer account-a');
assert.equal(call.init.headers['X-Tenant-Id'],'tenant-a');
assert.deepEqual(JSON.parse(call.init.body),{whatsapp_connection_id:225,group_jid:'120363183836984796@g.us'});
// Success state: parsed result passes through.
pending.shift().resolve({ok:true,status:200,text:async()=>'{"ok":true,"deselected":true,"group_jid":"120363183836984796@g.us","cap":{"cap":null,"remaining":null,"unlimited":true}}'});
const ok=await p;
assert.equal(ok.ok,true);assert.equal(ok.deselected,true);assert.equal(ok.group_jid,'120363183836984796@g.us');
// Error state: backend failure surfaces its detail message, no silent swallow.
p=api.deselectOnboardingGroup(225,'120363183836984796@g.us');await tick();
pending.shift().resolve({ok:false,status:500,statusText:'Internal Server Error',text:async()=>'{"detail":"deselect failed"}'});
await assert.rejects(p,/deselect failed/);
// Network failure also rejects (button must not mark success).
p=api.deselectOnboardingGroup(225,'120363183836984796@g.us');await tick();
pending.shift().reject(new Error('network'));
await assert.rejects(p,/network/);
console.log('PASS real API module: deselect request shape, auth+tenant headers, success parse, backend-error and network-error propagation');
})().catch(e=>{console.error(e);process.exitCode=1});
