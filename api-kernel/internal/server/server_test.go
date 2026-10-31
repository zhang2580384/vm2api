package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/api-kernel/internal/pool"
)

func TestForwardCopiesUpstream(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("X-Api-Key") != "sk-test" {
			t.Fatalf("missing x-api-key")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: {\"type\":\"message_stop\"}\n\n")
	}))
	defer up.Close()

	h := (&Server{Token: "t", Pool: pool.NewManager()}).Handler()
	env, _ := json.Marshal(forwardEnv{
		Method:  "POST",
		URL:     up.URL + "/v1/messages?beta=true",
		Headers: map[string]string{"x-api-key": "sk-test"},
		Body:    `{"model":"x"}`,
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/forward", strings.NewReader(string(env)))
	req.Header.Set("X-Kin-Internal-Token", "t")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "message_stop") {
		t.Fatalf("body %s", rec.Body.String())
	}
}

func TestForwardDeliversSSEBeforeUpstreamCompletes(t *testing.T) {
	for _, contentType := range []string{"text/event-stream", "text/event-stream; charset=utf-8"} {
		t.Run(contentType, func(t *testing.T) {
			finish := make(chan struct{})
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", contentType)
				_, _ = io.WriteString(w, "data: {\"type\":\"response.created\"}\n\n")
				w.(http.Flusher).Flush()
				select {
				case <-finish:
				case <-r.Context().Done():
				}
			}))
			defer up.Close()
			proxy := httptest.NewServer((&Server{Token: "t", Pool: pool.NewManager()}).Handler())
			defer proxy.Close()
			defer close(finish)
			env, err := json.Marshal(forwardEnv{Method: "POST", URL: up.URL, Body: `{}`})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, proxy.URL+"/internal/forward", strings.NewReader(string(env)))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("X-Kin-Internal-Token", "t")
			resp, err := proxy.Client().Do(req)
			if err != nil {
				t.Fatalf("SSE was not forwarded before upstream completion: %v", err)
			}
			defer resp.Body.Close()
			line, err := bufio.NewReader(resp.Body).ReadString('\n')
			if err != nil || line != "data: {\"type\":\"response.created\"}\n" {
				t.Fatalf("first event = %q, error = %v", line, err)
			}
		})
	}
}
