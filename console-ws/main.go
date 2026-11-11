package main

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	_ "modernc.org/sqlite"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type config struct {
	mode         string
	listen       string
	dockerSocket string
	dockerAPI    string
	jwtSecret    string
	sqlitePath   string
	nodeSecret   string
	proxyURL     string
}

func main() {
	cfg := config{}
	flag.StringVar(&cfg.mode, "mode", envOr("CONSOLE_WS_MODE", "server"), "server|agent")
	flag.StringVar(&cfg.listen, "listen", envOr("CONSOLE_WS_LISTEN", "127.0.0.1:9100"), "listen address")
	flag.StringVar(&cfg.dockerSocket, "docker-socket", envOr("DOCKER_SOCKET", "/var/run/docker.sock"), "docker unix socket")
	flag.StringVar(&cfg.dockerAPI, "docker-api", envOr("DOCKER_API_VERSION", "v1.45"), "docker API version")
	flag.StringVar(&cfg.jwtSecret, "jwt-secret-file", envOr("JWT_SECRET_FILE", "/var/www/html/var/jwt.secret"), "path to JWT secret")
	flag.StringVar(&cfg.sqlitePath, "sqlite", envOr("SQLITE_PATH", "/var/www/html/var/dockermanager.sqlite"), "SQLite DB for endpoints")
	flag.StringVar(&cfg.nodeSecret, "node-secret", envOr("NODE_SECRET", ""), "agent NODE_SECRET")
	flag.StringVar(&cfg.proxyURL, "proxy", envOr("CONSOLE_WS_PROXY", ""), "agent mode: reverse-proxy base URL for non-WS HTTP")
	flag.Parse()

	if !strings.HasPrefix(cfg.dockerAPI, "v") {
		cfg.dockerAPI = "v" + cfg.dockerAPI
	}

	mux := http.NewServeMux()
	s := &server{cfg: cfg, usedJTI: map[string]time.Time{}}

	switch cfg.mode {
	case "agent":
		mux.HandleFunc("/websocket/exec", s.handleAgentExecWS)
		mux.HandleFunc("/healthz", healthz)
		if cfg.proxyURL != "" {
			target, err := url.Parse(cfg.proxyURL)
			if err != nil {
				log.Fatalf("invalid --proxy: %v", err)
			}
			proxy := httputil.NewSingleHostReverseProxy(target)
			mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/websocket/") {
					http.NotFound(w, r)
					return
				}
				proxy.ServeHTTP(w, r)
			})
		}
	default:
		mux.HandleFunc("/api/websocket/exec", s.handleServerExecWS)
		mux.HandleFunc("/healthz", healthz)
	}

	httpServer := &http.Server{
		Addr:              cfg.listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("console-ws mode=%s listen=%s", cfg.mode, cfg.listen)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

type server struct {
	cfg     config
	usedMu  sync.Mutex
	usedJTI map[string]time.Time
}

type ticketClaims struct {
	Kind       string `json:"kind"`
	ExecID     string `json:"execId"`
	EndpointID int    `json:"endpointId"`
	UserID     int    `json:"userId"`
	JTI        string `json:"jti"`
	Exp        int64  `json:"exp"`
	Iat        int64  `json:"iat"`
}

type endpointRow struct {
	ID             int
	Kind           string
	AgentURL       string
	AgentSecret    string
	TLSFingerprint string
}

func (s *server) handleServerExecWS(w http.ResponseWriter, r *http.Request) {
	execID := strings.TrimSpace(r.URL.Query().Get("id"))
	endpointID := strings.TrimSpace(r.URL.Query().Get("endpointId"))
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if execID == "" || endpointID == "" || token == "" {
		http.Error(w, "missing id, endpointId or token", http.StatusBadRequest)
		return
	}

	secret, err := os.ReadFile(s.cfg.jwtSecret)
	if err != nil {
		http.Error(w, "jwt secret unavailable", http.StatusServiceUnavailable)
		return
	}
	claims, err := decodeTicket(strings.TrimSpace(string(secret)), token)
	if err != nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	if claims.Kind != "console" || claims.ExecID != execID || strconv.Itoa(claims.EndpointID) != endpointID {
		http.Error(w, "token mismatch", http.StatusUnauthorized)
		return
	}
	if !s.consumeJTI(claims.JTI) {
		http.Error(w, "token already used", http.StatusUnauthorized)
		return
	}

	ep, err := s.loadEndpoint(claims.EndpointID)
	if err != nil {
		http.Error(w, "endpoint not found", http.StatusNotFound)
		return
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(2 * time.Hour))
	_ = ws.SetWriteDeadline(time.Now().Add(2 * time.Hour))

	if ep.Kind == "agent" {
		if err := s.bridgeAgent(ws, ep, execID); err != nil {
			log.Printf("agent bridge: %v", err)
		}
		return
	}
	if err := s.bridgeLocal(ws, execID); err != nil {
		log.Printf("local bridge: %v", err)
	}
}

func (s *server) handleAgentExecWS(w http.ResponseWriter, r *http.Request) {
	if s.cfg.nodeSecret == "" {
		http.Error(w, "node secret not configured", http.StatusServiceUnavailable)
		return
	}
	auth := r.Header.Get("Authorization")
	qSecret := r.URL.Query().Get("token")
	ok := false
	if auth == "Bearer "+s.cfg.nodeSecret {
		ok = true
	}
	if qSecret != "" && qSecret == s.cfg.nodeSecret {
		ok = true
	}
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	execID := strings.TrimSpace(r.URL.Query().Get("id"))
	if execID == "" || !isHex(execID) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	if err := s.bridgeLocal(ws, execID); err != nil {
		log.Printf("agent local bridge: %v", err)
	}
}

func (s *server) bridgeLocal(ws *websocket.Conn, execID string) error {
	conn, err := net.DialTimeout("unix", s.cfg.dockerSocket, 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Hour))

	body := `{"Detach":false,"Tty":true}`
	req := fmt.Sprintf(
		"POST /%s/exec/%s/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n%s",
		s.cfg.dockerAPI,
		url.PathEscape(execID),
		len(body),
		body,
	)
	if _, err := io.WriteString(conn, req); err != nil {
		return err
	}

	br := bufio.NewReader(conn)
	statusLine, err := br.ReadString('\n')
	if err != nil {
		return err
	}
	parts := strings.Fields(statusLine)
	if len(parts) < 2 {
		return fmt.Errorf("bad status line: %q", statusLine)
	}
	code, err := strconv.Atoi(parts[1])
	if err != nil {
		return err
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return err
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	if code != 101 && code != 200 {
		rest, _ := io.ReadAll(io.LimitReader(br, 2048))
		return fmt.Errorf("docker exec start status %d: %s", code, string(rest))
	}

	return pipeWSAndReaderWriter(ws, br, conn)
}

func (s *server) bridgeAgent(ws *websocket.Conn, ep endpointRow, execID string) error {
	u, err := url.Parse(strings.TrimRight(ep.AgentURL, "/") + "/websocket/exec")
	if err != nil {
		return err
	}
	q := u.Query()
	q.Set("id", execID)
	q.Set("token", ep.AgentSecret)
	u.RawQuery = q.Encode()
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else if u.Scheme == "http" {
		u.Scheme = "ws"
	}

	dialer := *websocket.DefaultDialer
	dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // self-signed agents
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+ep.AgentSecret)

	agentWS, resp, err := dialer.Dial(u.String(), hdr)
	if err != nil {
		if resp != nil {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			_ = resp.Body.Close()
			return fmt.Errorf("agent dial: %w (%s)", err, string(b))
		}
		return err
	}
	defer agentWS.Close()
	return pipeWSAndWS(ws, agentWS)
}

func pipeWSAndReaderWriter(ws *websocket.Conn, r io.Reader, w io.Writer) error {
	errCh := make(chan error, 2)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				if werr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					errCh <- werr
					return
				}
			}
			if err != nil {
				errCh <- err
				return
			}
		}
	}()
	go func() {
		for {
			mt, data, err := ws.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			if mt == websocket.CloseMessage {
				errCh <- io.EOF
				return
			}
			if mt == websocket.BinaryMessage || mt == websocket.TextMessage {
				if _, err := w.Write(data); err != nil {
					errCh <- err
					return
				}
			}
		}
	}()
	err := <-errCh
	_ = ws.Close()
	if cw, ok := w.(io.Closer); ok {
		_ = cw.Close()
	}
	if errors.Is(err, io.EOF) || websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
		return nil
	}
	return err
}

func pipeWSAndWS(a, b *websocket.Conn) error {
	errCh := make(chan error, 2)
	copyFn := func(dst, src *websocket.Conn) {
		for {
			mt, data, err := src.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			if err := dst.WriteMessage(mt, data); err != nil {
				errCh <- err
				return
			}
		}
	}
	go copyFn(a, b)
	go copyFn(b, a)
	err := <-errCh
	_ = a.Close()
	_ = b.Close()
	if errors.Is(err, io.EOF) || websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
		return nil
	}
	return err
}

func (s *server) consumeJTI(jti string) bool {
	if jti == "" {
		return true
	}
	s.usedMu.Lock()
	defer s.usedMu.Unlock()
	now := time.Now()
	for k, exp := range s.usedJTI {
		if now.After(exp) {
			delete(s.usedJTI, k)
		}
	}
	if _, ok := s.usedJTI[jti]; ok {
		return false
	}
	s.usedJTI[jti] = now.Add(5 * time.Minute)
	return true
}

func (s *server) loadEndpoint(id int) (endpointRow, error) {
	db, err := sql.Open("sqlite", s.cfg.sqlitePath)
	if err != nil {
		return endpointRow{}, err
	}
	defer db.Close()
	row := endpointRow{}
	err = db.QueryRow(
		`SELECT id, COALESCE(kind,'local'), COALESCE(agent_url,''), COALESCE(agent_secret,''), COALESCE(tls_fingerprint,'') FROM endpoints WHERE id = ?`,
		id,
	).Scan(&row.ID, &row.Kind, &row.AgentURL, &row.AgentSecret, &row.TLSFingerprint)
	if err != nil {
		return endpointRow{}, err
	}
	return row, nil
}

func decodeTicket(secret, token string) (*ticketClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("bad jwt")
	}
	sigInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(sigInput))
	expected := b64url(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(parts[2])) {
		return nil, errors.New("bad sig")
	}
	payload, err := b64urlDecode(parts[1])
	if err != nil {
		return nil, err
	}
	var c ticketClaims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, err
	}
	if c.Exp > 0 && time.Now().Unix() > c.Exp {
		return nil, errors.New("expired")
	}
	return &c, nil
}

func b64url(b []byte) string {
	return strings.TrimRight(base64.URLEncoding.EncodeToString(b), "=")
}

func b64urlDecode(s string) ([]byte, error) {
	switch len(s) % 4 {
	case 2:
		s += "=="
	case 3:
		s += "="
	}
	return base64.URLEncoding.DecodeString(s)
}

func isHex(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
