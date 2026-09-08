import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GOOGLE_PLACES_URL = "https://places.googleapis.com/v1/places:autocomplete";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 120) || "";
    // Keep the fallback key server-only. The public Maps key is intentionally
    // not used for this proxy because autocomplete billing should be isolated
    // from browser-exposed map credentials.
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (query.length < 3 || !apiKey) return NextResponse.json({ suggestions: [] });

  try {
    const response = await fetch(GOOGLE_PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
      },
      body: JSON.stringify({ input: query, includedRegionCodes: ["in"], languageCode: "en" }),
      cache: "no-store",
    });
    if (!response.ok) return NextResponse.json({ suggestions: [] });
    const payload = await response.json();
    const suggestions = (Array.isArray(payload.suggestions) ? payload.suggestions : [])
      .map((suggestion: any) => suggestion?.placePrediction)
      .filter((prediction: any) => prediction?.text?.text)
      .slice(0, 5)
      .map((prediction: any) => ({
        label: String(prediction.text.text),
        secondary: String(prediction.structuredFormat?.secondaryText?.text || ""),
      }));
    return NextResponse.json({ suggestions });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
