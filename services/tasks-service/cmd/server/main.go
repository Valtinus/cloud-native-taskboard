package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"

	"taskboard/tasks-service/internal/handler"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx := context.Background()

	dsn := fmt.Sprintf(
		"host=%s port=%s dbname=%s user=%s password=%s sslmode=disable",
		os.Getenv("DB_HOST"), os.Getenv("DB_PORT"),
		os.Getenv("DB_NAME"), os.Getenv("DB_USER"), os.Getenv("DB_PASSWORD"),
	)

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal("db connect:", err)
	}
	if err := pool.Ping(ctx); err != nil {
		log.Fatal("db ping:", err)
	}

	s := &handler.Server{
		DB:       pool,
		UsersURL: os.Getenv("USERS_SERVICE_URL"),
	}
	if err := s.Migrate(ctx); err != nil {
		log.Fatal("migrate:", err)
	}

	mux := http.NewServeMux()
	s.RegisterRoutes(mux)

	log.Println("tasks-service :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
