import type { User } from "@supabase/supabase-js";

export type AuthenticatedUser = User & {
  broker_id?: string;
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
};
