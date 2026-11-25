// Static assertions for the "connection setup material belongs inside the
// Instinct tab, not the main page" request: the landing page must no longer
// render the connect-Instinct steps/manual setup card, and the Instinct
// workspace tab must carry the manual setup instruction with its copy button.
const fs=require('fs'),assert=require('node:assert/strict'),path=require('path');
const landing=fs.readFileSync(path.join(__dirname,'../frontend/src/app/BrokerLandingClient.tsx'),'utf8');
const tab=fs.readFileSync(path.join(__dirname,'../frontend/src/app/workspace/instinct/page.tsx'),'utf8');
const card=fs.readFileSync(path.join(__dirname,'../frontend/src/components/InstinctManualSetup.tsx'),'utf8');
const lib=fs.readFileSync(path.join(__dirname,'../frontend/src/lib/instinctManualSetup.ts'),'utf8');
// Main page no longer carries the setup material.
assert(!landing.includes('broker-instinct-section'),'landing: instinct section removed');
assert(!landing.includes('Manual setup instruction'),'landing: manual setup card removed');
assert(!landing.includes('Copy instruction'),'landing: copy button removed');
assert(!landing.includes('INSTINCT_SETUP'),'landing: setup constants moved out');
// Instinct tab renders the manual setup inside advanced/manual settings.
assert(tab.includes('import InstinctManualSetup from "@/components/InstinctManualSetup"'),'tab imports InstinctManualSetup');
assert(tab.includes('<InstinctManualSetup />'),'tab renders InstinctManualSetup');
assert(tab.indexOf('Advanced/manual connection settings')<tab.indexOf('<InstinctManualSetup />'),'manual setup sits inside advanced/manual settings');
// Card copies the full instruction (setup + write rules) to the clipboard.
assert(card.includes('INSTINCT_MANUAL_SETUP + INSTINCT_MANUAL_WRITE_RULES'),'card copies setup plus write rules');
assert(card.includes('Copy instruction'),'card has copy button');
// The moved instruction keeps its content.
assert(lib.includes('https://api.propai.live/api/external/v1'),'lib keeps REST endpoint text');
assert(lib.includes('PROPAI_API_KEY'),'lib keeps vault instruction');
console.log('PASS instinct tab: setup material moved off landing page into Instinct tab advanced settings with copy instruction intact');
