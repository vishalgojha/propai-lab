// Static assertions on the connections page: the required-confirmation state
// must present a primary in-card CTA (not only a banner link), the banner
// copy must state the missing-directory consequence, and the confirm dialog
// must disclose that missing-directory groups are removed and marked opted
// out. Guards the fix for the "buttons don't work" report where Start was
// grey with no visible required action.
const fs=require('fs'),assert=require('node:assert/strict'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'../frontend/src/app/connections/page.tsx'),'utf8');
// In-card primary CTA shown exactly when a saved selection lacks a valid receipt.
assert(src.includes('One confirmation is required before extraction can start.'),'in-card CTA copy present');
assert(src.includes('{persistedSelectedCount > 0 && !hasUnpersistedSelection && !receiptMatches && ('),'in-card CTA gated on saved-but-unverified state');
// The CTA is a solid primary button wired to the real confirmation dialog opener.
const ctaBlock=src.slice(src.indexOf('One confirmation is required before extraction can start.'),src.indexOf('One confirmation is required before extraction can start.')+1200);
assert(ctaBlock.includes('onClick={requestSelectionConfirmation}'),'in-card CTA opens the confirmation dialog');
assert(ctaBlock.includes('bg-amber-400'),'in-card CTA is solid primary styling');
// Banner and dialog disclose the missing-directory consequence before confirm.
assert(src.includes('Saved groups that are no longer in your WhatsApp directory are removed and marked opted out.'),'banner consequence copy');
assert(src.includes('Saved groups that are no longer in your latest WhatsApp directory are removed from the selection and marked opted out.'),'dialog consequence copy');
console.log('PASS connections page: in-card confirm CTA gating/styling/handler + missing-directory consequence copy in banner and dialog');
