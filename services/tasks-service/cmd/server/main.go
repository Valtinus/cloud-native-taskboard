package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"taskboard/tasks-service/internal/handler"

	"github.com/jackc/pgx/v5/pgxpool"
)

// secretValue returns env var `name`, or the contents of the file at env var
// `name+"_FILE"` if that path is set. Prod uses *_FILE (CSI-mounted from
// Secret Manager); dev uses the bare env var (docker-compose).
func secretValue(name string) string {
	if path := os.Getenv(name + "_FILE"); path != "" {
		if data, err := os.ReadFile(path); err == nil {
			return strings.TrimSpace(string(data))
		}
	}
	return os.Getenv(name)
}

func main() {
	ctx := context.Background()

	dsn := fmt.Sprintf(
		"host=%s port=%s dbname=%s user=%s password=%s sslmode=disable",
		os.Getenv("DB_HOST"), os.Getenv("DB_PORT"),
		os.Getenv("DB_NAME"), os.Getenv("DB_USER"), secretValue("DB_PASSWORD"),
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
