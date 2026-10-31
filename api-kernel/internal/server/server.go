package server

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/dofastted/kin-gateway/api-kernel/internal/pool"
)

type Server struct {
	Token string
	Pool  *pool.Manager
}

type flushingWriter struct {
	w       io.Writer
	flusher http.Flusher
}

func (w flushingWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	if err == nil {
		w.flusher.Flush()
	}
	return n, err
}

type forwardEnv struct {
	Method   string            `json:"method"`
	URL      string            `json:"url"`
	Headers  map[string]string `json:"headers"`
	Body     string            `json:"body"`
	ProxyURL string            `json:"proxy_url"`
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/health", s.authorize(s.health))
	mux.HandleFunc("POST /internal/forward", s.authorize(s.forward))
	return mux
}

func (s *Server) authorize(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if token := strings.TrimSpace(s.Token); token != "" {
			got := r.Header.Get("X-Kin-Internal-Token")
			if subtle.ConstantTimeCompare([]byte(token), []byte(got)) != 1 {
				http.Error(w, `{"ok":false,"error":{"code":"internal_auth_failed"}}`, http.StatusUnauthorized)
				return
			}
		}
		next(w, r)
	}
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"kernel":"api"}`))
}

func (s *Server) forward(w http.ResponseWriter, r *http.Request) {
	var env forwardEnv
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		http.Error(w, `{"ok":false,"error":{"code":"bad_envelope"}}`, http.StatusBadRequest)
		return
	}
	method := strings.ToUpper(strings.TrimSpace(env.Method))
	if method == "" {
		method = http.MethodPost
	}
	if !strings.HasPrefix(env.URL, "http://") && !strings.HasPrefix(env.URL, "https://") {
		http.Error(w, `{"ok":false,"error":{"code":"invalid_url"}}`, http.StatusBadRequest)
		return
	}
	client, err := s.Pool.Client(env.ProxyURL)
	if err != nil {
		http.Error(w, `{"ok":false,"error":{"code":"proxy_invalid"}}`, http.StatusBadRequest)
		return
	}
	up, err := http.NewRequestWithContext(r.Context(), method, env.URL, strings.NewReader(env.Body))
	if err != nil {
		http.Error(w, `{"ok":false,"error":{"code":"build_failed"}}`, http.StatusInternalServerError)
		return
	}
	for k, v := range env.Headers {
		if strings.TrimSpace(v) == "" {
			continue
		}
		up.Header.Set(k, v)
	}
	resp, err := client.Do(up)
	if err != nil {
		http.Error(w, `{"ok":false,"error":{"code":"upstream_transport","message":`+jsonQuote(err.Error())+`}}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vals := range resp.Header {
		lk := strings.ToLower(k)
		if lk == "connection" || lk == "transfer-encoding" {
			continue
		}
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	contentType, _, _ := strings.Cut(resp.Header.Get("Content-Type"), ";")
	if flusher, ok := w.(http.Flusher); ok && strings.EqualFold(strings.TrimSpace(contentType), "text/event-stream") {
		// net/http otherwise buffers small SSE frames until completion, losing
		// both interactive delivery and the upstream token timing boundary.
		_, _ = io.Copy(flushingWriter{w: w, flusher: flusher}, resp.Body)
		return
	}
	_, _ = io.Copy(w, resp.Body)
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
