package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Server holds shared state for all task-service handlers.
type Server struct {
	DB       *pgxpool.Pool
	UsersURL string
}

const migration = `
CREATE TABLE IF NOT EXISTS boards (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  owner_id   INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS board_columns (
  id         SERIAL PRIMARY KEY,
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name       VARCHAR(50) NOT NULL,
  color      VARCHAR(20),
  position   INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (board_id, position)
);

CREATE TABLE IF NOT EXISTS tasks (
  id               SERIAL PRIMARY KEY,
  column_id        INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  assigned_user_id INTEGER,
  deadline         TIMESTAMP,
  priority         VARCHAR(10) NOT NULL DEFAULT 'medium',
  position         INTEGER NOT NULL,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subtasks (
  id               SERIAL PRIMARY KEY,
  parent_task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  column_id        INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  assigned_user_id INTEGER,
  deadline         TIMESTAMP,
  priority         VARCHAR(10) NOT NULL DEFAULT 'medium',
  position         INTEGER NOT NULL,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_boards_owner      ON boards(owner_id);
CREATE INDEX IF NOT EXISTS idx_columns_board     ON board_columns(board_id);
CREATE INDEX IF NOT EXISTS idx_tasks_column      ON tasks(column_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_parent   ON subtasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_assignee ON subtasks(assigned_user_id);

-- Idempotent upgrades for existing databases
ALTER TABLE board_columns ADD COLUMN IF NOT EXISTS color    VARCHAR(20);
ALTER TABLE tasks         ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'medium';
ALTER TABLE subtasks      ADD COLUMN IF NOT EXISTS priority  VARCHAR(10) NOT NULL DEFAULT 'medium';
ALTER TABLE subtasks      ADD COLUMN IF NOT EXISTS column_id INTEGER REFERENCES board_columns(id) ON DELETE CASCADE;
-- Populate column_id for existing rows (place them in their parent task's column)
UPDATE subtasks s SET column_id = (SELECT column_id FROM tasks WHERE id = s.parent_task_id) WHERE s.column_id IS NULL;
ALTER TABLE subtasks      DROP COLUMN IF EXISTS completed;
CREATE INDEX IF NOT EXISTS idx_subtasks_column ON subtasks(column_id);
`

func (s *Server) Migrate(ctx context.Context) error {
	_, err := s.DB.Exec(ctx, migration)
	return err
}

func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.healthz)
	// boards
	mux.HandleFunc("GET /boards", s.listBoards)
	mux.HandleFunc("POST /boards", s.createBoard)
	mux.HandleFunc("GET /boards/{id}", s.getBoard)
	mux.HandleFunc("PUT /boards/{id}", s.updateBoard)
	mux.HandleFunc("DELETE /boards/{id}", s.deleteBoard)
	// columns
	mux.HandleFunc("GET /boards/{id}/columns", s.listColumns)
	mux.HandleFunc("POST /boards/{id}/columns", s.createColumn)
	mux.HandleFunc("PUT /columns/{id}", s.updateColumn)
	mux.HandleFunc("DELETE /columns/{id}", s.deleteColumn)
	// tasks
	mux.HandleFunc("GET /columns/{id}/tasks", s.listTasks)
	mux.HandleFunc("POST /columns/{id}/tasks", s.createTask)
	mux.HandleFunc("GET /tasks/{id}", s.getTask)
	mux.HandleFunc("PUT /tasks/{id}", s.updateTask)
	mux.HandleFunc("DELETE /tasks/{id}", s.deleteTask)
	// subtasks
	mux.HandleFunc("GET /columns/{id}/subtasks", s.listSubtasksByColumn)
	mux.HandleFunc("GET /tasks/{id}/subtasks", s.listSubtasks)
	mux.HandleFunc("POST /tasks/{id}/subtasks", s.createSubtask)
	mux.HandleFunc("GET /subtasks/{id}", s.getSubtask)
	mux.HandleFunc("PUT /subtasks/{id}", s.updateSubtask)
	mux.HandleFunc("DELETE /subtasks/{id}", s.deleteSubtask)
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

// ── shared helpers ────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func notFound(w http.ResponseWriter) { writeError(w, http.StatusNotFound, "not found") }

func callerID(r *http.Request) (int, bool) {
	id, err := strconv.Atoi(r.Header.Get("X-User-ID"))
	return id, err == nil && id > 0
}

// ── ownership helpers (walk up the tree) ─────────────────────────────────────

func (s *Server) boardOwnerID(ctx context.Context, boardID int) (int, error) {
	var ownerID int
	err := s.DB.QueryRow(ctx, `SELECT owner_id FROM boards WHERE id = $1`, boardID).Scan(&ownerID)
	return ownerID, err
}

func (s *Server) boardIDForColumn(ctx context.Context, columnID int) (boardID, ownerID int, err error) {
	err = s.DB.QueryRow(ctx, `
		SELECT b.id, b.owner_id FROM boards b
		JOIN board_columns c ON c.board_id = b.id
		WHERE c.id = $1`, columnID).Scan(&boardID, &ownerID)
	return
}

func (s *Server) boardIDForTask(ctx context.Context, taskID int) (boardID, ownerID int, err error) {
	err = s.DB.QueryRow(ctx, `
		SELECT b.id, b.owner_id FROM boards b
		JOIN board_columns c ON c.board_id = b.id
		JOIN tasks t ON t.column_id = c.id
		WHERE t.id = $1`, taskID).Scan(&boardID, &ownerID)
	return
}


// ── next-position helpers ─────────────────────────────────────────────────────

func (s *Server) nextColPos(ctx context.Context, boardID int) (int, error) {
	var max *int
	err := s.DB.QueryRow(ctx, `SELECT MAX(position) FROM board_columns WHERE board_id = $1`, boardID).Scan(&max)
	if max == nil {
		return 0, err
	}
	return *max + 1, err
}

func (s *Server) nextTaskPos(ctx context.Context, columnID int) (int, error) {
	var max *int
	err := s.DB.QueryRow(ctx, `SELECT MAX(position) FROM tasks WHERE column_id = $1`, columnID).Scan(&max)
	if max == nil {
		return 0, err
	}
	return *max + 1, err
}

func (s *Server) nextSubtaskPos(ctx context.Context, columnID int) (int, error) {
	var max *int
	err := s.DB.QueryRow(ctx, `SELECT MAX(position) FROM subtasks WHERE column_id = $1`, columnID).Scan(&max)
	if max == nil {
		return 0, err
	}
	return *max + 1, err
}

// columnCount returns how many columns a board has.
func (s *Server) columnCount(ctx context.Context, boardID int) (int, error) {
	var n int
	err := s.DB.QueryRow(ctx, `SELECT COUNT(*) FROM board_columns WHERE board_id = $1`, boardID).Scan(&n)
	return n, err
}

// validateAssignee calls users-service to verify the user exists.
func (s *Server) validateAssignee(ctx context.Context, userID int) bool {
	usersURL := s.UsersURL
	if usersURL == "" {
		usersURL = os.Getenv("USERS_SERVICE_URL")
	}
	resp, err := http.Get(fmt.Sprintf("%s/users/%d", usersURL, userID))
	return err == nil && resp.StatusCode == http.StatusOK
}

// reorderColumns rebuilds positions for a board after moving one column.
// Uses a two-pass update (negative then positive) to avoid unique constraint conflicts.
func (s *Server) reorderColumns(ctx context.Context, boardID, movedColID, newPos int) error {
	rows, err := s.DB.Query(ctx,
		`SELECT id FROM board_columns WHERE board_id = $1 ORDER BY position`, boardID)
	if err != nil {
		return err
	}
	defer rows.Close()

	var ids []int
	for rows.Next() {
		var id int
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()

	// Remove movedColID from current position
	filtered := make([]int, 0, len(ids)-1)
	for _, id := range ids {
		if id != movedColID {
			filtered = append(filtered, id)
		}
	}

	if newPos < 0 {
		newPos = 0
	}
	if newPos > len(filtered) {
		newPos = len(filtered)
	}

	// Splice movedColID in at newPos
	ordered := make([]int, 0, len(ids))
	ordered = append(ordered, filtered[:newPos]...)
	ordered = append(ordered, movedColID)
	ordered = append(ordered, filtered[newPos:]...)

	// Pass 1: set negative positions (guaranteed unique)
	for i, id := range ordered {
		if _, err := s.DB.Exec(ctx,
			`UPDATE board_columns SET position = $1 WHERE id = $2`, -(i + 1), id); err != nil {
			return err
		}
	}
	// Pass 2: set final positive positions
	for i, id := range ordered {
		if _, err := s.DB.Exec(ctx,
			`UPDATE board_columns SET position = $1 WHERE id = $2`, i, id); err != nil {
			return err
		}
	}
	return nil
}
