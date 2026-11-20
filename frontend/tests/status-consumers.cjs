const fs=require('fs'),ts=require('typescript'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const src=path.resolve(__dirname,'../src');
function moduleCode(source,vars){const m={exports:{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:m,exports:m.exports,...vars});return m.exports;}
const truth=moduleCode(fs.readFileSync(path.join(src,'lib/workspaceConnection.ts'),'utf8'));
const voice=fs.readFileSync(path.join(src,'components/VoiceAssistant.tsx'),'utf8');
const ast=ts.createSourceFile('voice.tsx',voice,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='describeSetup');
const {describeSetup}=moduleCode(fn.getText(ast)+'\nexport {describeSetup}',{confirmedConnection:truth.confirmedConnection});
for(const state of ['unavailable','unknown','checking','error']){
 const result=describeSetup([],null,{state,connected:null});assert(result.includes('status unavailable'));assert(!result.includes('not connected'));assert(!result.includes('disconnected'));
}
assert(describeSetup([],null,{state:'open',connected:true,status_stale:true}).includes('status unavailable'));
assert(describeSetup([],null,{state:'open',connected:false}).includes('status unavailable'));
assert(describeSetup([],null,{state:'open',connected:true}).includes(': connected'));
assert(describeSetup([],null,{state:'stopped',connected:false}).includes(': disconnected'));
const inbox=fs.readFileSync(path.join(src,'app/inbox/page.tsx'),'utf8');
const retired=inbox.slice(inbox.indexOf('function InboxPageInner('));
assert(retired.indexOf('return <UnifiedMarketInbox />;')<retired.indexOf('const [whatsappStatus'));
console.log('PASS actual VoiceAssistant summary: unknown/stale/contradictory not disconnected; open/stopped controls. Inbox status boolean lives after unconditional return, not an active consumer.');
