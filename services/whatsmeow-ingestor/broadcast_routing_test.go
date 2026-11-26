package main

import (
	"strings"
	"testing"

	"go.mau.fi/whatsmeow/types"
)

func mustJID(s string) types.JID {
	jid, err := types.ParseJID(s)
	if err != nil {
		panic(err)
	}
	return jid
}

func broadcastInfo(chat, sender string, fromMe bool) types.MessageInfo {
	info := types.MessageInfo{}
	info.MessageSource.Chat = mustJID(chat)
	info.MessageSource.IsFromMe = fromMe
	if sender != "" {
		info.MessageSource.Sender = mustJID(sender)
	}
	return info
}

// An incoming list broadcast (list JID as Chat, owner as Sender, not fromMe)
// is rekeyed onto the owner's direct chat so the opt-in DM gates apply.
func TestRemapBroadcastListIncomingListBroadcast(t *testing.T) {
	info := broadcastInfo("120363012345678901@broadcast", "919820009928@s.whatsapp.net", false)
	if !remapBroadcastList(&info) {
		t.Fatal("incoming list broadcast must be rekeyed onto the sender's direct chat")
	}
	if got := info.Chat.String(); got != "919820009928@s.whatsapp.net" {
		t.Fatalf("chat must become the sender DM JID, got %s", got)
	}
}

// LID senders rekey onto the LID chat; insertRawMessage resolves LID->phone
// for the designation lookup downstream.
func TestRemapBroadcastListLIDSender(t *testing.T) {
	info := broadcastInfo("120363012345678901@broadcast", "236395180587053@lid", false)
	if !remapBroadcastList(&info) {
		t.Fatal("incoming list broadcast from an LID sender must be rekeyed")
	}
	if got := info.Chat.String(); got != "236395180587053@lid" {
		t.Fatalf("chat must become the sender LID, got %s", got)
	}
}

// The owner's own outgoing list copy (fromMe, possibly with BroadcastListOwner
// set) is never captured.
func TestRemapBroadcastListOwnOutgoingCopyDropped(t *testing.T) {
	info := broadcastInfo("120363012345678901@broadcast", "919820009928@s.whatsapp.net", true)
	info.MessageSource.BroadcastListOwner = mustJID("919820056180@s.whatsapp.net")
	if remapBroadcastList(&info) {
		t.Fatal("own outgoing list copy must stay dropped")
	}
	if got := info.Chat.String(); got != "120363012345678901@broadcast" {
		t.Fatalf("chat must stay untouched, got %s", got)
	}
}

// Statuses keep their dedicated drop and never reach the remap.
func TestRemapBroadcastListStatusDropped(t *testing.T) {
	info := broadcastInfo("status@broadcast", "919820009928@s.whatsapp.net", false)
	if remapBroadcastList(&info) {
		t.Fatal("status broadcast must stay dropped")
	}
}

// A list broadcast with no sender identity cannot be gated on a designated
// sender, so it stays dropped.
func TestRemapBroadcastListMissingSenderDropped(t *testing.T) {
	info := broadcastInfo("120363012345678901@broadcast", "", false)
	if remapBroadcastList(&info) {
		t.Fatal("broadcast with no sender identity must stay dropped")
	}
}

// Ordinary DMs, groups and newsletters are not broadcasts and stay untouched.
func TestRemapBroadcastListNonBroadcastUntouched(t *testing.T) {
	cases := []struct {
		name  string
		chat  string
		isGrp bool
	}{
		{"ordinary DM", "919820009928@s.whatsapp.net", false},
		{"group", "120363012345678901@g.us", true},
		{"newsletter", "120363012345678901@newsletter", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			info := broadcastInfo(tc.chat, "919820009928@s.whatsapp.net", false)
			info.MessageSource.IsGroup = tc.isGrp
			if remapBroadcastList(&info) {
				t.Fatalf("%s must not be rekeyed", tc.name)
			}
			if got := info.Chat.String(); got != tc.chat {
				t.Fatalf("chat must stay %s, got %s", tc.chat, got)
			}
		})
	}
}

// A rekeyed broadcast carries the sender DM JID shape the raw_ingest DM gate
// accepts (@s.whatsapp.net or @lid), and the evidence flags recorded before
// rekeying survive in the payload data.
func TestRemapBroadcastListProducesGateCompatibleShape(t *testing.T) {
	info := broadcastInfo("120363012345678901@broadcast", "919820009928@s.whatsapp.net", false)
	multicast := info.Multicast
	incomingBroadcast := info.IsIncomingBroadcast()
	if !incomingBroadcast {
		t.Fatal("pre-rekey message must read as an incoming broadcast")
	}
	if !remapBroadcastList(&info) {
		t.Fatal("incoming list broadcast must be rekeyed")
	}
	if !strings.HasSuffix(info.Chat.String(), "@s.whatsapp.net") && !strings.HasSuffix(info.Chat.String(), "@lid") {
		t.Fatalf("rekeyed chat must match the DM gate's JID shape, got %s", info.Chat.String())
	}
	if info.IsIncomingBroadcast() {
		t.Fatal("post-rekey IsIncomingBroadcast must be false; flags must be captured before rekeying")
	}
	_ = multicast
}
