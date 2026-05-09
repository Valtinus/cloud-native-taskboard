package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type Column struct {
	ID        int       `json:"id"`
	BoardID   int       `json:"board_id"`
	Name      string    `json:"name"`
	Color     *string   `json:"color"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
}

const colCols = `id, board_id, name, color, position, created_at`

func scanColumn(row interface{ Scan(...any) error }, c *Column) error {
	return row.Scan(&c.ID, &c.BoardID, &c.Name, &c.Color, &c.Position, &c.CreatedAt)
}

func (s *Server) listColumns(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	boardID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return
	}
	ownerID, err := s.boardOwnerID(r.Context(), boardID)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}
	rows, err := s.DB.Query(r.Context(),
		`SELECT `+colCols+` FROM board_columns WHERE board_id = $1 ORDER BY position`, boardID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	cols := []Column{}
	for rows.Next() {
		var c Column
		scanColumn(rows, &c)
		cols = append(cols, c)
	}
	writeJSON(w, http.StatusOK, cols)
}

func (s *Server) createColumn(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	boardID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return
	}
	ownerID, err := s.boardOwnerID(r.Context(), boardID)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}

	count, err := s.columnCount(r.Context(), boardID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if count >= 10 {
		writeError(w, http.StatusConflict, "board already has 10 columns")
		return
	}

	var req struct {
		Name  string  `json:"name"`
		Color *string `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}
	if len(req.Name) > 50 {
		writeError(w, http.StatusBadRequest, "name too long (max 50 characters)")
		return
	}

	pos, err := s.nextColPos(r.Context(), boardID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	var c Column
	scanColumn(s.DB.QueryRow(r.Context(),
		`INSERT INTO board_columns (board_id, name, color, position) VALUES ($1, $2, $3, $4)
		 RETURNING `+colCols,
		boardID, req.Name, req.Color, pos,
	), &c)
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) updateColumn(w http.ResponseWriter, r *http.Request) {
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
	boardID, ownerID, err := s.boardIDForColumn(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}

	var req struct {
		Name       *string `json:"name"`
		Color      *string `json:"color"`
		ClearColor bool    `json:"clear_color"`
		Position   *int    `json:"position"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Name != nil {
		if *req.Name == "" || len(*req.Name) > 50 {
			writeError(w, http.StatusBadRequest, "invalid name")
			return
		}
		s.DB.Exec(r.Context(), `UPDATE board_columns SET name = $1 WHERE id = $2`, *req.Name, id)
	}
	if req.ClearColor {
		s.DB.Exec(r.Context(), `UPDATE board_columns SET color = NULL WHERE id = $1`, id)
	} else if req.Color != nil {
		s.DB.Exec(r.Context(), `UPDATE board_columns SET color = $1 WHERE id = $2`, *req.Color, id)
	}
	if req.Position != nil {
		if err := s.reorderColumns(r.Context(), boardID, id, *req.Position); err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
	}

	var c Column
	scanColumn(s.DB.QueryRow(r.Context(),
		`SELECT `+colCols+` FROM board_columns WHERE id = $1`, id,
	), &c)
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) deleteColumn(w http.ResponseWriter, r *http.Request) {
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
	boardID, ownerID, err := s.boardIDForColumn(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}

	count, _ := s.columnCount(r.Context(), boardID)
	if count <= 1 {
		writeError(w, http.StatusConflict, "cannot delete the last column")
		return
	}

	var taskCount int
	s.DB.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM tasks WHERE column_id = $1`, id).Scan(&taskCount)
	if taskCount > 0 {
		writeError(w, http.StatusConflict, "column has tasks; move or delete them first")
		return
	}

	s.DB.Exec(r.Context(), `DELETE FROM board_columns WHERE id = $1`, id)
	w.WriteHeader(http.StatusNoContent)
}
