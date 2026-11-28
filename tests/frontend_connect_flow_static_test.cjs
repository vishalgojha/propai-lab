// Static assertions: assistant-connection sign-up returns to /connect, and the
// connect success screen points to WhatsApp pairing without implying consent.
const fs=require('fs'),path=require('path'),assert=require('assert');
const panel=fs.readFileSync(path.join(__dirname,'../frontend/src/components/BrokerAccessPanel.tsx'),'utf8');
const connect=fs.readFileSync(path.join(__dirname,'../frontend/src/app/connect/page.tsx'),'utf8');
assert(panel.includes('nextPath.startsWith("/connect?code=")'),'signup keeps the connect link as next');
assert(panel.includes('"/setup"'),'default signup still lands on /setup');
assert(connect.includes('/whatsapp?tab=numbers'),'success screen links to WhatsApp pairing');
assert(connect.includes('Nothing is saved from your groups until you confirm them yourself'),'consent copy present');
console.log('PASS connect flow static');
const cb=fs.readFileSync(path.join(__dirname,'../frontend/src/app/auth/callback/CallbackClient.tsx'),'utf8');
const au=fs.readFileSync(path.join(__dirname,'../frontend/src/lib/auth.ts'),'utf8');
assert(au.includes('propai_connect_code'),'signup carries connect code in metadata');
assert(cb.includes('propai_connect_code')&&cb.includes('/connect?code='),'callback resumes connect from metadata');
console.log('PASS cross-device static');
