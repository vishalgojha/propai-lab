package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

var (
	databaseURL  = getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/whatsmeow?sslmode=disable")
	webhookURL   = getEnv("PROPAI_WEBHOOK_URL", "https://api.propai.live/webhook")
	apiURL       = getEnv("PROPAI_API_URL", "https://api.propai.live")
	instanceName = getEnv("PROPAI_INSTANCE_NAME", "propai-whatsmeow")
	sendPort     = getEnv("PROPAI_SEND_PORT", "3001")
)

// ── Status ──────────────────────────────────────────────────────────────────

type Status struct {
	BrokerID              string `json:"broker_id,omitempty"`
	Connected             bool   `json:"connected"`
	ConnectionState       string `json:"connection_state"`
	QR                    string `json:"qr,omitempty"`
	QRAvailable           bool   `json:"qr_available,omitempty"`
	PhoneNumber           string `json:"phone_number,omitempty"`
	DisplayName           string `json:"display_name,omitempty"`
	InstanceName          string `json:"instance_name,omitempty"`
	ConnectedSince        string `json:"connected_since,omitempty"`
	LastMessageAt         string `json:"last_message_at,omitempty"`
	DisconnectReason      int    `json:"disconnect_reason,omitempty"`
	SendPort              int    `json:"send_port,omitempty"`
	ReconnectCount        int    `json:"reconnect_count,omitempty"`
	ConsecutiveFailures   int    `json:"consecutive_failures,omitempty"`
	TotalMessagesReceived int64  `json:"total_messages_received,omitempty"`
	LastDisconnectAt      string `json:"last_disconnect_at,omitempty"`
	SocketState           string `json:"socket_state,omitempty"`
	HeartbeatAt           string `json:"heartbeat_at,omitempty"`
}

// ── Broker session ─────────────────────────────────────────────────────────

type BrokerSession struct {
	mu                sync.RWMutex
	brokerID          string
	client            *whatsmeow.Client
	device            *store.Device
	status            Status
	ctx               context.Context
	cancel            context.CancelFunc
	disconnected      chan struct{}
	disconnectOnce    func() struct{}
	reconnectFailures int
	reconnectCount    int
	totalMessages     int64
	statusFile        string
}

func (s *BrokerSession) getStatus() Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

func (s *BrokerSession) setStatus(st Status) {
	s.mu.Lock()
	// Preserve current values for fields not explicitly set in the new status
	cur := s.status
	if st.PhoneNumber == "" {
		st.PhoneNumber = cur.PhoneNumber
	}
	if st.DisplayName == "" {
		st.DisplayName = cur.DisplayName
	}
	if st.ConnectedSince == "" {
		st.ConnectedSince = cur.ConnectedSince
	}
	if st.LastMessageAt == "" {
		st.LastMessageAt = cur.LastMessageAt
	}
	if st.LastDisconnectAt == "" {
		st.LastDisconnectAt = cur.LastDisconnectAt
	}
	if st.HeartbeatAt == "" {
		st.HeartbeatAt = cur.HeartbeatAt
	}
	st.ReconnectCount = s.reconnectCount
	st.ConsecutiveFailures = s.reconnectFailures
	st.TotalMessagesReceived = s.totalMessages
	st.BrokerID = s.brokerID
	st.InstanceName = instanceName
	st.SendPort = parsePort(sendPort)
	s.status = st
	b, err := json.MarshalIndent(st, "", "  ")
	s.mu.Unlock()

	if err != nil {
		log.Printf("[broker %s] error marshalling status: %v", s.brokerID, err)
		return
	}
	if err := os.WriteFile(s.statusFile, b, 0644); err != nil {
		log.Printf("[broker %s] error writing status file: %v", s.brokerID, err)
	}
	s.postStatus(st)
}

func (s *BrokerSession) postStatus(st Status) {
	b, _ := json.Marshal(st)
	resp, err := http.Post(apiURL+"/api/sync/status", "application/json", strings.NewReader(string(b)))
	if err != nil {
		log.Printf("[broker %s] error posting status: %v", s.brokerID, err)
		return
	}
	resp.Body.Close()
}

func (s *BrokerSession) clearDevice() {
	if s.client != nil && s.client.Store.ID != nil {
		if err := s.client.Store.Delete(context.Background()); err != nil {
			log.Printf("[broker %s] error deleting device: %v", s.brokerID, err)
		}
	}
}

// ── Session manager ────────────────────────────────────────────────────────

type SessionManager struct {
	mu        sync.RWMutex
	sessions  map[string]*BrokerSession
	container *sqlstore.Container
	db        *sql.DB
}

type inboxThreadCursor struct {
	GroupName  string                 `json:"group_name"`
	SenderJID  string                 `json:"sender_jid"`
	Timestamp  string                 `json:"timestamp"`
	RawPayload map[string]interface{} `json:"raw_payload"`
}

func NewSessionManager(container *sqlstore.Container, db *sql.DB) *SessionManager {
	return &SessionManager{
		sessions:  make(map[string]*BrokerSession),
		container: container,
		db:        db,
	}
}

func (sm *SessionManager) Get(brokerID string) *BrokerSession {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.sessions[brokerID]
}

func (sm *SessionManager) List() []*BrokerSession {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	out := make([]*BrokerSession, 0, len(sm.sessions))
	for _, s := range sm.sessions {
		out = append(out, s)
	}
	return out
}

func (sm *SessionManager) Remove(brokerID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	delete(sm.sessions, brokerID)
}

func (sm *SessionManager) StartOrGet(brokerID string) *BrokerSession {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if existing, ok := sm.sessions[brokerID]; ok {
		return existing
	}

	ctx := context.Background()

	// Check if we have a stored device mapping
	deviceJID, err := sm.lookupDeviceJID(ctx, brokerID)
	if err != nil {
		log.Printf("[broker %s] error looking up device mapping: %v", brokerID, err)
	}
	var device *store.Device
	if deviceJID != "" {
		jid, err := types.ParseJID(deviceJID)
		if err == nil {
			device, err = sm.container.GetDevice(ctx, jid)
			if err != nil {
				log.Printf("[broker %s] error getting device from store: %v", brokerID, err)
			}
		}
	}

	if device == nil {
		device = sm.container.NewDevice()
		log.Printf("[broker %s] created new unpaired device", brokerID)
	}

	session := sm.newSession(brokerID, device)
	sm.sessions[brokerID] = session
	go sm.runSession(session)
	return session
}

func (sm *SessionManager) newSession(brokerID string, device *store.Device) *BrokerSession {
	ctx, cancel := context.WithCancel(context.Background())
	return &BrokerSession{
		brokerID:   brokerID,
		device:     device,
		ctx:        ctx,
		cancel:     cancel,
		statusFile: fmt.Sprintf("/tmp/status_%s.json", brokerID),
		status: Status{
			ConnectionState: "new",
			SocketState:     "new",
			InstanceName:    instanceName,
			BrokerID:        brokerID,
			SendPort:        parsePort(sendPort),
		},
	}
}

func (sm *SessionManager) lookupDeviceJID(ctx context.Context, brokerID string) (string, error) {
	var jid string
	err := sm.db.QueryRowContext(ctx, "SELECT device_jid FROM broker_whatsapp_devices WHERE broker_id=$1", brokerID).Scan(&jid)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return jid, err
}

func (sm *SessionManager) saveDeviceJID(ctx context.Context, brokerID, deviceJID string) error {
	_, err := sm.db.ExecContext(ctx,
		`INSERT INTO broker_whatsapp_devices (broker_id, device_jid, created_at)
		 VALUES ($1, $2, NOW())
		 ON CONFLICT (broker_id) DO UPDATE SET device_jid=$2, updated_at=NOW()`,
		brokerID, deviceJID)
	return err
}

func (sm *SessionManager) deleteDeviceMapping(ctx context.Context, brokerID string, reason string) error {
	// Look up the existing device_jid to log it in history
	var deviceJID string
	err := sm.db.QueryRowContext(ctx, "SELECT device_jid FROM broker_whatsapp_devices WHERE broker_id=$1", brokerID).Scan(&deviceJID)
	if err != nil && err != sql.ErrNoRows {
		log.Printf("[broker %s] error looking up device JID for history: %v", brokerID, err)
	}

	if deviceJID != "" {
		_, err := sm.db.ExecContext(ctx,
			"INSERT INTO broker_whatsapp_device_history (broker_id, device_jid, wiped_at, reason) VALUES ($1, $2, NOW(), $3)",
			brokerID, deviceJID, reason)
		if err != nil {
			log.Printf("[broker %s] error writing to history table: %v", brokerID, err)
		}
	}

	_, err = sm.db.ExecContext(ctx, "DELETE FROM broker_whatsapp_devices WHERE broker_id=$1", brokerID)
	return err
}

// ── Session lifecycle ──────────────────────────────────────────────────────

func (sm *SessionManager) runSession(s *BrokerSession) {
	log.Printf("[broker %s] starting session goroutine", s.brokerID)

	for attempt := 0; ; attempt++ {
		// Check if session was stopped externally
		select {
		case <-s.ctx.Done():
			log.Printf("[broker %s] session cancelled", s.brokerID)
			return
		default:
		}

		if attempt > 0 {
			s.reconnectCount++
			s.reconnectFailures++
			s.setStatus(Status{LastDisconnectAt: time.Now().UTC().Format(time.RFC3339)})
			backoff := time.Duration(2+rand.Intn(1+attempt)) * time.Second
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
			log.Printf("[broker %s] reconnect attempt %d in %v", s.brokerID, attempt, backoff)

			select {
			case <-time.After(backoff):
			case <-s.ctx.Done():
				return
			}
		}

		log.Printf("[broker %s] connecting to WhatsApp...", s.brokerID)
		s.setStatus(Status{Connected: false, ConnectionState: "connecting", SocketState: "connecting"})

		ctx := context.Background()

		// Remove old client handlers if any
		if s.client != nil {
			s.client.RemoveEventHandlers()
			s.client.Disconnect()
		}

		if s.device == nil {
			log.Printf("[broker %s] device is nil, creating new device", s.brokerID)
			s.device = sm.container.NewDevice()
		}

		disconnected := make(chan struct{})
		s.disconnected = disconnected
		s.disconnectOnce = sync.OnceValue(func() struct{} { close(disconnected); return struct{}{} })

		s.client = whatsmeow.NewClient(s.device, waLog.Noop)
		s.client.AddEventHandler(func(evt interface{}) {
			sm.handleEvent(s, evt)
		})

		// Too many reconnect failures → clear device, force QR
		// Tradeoff: Lower threshold (e.g. 10) triggers a full wipe fast but forces re-pairing (QR code).
		// Higher threshold (e.g. 25-30) is better for high-traffic sessions with transient disconnects.
		// MAX_RECONNECT_FAILURES is configurable via environment variable.
		maxReconnectFailures := getEnvInt("MAX_RECONNECT_FAILURES", 10)
		if s.device.ID != nil && s.reconnectFailures >= maxReconnectFailures {
			log.Printf("[broker %s] SESSION_WIPED reason=max_reconnect_failures timestamp=%s reconnectFailures=%d reconnectCount=%d",
				s.brokerID, time.Now().UTC().Format(time.RFC3339), s.reconnectFailures, s.reconnectCount)
			s.clearDevice()
			sm.deleteDeviceMapping(ctx, s.brokerID, "max_reconnect_failures")
			s.device = sm.container.NewDevice()
			s.reconnectFailures = 0
		}

		var heartbeatStop chan struct{}
		stopHeartbeat := func() {
			if heartbeatStop != nil {
				close(heartbeatStop)
				heartbeatStop = nil
			}
		}

		if s.device.ID == nil {
			// No session — QR pairing flow
			s.reconnectFailures = 0
			qrChan, err := s.client.GetQRChannel(ctx)
			if err != nil {
				log.Printf("[broker %s] error getting QR channel: %v", s.brokerID, err)
				s.reconnectFailures++
				continue
			}
			if err := s.client.Connect(); err != nil {
				log.Printf("[broker %s] error connecting: %v", s.brokerID, err)
				s.reconnectFailures++
				continue
			}
			heartbeatStop = s.startHeartbeat()
		outer:
			for {
				select {
				case evt, ok := <-qrChan:
					if !ok {
						break outer
					}
					if evt.Event == "code" {
						s.setStatus(Status{Connected: false, ConnectionState: "qr", QR: evt.Code, QRAvailable: true})
						fmt.Printf("[broker %s] QR: %s\n", s.brokerID, evt.Code)
					}
				case <-disconnected:
					break outer
				case <-s.ctx.Done():
					stopHeartbeat()
					s.client.Disconnect()
					return
				}
			}
			stopHeartbeat()
			continue
		} else {
			// Existing session — connect directly
			if err := s.client.Connect(); err != nil {
				log.Printf("[broker %s] error connecting: %v", s.brokerID, err)
				s.reconnectFailures++
				continue
			}
			heartbeatStop = s.startHeartbeat()
		}

		s.reconnectFailures = 0

		// Block until disconnected or cancelled
		select {
		case <-disconnected:
		case <-s.ctx.Done():
			stopHeartbeat()
			if s.client != nil {
				s.client.Disconnect()
			}
			return
		}
		stopHeartbeat()
	}
}

func (s *BrokerSession) startHeartbeat() chan struct{} {
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				cur := s.getStatus()
				cur.HeartbeatAt = time.Now().UTC().Format(time.RFC3339)
				s.setStatus(cur)
			case <-stop:
				return
			case <-s.ctx.Done():
				return
			}
		}
	}()
	return stop
}

// ── Event handler ──────────────────────────────────────────────────────────

func (sm *SessionManager) handleEvent(s *BrokerSession, evt interface{}) {
	switch v := evt.(type) {
	case *events.QR:
		code := strings.Join(v.Codes, "\n")
		s.setStatus(Status{Connected: false, ConnectionState: "qr", QR: code, QRAvailable: true})

	case *events.QRScannedWithoutMultidevice:
		s.setStatus(Status{Connected: false, ConnectionState: "scanning"})

	case *events.LoggedOut:
		log.Printf("[broker %s] SESSION_WIPED reason=logged_out timestamp=%s reconnectFailures=%d reconnectCount=%d",
			s.brokerID, time.Now().UTC().Format(time.RFC3339), s.reconnectFailures, s.reconnectCount)
		s.setStatus(Status{Connected: false, ConnectionState: "logged_out", DisconnectReason: 401})
		s.clearDevice()
		sm.deleteDeviceMapping(context.Background(), s.brokerID, "logged_out")
		s.device = nil
		if s.disconnectOnce != nil {
			s.disconnectOnce()
		}

	case *events.Disconnected:
		hasSession := s.client != nil && s.client.Store.ID != nil
		state := "reconnecting"
		socketState := "disconnected"
		if !hasSession {
			state = "closed"
			socketState = "closed"
		}
		now := time.Now().UTC().Format(time.RFC3339)
		s.setStatus(Status{Connected: false, ConnectionState: state, SocketState: socketState, LastDisconnectAt: now})
		log.Printf("[broker %s] disconnected (session: %v)", s.brokerID, hasSession)
		if s.disconnectOnce != nil {
			s.disconnectOnce()
		}

	case *events.StreamReplaced:
		log.Printf("[broker %s] SESSION_WIPED reason=stream_replaced timestamp=%s reconnectFailures=%d reconnectCount=%d",
			s.brokerID, time.Now().UTC().Format(time.RFC3339), s.reconnectFailures, s.reconnectCount)
		s.setStatus(Status{Connected: false, ConnectionState: "logged_out", DisconnectReason: 401})
		s.clearDevice()
		sm.deleteDeviceMapping(context.Background(), s.brokerID, "stream_replaced")
		s.device = nil
		if s.disconnectOnce != nil {
			s.disconnectOnce()
		}

	case *events.Connected:
		hasSession := s.client.Store.ID != nil
		phone := ""
		displayName := ""
		if hasSession {
			phone = s.client.Store.ID.User
			displayName = s.client.Store.PushName
		}
		s.reconnectFailures = 0
		s.setStatus(Status{
			Connected:       hasSession,
			ConnectionState: "open",
			SocketState:     "connected",
			PhoneNumber:     phone,
			DisplayName:     displayName,
			ConnectedSince:  time.Now().UTC().Format(time.RFC3339),
		})
		log.Printf("[broker %s] connected to WhatsApp server (phone: %s)", s.brokerID, phone)

	case *events.PairSuccess:
		phone := v.ID.User
		displayName := v.BusinessName
		if displayName == "" {
			displayName = s.client.Store.PushName
		}
		// Save the device JID mapping after successful pairing
		jidStr := v.ID.String()
		if err := sm.saveDeviceJID(context.Background(), s.brokerID, jidStr); err != nil {
			log.Printf("[broker %s] error saving device mapping: %v", s.brokerID, err)
		}
		s.setStatus(Status{
			Connected: true, ConnectionState: "open", SocketState: "connected",
			PhoneNumber: phone, DisplayName: displayName,
			ConnectedSince: time.Now().UTC().Format(time.RFC3339),
		})
		log.Printf("[broker %s] paired — phone: %s, jid: %s", s.brokerID, phone, jidStr)

	case *events.PushNameSetting:
		cur := s.getStatus()
		s.setStatus(Status{
			Connected:       cur.Connected,
			ConnectionState: cur.ConnectionState,
			PhoneNumber:     cur.PhoneNumber,
			DisplayName:     v.Action.GetName(),
			ConnectedSince:  cur.ConnectedSince,
			LastMessageAt:   cur.LastMessageAt,
		})

	case *events.Message:
		go sm.handleMessage(s, v)

	case *events.HistorySync:
		go sm.handleHistorySync(s, v)
	}
}

// ── Message handling ───────────────────────────────────────────────────────

func (sm *SessionManager) handleMessage(s *BrokerSession, evt *events.Message) {
	info := evt.Info
	if info.ID == "" || info.IsFromMe {
		return
	}

	s.totalMessages++

	key := map[string]interface{}{
		"remoteJid": info.Chat.String(),
		"fromMe":    info.IsFromMe,
		"id":        info.ID,
	}
	if info.IsGroup {
		key["participant"] = info.Sender.String()
	}

	sender := map[string]interface{}{
		"id":   info.Sender.String(),
		"name": info.PushName,
	}

	payload := map[string]interface{}{
		"event": "MESSAGES_UPSERT",
		"data": map[string]interface{}{
			"key":              key,
			"message":          marshalMessage(evt.Message),
			"pushName":         info.PushName,
			"messageTimestamp": info.Timestamp.Unix(),
			"sender":           sender,
			"instance":         instanceName,
			"broker_id":        s.brokerID,
		},
	}

	cur := s.getStatus()
	s.setStatus(Status{
		Connected:       true,
		ConnectionState: "open",
		SocketState:     "connected",
		PhoneNumber:     cur.PhoneNumber,
		DisplayName:     cur.DisplayName,
		ConnectedSince:  cur.ConnectedSince,
		LastMessageAt:   info.Timestamp.Format(time.RFC3339),
	})

	b, _ := json.Marshal(payload)
	resp, err := http.Post(webhookURL, "application/json", strings.NewReader(string(b)))
	if err != nil {
		log.Printf("[broker %s] error sending webhook: %v", s.brokerID, err)
		return
	}
	resp.Body.Close()
}

// ── HTTP handlers ──────────────────────────────────────────────────────────

func (sm *SessionManager) handleHistorySync(s *BrokerSession, evt *events.HistorySync) {
	if evt == nil || evt.Data == nil {
		return
	}

	conversations := evt.Data.GetConversations()
	posted := 0
	for _, conv := range conversations {
		if conv == nil {
			continue
		}
		chatID := conv.GetID()
		chatName := strings.TrimSpace(conv.GetName())
		if chatName == "" {
			chatName = strings.TrimSpace(conv.GetDisplayName())
		}

		for _, historyMsg := range conv.GetMessages() {
			if historyMsg == nil || historyMsg.GetMessage() == nil {
				continue
			}
			if sm.postWebMessage(s, historyMsg.GetMessage(), chatID, chatName, "history_sync") {
				posted++
			}
		}
	}

	if posted > 0 {
		s.totalMessages += int64(posted)
		cur := s.getStatus()
		s.setStatus(Status{
			Connected:       true,
			ConnectionState: "open",
			SocketState:     "connected",
			PhoneNumber:     cur.PhoneNumber,
			DisplayName:     cur.DisplayName,
			ConnectedSince:  cur.ConnectedSince,
			LastMessageAt:   time.Now().UTC().Format(time.RFC3339),
		})
	}
	log.Printf("[broker %s] history sync progress=%d conversations=%d messages_posted=%d", s.brokerID, evt.Data.GetProgress(), len(conversations), posted)
}

func (sm *SessionManager) postWebMessage(s *BrokerSession, wmsg *waWeb.WebMessageInfo, chatID, chatName, source string) bool {
	if wmsg == nil || wmsg.GetMessage() == nil || wmsg.GetKey() == nil {
		return false
	}

	keyInfo := wmsg.GetKey()
	messageID := strings.TrimSpace(keyInfo.GetID())
	if messageID == "" {
		return false
	}

	remoteJID := strings.TrimSpace(keyInfo.GetRemoteJID())
	if remoteJID == "" {
		remoteJID = strings.TrimSpace(chatID)
	}
	if remoteJID == "" {
		return false
	}

	fromMe := keyInfo.GetFromMe()
	participant := strings.TrimSpace(wmsg.GetParticipant())
	if participant == "" {
		participant = strings.TrimSpace(keyInfo.GetParticipant())
	}

	senderID := participant
	if senderID == "" && !fromMe {
		senderID = remoteJID
	}

	key := map[string]interface{}{
		"remoteJid": remoteJID,
		"fromMe":    fromMe,
		"id":        messageID,
	}
	if participant != "" {
		key["participant"] = participant
	}

	pushName := strings.TrimSpace(wmsg.GetPushName())
	timestamp := int64(wmsg.GetMessageTimestamp())
	if timestamp <= 0 {
		timestamp = time.Now().Unix()
	}

	payload := map[string]interface{}{
		"event": "MESSAGES_UPSERT",
		"data": map[string]interface{}{
			"key":              key,
			"message":          marshalMessage(wmsg.GetMessage()),
			"pushName":         pushName,
			"messageTimestamp": timestamp,
			"sender": map[string]interface{}{
				"id":   senderID,
				"name": pushName,
			},
			"instance":         instanceName,
			"broker_id":        s.brokerID,
			"source":           source,
			"conversationName": chatName,
		},
	}

	b, _ := json.Marshal(payload)
	resp, err := http.Post(webhookURL, "application/json", strings.NewReader(string(b)))
	if err != nil {
		log.Printf("[broker %s] error sending %s webhook: %v", s.brokerID, source, err)
		return false
	}
	resp.Body.Close()
	return true
}

func brokerIDFromRequest(r *http.Request) string {
	if id := r.URL.Query().Get("broker_id"); id != "" {
		return id
	}
	if id := r.Header.Get("X-Broker-Id"); id != "" {
		return id
	}
	return "default"
}

func (sm *SessionManager) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	brokerID := r.URL.Query().Get("broker_id")
	if brokerID == "all" {
		sessions := sm.List()
		statuses := make([]Status, 0, len(sessions))
		for _, s := range sessions {
			statuses = append(statuses, s.getStatus())
		}
		json.NewEncoder(w).Encode(statuses)
		return
	}
	if brokerID == "" {
		brokerID = "default"
	}
	s := sm.Get(brokerID)
	if s == nil {
		json.NewEncoder(w).Encode(Status{
			BrokerID: brokerID, ConnectionState: "unknown", Connected: false,
			InstanceName: instanceName, SendPort: parsePort(sendPort),
		})
		return
	}
	json.NewEncoder(w).Encode(s.getStatus())
}

func (sm *SessionManager) connectHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	brokerID := brokerIDFromRequest(r)
	if brokerID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "broker_id is required"})
		return
	}
	session := sm.StartOrGet(brokerID)
	status := session.getStatus()
	json.NewEncoder(w).Encode(status)
}

func (sm *SessionManager) resetHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	brokerID := brokerIDFromRequest(r)
	if brokerID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "broker_id is required"})
		return
	}
	s := sm.Get(brokerID)
	if s == nil {
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "note": "no session to reset"})
		return
	}
	log.Printf("[broker %s] SESSION_WIPED reason=http_reset timestamp=%s reconnectFailures=%d reconnectCount=%d",
		brokerID, time.Now().UTC().Format(time.RFC3339), s.reconnectFailures, s.reconnectCount)
	s.clearDevice()
	sm.deleteDeviceMapping(context.Background(), brokerID, "http_reset")
	s.device = sm.container.NewDevice()
	s.reconnectFailures = 0
	if s.disconnectOnce != nil {
		s.disconnectOnce()
	}
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (sm *SessionManager) disconnectHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	brokerID := brokerIDFromRequest(r)
	if brokerID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "broker_id is required"})
		return
	}
	s := sm.Get(brokerID)
	if s == nil {
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "note": "no session to disconnect"})
		return
	}
	if s.cancel != nil {
		s.cancel()
	}
	sm.Remove(brokerID)
	log.Printf("[broker %s] disconnected and removed", brokerID)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// ── Helpers ────────────────────────────────────────────────────────────────

func (sm *SessionManager) listHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	sessions := sm.List()
	result := make([]Status, 0, len(sessions))
	for _, s := range sessions {
		result = append(result, s.getStatus())
	}
	json.NewEncoder(w).Encode(result)
}

func (sm *SessionManager) historyBackfillHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	brokerID := brokerIDFromRequest(r)
	s := sm.Get(brokerID)
	if s == nil || s.client == nil || !s.client.IsConnected() {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "whatsapp session is not connected"})
		return
	}

	limit := 25
	count := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		fmt.Sscanf(raw, "%d", &limit)
	}
	if raw := r.URL.Query().Get("count"); raw != "" {
		fmt.Sscanf(raw, "%d", &count)
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	if count < 1 {
		count = 1
	}
	if count > 50 {
		count = 50
	}

	reqURL := fmt.Sprintf("%s/api/inbox/threads?limit=%d", strings.TrimRight(apiURL, "/"), limit)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(reqURL)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": fmt.Sprintf("api returned %d", resp.StatusCode)})
		return
	}

	var cursors []inboxThreadCursor
	if err := json.NewDecoder(resp.Body).Decode(&cursors); err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}

	requested := 0
	skipped := 0
	for _, cursor := range cursors {
		info, ok := messageInfoFromCursor(cursor)
		if !ok {
			skipped++
			continue
		}
		historyReq := s.client.BuildHistorySyncRequest(info, count)
		if historyReq == nil {
			skipped++
			continue
		}
		sendCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, err := s.client.SendPeerMessage(sendCtx, historyReq)
		cancel()
		if err != nil {
			log.Printf("[broker %s] history backfill request failed for %s: %v", brokerID, info.Chat.String(), err)
			skipped++
			continue
		}
		requested++
		time.Sleep(250 * time.Millisecond)
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":             true,
		"requested":      requested,
		"skipped":        skipped,
		"messages_count": count,
		"note":           "WhatsApp will return history asynchronously through HistorySync events.",
	})
}

func messageInfoFromCursor(cursor inboxThreadCursor) (*types.MessageInfo, bool) {
	data, _ := cursor.RawPayload["data"].(map[string]interface{})
	key, _ := data["key"].(map[string]interface{})
	if len(key) == 0 {
		return nil, false
	}

	remoteJID := stringFromAny(key["remoteJid"])
	if remoteJID == "" {
		remoteJID = strings.TrimSpace(cursor.GroupName)
	}
	messageID := stringFromAny(key["id"])
	if remoteJID == "" || messageID == "" {
		return nil, false
	}

	chat, err := types.ParseJID(remoteJID)
	if err != nil {
		return nil, false
	}

	fromMe := boolFromAny(key["fromMe"])
	participant := stringFromAny(key["participant"])
	if participant == "" {
		participant = strings.TrimSpace(cursor.SenderJID)
	}
	sender := types.EmptyJID
	if participant != "" {
		if parsed, err := types.ParseJID(participant); err == nil {
			sender = parsed
		}
	}
	if sender.IsEmpty() && !fromMe {
		sender = chat
	}

	ts := time.Now()
	if parsed := timestampFromAny(data["messageTimestamp"]); !parsed.IsZero() {
		ts = parsed
	} else if parsed := timestampFromAny(cursor.Timestamp); !parsed.IsZero() {
		ts = parsed
	}

	return &types.MessageInfo{
		MessageSource: types.MessageSource{
			Chat:     chat,
			Sender:   sender,
			IsFromMe: fromMe,
			IsGroup:  strings.HasSuffix(remoteJID, "@g.us"),
		},
		ID:        messageID,
		PushName:  stringFromAny(data["pushName"]),
		Timestamp: ts,
	}, true
}

func stringFromAny(value interface{}) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case fmt.Stringer:
		return strings.TrimSpace(v.String())
	default:
		return ""
	}
}

func boolFromAny(value interface{}) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true")
	default:
		return false
	}
}

func timestampFromAny(value interface{}) time.Time {
	switch v := value.(type) {
	case float64:
		if v > 10_000_000_000 {
			v = v / 1000
		}
		return time.Unix(int64(v), 0)
	case int64:
		if v > 10_000_000_000 {
			v = v / 1000
		}
		return time.Unix(v, 0)
	case string:
		if v == "" {
			return time.Time{}
		}
		if parsed, err := time.Parse(time.RFC3339, v); err == nil {
			return parsed
		}
		var numeric float64
		if _, err := fmt.Sscanf(v, "%f", &numeric); err == nil && numeric > 0 {
			if numeric > 10_000_000_000 {
				numeric = numeric / 1000
			}
			return time.Unix(int64(numeric), 0)
		}
	}
	return time.Time{}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parsePort(p string) int {
	port := 3001
	fmt.Sscanf(p, "%d", &port)
	return port
}

func marshalMessage(msg *waE2E.Message) json.RawMessage {
	if msg == nil {
		return json.RawMessage("{}")
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return json.RawMessage("{}")
	}
	return json.RawMessage(b)
}

// ── Main ───────────────────────────────────────────────────────────────────

func main() {
	log.Printf("starting whatsmeow ingestor (instance: %s)", instanceName)

	// Open DB connection for broker-device mapping
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		log.Fatalf("error opening database: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)

	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS broker_whatsapp_devices (
		broker_id TEXT PRIMARY KEY,
		device_jid TEXT NOT NULL,
		created_at TIMESTAMPTZ DEFAULT NOW(),
		updated_at TIMESTAMPTZ DEFAULT NOW()
	)`); err != nil {
		log.Fatalf("error creating mapping table: %v", err)
	}

	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS broker_whatsapp_device_history (
		id SERIAL PRIMARY KEY,
		broker_id TEXT NOT NULL,
		device_jid TEXT NOT NULL,
		wiped_at TIMESTAMPTZ DEFAULT NOW(),
		reason TEXT NOT NULL
	)`); err != nil {
		log.Fatalf("error creating history table: %v", err)
	}

	// Create whatsmeow container (handles its own connection pooling)
	ctx := context.Background()
	container, err := sqlstore.New(ctx, "postgres", databaseURL, waLog.Noop)
	if err != nil {
		log.Fatalf("error creating store container: %v", err)
	}

	sm := NewSessionManager(container, db)

	// Load existing broker sessions from stored device mappings
	rows, err := db.Query("SELECT broker_id, device_jid FROM broker_whatsapp_devices")
	if err != nil {
		log.Printf("error loading existing sessions: %v", err)
	} else {
		for rows.Next() {
			var brokerID, deviceJID string
			if err := rows.Scan(&brokerID, &deviceJID); err != nil {
				log.Printf("error scanning row: %v", err)
				continue
			}
			jid, parseErr := types.ParseJID(deviceJID)
			if parseErr != nil {
				log.Printf("[broker %s] invalid JID %q: %v", brokerID, deviceJID, parseErr)
				continue
			}
			device, getErr := container.GetDevice(ctx, jid)
			if getErr != nil {
				log.Printf("[broker %s] error getting device: %v", brokerID, getErr)
				continue
			}
			if device == nil {
				log.Printf("[broker %s] device %q not found in store, removing mapping", brokerID, deviceJID)
				db.Exec("DELETE FROM broker_whatsapp_devices WHERE broker_id=$1", brokerID)
				continue
			}
			session := sm.newSession(brokerID, device)
			sm.mu.Lock()
			sm.sessions[brokerID] = session
			sm.mu.Unlock()
			go sm.runSession(session)
			log.Printf("[broker %s] session restored from device %q", brokerID, deviceJID)
		}
		rows.Close()
	}

	// HTTP server
	mux := http.NewServeMux()
	mux.HandleFunc("/health", sm.healthHandler)
	mux.HandleFunc("/connect", sm.connectHandler)
	mux.HandleFunc("/reset", sm.resetHandler)
	mux.HandleFunc("/disconnect", sm.disconnectHandler)
	mux.HandleFunc("/list", sm.listHandler)
	mux.HandleFunc("/history/backfill", sm.historyBackfillHandler)

	server := &http.Server{
		Addr:    ":" + sendPort,
		Handler: mux,
	}

	go func() {
		log.Printf("HTTP server listening on port %s", sendPort)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	// Wait for shutdown signal
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	<-c

	log.Printf("shutting down...")
	ctxShutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Cancel all broker sessions
	sm.mu.RLock()
	for _, s := range sm.sessions {
		if s.cancel != nil {
			s.cancel()
		}
	}
	sm.mu.RUnlock()

	server.Shutdown(ctxShutdown)
}

func getEnvInt(key string, fallback int) int {
	val := os.Getenv(key)
	if val == "" {
		return fallback
	}
	var intVal int
	if _, err := fmt.Sscanf(val, "%d", &intVal); err != nil {
		return fallback
	}
	return intVal
}
