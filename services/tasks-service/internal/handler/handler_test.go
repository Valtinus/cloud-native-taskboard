package handler_test

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
	"taskboard/tasks-service/internal/handler"
)

// setupTestDB connects to a test postgres instance and runs migrations.
// Skips the test if TEST_DB_HOST is not set.
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
	s := &handler.Server{DB: pool}
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), "DELETE FROM boards")
		pool.Close()
	})
	return pool
}

func newMux(s *handler.Server) http.Handler {
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)
	return mux
}

func jsonBody(v any) *bytes.Buffer {
	b, _ := json.Marshal(v)
	return bytes.NewBuffer(b)
}

func withUser(req *http.Request, userID int) *http.Request {
	req.Header.Set("X-User-ID", fmt.Sprintf("%d", userID))
	return req
}

// TestHealthz does not need a DB.
func TestHealthz(t *testing.T) {
	s := &handler.Server{}
	mux := newMux(s)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
}

func TestCreateBoard(t *testing.T) {
	pool := setupTestDB(t)
	s := &handler.Server{DB: pool}
	mux := newMux(s)

	rec := httptest.NewRecorder()
	req := withUser(httptest.NewRequest("POST", "/boards", jsonBody(map[string]string{"name": "My Board"})), 1)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d: %s", rec.Code, rec.Body)
	}
	var b map[string]any
	json.NewDecoder(rec.Body).Decode(&b)
	if b["id"] == nil {
		t.Fatal("expected board id in response")
	}
}

func TestListBoards(t *testing.T) {
	pool := setupTestDB(t)
	s := &handler.Server{DB: pool}
	mux := newMux(s)

	// Create a board first
	withUser(httptest.NewRequest("POST", "/boards", jsonBody(map[string]string{"name": "Board A"})), 2)
	mux.ServeHTTP(httptest.NewRecorder(),
		withUser(httptest.NewRequest("POST", "/boards", jsonBody(map[string]string{"name": "Board A"})), 2))

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, withUser(httptest.NewRequest("GET", "/boards", nil), 2))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body)
	}
	var boards []map[string]any
	json.NewDecoder(rec.Body).Decode(&boards)
	if len(boards) == 0 {
		t.Fatal("expected at least one board")
	}
}

// createBoard is a helper that creates a board and returns its ID and first column ID.
func createBoard(t *testing.T, mux http.Handler, userID int, name string) (boardID int, firstColID int) {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, withUser(httptest.NewRequest("POST", "/boards", jsonBody(map[string]string{"name": name})), userID))
	if rec.Code != http.StatusCreated {
		t.Fatalf("createBoard: want 201, got %d: %s", rec.Code, rec.Body)
	}
	var b map[string]any
	json.NewDecoder(rec.Body).Decode(&b)
	boardID = int(b["id"].(float64))

	// Fetch the first column
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, withUser(httptest.NewRequest("GET", fmt.Sprintf("/boards/%d/columns", boardID), nil), userID))
	var cols []map[string]any
	json.NewDecoder(rec2.Body).Decode(&cols)
	firstColID = int(cols[0]["id"].(float64))
	return
}

func TestDeleteBoard(t *testing.T) {
	pool := setupTestDB(t)
	s := &handler.Server{DB: pool}
	mux := newMux(s)

	boardID, _ := createBoard(t, mux, 3, "Temp Board")

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, withUser(httptest.NewRequest("DELETE", fmt.Sprintf("/boards/%d", boardID), nil), 3))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d: %s", rec.Code, rec.Body)
	}
}

func TestDeleteColumn_WithTasks_Returns409(t *testing.T) {
	pool := setupTestDB(t)
	s := &handler.Server{DB: pool}
	mux := newMux(s)

	_, colID := createBoard(t, mux, 4, "Board With Tasks")

	// Create a task in the column
	createRec := httptest.NewRecorder()
	mux.ServeHTTP(createRec, withUser(
		httptest.NewRequest("POST", fmt.Sprintf("/columns/%d/tasks", colID), jsonBody(map[string]string{"title": "My Task"})),
		4,
	))
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create task: want 201, got %d: %s", createRec.Code, createRec.Body)
	}

	// Try to delete the column — should fail because it has tasks
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, withUser(httptest.NewRequest("DELETE", fmt.Sprintf("/columns/%d", colID), nil), 4))
	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d: %s", rec.Code, rec.Body)
	}
}

func TestCreateTask(t *testing.T) {
	pool := setupTestDB(t)
	s := &handler.Server{DB: pool}
	mux := newMux(s)

	_, colID := createBoard(t, mux, 5, "Task Board")

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, withUser(
		httptest.NewRequest("POST", fmt.Sprintf("/columns/%d/tasks", colID), jsonBody(map[string]string{"title": "New Task", "priority": "high"})),
		5,
	))
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d: %s", rec.Code, rec.Body)
	}
}

func TestCreateSubtask(t *testing.T) {
	pool := setupTestDB(t)
	s := &handler.Server{DB: pool}
	mux := newMux(s)

	_, colID := createBoard(t, mux, 6, "Subtask Board")

	// Create parent task
	taskRec := httptest.NewRecorder()
	mux.ServeHTTP(taskRec, withUser(
		httptest.NewRequest("POST", fmt.Sprintf("/columns/%d/tasks", colID), jsonBody(map[string]string{"title": "Parent"})),
		6,
	))
	var task map[string]any
	json.NewDecoder(taskRec.Body).Decode(&task)
	taskID := int(task["id"].(float64))

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, withUser(
		httptest.NewRequest("POST", fmt.Sprintf("/tasks/%d/subtasks", taskID), jsonBody(map[string]string{"title": "Subtask"})),
		6,
	))
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d: %s", rec.Code, rec.Body)
	}
}

func TestOwnershipEnforcement(t *testing.T) {
	pool := setupTestDB(t)
	s := &handler.Server{DB: pool}
	mux := newMux(s)

	// User 7 creates a board
	boardID, _ := createBoard(t, mux, 7, "Private Board")

	// User 8 tries to access it — should get 404
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, withUser(httptest.NewRequest("GET", fmt.Sprintf("/boards/%d", boardID), nil), 8))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404 for non-owner access, got %d", rec.Code)
	}
}
