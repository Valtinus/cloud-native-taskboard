# TaskBoard — Cloud-Native on GKE

A Trello-like task board built with Go microservices and a React frontend,
deployed to GKE Autopilot via OpenTofu, with GitHub Actions CI/CD on GCP.

## Stack

| Layer | Technology |
|---|---|
| Backend services | Go (stdlib net/http, pgx/v5) |
| Frontend | React + Vite + shadcn/ui + Tailwind CSS v3 |
| Database | Cloud SQL (PostgreSQL 15) |
| Container registry | Artifact Registry |
| Orchestration | GKE Autopilot |
| IaC | OpenTofu (HCL, GCS backend) |
| CI/CD | GitHub Actions + Workload Identity Federation |
| Auth | JWT HS256 + bcrypt cost 12 |

## Local development

```bash
docker compose up
# App available at http://localhost:8080
```

## Cloud deployment

```bash
# One-time: create GCS state bucket manually, then:
cd terraform/
tofu init
tofu apply
```

## Services

| Service | Port | Responsibility |
|---|---|---|
| `api-gateway` | 8080 | JWT validation, reverse proxy |
| `users-service` | 8080 | Auth (register/login), user CRUD |
| `tasks-service` | 8080 | Boards, columns, tasks, subtasks |
| `frontend` | 80 | React SPA served by nginx |
