package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

type server struct {
	usersProxy *httputil.ReverseProxy
	tasksProxy *httputil.ReverseProxy
	key        []byte
}

func newProxy(rawURL string) *httputil.ReverseProxy {
	target, err := url.Parse(rawURL)
	if err != nil {
		log.Fatal("parse upstream url:", err)
	}
	return httputil.NewSingleHostReverseProxy(target)
}

// secretValue returns env var `name`, or the contents of the file at env var
// `name+"_FILE"` if that path is set. Prod uses *_FILE (CSI-mounted from
// Secret Manager); dev uses the bare env var (docker-compose).
func secretValue(name string) string {
	if path := os.Getenv(name + "_FILE"); path != "" {
		if data, err := os.ReadFile(path); err == nil {
			return strings.TrimSpace(string(data))
		}
	}
	return os.Getenv(name)
}

func main() {
	s := &server{
		usersProxy: newProxy(os.Getenv("USERS_SERVICE_URL")),
		tasksProxy: newProxy(os.Getenv("TASKS_SERVICE_URL")),
		key:        []byte(secretValue("JWT_SIGNING_KEY")),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)

	// Public — no JWT, but still strip any injected X-User-ID
	mux.Handle("/api/auth/", stripUserID(http.StripPrefix("/api", s.usersProxy)))

	// Protected → users-service
	mux.Handle("/api/users/", s.auth(http.StripPrefix("/api", s.usersProxy)))

	// Protected → tasks-service
	for _, prefix := range []string{"/api/boards/", "/api/columns/", "/api/tasks/", "/api/subtasks/"} {
		mux.Handle(prefix, s.auth(http.StripPrefix("/api", s.tasksProxy)))
	}
	// Also handle exact /api/boards (no trailing slash) for POST + GET list
	mux.Handle("/api/boards", s.auth(http.StripPrefix("/api", s.tasksProxy)))

	log.Println("api-gateway :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}

func (s *server) healthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// stripUserID removes any X-User-ID the client might inject.
func stripUserID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Del("X-User-ID")
		next.ServeHTTP(w, r)
	})
}

// auth validates the JWT, sets X-User-ID, and forwards the request.
func (s *server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Strip any client-supplied X-User-ID before doing anything else.
		r.Header.Del("X-User-ID")

		raw := r.Header.Get("Authorization")
		if !strings.HasPrefix(raw, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "missing token")
			return
		}
		tokenStr := strings.TrimPrefix(raw, "Bearer ")

		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, errors.New("unexpected signing method")
			}
			return s.key, nil
		})
		if err != nil || !token.Valid {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}

		sub, err := token.Claims.GetSubject()
		if err != nil || sub == "" {
			writeError(w, http.StatusUnauthorized, "invalid token claims")
			return
		}

		r.Header.Set("X-User-ID", sub)
		next.ServeHTTP(w, r)
	})
}
