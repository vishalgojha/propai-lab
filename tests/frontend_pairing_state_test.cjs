// Behaviour test: a signup-registered number that was never paired is "awaiting pairing"; a paired one is not.
const fs=require('fs'),path=require('path'),assert=require('assert');
const ts=require(path.join(__dirname,'../frontend/node_modules/typescript'));
const src=fs.readFileSync(path.join(__dirname,'../frontend/src/lib/connectionHealth.ts'),'utf8');
const js=ts.transpileModule(src,{compilerOptions:{module:'commonjs',target:'es2019'}}).outputText;
const m={exports:{}};new Function('module','exports',js)(m,m.exports);
const {isNeverPairedPhone:n}=m.exports;
assert.strictEqual(n({instance_name:'',phone_number_live:'',connected_since:'',last_message_at:'',total_messages_received:0,connected:false}),true,'signup card never paired');
assert.strictEqual(n({instance_name:'main',connected:false}),false,'has instance');
assert.strictEqual(n({phone_number_live:'919820056180',instance_name:'',connected:false}),true,'echoed registered number is not proof of pairing');
assert.strictEqual(n({connected_since:'2026-11-01T00:00:00Z'}),false,'had a session');
assert.strictEqual(n({total_messages_received:5}),false,'has messages');
assert.strictEqual(n({connected:true}),false,'connected');
const layout=fs.readFileSync(path.join(__dirname,'../frontend/src/app/layout.tsx'),'utf8');
assert(layout.includes('awaitingPairing')&&layout.includes('Ready to pair WhatsApp'));
assert(/awaitingPairing\) return;/.test(layout),'no disconnect banner while awaiting pairing');
const c=fs.readFileSync(path.join(__dirname,'../frontend/src/app/connect/page.tsx'),'utf8');
assert(!c.includes('Account → MCP'),'stale MCP destination removed');
console.log('PASS pairing state');
