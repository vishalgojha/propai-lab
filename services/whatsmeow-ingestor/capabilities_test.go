package main

import "testing"

func capabilityTestDefs() []capabilityRow {
	return []capabilityRow{
		{Name: "Text Messages", Status: "active", Icon: "MessageSquare", Description: ""},
		{Name: "Images", Status: "active", Icon: "Image", Description: ""},
		{Name: "Video", Status: "active", Icon: "Video", Description: ""},
		{Name: "Audio", Status: "active", Icon: "Mic", Description: ""},
		{Name: "Documents", Status: "active", Icon: "FileText", Description: ""},
		{Name: "Stickers", Status: "active", Icon: "Smile", Description: ""},
		{Name: "Location", Status: "active", Icon: "MapPin", Description: ""},
		{Name: "Live Location", Status: "active", Icon: "Navigation", Description: ""},
		{Name: "Contact Cards", Status: "active", Icon: "Users", Description: ""},
		{Name: "Contact Arrays", Status: "active", Icon: "Contact", Description: ""},
		{Name: "Reactions", Status: "active", Icon: "SmilePlus", Description: ""},
		{Name: "Poll Creation", Status: "active", Icon: "BarChart3", Description: ""},
		{Name: "Poll Updates", Status: "active", Icon: "Vote", Description: ""},
		{Name: "Edited Messages", Status: "active", Icon: "Pencil", Description: ""},
		{Name: "Outgoing Messages", Status: "active", Icon: "ArrowUpRight", Description: ""},
		{Name: "History Sync", Status: "active", Icon: "Clock", Description: ""},
		{Name: "Profile Pictures", Status: "active", Icon: "Camera", Description: ""},
		{Name: "Group Directory", Status: "active", Icon: "Users", Description: ""},
		{Name: "Media Download", Status: "active", Icon: "Download", Description: ""},
		{Name: "Media Upload", Status: "active", Icon: "Upload", Description: ""},
		{Name: "Self-Chat Agent", Status: "active", Icon: "Bot", Description: ""},
		{Name: "Read Receipts", Status: "captured_unused", Icon: "CheckCheck", Description: ""},
		{Name: "Typing Presence", Status: "captured_unused", Icon: "Pencil", Description: ""},
	}
}

func testCapturedUnused() map[string]bool {
	return map[string]bool{"Read Receipts": true, "Typing Presence": true}
}

func testAlwaysOn() map[string]bool {
	return map[string]bool{
		"Outgoing Messages": true,
		"History Sync":      true,
		"Profile Pictures":  true,
		"Group Directory":   true,
		"Media Download":    true,
		"Media Upload":      true,
		"Self-Chat Agent":   true,
	}
}

func testTypeKey() map[string]string {
	return map[string]string{
		"Text Messages":   "text",
		"Images":          "image",
		"Video":           "video",
		"Audio":           "audio",
		"Documents":       "document",
		"Stickers":        "sticker",
		"Location":        "location",
		"Live Location":   "live_location",
		"Contact Cards":   "contact",
		"Contact Arrays":  "contacts_array",
		"Reactions":       "reaction",
		"Poll Creation":   "poll_creation",
		"Poll Updates":    "poll_update",
		"Edited Messages": "edited",
	}
}

func findCap(rows []capabilityRow, name string) capabilityRow {
	for _, r := range rows {
		if r.Name == name {
			return r
		}
	}
	return capabilityRow{Name: name}
}

func TestCapturedUnusedAlwaysReturned(t *testing.T) {
	defs := capabilityTestDefs()
	capturedUnused := testCapturedUnused()
	alwaysOn := testAlwaysOn()
	typeKey := testTypeKey()

	cases := []struct {
		name         string
		anySession   bool
		anyConnected bool
		counts       map[string]int64
	}{
		{"disconnected", false, false, map[string]int64{}},
		{"session but offline", true, false, map[string]int64{}},
		{"connected no evidence", true, true, map[string]int64{}},
		{"connected with evidence", true, true, map[string]int64{"reaction": 99}},
	}
	for _, tc := range cases {
		out := computeCapabilityStatuses(defs, capturedUnused, alwaysOn, typeKey, tc.counts, tc.anyConnected, tc.anySession)
		rr := findCap(out, "Read Receipts")
		if rr.Status != "captured_unused" {
			t.Errorf("[%s] Read Receipts status = %q, want captured_unused", tc.name, rr.Status)
		}
		if rr.EvidenceCount != 0 {
			t.Errorf("[%s] Read Receipts evidence = %d, want 0", tc.name, rr.EvidenceCount)
		}
		tp := findCap(out, "Typing Presence")
		if tp.Status != "captured_unused" {
			t.Errorf("[%s] Typing Presence status = %q, want captured_unused", tc.name, tp.Status)
		}
	}
}

func TestAlwaysOnConnectedIsActive(t *testing.T) {
	defs := capabilityTestDefs()
	capturedUnused := testCapturedUnused()
	alwaysOn := testAlwaysOn()
	typeKey := testTypeKey()

	out := computeCapabilityStatuses(defs, capturedUnused, alwaysOn, typeKey, map[string]int64{}, true, true)
	alwaysOnNames := []string{
		"Outgoing Messages", "History Sync", "Profile Pictures", "Group Directory",
		"Media Download", "Media Upload", "Self-Chat Agent",
	}
	for _, name := range alwaysOnNames {
		c := findCap(out, name)
		if c.Status != "active" {
			t.Errorf("%s status = %q, want active", name, c.Status)
		}
	}
}

func TestAlwaysOnSessionOfflineIsPartial(t *testing.T) {
	defs := capabilityTestDefs()
	capturedUnused := testCapturedUnused()
	alwaysOn := testAlwaysOn()
	typeKey := testTypeKey()

	out := computeCapabilityStatuses(defs, capturedUnused, alwaysOn, typeKey, map[string]int64{}, false, true)
	for _, name := range []string{
		"Outgoing Messages", "History Sync", "Profile Pictures", "Group Directory",
		"Media Download", "Media Upload", "Self-Chat Agent",
	} {
		c := findCap(out, name)
		if c.Status != "partial" {
			t.Errorf("%s status = %q, want partial", name, c.Status)
		}
	}
}

func TestAlwaysOnNoSessionIsNotAvailable(t *testing.T) {
	defs := capabilityTestDefs()
	capturedUnused := testCapturedUnused()
	alwaysOn := testAlwaysOn()
	typeKey := testTypeKey()

	out := computeCapabilityStatuses(defs, capturedUnused, alwaysOn, typeKey, map[string]int64{}, false, false)
	for _, name := range []string{
		"Outgoing Messages", "History Sync", "Profile Pictures", "Group Directory",
		"Media Download", "Media Upload", "Self-Chat Agent",
	} {
		c := findCap(out, name)
		if c.Status != "not_available" {
			t.Errorf("%s status = %q, want not_available", name, c.Status)
		}
	}
}

func TestEvidenceBasedWithCountIsActive(t *testing.T) {
	defs := capabilityTestDefs()
	capturedUnused := testCapturedUnused()
	alwaysOn := testAlwaysOn()
	typeKey := testTypeKey()

	counts := map[string]int64{
		"text":          100,
		"image":         42,
		"video":         7,
		"live_location": 3,
		"contacts_array": 11,
		"poll_update":   5,
		"edited":        4,
	}
	out := computeCapabilityStatuses(defs, capturedUnused, alwaysOn, typeKey, counts, true, true)

	checks := []struct {
		name  string
		count int64
	}{
		{"Text Messages", 100},
		{"Images", 42},
		{"Video", 7},
		{"Live Location", 3},
		{"Contact Arrays", 11},
		{"Poll Updates", 5},
		{"Edited Messages", 4},
	}
	for _, tc := range checks {
		c := findCap(out, tc.name)
		if c.Status != "active" {
			t.Errorf("%s status = %q, want active", tc.name, c.Status)
		}
		if c.EvidenceCount != tc.count {
			t.Errorf("%s evidence = %d, want %d", tc.name, c.EvidenceCount, tc.count)
		}
	}
}

func TestEvidenceBasedZeroCountSessionIsPartial(t *testing.T) {
	defs := capabilityTestDefs()
	capturedUnused := testCapturedUnused()
	alwaysOn := testAlwaysOn()
	typeKey := testTypeKey()

	// Has a session (so partial is possible), but no evidence for Video.
	counts := map[string]int64{"text": 50}
	out := computeCapabilityStatuses(defs, capturedUnused, alwaysOn, typeKey, counts, false, true)

	c := findCap(out, "Video")
	if c.Status != "partial" {
		t.Errorf("Video status = %q, want partial", c.Status)
	}
	if c.EvidenceCount != 0 {
		t.Errorf("Video evidence = %d, want 0", c.EvidenceCount)
	}
}

func TestEvidenceBasedNoSessionIsNotAvailable(t *testing.T) {
	defs := capabilityTestDefs()
	capturedUnused := testCapturedUnused()
	alwaysOn := testAlwaysOn()
	typeKey := testTypeKey()

	out := computeCapabilityStatuses(defs, capturedUnused, alwaysOn, typeKey, map[string]int64{}, false, false)
	c := findCap(out, "Images")
	if c.Status != "not_available" {
		t.Errorf("Images status = %q, want not_available", c.Status)
	}
	if c.EvidenceCount != 0 {
		t.Errorf("Images evidence = %d, want 0", c.EvidenceCount)
	}
}

func TestTypeKeyMatchesExtractorValues(t *testing.T) {
	// Sanity: every name in our typeKey map must appear in the canonical
	// capability definitions, and every value must be a non-empty string.
	defs := capabilityTestDefs()
	tk := testTypeKey()
	defNames := map[string]bool{}
	for _, d := range defs {
		defNames[d.Name] = true
	}
	for name, key := range tk {
		if !defNames[name] {
			t.Errorf("typeKey has %q but no matching capability definition", name)
		}
		if key == "" {
			t.Errorf("typeKey value for %q is empty", name)
		}
	}
}

func TestAggregateByTypeEmptyByDefault(t *testing.T) {
	sm := &SessionManager{}
	got := sm.aggregateByType()
	if len(got) != 0 {
		t.Errorf("aggregateByType with no sessions = %v, want empty map", got)
	}
}

func TestAggregateByTypeSumsAcrossSessions(t *testing.T) {
	sm := &SessionManager{}
	s1 := &BrokerSession{totalByType: map[string]int64{"text": 3, "image": 1}}
	s2 := &BrokerSession{totalByType: map[string]int64{"text": 2, "video": 4}}
	sm.sessions = map[string]*BrokerSession{"a": s1, "b": s2}

	got := sm.aggregateByType()
	if got["text"] != 5 {
		t.Errorf("text = %d, want 5", got["text"])
	}
	if got["image"] != 1 {
		t.Errorf("image = %d, want 1", got["image"])
	}
	if got["video"] != 4 {
		t.Errorf("video = %d, want 4", got["video"])
	}
}
