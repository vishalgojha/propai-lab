import { NextResponse, type NextRequest } from "next/server";

const PRIVATE_BROKERAGE_MODE = process.env.PROPAI_PRIVATE_BROKERAGE_MODE === "true";
const BROKERAGE_APP_URL = process.env.PROPAI_BROKERAGE_APP_URL || "https://app.propai.live";

// Back-compat: old bare-numeric URLs like /listings/12345 308 to
// /listings/12345/12345, which the canonical /listings/[slug]/[id]/page.tsx
// then 301s to the SEO-slug form (/listings/3-bhk-andheri-west-12345).
//
// We can't compute the canonical slug here (proxy runs before the page and
// Supabase isn't reachable), so we hand off to the canonical route which
// handles the slug canonicalization. Two hops total, but Google treats 308 as
// permanent and consolidates ranking signals.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)",
  ],
};

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PRIVATE_BROKERAGE_MODE) {
    const destination = new URL(BROKERAGE_APP_URL);
    destination.pathname = "/dashboard";
    destination.searchParams.set("from", pathname);
    return NextResponse.redirect(destination, 307);
  }

  // Only redirect bare numeric ids. If someone visits /listings/abc (single
  // non-numeric segment), let the canonical route 404 it.
  const match = pathname.match(/^\/listings\/(\d+)$/);
  if (!match) return NextResponse.next();
  const id = match[1];
  // 308 preserves method (in case POSTs ever hit bare-id URLs); for GETs the
  // behaviour is identical to 301.
  return NextResponse.redirect(
    new URL(`/listings/${id}/${id}`, request.url),
    308,
  );
}
