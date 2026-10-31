package config

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadRuntimeKindDefaultsDocker(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worker.json")
	sock := filepath.ToSlash(filepath.Join(dir, "worker.sock"))
	cred := filepath.ToSlash(filepath.Join(dir, "credentials.json"))
	raw := fmt.Sprintf(`{
  "vm_id": "vm-01",
  "socket_path": %q,
  "credential_path": %q,
  "proxy_url": "socks5h://127.0.0.1:1080",
  "proxy_required": true,
  "test_endpoints": true,
  "anthropic_base_url": "http://127.0.0.1:9",
  "oauth_token_url": "http://127.0.0.1:9"
}`, sock, cred)
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeKind != "docker" {
		t.Fatalf("RuntimeKind=%q", cfg.RuntimeKind)
	}
	if cfg.ConfigPath != path {
		t.Fatalf("ConfigPath=%q", cfg.ConfigPath)
	}
	if cfg.FirstByteSecs != DefaultFirstByteSecs {
		t.Fatalf("FirstByteSecs=%d", cfg.FirstByteSecs)
	}
	if cfg.IdleTimeoutSecs != DefaultIdleTimeoutSecs {
		t.Fatalf("IdleTimeoutSecs=%d", cfg.IdleTimeoutSecs)
	}
	if cfg.RequestTimeoutSec != DefaultRequestTimeoutSecs {
		t.Fatalf("RequestTimeoutSec=%d", cfg.RequestTimeoutSec)
	}
}

func TestLoadTransparentAllowsEmptyProxyURL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worker.json")
	sock := filepath.ToSlash(filepath.Join(dir, "worker.sock"))
	cred := filepath.ToSlash(filepath.Join(dir, "credentials.json"))
	raw := fmt.Sprintf(`{
  "vm_id": "vm-01",
  "socket_path": %q,
  "credential_path": %q,
  "proxy_url": "",
  "proxy_required": false,
  "egress_mode": "transparent",
  "test_endpoints": true,
  "anthropic_base_url": "http://127.0.0.1:9",
  "oauth_token_url": "http://127.0.0.1:9"
}`, sock, cred)
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EgressMode != "transparent" {
		t.Fatalf("EgressMode=%q", cfg.EgressMode)
	}
	if cfg.ProxyURL != "" {
		t.Fatalf("ProxyURL=%q", cfg.ProxyURL)
	}
}
