import type { User } from "@supabase/supabase-js";

export type AuthenticatedUser = User & {
  broker_id?: string;
  tenant_id?: string;
};

export type ToolContext = {
  user?: AuthenticatedUser;
};

export type PublicListing = {
  source_message_id: string;
  source_group_name: string | null;
  listing_type: string;
  area: string | null;
  sub_area: string | null;
  location: string | null;
  price: number | null;
  price_type: string | null;
  size_sqft: number | null;
  furnishing: string | null;
  bhk: number | null;
  property_type: string | null;
  title: string | null;
  description: string | null;
  raw_message: string | null;
  cleaned_message: string | null;
  primary_contact_name: string | null;
  primary_contact_number: string | null;
  primary_contact_wa: string | null;
  message_timestamp: string | null;
  created_at: string | null;
  listing_id?: string;
  transaction_type?: "rent" | "sale" | "lease" | null;
  building?: string | null;
  locality?: string | null;
  micro_market?: string | null;
  road?: string | null;
  carpet_sqft?: number | null;
  floor?: string | null;
  car_parks?: number | null;
  rent_monthly_inr?: number | null;
  rent_range_monthly_inr?: { min: number; max: number } | null;
  rent_negotiable?: boolean | null;
  final_price?: boolean | null;
  deposit?: string | null;
  brokerage_terms?: string | null;
  pets_allowed?: boolean | null;
  community_restrictions?: string | null;
  possession?: string | null;
  deal_type?: "direct" | "side_by_side" | null;
  first_seen?: string | null;
  last_seen?: string | null;
  repost_count?: number;
  source_groups?: string[];
  brokers?: Array<{ name: string | null; phone: string | null; firm: string | null }>;
  source_message_ids?: string[];
  confidence?: Record<string, "source" | "inferred" | "ambiguous" | "missing">;
  location_confidence?: "high" | "medium" | "ambiguous" | "low";
};
