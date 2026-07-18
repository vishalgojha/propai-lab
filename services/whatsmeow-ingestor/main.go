package main

import (
	"context"
	"crypto/hmac"
	"database/sql"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log"
	"math/rand"
	"net/http"
	"net/url"
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
	"google.golang.org/protobuf/proto"
)

var (
	databaseURL  = resolveDatabaseURL()
	webhookURL   = getEnv("PROPAI_WEBHOOK_URL", "https://api.propai.live/webhook")
	apiURL       = getEnv("PROPAI_API_URL", "https://api.propai.live")
	instanceName = getEnv("PROPAI_INSTANCE_NAME", "propai-whatsmeow")
	sendPort     = getEnv("PROPAI_SEND_PORT", "3001")
	statusClient = &http.Client{Timeout: 5 * time.Second}
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
	lockConn          *sql.Conn
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
	req, err := http.NewRequest(http.MethodPost, apiURL+"/api/sync/status", strings.NewReader(string(b)))
	if err != nil {
		log.Printf("[broker %s] error building status request: %v", s.brokerID, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if token := internalServiceToken(); token != "" {
		req.Header.Set("X-PropAI-Internal-Token", token)
	}
	resp, err := statusClient.Do(req)
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

func (s *BrokerSession) releaseLock() {
	if s.lockConn == nil {
		return
	}
	key := brokerLockKey(s.brokerID)
	if _, err := s.lockConn.ExecContext(context.Background(), "SELECT pg_advisory_unlock($1)", key); err != nil {
		log.Printf("[broker %s] error releasing session lock: %v", s.brokerID, err)
	}
	if err := s.lockConn.Close(); err != nil {
		log.Printf("[broker %s] error closing session lock connection: %v", s.brokerID, err)
	}
	s.lockConn = nil
}

// ── Session manager ────────────────────────────────────────────────────────

type SessionManager struct {
	mu         sync.RWMutex
	deliveryMu sync.Mutex
	sessions   map[string]*BrokerSession
	container  *sqlstore.Container
	db         *sql.DB
}

type inboxThreadCursor struct {
	GroupName  string                 `json:"group_name"`
	SenderJID  string                 `json:"sender_jid"`
	Timestamp  string                 `json:"timestamp"`
	RawPayload map[string]interface{} `json:"raw_payload"`
}

type sendMessageRequest struct {
	BrokerID          string `json:"brokerId"`
	RemoteJID         string `json:"remoteJid"`
	Text              string `json:"text"`
	QuotedMessageID   string `json:"quotedMessageId"`
	QuotedRemoteJID   string `json:"quotedRemoteJid"`
	QuotedParticipant string `json:"quotedParticipant"`
	QuotedFromMe      bool   `json:"quotedFromMe"`
}

type selfChatAgentRequest struct {
	BrokerID  string `json:"broker_id"`
	Text      string `json:"text"`
	MessageID string `json:"message_id"`
	SenderJID string `json:"sender_jid"`
}

type selfChatAgentResponse struct {
	Reply   string `json:"reply"`
	Error   string `json:"error"`
	Message string `json:"message"`
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
	session := sm.sessions[brokerID]
	delete(sm.sessions, brokerID)
	sm.mu.Unlock()
	if session != nil {
		session.releaseLock()
	}
}

func brokerLockKey(brokerID string) int64 {
	hasher := fnv.New64a()
	_, _ = hasher.Write([]byte(brokerID))
	return int64(hasher.Sum64() & ^(uint64(1) << 63))
}

func (sm *SessionManager) acquireBrokerLock(ctx context.Context, brokerID string) (*sql.Conn, bool, error) {
	conn, err := sm.db.Conn(ctx)
	if err != nil {
		return nil, false, err
	}
	var locked bool
	if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", brokerLockKey(brokerID)).Scan(&locked); err != nil {
		_ = conn.Close()
		return nil, false, err
	}
	if !locked {
		_ = conn.Close()
		return nil, false, nil
	}
	return conn, true, nil
}

func (sm *SessionManager) StartOrGet(brokerID string) *BrokerSession {
	sm.mu.Lock()
	if existing, ok := sm.sessions[brokerID]; ok {
		sm.mu.Unlock()
		return existing
	}
	sm.mu.Unlock()

	ctx := context.Background()
	lockConn, locked, err := sm.acquireBrokerLock(ctx, brokerID)
	if err != nil {
		log.Printf("[broker %s] error acquiring session lock: %v", brokerID, err)
		return nil
	}
	if !locked {
		log.Printf("[broker %s] session lock already held by another ingestor instance", brokerID)
		return nil
	}

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
	session.lockConn = lockConn
	sm.mu.Lock()
	sm.sessions[brokerID] = session
	sm.mu.Unlock()
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
	defer s.releaseLock()

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

		// A network outage must never destroy valid WhatsApp credentials.
		maxReconnectFailures := getEnvInt("MAX_RECONNECT_FAILURES", 10)
		if s.device.ID != nil && s.reconnectFailures >= maxReconnectFailures {
			log.Printf("[broker %s] reconnect threshold reached; preserving session timestamp=%s reconnectFailures=%d reconnectCount=%d",
				s.brokerID, time.Now().UTC().Format(time.RFC3339), s.reconnectFailures, s.reconnectCount)
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
		log.Printf("[broker %s] stream replaced; preserving credentials timestamp=%s reconnectFailures=%d reconnectCount=%d",
			s.brokerID, time.Now().UTC().Format(time.RFC3339), s.reconnectFailures, s.reconnectCount)
		s.setStatus(Status{Connected: false, ConnectionState: "reconnecting", SocketState: "disconnected", LastDisconnectAt: time.Now().UTC().Format(time.RFC3339)})
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
		go sm.initializeConnectedSession(s)

	case *events.PairSuccess:
		phone := v.ID.User
		displayName := v.BusinessName
		if displayName == "" {
			displayName = s.client.Store.PushName
		}
		jidStr := v.ID.String()
		if err := sm.saveDeviceJID(context.Background(), s.brokerID, jidStr); err != nil {
			log.Printf("[broker %s] error saving device mapping: %v", s.brokerID, err)
		}
		s.reconnectFailures = 0
		s.reconnectCount = 0
		s.setStatus(Status{
			Connected: true, ConnectionState: "open", SocketState: "connected",
			PhoneNumber: phone, DisplayName: displayName,
			ConnectedSince: time.Now().UTC().Format(time.RFC3339),
		})
		log.Printf("[broker %s] paired — phone: %s, jid: %s (failures reset)", s.brokerID, phone, jidStr)

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

	case *events.Receipt:
		sm.queueWebhook(s.brokerID, fmt.Sprintf("receipt:%s:%d", s.brokerID, time.Now().UnixNano()), map[string]interface{}{
			"event": "WHATSAPP_RECEIPT",
			"data": map[string]interface{}{
				"broker_id": s.brokerID, "chat_jid": v.Chat.String(), "sender_jid": v.Sender.String(),
				"message_ids": v.MessageIDs, "receipt_type": string(v.Type), "timestamp": v.Timestamp.Unix(),
			},
		})

	case *events.Contact:
		sm.queueWebhook(s.brokerID, fmt.Sprintf("contact:%s:%s:%d", s.brokerID, v.JID.String(), v.Timestamp.Unix()), map[string]interface{}{
			"event": "WHATSAPP_CONTACT_UPDATED",
			"data":  map[string]interface{}{"broker_id": s.brokerID, "jid": v.JID.String(), "timestamp": v.Timestamp.Unix(), "contact": v.Action},
		})

	case *events.PushName:
		sm.queueWebhook(s.brokerID, fmt.Sprintf("push-name:%s:%s:%s", s.brokerID, v.JID.String(), v.NewPushName), map[string]interface{}{
			"event": "WHATSAPP_CONTACT_UPDATED",
			"data":  map[string]interface{}{"broker_id": s.brokerID, "jid": v.JID.String(), "jid_alt": v.JIDAlt.String(), "push_name": v.NewPushName},
		})

	case *events.BusinessName:
		sm.queueWebhook(s.brokerID, fmt.Sprintf("business-name:%s:%s:%s", s.brokerID, v.JID.String(), v.NewBusinessName), map[string]interface{}{
			"event": "WHATSAPP_CONTACT_UPDATED",
			"data":  map[string]interface{}{"broker_id": s.brokerID, "jid": v.JID.String(), "business_name": v.NewBusinessName},
		})

	case *events.JoinedGroup:
		go sm.syncGroups(s)

	case *events.GroupInfo:
		go sm.syncGroups(s)

	case *events.ChatPresence:
		sm.queueWebhook(s.brokerID, fmt.Sprintf("chat-presence:%s:%s:%d", s.brokerID, v.Chat.String(), time.Now().UnixNano()), map[string]interface{}{
			"event": "presence.update",
			"data":  map[string]interface{}{"broker_id": s.brokerID, "chat_jid": v.Chat.String(), "sender_jid": v.Sender.String(), "state": string(v.State), "media": string(v.Media)},
		})
	}
}

func (sm *SessionManager) initializeConnectedSession(s *BrokerSession) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := s.client.SendPresence(ctx, types.PresenceAvailable); err != nil {
		log.Printf("[broker %s] send available presence failed: %v", s.brokerID, err)
	}
	sm.syncGroups(s)
}

func (sm *SessionManager) syncGroups(s *BrokerSession) {
	if s == nil || s.client == nil || !s.client.IsConnected() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	groups, err := s.client.GetJoinedGroups(ctx)
	if err != nil {
		log.Printf("[broker %s] group directory sync failed: %v", s.brokerID, err)
		return
	}
	directory := make([]map[string]interface{}, 0, len(groups))
	for _, group := range groups {
		participants := make([]map[string]interface{}, 0, len(group.Participants))
		for _, participant := range group.Participants {
			participants = append(participants, map[string]interface{}{
				"id": participant.JID.String(), "phone_jid": participant.PhoneNumber.String(),
				"lid": participant.LID.String(), "display_name": participant.DisplayName,
				"is_admin": participant.IsAdmin, "is_super_admin": participant.IsSuperAdmin,
			})
		}
		directory = append(directory, map[string]interface{}{
			"id": group.JID.String(), "name": group.Name, "topic": group.Topic,
			"size": group.ParticipantCount, "participants": participants,
			"is_announce": group.IsAnnounce, "is_locked": group.IsLocked,
			"is_ephemeral": group.IsEphemeral, "disappearing_timer": group.DisappearingTimer,
		})
	}
	sm.queueWebhook(s.brokerID, fmt.Sprintf("group-directory:%s:%d", s.brokerID, time.Now().Unix()/30), map[string]interface{}{
		"event": "GROUPS_REFRESHED", "instance": instanceName, "groups": directory,
		"data": map[string]interface{}{"broker_id": s.brokerID},
	})
}

// ── Message handling ───────────────────────────────────────────────────────

func (sm *SessionManager) handleMessage(s *BrokerSession, evt *events.Message) {
	info := evt.Info
	if info.ID == "" {
		return
	}
	if info.IsFromMe {
		if target, text, ok := selfChatCommand(s, evt); ok {
			sm.handleSelfChatCommand(s, target, info.ID, text)
		}
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

	payloadData := map[string]interface{}{
		"key":              key,
		"message":          marshalMessage(evt.Message),
		"pushName":         info.PushName,
		"messageTimestamp": info.Timestamp.Unix(),
		"sender":           sender,
		"instance":         instanceName,
		"broker_id":        s.brokerID,
	}
	if media := sm.captureMedia(s, evt.Message, info.Chat.String(), info.ID); media != nil {
		payloadData["media"] = media
	}
	payload := map[string]interface{}{
		"event": "MESSAGES_UPSERT",
		"data":  payloadData,
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

	eventID := fmt.Sprintf("message:%s:%s:%s", s.brokerID, info.Chat.String(), info.ID)
	if !sm.queueWebhook(s.brokerID, eventID, payload) {
		return
	}
	if strings.EqualFold(getEnv("PROPAI_MARK_MESSAGES_READ", "false"), "true") {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.client.MarkRead(ctx, []types.MessageID{info.ID}, info.Timestamp, info.Chat, info.Sender); err != nil {
			log.Printf("[broker %s] mark read failed for %s: %v", s.brokerID, info.ID, err)
		}
	}
}

func selfChatCommand(s *BrokerSession, evt *events.Message) (types.JID, string, bool) {
	if s == nil || s.client == nil || s.client.Store.ID == nil || evt == nil {
		return types.EmptyJID, "", false
	}
	info := evt.Info
	// DeviceSentMeta proves that the command came from another linked device.
	// Locally generated bot replies do not have it, which prevents reply loops.
	if !info.IsFromMe || info.IsGroup || info.DeviceSentMeta == nil {
		return types.EmptyJID, "", false
	}
	own := s.client.Store.ID.ToNonAD()
	destination, err := types.ParseJID(info.DeviceSentMeta.DestinationJID)
	if err != nil || destination.ToNonAD() != own {
		return types.EmptyJID, "", false
	}
	text := messageText(evt.Message)
	if text == "" {
		return types.EmptyJID, "", false
	}
	return own, text, true
}

func messageText(msg *waE2E.Message) string {
	if msg == nil {
		return ""
	}
	if text := strings.TrimSpace(msg.GetConversation()); text != "" {
		return text
	}
	if text := strings.TrimSpace(msg.GetExtendedTextMessage().GetText()); text != "" {
		return text
	}
	return ""
}

func (sm *SessionManager) handleSelfChatCommand(s *BrokerSession, target types.JID, messageID, text string) {
	presenceCtx, presenceCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = s.client.SendChatPresence(presenceCtx, target, types.ChatPresenceComposing, types.ChatPresenceMediaText)
	presenceCancel()
	defer func() {
		pausedCtx, pausedCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer pausedCancel()
		_ = s.client.SendChatPresence(pausedCtx, target, types.ChatPresencePaused, types.ChatPresenceMediaText)
	}()
	payload, _ := json.Marshal(selfChatAgentRequest{
		BrokerID:  s.brokerID,
		Text:      text,
		MessageID: string(messageID),
		SenderJID: target.String(),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		strings.TrimRight(apiURL, "/")+"/api/internal/self-chat",
		strings.NewReader(string(payload)),
	)
	if err != nil {
		log.Printf("[broker %s] self-chat request build failed: %v", s.brokerID, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	token := strings.TrimSpace(os.Getenv("PROPAI_INTERNAL_TOKEN"))
	if token == "" {
		token = strings.TrimSpace(os.Getenv("SUPABASE_SERVICE_KEY"))
	}
	if token != "" {
		req.Header.Set("X-PropAI-Internal-Token", token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[broker %s] self-chat agent request failed: %v", s.brokerID, err)
		return
	}
	defer resp.Body.Close()
	var agentResponse selfChatAgentResponse
	if err := json.NewDecoder(resp.Body).Decode(&agentResponse); err != nil {
		log.Printf("[broker %s] self-chat agent response decode failed: %v", s.brokerID, err)
		return
	}
	if resp.StatusCode >= 300 || strings.TrimSpace(agentResponse.Reply) == "" {
		detail := agentResponse.Error
		if detail == "" {
			detail = agentResponse.Message
		}
		log.Printf("[broker %s] self-chat agent returned status=%d error=%s", s.brokerID, resp.StatusCode, detail)
		return
	}
	sendCtx, sendCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer sendCancel()
	if _, err := s.client.SendMessage(
		sendCtx,
		target,
		&waE2E.Message{Conversation: proto.String(strings.TrimSpace(agentResponse.Reply))},
	); err != nil {
		log.Printf("[broker %s] self-chat reply send failed: %v", s.brokerID, err)
	}
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
	if media := sm.captureMedia(s, wmsg.GetMessage(), remoteJID, messageID); media != nil {
		payload["data"].(map[string]interface{})["media"] = media
	}

	eventID := fmt.Sprintf("message:%s:%s:%s", s.brokerID, remoteJID, messageID)
	return sm.queueWebhook(s.brokerID, eventID, payload)
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

func internalServiceToken() string {
	if token := strings.TrimSpace(os.Getenv("PROPAI_INTERNAL_TOKEN")); token != "" {
		return token
	}
	return strings.TrimSpace(os.Getenv("SUPABASE_SERVICE_KEY"))
}

func validInternalRequest(r *http.Request) bool {
	expected := internalServiceToken()
	supplied := strings.TrimSpace(r.Header.Get("X-PropAI-Internal-Token"))
	return expected != "" && supplied != "" && hmac.Equal([]byte(supplied), []byte(expected))
}

func internalOnly(next http.HandlerFunc, allowPublicLiveness bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if allowPublicLiveness && r.Method == http.MethodGet && r.URL.Query().Get("broker_id") == "" && !validInternalRequest(r) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "instance": instanceName})
			return
		}
		if internalServiceToken() == "" {
			http.Error(w, `{"error":"internal service authentication is not configured"}`, http.StatusServiceUnavailable)
			return
		}
		if !validInternalRequest(r) {
			http.Error(w, `{"error":"invalid internal service token"}`, http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	w.WriteHeader(http.StatusMethodNotAllowed)
	json.NewEncoder(w).Encode(map[string]string{"error": method + " required"})
	return false
}

func (sm *SessionManager) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
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
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	brokerID := brokerIDFromRequest(r)
	if brokerID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "broker_id is required"})
		return
	}
	session := sm.StartOrGet(brokerID)
	if session == nil {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": "session is already active in another ingestor instance"})
		return
	}
	status := session.getStatus()
	json.NewEncoder(w).Encode(status)
}

func (sm *SessionManager) resetHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
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
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
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

func (sm *SessionManager) deleteSessionHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	brokerID := brokerIDFromRequest(r)
	if brokerID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "broker_id is required"})
		return
	}

	if session := sm.Get(brokerID); session != nil {
		if session.cancel != nil {
			session.cancel()
		}
		session.clearDevice()
		sm.Remove(brokerID)
	} else if deviceJID, err := sm.lookupDeviceJID(context.Background(), brokerID); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "failed to look up stored WhatsApp session"})
		return
	} else if deviceJID != "" {
		if jid, parseErr := types.ParseJID(deviceJID); parseErr == nil {
			if device, getErr := sm.container.GetDevice(context.Background(), jid); getErr == nil && device != nil {
				if deleteErr := device.Delete(context.Background()); deleteErr != nil {
					log.Printf("[broker %s] error deleting inactive device: %v", brokerID, deleteErr)
				}
			}
		}
	}

	if err := sm.deleteDeviceMapping(context.Background(), brokerID, "http_delete"); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "failed to delete stored WhatsApp session"})
		return
	}
	log.Printf("[broker %s] session and device mapping deleted", brokerID)
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (sm *SessionManager) connectedSession(brokerID string) (*BrokerSession, error) {
	if brokerID != "" {
		s := sm.Get(brokerID)
		if s == nil {
			return nil, fmt.Errorf("phone not found")
		}
		if s.client == nil || !s.client.IsConnected() || s.client.Store.ID == nil {
			return nil, fmt.Errorf("phone is not connected")
		}
		return s, nil
	}

	var selected *BrokerSession
	for _, s := range sm.List() {
		if s.client == nil || !s.client.IsConnected() || s.client.Store.ID == nil {
			continue
		}
		if selected != nil {
			return nil, fmt.Errorf("multiple phones are connected; brokerId is required")
		}
		selected = s
	}
	if selected == nil {
		return nil, fmt.Errorf("no connected phone")
	}
	return selected, nil
}

func (sm *SessionManager) sendMessageHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "POST required"})
		return
	}
	var body sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "invalid JSON body"})
		return
	}
	body.RemoteJID = strings.TrimSpace(body.RemoteJID)
	body.Text = strings.TrimSpace(body.Text)
	if body.RemoteJID == "" || body.Text == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "remoteJid and text are required"})
		return
	}
	target, err := types.ParseJID(body.RemoteJID)
	if err != nil || target.IsEmpty() {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "invalid remoteJid"})
		return
	}
	session, err := sm.connectedSession(strings.TrimSpace(body.BrokerID))
	if err != nil {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	message := &waE2E.Message{Conversation: proto.String(body.Text)}
	if quotedID := strings.TrimSpace(body.QuotedMessageID); quotedID != "" {
		remoteJID := strings.TrimSpace(body.QuotedRemoteJID)
		if remoteJID == "" {
			remoteJID = target.String()
		}
		message = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String(body.Text),
			ContextInfo: &waE2E.ContextInfo{
				StanzaID: proto.String(quotedID), RemoteJID: proto.String(remoteJID),
				Participant:   proto.String(strings.TrimSpace(body.QuotedParticipant)),
				QuotedMessage: &waE2E.Message{Conversation: proto.String("")},
			},
		}}
	}
	result, err := session.client.SendMessage(
		ctx,
		target,
		message,
	)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":    true,
		"message_id": result.ID,
		"timestamp":  result.Timestamp.UTC().Format(time.RFC3339),
		"broker_id":  session.brokerID,
	})
}

// ── Helpers ────────────────────────────────────────────────────────────────

func (sm *SessionManager) listHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	sessions := sm.List()
	result := make([]Status, 0, len(sessions))
	for _, s := range sessions {
		result = append(result, s.getStatus())
	}
	json.NewEncoder(w).Encode(result)
}

func (sm *SessionManager) historyBackfillHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
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

func resolveDatabaseURL() string {
	for _, key := range []string{"DATABASE_URL", "SUPABASE_DATABASE_URL", "SUPABASE_DB_URL"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}

	projectRef := strings.TrimSpace(os.Getenv("SUPABASE_REF"))
	password := os.Getenv("SUPABASE_DB_PASSWORD")
	if projectRef == "" || password == "" {
		return ""
	}

	connection := &url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword("postgres", password),
		Host:     "db." + projectRef + ".supabase.co:5432",
		Path:     "/postgres",
		RawQuery: "sslmode=require",
	}
	return connection.String()
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
	if databaseURL == "" {
		log.Fatal("database configuration missing: set DATABASE_URL (recommended), SUPABASE_DATABASE_URL, SUPABASE_DB_URL, or both SUPABASE_REF and SUPABASE_DB_PASSWORD")
	}

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
	if err := ensureWebhookOutbox(db); err != nil {
		log.Fatalf("error creating webhook outbox: %v", err)
	}

	// Create whatsmeow container (handles its own connection pooling)
	ctx := context.Background()
	container, err := sqlstore.New(ctx, "postgres", databaseURL, waLog.Noop)
	if err != nil {
		log.Fatalf("error creating store container: %v", err)
	}

	sm := NewSessionManager(container, db)
	dispatcherCtx, stopDispatcher := context.WithCancel(context.Background())
	defer stopDispatcher()
	sm.startWebhookDispatcher(dispatcherCtx)

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
			lockConn, locked, lockErr := sm.acquireBrokerLock(ctx, brokerID)
			if lockErr != nil {
				log.Printf("[broker %s] error acquiring session lock during restore: %v", brokerID, lockErr)
				continue
			}
			if !locked {
				log.Printf("[broker %s] skipping restore because another ingestor instance owns the lock", brokerID)
				continue
			}
			session := sm.newSession(brokerID, device)
			session.lockConn = lockConn
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
	mux.HandleFunc("/health", internalOnly(sm.healthHandler, true))
	mux.HandleFunc("/connect", internalOnly(sm.connectHandler, false))
	mux.HandleFunc("/reset", internalOnly(sm.resetHandler, false))
	mux.HandleFunc("/disconnect", internalOnly(sm.disconnectHandler, false))
	mux.HandleFunc("/delete-session", internalOnly(sm.deleteSessionHandler, false))
	mux.HandleFunc("/send-message", internalOnly(sm.sendMessageHandler, false))
	mux.HandleFunc("/list", internalOnly(sm.listHandler, false))
	mux.HandleFunc("/history/backfill", internalOnly(sm.historyBackfillHandler, false))

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
