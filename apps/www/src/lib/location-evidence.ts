export type LocationEvidence = {
  latitude?: number | null;
  longitude?: number | null;
  geocode_source?: string | null;
  geocode_confidence?: number | string | null;
};

/** Public location claims require a verified Google Places result. */
export function hasTrustedGoogleLocation(row: LocationEvidence | null | undefined): boolean {
  const latitude = Number(row?.latitude);
  const longitude = Number(row?.longitude);
  const confidence = Number(row?.geocode_confidence);
  return row?.geocode_source === "google_places_text_search"
    && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    && Number.isFinite(confidence) && confidence >= 0.9;
}
