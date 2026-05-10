package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testKey = "test-secret-key-32-bytes-padded!"

func makeToken(t *testing.T, sub string, exp time.Time) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": sub,
		"exp": exp.Unix(),
	})
	signed, err := tok.SignedString([]byte(testKey))
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func newTestServer() *server {
	return &server{key: []byte(testKey)}
}

func TestHealthz(t *testing.T) {
	s := newTestServer()
	rec := httptest.NewRecorder()
	s.healthz(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
}

func TestAuth_MissingAuthorizationHeader(t *testing.T) {
	s := newTestServer()
	h := s.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/boards", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestAuth_InvalidToken(t *testing.T) {
	s := newTestServer()
	h := s.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/boards", nil)
	req.Header.Set("Authorization", "Bearer not-a-real-token")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestAuth_ExpiredToken(t *testing.T) {
	s := newTestServer()
	h := s.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/boards", nil)
	req.Header.Set("Authorization", "Bearer "+makeToken(t, "1", time.Now().Add(-time.Hour)))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 for expired token, got %d", rec.Code)
	}
}

func TestAuth_ValidToken_SetsUserID(t *testing.T) {
	var capturedUserID string
	h := newTestServer().auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUserID = r.Header.Get("X-User-ID")
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/boards", nil)
	req.Header.Set("Authorization", "Bearer "+makeToken(t, "42", time.Now().Add(time.Hour)))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	if capturedUserID != "42" {
		t.Fatalf("want X-User-ID=42, got %q", capturedUserID)
	}
}

func TestAuth_ClientCannotSpoofUserID(t *testing.T) {
	var capturedUserID string
	h := newTestServer().auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUserID = r.Header.Get("X-User-ID")
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/boards", nil)
	req.Header.Set("Authorization", "Bearer "+makeToken(t, "7", time.Now().Add(time.Hour)))
	req.Header.Set("X-User-ID", "999") // client tries to spoof
	h.ServeHTTP(rec, req)
	if capturedUserID == "999" {
		t.Fatal("client-supplied X-User-ID leaked through auth middleware")
	}
	if capturedUserID != "7" {
		t.Fatalf("want X-User-ID=7 from token sub, got %q", capturedUserID)
	}
}

func TestStripUserID_PublicRoute(t *testing.T) {
	var capturedUserID string
	h := stripUserID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedUserID = r.Header.Get("X-User-ID")
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/auth/login", nil)
	req.Header.Set("X-User-ID", "injected-by-client")
	h.ServeHTTP(rec, req)
	if capturedUserID != "" {
		t.Fatalf("X-User-ID should be stripped on public routes, got %q", capturedUserID)
	}
}
