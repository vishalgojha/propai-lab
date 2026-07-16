package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
)

type inboundMedia struct {
	Kind        string `json:"kind"`
	MIMEType    string `json:"mime_type,omitempty"`
	FileName    string `json:"file_name,omitempty"`
	FileLength  uint64 `json:"file_length,omitempty"`
	StoragePath string `json:"storage_path,omitempty"`
	Error       string `json:"error,omitempty"`
}

func (sm *SessionManager) captureMedia(s *BrokerSession, msg *waE2E.Message, chatJID, messageID string) *inboundMedia {
	if s == nil || s.client == nil || msg == nil {
		return nil
	}
	var downloadable whatsmeow.DownloadableMessage
	media := &inboundMedia{}
	switch {
	case msg.GetImageMessage() != nil:
		downloadable = msg.GetImageMessage()
		media.Kind, media.MIMEType, media.FileLength = "image", msg.GetImageMessage().GetMimetype(), msg.GetImageMessage().GetFileLength()
	case msg.GetVideoMessage() != nil:
		downloadable = msg.GetVideoMessage()
		media.Kind, media.MIMEType, media.FileLength = "video", msg.GetVideoMessage().GetMimetype(), msg.GetVideoMessage().GetFileLength()
	case msg.GetAudioMessage() != nil:
		downloadable = msg.GetAudioMessage()
		media.Kind, media.MIMEType, media.FileLength = "audio", msg.GetAudioMessage().GetMimetype(), msg.GetAudioMessage().GetFileLength()
	case msg.GetDocumentMessage() != nil:
		downloadable = msg.GetDocumentMessage()
		media.Kind, media.MIMEType = "document", msg.GetDocumentMessage().GetMimetype()
		media.FileName, media.FileLength = msg.GetDocumentMessage().GetFileName(), msg.GetDocumentMessage().GetFileLength()
	case msg.GetStickerMessage() != nil:
		downloadable = msg.GetStickerMessage()
		media.Kind, media.MIMEType, media.FileLength = "sticker", msg.GetStickerMessage().GetMimetype(), msg.GetStickerMessage().GetFileLength()
	default:
		return nil
	}

	maxBytes := uint64(20 * 1024 * 1024)
	if raw := strings.TrimSpace(os.Getenv("PROPAI_MEDIA_MAX_BYTES")); raw != "" {
		if parsed, err := strconv.ParseUint(raw, 10, 64); err == nil {
			maxBytes = parsed
		}
	}
	if media.FileLength > maxBytes {
		media.Error = fmt.Sprintf("media exceeds %d byte limit", maxBytes)
		return media
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	content, err := s.client.Download(ctx, downloadable)
	if err != nil {
		media.Error = "download failed"
		log.Printf("[broker %s] media download failed for %s: %v", s.brokerID, messageID, err)
		return media
	}
	if uint64(len(content)) > maxBytes {
		media.Error = fmt.Sprintf("downloaded media exceeds %d byte limit", maxBytes)
		return media
	}
	media.FileLength = uint64(len(content))
	path, err := uploadInboundMedia(ctx, s.brokerID, chatJID, messageID, media, content)
	if err != nil {
		media.Error = "storage upload failed"
		log.Printf("[broker %s] media upload failed for %s: %v", s.brokerID, messageID, err)
		return media
	}
	media.StoragePath = path
	return media
}

func uploadInboundMedia(ctx context.Context, brokerID, chatJID, messageID string, media *inboundMedia, content []byte) (string, error) {
	baseURL := resolveSupabaseURL()
	serviceKey := strings.TrimSpace(os.Getenv("SUPABASE_SERVICE_ROLE_KEY"))
	if serviceKey == "" {
		serviceKey = strings.TrimSpace(os.Getenv("SUPABASE_SERVICE_KEY"))
	}
	if baseURL == "" || serviceKey == "" {
		return "", fmt.Errorf("Supabase storage configuration is missing")
	}
	ext := extensionForMIME(media.MIMEType)
	if media.FileName != "" {
		if dot := strings.LastIndex(media.FileName, "."); dot >= 0 && len(media.FileName)-dot <= 10 {
			ext = media.FileName[dot:]
		}
	}
	path := strings.Join([]string{safePathPart(brokerID), safePathPart(chatJID), safePathPart(messageID) + ext}, "/")
	endpoint := strings.TrimRight(baseURL, "/") + "/storage/v1/object/whatsapp-media/" + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(content))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+serviceKey)
	req.Header.Set("apikey", serviceKey)
	req.Header.Set("Content-Type", media.MIMEType)
	req.Header.Set("x-upsert", "true")
	resp, err := webhookHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return "", fmt.Errorf("storage returned %d: %s", resp.StatusCode, string(body))
	}
	return path, nil
}

func resolveSupabaseURL() string {
	if configured := strings.TrimSpace(os.Getenv("SUPABASE_URL")); configured != "" {
		return configured
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return ""
	}
	host := strings.TrimPrefix(parsed.Hostname(), "db.")
	if !strings.HasSuffix(host, ".supabase.co") {
		return ""
	}
	return "https://" + host
}

func safePathPart(value string) string {
	return url.PathEscape(strings.TrimSpace(value))
}

func extensionForMIME(mime string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0])) {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "video/mp4":
		return ".mp4"
	case "audio/ogg":
		return ".ogg"
	case "audio/mpeg":
		return ".mp3"
	case "application/pdf":
		return ".pdf"
	default:
		return ".bin"
	}
}
