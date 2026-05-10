package handler

import (
	"context"
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
	ColumnID       int        `json:"column_id"`
	Title          string     `json:"title"`
	Description    *string    `json:"description"`
	AssignedUserID *int       `json:"assigned_user_id"`
	Deadline       *time.Time `json:"deadline"`
	Priority       string     `json:"priority"`
	Position       int        `json:"position"`
	CreatedAt      time.Time  `json:"created_at"`
}

const subtaskCols = `id, parent_task_id, column_id, title, description,
	assigned_user_id, deadline, priority, position, created_at`

func scanSubtask(row interface{ Scan(...any) error }, st *Subtask) error {
	return row.Scan(&st.ID, &st.ParentTaskID, &st.ColumnID, &st.Title, &st.Description,
		&st.AssignedUserID, &st.Deadline, &st.Priority, &st.Position, &st.CreatedAt)
}

// boardIDForSubtask resolves ownership via the subtask's own column_id.
func (s *Server) boardIDForSubtask(ctx context.Context, subtaskID int) (boardID, ownerID int, err error) {
	err = s.DB.QueryRow(ctx, `
		SELECT b.id, b.owner_id FROM boards b
		JOIN board_columns c ON c.board_id = b.id
		JOIN subtasks st ON st.column_id = c.id
		WHERE st.id = $1`, subtaskID).Scan(&boardID, &ownerID)
	return
}

// listSubtasksByColumn returns all subtasks in a column, ordered by position.
func (s *Server) listSubtasksByColumn(w http.ResponseWriter, r *http.Request) {
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
		`SELECT `+subtaskCols+` FROM subtasks WHERE column_id = $1 ORDER BY position`,
		columnID)
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

// listSubtasks returns all subtasks of a task (regardless of column).
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
		ColumnID       *int       `json:"column_id"`
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

	// Resolve column: use provided column_id or fall back to parent task's column.
	var columnID int
	if req.ColumnID != nil {
		_, colOwner, err := s.boardIDForColumn(r.Context(), *req.ColumnID)
		if errors.Is(err, pgx.ErrNoRows) || colOwner != uid {
			writeError(w, http.StatusBadRequest, "column not found")
			return
		}
		columnID = *req.ColumnID
	} else {
		if err := s.DB.QueryRow(r.Context(),
			`SELECT column_id FROM tasks WHERE id = $1`, taskID,
		).Scan(&columnID); err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
	}

	pos, err := s.nextSubtaskPos(r.Context(), columnID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	var st Subtask
	err = scanSubtask(s.DB.QueryRow(r.Context(),
		`INSERT INTO subtasks
		   (parent_task_id, column_id, title, description, assigned_user_id, deadline, priority, position)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING `+subtaskCols,
		taskID, columnID, req.Title, req.Description, req.AssignedUserID, req.Deadline, req.Priority, pos,
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
			writeError(w, http.StatusBadRequest, "column not found")
			return
		}
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
	if req.ColumnID != nil {
		s.DB.Exec(ctx, `UPDATE subtasks SET column_id = $1 WHERE id = $2`, *req.ColumnID, id)
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
