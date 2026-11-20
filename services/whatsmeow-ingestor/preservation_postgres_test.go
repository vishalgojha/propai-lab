package main

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
	"os"
	"strings"
	"testing"
	"time"
)

func TestNormalPreservationRealPostgresAndExplicitDeletion(t *testing.T) {

	dsn := os.Getenv("PROPAI_TEST_LOCAL_PG_DSN")
	if dsn == "" {
		t.Skip("disposable PG not configured")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "/tmp/propai-pairing-pg" {
		t.Fatal("requires disposable local socket")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	name := fmt.Sprintf("recovery_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec("DROP DATABASE " + name + " WITH (FORCE)")
	cfg.Database = name
	db := stdlib.OpenDB(*cfg)
	defer db.Close()
	ctx := context.Background()
	var before int
	if err = db.QueryRow("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if verifyExistingSessionSchema(ctx, db) == nil {
		t.Fatal("accepted missing schema")
	}
	var count int
	if err = db.QueryRow("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&count); err != nil || count != before {
		t.Fatal("read-only verification created tables", count, err)
	}
	container := sqlstore.NewWithDB(db, "postgres", waLog.Noop)
	// Fixture setup only. The recovery startup path deliberately does not Upgrade.
	if err = container.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"broker_whatsapp_devices", "broker_whatsapp_device_history", "group_members", "raw_messages"} {
		if _, err = db.Exec("CREATE TABLE " + table + "(fixture int)"); err != nil {
			t.Fatal(err)
		}
	}
	if err = verifyExistingSessionSchema(ctx, db); err != nil {
		t.Fatal(err)
	}
	d := container.NewDevice()
	jid := types.NewJID("123", types.DefaultUserServer)
	d.ID = &jid
	d.Account = &waAdv.ADVSignedDeviceIdentity{Details: []byte{0}, AccountSignature: make([]byte, 64), AccountSignatureKey: make([]byte, 32), DeviceSignature: make([]byte, 64)}
	protectDevice(d)
	if err = d.Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := d.Container.(preservingDeviceContainer); !ok {
		t.Fatal("new device Save lost wrapper")
	}
	loaded, err := container.GetDevice(ctx, jid)
	if err != nil || loaded == nil {
		t.Fatal(err)
	}
	protectDevice(loaded)
	if err = loaded.Save(ctx); err != nil {
		t.Fatal("loaded normal PutDevice failed", err)
	}
	if err = loaded.Delete(ctx); err == nil {
		t.Fatal("actual SQL device deletion escaped")
	}
	loadedAgain, err := container.GetDevice(ctx, jid)
	if err != nil || loadedAgain == nil || loaded.ID == nil || loaded.Deleted {
		t.Fatal("device evidence lost", err)
	}
	if err = loaded.Delete(explicitDeviceDeletion(ctx, loaded)); err != nil {
		t.Fatal("explicit deletion failed", err)
	}
	deleted, err := container.GetDevice(ctx, jid)
	if err != nil || deleted != nil {
		t.Fatal("deliberate deletion not persisted", err)
	}
	if _, err = db.Exec("UPDATE whatsmeow_version SET version=14"); err != nil {
		t.Fatal(err)
	}
	if err = verifyExistingSessionSchema(ctx, db); err == nil || !strings.Contains(err.Error(), "version15") {
		t.Fatal("version mismatch not refused", err)
	}
	var version int
	_ = db.QueryRow("SELECT version FROM whatsmeow_version").Scan(&version)
	if version != 14 {
		t.Fatal("verification changed version")
	}
}
