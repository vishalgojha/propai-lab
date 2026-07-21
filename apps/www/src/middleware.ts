import { NextResponse, type NextRequest } from "next/server";

// Back-compat: old bare-numeric URLs like /listings/12345 308 to
// /listings/12345/12345, which the canonical /listings/[slug]/[id]/page.tsx
// then 301s to the SEO-slug form (/listings/3-bhk-andheri-west-12345).
//
// We can't compute the canonical slug here (middleware runs on the Edge
// runtime and Supabase isn't reachable), so we hand off to the canonical
// route which handles the slug canonicalization. Two hops total, but
// Google treats 308 as permanent and consolidates ranking signals.
//
// Match only single-segment numeric paths so we don't accidentally intercept
// /listings/{slug}/{id} (two segments).
export const config = {
  matcher: "/listings/:id",
};

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Only redirect bare numeric ids. If someone visits /listings/abc (single
  // non-numeric segment), let the canonical route 404 it.
  const match = pathname.match(/^\/listings\/(\d+)$/);
  if (!match) return NextResponse.next();
  const id = match[1];
  // 308 preserves method (in case POSTs ever hit bare-id URLs); for GETs
  // the behaviour is identical to 301.
  return NextResponse.redirect(
    new URL(`/listings/${id}/${id}`, request.url),
    308,
  );
}
