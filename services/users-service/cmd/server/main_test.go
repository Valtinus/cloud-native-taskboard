package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// newTestMux mirrors the route registration in main().
func newTestMux(s *server) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("POST /auth/register", s.register)
	mux.HandleFunc("POST /auth/login", s.login)
	mux.HandleFunc("GET /users/me", s.getMe)
	mux.HandleFunc("PUT /users/me", s.updateMe)
	mux.HandleFunc("DELETE /users/me", s.deleteMe)
	mux.HandleFunc("GET /users/{id}", s.getUser)
	return mux
}

// setupTestDB connects to a test postgres instance. Skips the test if
// TEST_DB_HOST is not set so that local runs without a DB still pass.
func setupTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	host := os.Getenv("TEST_DB_HOST")
	if host == "" {
		t.Skip("TEST_DB_HOST not set — skipping DB integration test")
	}
	port := os.Getenv("TEST_DB_PORT")
	if port == "" {
		port = "5432"
	}
	dsn := fmt.Sprintf(
		"host=%s port=%s dbname=%s user=%s password=%s sslmode=disable",
		host, port,
		os.Getenv("TEST_DB_NAME"),
		os.Getenv("TEST_DB_USER"),
		os.Getenv("TEST_DB_PASSWORD"),
	)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to test DB: %v", err)
	}
	if _, err := pool.Exec(context.Background(), migration); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), "DELETE FROM users")
		pool.Close()
	})
	return pool
}

func jsonBody(v any) *bytes.Buffer {
	b, _ := json.Marshal(v)
	return bytes.NewBuffer(b)
}

// ── DB-free tests ─────────────────────────────────────────────────────────────

func TestHealthz(t *testing.T) {
	s := &server{}
	mux := newTestMux(s)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
}

func TestRegister_InvalidEmail(t *testing.T) {
	s := &server{}
	mux := newTestMux(s)
	rec := httptest.NewRecorder()
	body := jsonBody(map[string]string{"name": "Alice", "email": "not-an-email", "password": "secret123"})
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/auth/register", body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestRegister_ShortPassword(t *testing.T) {
	s := &server{}
	mux := newTestMux(s)
	rec := httptest.NewRecorder()
	body := jsonBody(map[string]string{"name": "Alice", "email": "alice@example.com", "password": "short"})
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/auth/register", body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestRegister_EmptyName(t *testing.T) {
	s := &server{}
	mux := newTestMux(s)
	rec := httptest.NewRecorder()
	body := jsonBody(map[string]string{"name": "   ", "email": "alice@example.com", "password": "secret123"})
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/auth/register", body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestGetMe_MissingHeader(t *testing.T) {
	s := &server{}
	mux := newTestMux(s)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/users/me", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

// ── DB integration tests ──────────────────────────────────────────────────────

func TestRegister_Success(t *testing.T) {
	pool := setupTestDB(t)
	s := &server{db: pool, key: []byte("test-key")}
	mux := newTestMux(s)

	rec := httptest.NewRecorder()
	body := jsonBody(map[string]string{"name": "Alice", "email": "alice@example.com", "password": "secret123"})
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/auth/register", body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d: %s", rec.Code, rec.Body)
	}
}

func TestRegister_DuplicateEmail(t *testing.T) {
	pool := setupTestDB(t)
	s := &server{db: pool, key: []byte("test-key")}
	mux := newTestMux(s)

	payload := jsonBody(map[string]string{"name": "Bob", "email": "bob@example.com", "password": "secret123"})
	mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/auth/register", payload))

	rec := httptest.NewRecorder()
	payload = jsonBody(map[string]string{"name": "Bob2", "email": "bob@example.com", "password": "secret456"})
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/auth/register", payload))
	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d: %s", rec.Code, rec.Body)
	}
}

func TestLogin_Success(t *testing.T) {
	pool := setupTestDB(t)
	s := &server{db: pool, key: []byte("test-key")}
	mux := newTestMux(s)

	// Register first
	reg := jsonBody(map[string]string{"name": "Carol", "email": "carol@example.com", "password": "secret123"})
	mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/auth/register", reg))

	// Login
	rec := httptest.NewRecorder()
	login := jsonBody(map[string]string{"email": "carol@example.com", "password": "secret123"})
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/auth/login", login))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body)
	}
	var resp map[string]any
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["token"] == "" {
		t.Fatal("expected token in login response")
	}
}

func TestLogin_WrongPassword(t *testing.T) {
	pool := setupTestDB(t)
	s := &server{db: pool, key: []byte("test-key")}
	mux := newTestMux(s)

	reg := jsonBody(map[string]string{"name": "Dave", "email": "dave@example.com", "password": "secret123"})
	mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/auth/register", reg))

	rec := httptest.NewRecorder()
	login := jsonBody(map[string]string{"email": "dave@example.com", "password": "wrongpassword"})
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/auth/login", login))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d: %s", rec.Code, rec.Body)
	}
}

func TestGetUser_NotFound(t *testing.T) {
	pool := setupTestDB(t)
	s := &server{db: pool, key: []byte("test-key")}
	mux := newTestMux(s)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/users/99999", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", rec.Code)
	}
}
