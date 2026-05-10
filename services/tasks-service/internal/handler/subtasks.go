package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type Subtask struct {
	ID             int        `json:"id"`
	ParentTaskID   int        `json:"parent_task_id"`
	Title          string     `json:"title"`
	Description    *string    `json:"description"`
	AssignedUserID *int       `json:"assigned_user_id"`
	Deadline       *time.Time `json:"deadline"`
	Priority       string     `json:"priority"`
	Completed      bool       `json:"completed"`
	Position       int        `json:"position"`
	CreatedAt      time.Time  `json:"created_at"`
}

const subtaskCols = `id, parent_task_id, title, description, assigned_user_id,
	deadline, priority, completed, position, created_at`

func scanSubtask(row interface{ Scan(...any) error }, st *Subtask) error {
	return row.Scan(&st.ID, &st.ParentTaskID, &st.Title, &st.Description,
		&st.AssignedUserID, &st.Deadline, &st.Priority, &st.Completed, &st.Position, &st.CreatedAt)
}

func (s *Server) listSubtasks(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	taskID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return
	}
	_, ownerID, err := s.boardIDForTask(r.Context(), taskID)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}
	rows, err := s.DB.Query(r.Context(),
		`SELECT `+subtaskCols+` FROM subtasks WHERE parent_task_id = $1 ORDER BY position`,
		taskID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	subtasks := []Subtask{}
	for rows.Next() {
		var st Subtask
		scanSubtask(rows, &st)
		subtasks = append(subtasks, st)
	}
	writeJSON(w, http.StatusOK, subtasks)
}

func (s *Server) createSubtask(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	taskID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return
	}
	_, ownerID, err := s.boardIDForTask(r.Context(), taskID)
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

	pos, err := s.nextSubtaskPos(r.Context(), taskID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	var st Subtask
	err = scanSubtask(s.DB.QueryRow(r.Context(),
		`INSERT INTO subtasks (parent_task_id, title, description, assigned_user_id, deadline, priority, position)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+subtaskCols,
		taskID, req.Title, req.Description, req.AssignedUserID, req.Deadline, req.Priority, pos,
	), &st)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusCreated, st)
}

func (s *Server) getSubtask(w http.ResponseWriter, r *http.Request) {
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
	_, ownerID, err := s.boardIDForSubtask(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}
	var st Subtask
	scanSubtask(s.DB.QueryRow(r.Context(),
		`SELECT `+subtaskCols+` FROM subtasks WHERE id = $1`, id,
	), &st)
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) updateSubtask(w http.ResponseWriter, r *http.Request) {
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
	_, ownerID, err := s.boardIDForSubtask(r.Context(), id)
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
		Completed      *bool      `json:"completed"`
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

	ctx := r.Context()
	if req.Title != nil {
		s.DB.Exec(ctx, `UPDATE subtasks SET title = $1 WHERE id = $2`, *req.Title, id)
	}
	if req.ClearDesc {
		s.DB.Exec(ctx, `UPDATE subtasks SET description = NULL WHERE id = $1`, id)
	} else if req.Description != nil {
		s.DB.Exec(ctx, `UPDATE subtasks SET description = $1 WHERE id = $2`, *req.Description, id)
	}
	if req.ClearAssignee {
		s.DB.Exec(ctx, `UPDATE subtasks SET assigned_user_id = NULL WHERE id = $1`, id)
	} else if req.AssignedUserID != nil {
		s.DB.Exec(ctx, `UPDATE subtasks SET assigned_user_id = $1 WHERE id = $2`, *req.AssignedUserID, id)
	}
	if req.ClearDeadline {
		s.DB.Exec(ctx, `UPDATE subtasks SET deadline = NULL WHERE id = $1`, id)
	} else if req.Deadline != nil {
		s.DB.Exec(ctx, `UPDATE subtasks SET deadline = $1 WHERE id = $2`, *req.Deadline, id)
	}
	if req.Priority != nil {
		s.DB.Exec(ctx, `UPDATE subtasks SET priority = $1 WHERE id = $2`, *req.Priority, id)
	}
	if req.Completed != nil {
		s.DB.Exec(ctx, `UPDATE subtasks SET completed = $1 WHERE id = $2`, *req.Completed, id)
	}
	if req.Position != nil {
		s.DB.Exec(ctx, `UPDATE subtasks SET position = $1 WHERE id = $2`, *req.Position, id)
	}

	var st Subtask
	scanSubtask(s.DB.QueryRow(ctx,
		`SELECT `+subtaskCols+` FROM subtasks WHERE id = $1`, id,
	), &st)
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) deleteSubtask(w http.ResponseWriter, r *http.Request) {
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
	_, ownerID, err := s.boardIDForSubtask(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}
	s.DB.Exec(r.Context(), `DELETE FROM subtasks WHERE id = $1`, id)
	w.WriteHeader(http.StatusNoContent)
}
