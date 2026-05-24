# CLAUDE.md — services/

All three backend services (api-gateway, users-service, tasks-service) are standalone Go modules with the same structure and build pattern. The frontend is a Vite + React TypeScript app.

## Go service layout

```
services/<name>/
├── cmd/server/main.go   ← entrypoint; wire everything here
├── go.mod               ← module: taskboard/<name>
├── go.sum
└── Dockerfile
```

Keep all code in `cmd/server/main.go` until it exceeds ~500 lines, then split into sibling packages under `internal/`. There is no mandatory package structure yet.

## Go module names

```
taskboard/api-gateway
taskboard/users-service
taskboard/tasks-service
```

## Dependencies by service

| Service | Key deps |
|---|---|
| `users-service` | `github.com/jackc/pgx/v5`, `golang.org/x/crypto/bcrypt`, `github.com/golang-jwt/jwt/v5` |
| `tasks-service` | `github.com/jackc/pgx/v5` |
| `api-gateway` | `github.com/golang-jwt/jwt/v5` |

All services use stdlib `net/http` only — no router framework.

## Standard patterns

### Health check (every service must have this)

```go
mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("ok"))
})
```

### DB connection (users-service and tasks-service)

Read config from env. The password is the only sensitive value — pulled via the `secretValue` helper, which prefers a file mount (prod, CSI driver from Secret Manager) and falls back to the bare env var (dev / docker-compose):

```go
dsn := fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=disable",
    os.Getenv("DB_HOST"), os.Getenv("DB_PORT"),
    os.Getenv("DB_NAME"), os.Getenv("DB_USER"), secretValue("DB_PASSWORD"))
pool, err := pgxpool.New(ctx, dsn)
```

### secretValue helper (inline in each service's main.go)

```go
func secretValue(name string) string {
    if path := os.Getenv(name + "_FILE"); path != "" {
        if data, err := os.ReadFile(path); err == nil {
            return strings.TrimSpace(string(data))
        }
    }
    return os.Getenv(name)
}
```

In prod, the manifest sets `DB_PASSWORD_FILE=/mnt/secrets-store/db-password` (a file written by the Secret Manager CSI driver). In dev, `docker-compose.yml` sets `DB_PASSWORD` directly — the helper falls back. Either path returns the same string to the caller.

On startup: ping the DB, run `CREATE TABLE IF NOT EXISTS` migrations, then start the server. Never use an external migration tool — keep migrations inline.

### JWT signing key (users-service and api-gateway only)

Read via the same `secretValue` helper as the DB password. In prod it comes from `JWT_SIGNING_KEY_FILE=/mnt/secrets-store/jwt-signing-key` (CSI mount); in dev from `JWT_SIGNING_KEY` env var:

```go
signingKey := []byte(secretValue("JWT_SIGNING_KEY"))
```

tasks-service deliberately does NOT receive this secret.

### JSON responses

Always set `Content-Type: application/json`. Use a helper:

```go
func writeJSON(w http.ResponseWriter, status int, v any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(v)
}
```

### Error responses

```go
func writeError(w http.ResponseWriter, status int, msg string) {
    writeJSON(w, status, map[string]string{"error": msg})
}
```

Return `404` (not `403`) when a resource exists but the caller doesn't own it — avoids leaking resource existence.

### Extracting the caller identity (tasks-service)

The gateway sets `X-User-ID` after verifying the JWT. Read it and convert:

```go
userIDStr := r.Header.Get("X-User-ID")
userID, err := strconv.Atoi(userIDStr)
if err != nil || userID == 0 {
    writeError(w, http.StatusUnauthorized, "missing user")
    return
}
```

### Cross-service HTTP call (tasks-service → users-service)

Used to validate `assigned_user_id` before insert/update on tasks and subtasks:

```go
usersURL := os.Getenv("USERS_SERVICE_URL") // e.g. http://users-service:8080
resp, err := http.Get(fmt.Sprintf("%s/users/%d", usersURL, assignedUserID))
if err != nil || resp.StatusCode == 404 {
    writeError(w, http.StatusBadRequest, "assigned_user_id does not exist")
    return
}
```

## Business rules to enforce in code

These are app-logic invariants — not expressed as SQL constraints:

- **Column count**: a board must have 1–10 columns. Reject the 11th add and the last-column delete with `409 Conflict`.
- **Delete column with tasks**: reject with `409 Conflict`. Caller must move or delete tasks first.
- **`assigned_user_id`**: validate via HTTP call to users-service before any INSERT or UPDATE on `tasks` or `subtasks`.
- **Subtask depth**: structurally impossible (no `parent_subtask_id` column) — no runtime check needed.
- **Ownership**: every handler for boards/columns/tasks/subtasks resolves `board.owner_id` and compares to `X-User-ID`. Walk: `subtask → task → column → board`.

## Dockerfile pattern (Go services)

Multi-stage, distroless final image (~15–20 MB). The `go.sum` file must be committed and present for the `go mod download` layer to cache correctly.

```dockerfile
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app ./cmd/server

FROM gcr.io/distroless/static:nonroot
COPY --from=build /app /app
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/app"]
```

## Testing

Run tests from the service directory:

```bash
cd services/users-service && go test ./...
```

The CI pipeline runs `go test ./...` for each Go service before building the image. Tests must pass before the image is pushed. There are no integration test requirements yet — unit tests covering handler logic are sufficient for Phase 1.

## Frontend (services/frontend/)

- Vite + React 18 + TypeScript
- Tailwind CSS v3 with `dark:` class strategy — toggle `dark` on `<html>`, persist to `localStorage`
- shadcn/ui components are copied into `src/components/ui/` (not a runtime dep)
- `react-router-dom` for routing
- JWT stored in `localStorage`; a `fetch` wrapper attaches `Authorization: Bearer <token>` and redirects to `/login` on `401`
- nginx proxies `/api/*` to `api-gateway:8080`; all other paths serve `index.html` (SPA fallback)

Local dev (without Docker):
```bash
cd services/frontend
npm install
npm run dev     # proxies /api/* to localhost:8080 via vite.config.ts
```
