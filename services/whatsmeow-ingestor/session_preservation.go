package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"go.mau.fi/whatsmeow/store"
)

// A context capability exists only on deliberate account actions. Never derive
// it from a request parameter, webhook, protocol event or shared mutable flag.
type explicitDeviceDeletionKey struct{}

func explicitDeviceDeletion(ctx context.Context, d *store.Device) context.Context {
	return context.WithValue(ctx, explicitDeviceDeletionKey{}, d)
}

var errAutomaticDeviceDeletion = errors.New("automatic device deletion blocked; preserve local evidence and request deliberate account repair")

type preservingDeviceContainer struct{ store.DeviceContainer }

func (p preservingDeviceContainer) DeleteDevice(ctx context.Context, d *store.Device) error {
	if ctx.Value(explicitDeviceDeletionKey{}) != d {
		return errAutomaticDeviceDeletion
	}
	return p.DeviceContainer.DeleteDevice(ctx, d)
}
func (p preservingDeviceContainer) PutDevice(ctx context.Context, d *store.Device) error {
	// sqlstore initializes a newly paired device on first Save, replacing its
	// Container. Reinstall the same protection before returning to the library.
	err := p.DeviceContainer.PutDevice(ctx, d)
	d.Container = p
	return err
}
func protectDevice(d *store.Device) {
	if d == nil {
		return
	}
	if _, ok := d.Container.(preservingDeviceContainer); !ok {
		d.Container = preservingDeviceContainer{d.Container}
	}
}

// The rollout selector controls existing identities resumed at startup only.
// Blank resumes all preexisting mappings. It never grants data access or
// prevents a new broker from deliberately setting up its own fresh connection.
func startupBrokerSelection(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	seen := map[string]bool{}
	var result []string
	for _, item := range strings.Split(raw, ",") {
		id := strings.TrimSpace(item)
		if id == "" || strings.ContainsAny(id, " \t\n\r") {
			return nil, errors.New("invalid existing broker startup selector")
		}
		if seen[id] {
			return nil, errors.New("duplicate existing broker startup selector")
		}
		seen[id] = true
		result = append(result, id)
	}
	return result, nil
}
func selectStartupBroker(id string, selected []string) bool {
	if len(selected) == 0 {
		return true
	}
	for _, wanted := range selected {
		if id == wanted {
			return true
		}
	}
	return false
}

// Schema changes are a separate deployment, not an incidental restart effect.
func verifyExistingSessionSchema(ctx context.Context, db *sql.DB) error {
	var version int
	if err := db.QueryRowContext(ctx, "SELECT version FROM whatsmeow_version LIMIT 1").Scan(&version); err != nil {
		return err
	}
	if version != 15 {
		return fmt.Errorf("pinned session schema must be version15, got%d; no upgrade performed", version)
	}
	for _, table := range []string{"broker_whatsapp_devices", "broker_whatsapp_device_history", "group_members", "raw_messages"} {
		var exists bool
		if err := db.QueryRowContext(ctx, "SELECT to_regclass($1) IS NOT NULL", "public."+table).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("missing required existing table%s; no schema changes performed", table)
		}
	}
	return nil
}
