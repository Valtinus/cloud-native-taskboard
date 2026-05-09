package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type Board struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	OwnerID   int       `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Server) listBoards(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rows, err := s.DB.Query(r.Context(),
		`SELECT id, name, owner_id, created_at FROM boards WHERE owner_id = $1 ORDER BY created_at DESC`,
		uid)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	boards := []Board{}
	for rows.Next() {
		var b Board
		rows.Scan(&b.ID, &b.Name, &b.OwnerID, &b.CreatedAt)
		boards = append(boards, b)
	}
	writeJSON(w, http.StatusOK, boards)
}

func (s *Server) createBoard(w http.ResponseWriter, r *http.Request) {
	uid, ok := callerID(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}

	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer tx.Rollback(r.Context())

	var b Board
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO boards (name, owner_id) VALUES ($1, $2)
		 RETURNING id, name, owner_id, created_at`,
		req.Name, uid,
	).Scan(&b.ID, &b.Name, &b.OwnerID, &b.CreatedAt); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	for i, name := range []string{"To Do", "In Progress", "Done"} {
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO board_columns (board_id, name, position) VALUES ($1, $2, $3)`,
			b.ID, name, i,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusCreated, b)
}

func (s *Server) getBoard(w http.ResponseWriter, r *http.Request) {
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
	var b Board
	err = s.DB.QueryRow(r.Context(),
		`SELECT id, name, owner_id, created_at FROM boards WHERE id = $1`, id,
	).Scan(&b.ID, &b.Name, &b.OwnerID, &b.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) || b.OwnerID != uid {
		notFound(w)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) updateBoard(w http.ResponseWriter, r *http.Request) {
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
	ownerID, err := s.boardOwnerID(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}
	var b Board
	s.DB.QueryRow(r.Context(),
		`UPDATE boards SET name = $1 WHERE id = $2 RETURNING id, name, owner_id, created_at`,
		req.Name, id,
	).Scan(&b.ID, &b.Name, &b.OwnerID, &b.CreatedAt)
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) deleteBoard(w http.ResponseWriter, r *http.Request) {
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
	ownerID, err := s.boardOwnerID(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || ownerID != uid {
		notFound(w)
		return
	}
	s.DB.Exec(r.Context(), `DELETE FROM boards WHERE id = $1`, id)
	w.WriteHeader(http.StatusNoContent)
}
