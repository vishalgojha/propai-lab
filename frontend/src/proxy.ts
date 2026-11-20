// Preparation template. No deployment authorized. Add at frontend/src/proxy.ts
// only after verifying that no existing proxy/middleware has to be preserved.
import { NextResponse, type NextRequest } from 'next/server';

const paths = new Set(['/api/auth/me', '/api/phones', '/api/dashboard/whatsapp-status',
  '/api/extraction/progress', '/api/stats']);
const run = process.env.PROPAI_DIAG_RUN || '';
const created = Date.now();
const expiry = Math.min(Number(process.env.PROPAI_DIAG_UNTIL_MS || 0), created + 180000);
let count = 0;

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const trace = request.headers.get('x-propai-diag-id') || '';
  if (request.method === 'GET' && paths.has(path) && /^[a-f0-9]{16}$/.test(run)
      && new RegExp('^' + run + '-[a-f0-9]{16}$').test(trace)
      && Date.now() < expiry && count < 50) {
    count++;
    // Do not log the request, URL, headers or exception, only these fields.
    console.info('correlated_timing ' + JSON.stringify({stage:'next_admit',
      wall_ms:Date.now(),trace,path,pid:process.pid}));
  }
  // Normal forwarding unchanged, including authorization and tenant headers.
  return NextResponse.next();
}

export const config = {matcher:[
  '/api/auth/me', '/api/phones', '/api/dashboard/whatsapp-status',
  '/api/extraction/progress', '/api/stats'
]};
