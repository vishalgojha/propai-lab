export type PairingResume = {kind:"idle"}|{kind:"connected"}|{kind:"code";code:string;expiresAt:string;startedAt:number}|{kind:"pending";startedAt:number};

/** Interpret server-authoritative state. Never persist linking codes in browser storage. */
export function pairingResume(result:any,now=Date.now()):PairingResume {
 const status=result?.status||result||{};
 const state=String(result?.state||status.connection_state||"").toLowerCase();
 if((result?.connected===true||status.connected===true)&&["open","connected"].includes(state))return {kind:"connected"};
 if(result?.pairing_error||status.pairing_error||["error","pairing_error","qr","generating_qr"].includes(state))return {kind:"idle"};
 const startedAt=Date.parse(String(status.pairing_started_at||result?.pairing_started_at||""));
 const operation=String(status.pairing_operation_id||result?.pairing_operation_id||"");
 if(!operation||!Number.isFinite(startedAt)||startedAt>now||now-startedAt>=160000)return {kind:"idle"};
 const code=String(result?.pairing_code||result?.code||status.pairing_code||"");
 const expiry=String(result?.pairing_window_expires_at||status.pairing_window_expires_at||"");
 if(code){const expires=Date.parse(expiry);if(Number.isFinite(expires)&&expires>now)return {kind:"code",code,expiresAt:expiry,startedAt};return {kind:"idle"};}
 if(["generating","pairing_requested","connecting","new"].includes(state)&&now-startedAt<70000)return {kind:"pending",startedAt};
 return {kind:"idle"};
}
