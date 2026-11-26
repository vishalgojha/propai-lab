package main

import (
	"context"
	"log"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Opt-in capture of property-listing direct messages.
//
// WhatsApp broadcast lists arrive as ordinary direct messages: the protocol
// exposes no broadcast marker, so capture is gated twice:
//
//  1. sender gate - the sender's phone must be explicitly designated by the
//     workspace owner (broker_dm_capture_senders row carrying the current
//     consent wording version, not revoked, on an active connection); and
//  2. content gate - the message text must look like a property listing, so
//     personal chatter from the same sender is never persisted.
//
// Designated-sender rows are searchable only in the owner's own account: the
// rows are is_group=false and carry no group consent, so cross-broker
// surfaces (broker_market_eligible_source_rows and anything built on it) can
// never include them. Everything fails closed: a lookup error, a version
// mismatch or missing rows all mean the message is dropped before storage.

// defaultDMCaptureConsentVersion is the consent-wording version a sender
// designation must carry before any direct message is persisted. The API
// records it only when the owner confirmed the current wording.
// PROPAI_DM_CAPTURE_CONSENT_VERSION overrides it for a future wording change;
// an explicitly empty override is ignored (the default still applies), and a
// designation carrying no version never passes.
const defaultDMCaptureConsentVersion = "broker-dm-capture-v1"

var dmConsentVersionOnce sync.Once
var dmConsentVersion string

func dmCaptureConsentVersion() string {
	dmConsentVersionOnce.Do(func() {
		dmConsentVersion = strings.TrimSpace(os.Getenv("PROPAI_DM_CAPTURE_CONSENT_VERSION"))
		if dmConsentVersion == "" {
			dmConsentVersion = defaultDMCaptureConsentVersion
		}
	})
	return dmConsentVersion
}

var dmCaptureCache sync.Map

const (
	// Same posture as group capture: allow entries expire quickly so a revoke
	// stops capture within seconds; deny entries absorb message bursts.
	dmCaptureAllowTTL = 15 * time.Second
	dmCaptureDenyTTL  = 30 * time.Second
)

// normalizeDMPhone reduces a JID or phone string to bare digits, the storage
// format of broker_dm_capture_senders.sender_phone. Returns "" when the value
// cannot be a phone identity.
func normalizeDMPhone(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if at := strings.Index(value, "@"); at >= 0 {
		value = value[:at]
	}
	var b strings.Builder
	for _, r := range value {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	digits := b.String()
	if len(digits) < 10 || len(digits) > 15 {
		return ""
	}
	return digits
}

// brokerDMCaptureAllowed reports whether the broker may capture direct
// messages from this sender. The lookup fails closed on any error.
func (sm *SessionManager) brokerDMCaptureAllowed(brokerID, senderPhone string) bool {
	version := dmCaptureConsentVersion()
	if version == "" || senderPhone == "" {
		return false
	}
	key := brokerID + "|dm|" + senderPhone
	if cached, ok := dmCaptureCache.Load(key); ok {
		if decision, ok := cached.(captureDecision); ok && time.Now().Before(decision.expires) {
			return decision.allowed
		}
		dmCaptureCache.Delete(key)
	}
	allowed := false
	if sm.db != nil {
		var exists bool
		err := sm.db.QueryRowContext(context.Background(), `
			SELECT EXISTS(
				SELECT 1
				FROM public.broker_dm_capture_senders s
				JOIN public.org_whatsapp_connections owc
				  ON owc.id = s.whatsapp_connection_id
				WHERE owc.broker_id = $1
				  AND owc.is_active
				  AND s.sender_phone = $2
				  AND s.version = $3
				  AND s.revoked_at IS NULL
			)`, brokerID, senderPhone, version).Scan(&exists)
		if err != nil {
			log.Printf("[broker %s] DM capture permission check failed for sender %s: %v (failing closed)", brokerID, senderPhone, err)
		} else {
			allowed = exists
		}
	}
	ttl := dmCaptureDenyTTL
	if allowed {
		ttl = dmCaptureAllowTTL
	}
	dmCaptureCache.Store(key, captureDecision{allowed: allowed, expires: time.Now().Add(ttl)})
	return allowed
}

// Content gate: a designated sender's message is persisted only when it looks
// like a property listing. At least two independent signal groups must match,
// and the message must be long enough to be a listing rather than a one-line
// personal reply. This deliberately errs toward dropping real listings rather
// than capturing personal chatter.
var (
	propertySignalBHK    = regexp.MustCompile(`(?i)\b\d+(?:\.\d+)?\s*bhk\b|\b\d\s*rk\b`)
	propertySignalPrice  = regexp.MustCompile(`(?i)₹|\b\d+(?:\.\d+)?\s*(?:cr|crore|crores|lac|lacs|lakh|lakhs)\b|\b\d[\d,]*(?:\.\d+)?\s*(?:k|thousand)\b\s*(?:/|-)?\s*(?:per\s*month|pm|rent)?`)
	propertySignalIntent = regexp.MustCompile(`(?i)\b(?:rent|rental|lease|leased|sale|sell|selling|buy|buying|purchase|available|availability|requirement|required|inventory|listing|vacant|possession)\b`)
	propertySignalSize   = regexp.MustCompile(`(?i)\b\d[\d,]*\s*(?:sq\.?\s*ft\.?|sqft|sq\.?\s*ft|carpet|built-?\s*up)\b`)
)

func looksLikePropertyListing(text string) bool {
	text = strings.TrimSpace(text)
	if len(text) < 30 {
		return false
	}
	signals := 0
	if propertySignalBHK.MatchString(text) {
		signals++
	}
	if propertySignalPrice.MatchString(text) {
		signals++
	}
	if propertySignalIntent.MatchString(text) {
		signals++
	}
	if propertySignalSize.MatchString(text) {
		signals++
	}
	return signals >= 2
}
