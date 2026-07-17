"use client";

import { getBrokersFeed } from "./api";

interface BrokerIdentity {
  id: number;
  identity_key: string;
  primary_phone: string;
  canonical_name: string;
  building_count: number;
  active_days_30: number;
  observation_count: number;
  listing_count: number;
  requirement_count: number;
}

let brokerCache: Map<string, BrokerIdentity> = new Map();
let cachePromise: Promise<void> | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
let lastCacheTime = 0;

async function buildBrokerCache(): Promise<void> {
  const now = Date.now();
  if (brokerCache.size > 0 && now - lastCacheTime < CACHE_DURATION) {
    return;
  }

  try {
    const brokers = await getBrokersFeed(500, 0); // Get more brokers
    const newCache = new Map<string, BrokerIdentity>();

    for (const b of brokers) {
      // Index by phone (last 10 digits)
      const phoneKey = (b.primary_phone || "").replace(/\D/g, "").slice(-10);
      if (phoneKey.length === 10) {
        newCache.set(phoneKey, b as BrokerIdentity);
      }

      // Index by canonical name (lowercase)
      if (b.canonical_name) {
        newCache.set(b.canonical_name.toLowerCase(), b as BrokerIdentity);
      }

      // Index by identity_key
      if (b.identity_key) {
        newCache.set(b.identity_key.toLowerCase(), b as BrokerIdentity);
      }
    }

    brokerCache = newCache;
    lastCacheTime = now;
  } catch (error) {
    console.warn("Failed to build broker cache:", error);
  }
}

export async function resolveBrokerIdentity(
  brokerName: string | undefined,
  brokerPhone: string | undefined
): Promise<BrokerIdentity | null> {
  await buildBrokerCache();

  // Priority 1: Try phone number match (most reliable)
  if (brokerPhone) {
    const phoneKey = brokerPhone.replace(/\D/g, "").slice(-10);
    if (phoneKey.length === 10 && brokerCache.has(phoneKey)) {
      return brokerCache.get(phoneKey)!;
    }
  }

  // Priority 2: Try canonical name match
  if (brokerName && brokerName.trim()) {
    const nameKey = brokerName.trim().toLowerCase();
    if (brokerCache.has(nameKey)) {
      return brokerCache.get(nameKey)!;
    }

    // Try fuzzy match on name (partial match)
    for (const [key, broker] of brokerCache.entries()) {
      if (key.length > 5 && broker.canonical_name &&
          (key.includes(nameKey) || nameKey.includes(key))) {
        return broker;
      }
    }
  }

  return null;
}

export function getDisplayName(
  brokerName: string | undefined,
  brokerPhone: string | undefined,
  resolvedIdentity: BrokerIdentity | null
): { name: string; phone: string; isResolved: boolean } {
  // If we have a resolved identity, use its canonical name
  if (resolvedIdentity?.canonical_name) {
    return {
      name: resolvedIdentity.canonical_name,
      phone: formatPhone(resolvedIdentity.primary_phone),
      isResolved: true,
    };
  }

  // Fallback to broker_name from parsed output
  if (brokerName && brokerName.trim() && !looksLikePhone(brokerName)) {
    return {
      name: brokerName.trim(),
      phone: brokerPhone ? formatPhone(brokerPhone) : "",
      isResolved: false,
    };
  }

  // Fallback to WhatsApp contact name / push name (if it doesn't look like a phone)
  // This would come from a different field if available

  // Last resort: formatted phone number
  return {
    name: brokerPhone ? formatPhone(brokerPhone) : "Unknown",
    phone: brokerPhone ? formatPhone(brokerPhone) : "",
    isResolved: false,
  };
}

function looksLikePhone(str: string): boolean {
  const digits = str.replace(/\D/g, "");
  return digits.length >= 10;
}

function formatPhone(phone?: string): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return phone;
  return `+91 ${digits.slice(0, 2)} ${digits.slice(2, 7)} ${digits.slice(7)}`;
}

export function clearBrokerCache(): void {
  brokerCache.clear();
  lastCacheTime = 0;
}