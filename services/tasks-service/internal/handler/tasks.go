package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type Task struct {
	ID             int        `json:"id"`
	ColumnID       int        `json:"column_id"`
	Title          string     `json:"title"`
	Description    *string    `json:"description"`
	AssignedUserID *int       `json:"assigned_user_id"`
	Deadline       *time.Time `json:"deadline"`
	Priority       string     `json:"priority"`
	Position       int        `json:"position"`
	CreatedAt      time.Time  `json:"created_at"`
}

const taskCols = `id, column_id, title, description, assigned_user_id, deadline, priority, position, created_at`

func scanTask(row interface{ Scan(...any) error }, t *Task) error {
	return row.Scan(&t.ID, &t.ColumnID, &t.Title, &t.Description,
		&t.AssignedUserID, &t.Deadline, &t.Priority, &t.Position, &t.CreatedAt)
}

var validPriorities = map[string]bool{"low": true, "medium": true, "high": true}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	columnID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return
	}
	_, ownerID, err := s.boardIDForColumn(r.Context(), columnID)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}
	rows, err := s.DB.Query(r.Context(),
		`SELECT `+taskCols+` FROM tasks WHERE column_id = $1 ORDER BY position`, columnID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	tasks := []Task{}
	for rows.Next() {
		var t Task
		scanTask(rows, &t)
		tasks = append(tasks, t)
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	columnID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return
	}
	_, ownerID, err := s.boardIDForColumn(r.Context(), columnID)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}

	var req struct {
		Title          string     `json:"title"`
		Description    *string    `json:"description"`
		AssignedUserID *int       `json:"assigned_user_id"`
		Deadline       *time.Time `json:"deadline"`
		Priority       string     `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Title == "" {
		writeError(w, http.StatusBadRequest, "title required")
		return
	}
	if req.Priority == "" {
		req.Priority = "medium"
	}
	if !validPriorities[req.Priority] {
		writeError(w, http.StatusBadRequest, "priority must be low, medium, or high")
		return
	}
	if req.AssignedUserID != nil && !s.validateAssignee(r.Context(), *req.AssignedUserID) {
		writeError(w, http.StatusBadRequest, "assigned_user_id does not exist")
		return
	}

	pos, err := s.nextTaskPos(r.Context(), columnID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	var t Task
	err = scanTask(s.DB.QueryRow(r.Context(),
		`INSERT INTO tasks (column_id, title, description, assigned_user_id, deadline, priority, position)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+taskCols,
		columnID, req.Title, req.Description, req.AssignedUserID, req.Deadline, req.Priority, pos,
	), &t)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return
	}
	_, ownerID, err := s.boardIDForTask(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}
	var t Task
	scanTask(s.DB.QueryRow(r.Context(),
		`SELECT `+taskCols+` FROM tasks WHERE id = $1`, id,
	), &t)
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) updateTask(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return
	}
	_, ownerID, err := s.boardIDForTask(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}

	var req struct {
		Title          *string    `json:"title"`
		Description    *string    `json:"description"`
		ClearDesc      bool       `json:"clear_description"`
		AssignedUserID *int       `json:"assigned_user_id"`
		ClearAssignee  bool       `json:"clear_assignee"`
		Deadline       *time.Time `json:"deadline"`
		ClearDeadline  bool       `json:"clear_deadline"`
		Priority       *string    `json:"priority"`
		ColumnID       *int       `json:"column_id"`
		Position       *int       `json:"position"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Priority != nil && !validPriorities[*req.Priority] {
		writeError(w, http.StatusBadRequest, "priority must be low, medium, or high")
		return
	}
	if req.AssignedUserID != nil && !s.validateAssignee(r.Context(), *req.AssignedUserID) {
		writeError(w, http.StatusBadRequest, "assigned_user_id does not exist")
		return
	}
	if req.ColumnID != nil {
		_, colOwner, err := s.boardIDForColumn(r.Context(), *req.ColumnID)
		if errors.Is(err, pgx.ErrNoRows) || colOwner != uid {
			writeError(w, http.StatusBadRequest, "target column not found")
			return
		}
	}

	ctx := r.Context()
	if req.Title != nil {
		s.DB.Exec(ctx, `UPDATE tasks SET title = $1 WHERE id = $2`, *req.Title, id)
	}
	if req.ClearDesc {
		s.DB.Exec(ctx, `UPDATE tasks SET description = NULL WHERE id = $1`, id)
	} else if req.Description != nil {
		s.DB.Exec(ctx, `UPDATE tasks SET description = $1 WHERE id = $2`, *req.Description, id)
	}
	if req.ClearAssignee {
		s.DB.Exec(ctx, `UPDATE tasks SET assigned_user_id = NULL WHERE id = $1`, id)
	} else if req.AssignedUserID != nil {
		s.DB.Exec(ctx, `UPDATE tasks SET assigned_user_id = $1 WHERE id = $2`, *req.AssignedUserID, id)
	}
	if req.ClearDeadline {
		s.DB.Exec(ctx, `UPDATE tasks SET deadline = NULL WHERE id = $1`, id)
	} else if req.Deadline != nil {
		s.DB.Exec(ctx, `UPDATE tasks SET deadline = $1 WHERE id = $2`, *req.Deadline, id)
	}
	if req.Priority != nil {
		s.DB.Exec(ctx, `UPDATE tasks SET priority = $1 WHERE id = $2`, *req.Priority, id)
	}
	if req.ColumnID != nil {
		s.DB.Exec(ctx, `UPDATE tasks SET column_id = $1 WHERE id = $2`, *req.ColumnID, id)
	}
	if req.Position != nil {
		s.DB.Exec(ctx, `UPDATE tasks SET position = $1 WHERE id = $2`, *req.Position, id)
	}

	var t Task
	scanTask(s.DB.QueryRow(ctx, `SELECT `+taskCols+` FROM tasks WHERE id = $1`, id), &t)
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) deleteTask(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return
	}
	_, ownerID, err := s.boardIDForTask(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}
	s.DB.Exec(r.Context(), `DELETE FROM tasks WHERE id = $1`, id)
	w.WriteHeader(http.StatusNoContent)
}
