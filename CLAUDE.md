# CLAUDE.md — TaskBoard

University cloud infrastructure project. Go microservices + React frontend deployed to GKE Autopilot via OpenTofu, with GitHub Actions CI/CD on GCP.

## Directory-level guidance

Each subdirectory has its own CLAUDE.md with details specific to that layer:

- [services/CLAUDE.md](services/CLAUDE.md) — Go service conventions, env vars, DB patterns, testing
- [terraform/CLAUDE.md](terraform/CLAUDE.md) — OpenTofu workflow, resource naming, state, providers
- [.github/CLAUDE.md](.github/CLAUDE.md) — CI/CD conventions, Workload Identity Federation, path filters

## Project phases

| Phase | Status | Goal |
|---|---|---|
| 0 | Done | Repo structure, tool installs, GCP account |
| 1 | Next | All services running locally via `docker compose up` |
| 2 | — | `tofu apply` provisions full cloud environment |
| 3 | — | `git push` auto-builds and deploys to GKE |
| 4 | — | Infrastructure + CI/CD documentation |
| 5 | — | Demo rehearsal |

## Running locally

```bash
docker compose up          # full stack at http://localhost:8080
docker compose down -v     # tear down + delete volumes
```

Postgres is healthy-checked; services wait on it. The `init.sql` schema is applied automatically on first start.

## Architecture in one paragraph

The frontend (nginx + React SPA) proxies `/api/*` to the api-gateway. The gateway validates JWTs (HS256) and injects `X-User-ID` before forwarding to users-service or tasks-service over cluster-internal DNS. Neither backend service is internet-reachable. Both connect to Cloud SQL over a private VPC peering link. The JWT signing key lives in Secret Manager and is mounted as a file into the gateway and users-service pods only.

## Services at a glance

| Service | Port | Owns |
|---|---|---|
| `api-gateway` | 8080 | JWT validation, reverse proxy |
| `users-service` | 8080 | `users` table; register, login, profile |
| `tasks-service` | 8080 | `boards`, `board_columns`, `tasks`, `subtasks` tables |
| `frontend` | 80 | React SPA served by nginx |

## Data model summary

```
users
  └─ boards (owner_id)
       └─ board_columns (board_id)
            └─ tasks (column_id)
                 └─ subtasks (parent_task_id)   ← one level only; no parent_subtask_id
```

Key invariants enforced in service code (not SQL):
- A board always has 1–10 columns.
- A column with tasks cannot be deleted (caller must move/delete tasks first).
- `assigned_user_id` on tasks and subtasks is validated via HTTP call to users-service before write.
- A subtask cannot be a parent — enforced structurally (no `parent_subtask_id` column exists).

## Auth flow

1. `POST /api/auth/register` and `POST /api/auth/login` → unauthenticated, go to users-service.
2. Login returns a JWT (`sub=user_id`, `exp=now+24h`, HS256).
3. Every other request: gateway strips any client-supplied `X-User-ID`, verifies the Bearer token, writes `X-User-ID` from `sub`.
4. Backend services trust `X-User-ID` from the gateway (ClusterIP-only, no external path).
5. tasks-service walks `subtask → task → column → board.owner_id` and returns `404` on mismatch (not `403` — avoids leaking resource existence).

## Environment variables reference

| Variable | Services | Source in prod |
|---|---|---|
| `DB_HOST` | users, tasks | ConfigMap |
| `DB_PORT` | users, tasks | ConfigMap |
| `DB_NAME` | users, tasks | ConfigMap |
| `DB_USER` | users, tasks | ConfigMap |
| `DB_PASSWORD` | users, tasks | Secret (`db-credentials`) |
| `JWT_SIGNING_KEY` | users, gateway | Secret (`jwt-signing-key`) mounted as env var |
| `USERS_SERVICE_URL` | tasks, gateway | ConfigMap |
| `TASKS_SERVICE_URL` | gateway | ConfigMap |

In docker-compose, all secrets are plain env vars (`dev` / `dev-only-not-for-prod-please-rotate`).

## Key technology choices (settled — do not re-litigate)

- **GKE Autopilot** over Cloud Run — microservices need service discovery and the grader rewards K8s
- **Cloud SQL PostgreSQL 15** over self-hosted — DBaaS, private IP only
- **OpenTofu** over Terraform — MPL-2.0, Linux Foundation, identical HCL syntax
- **Workload Identity Federation** over service account keys — no long-lived credentials
- **Git SHA image tags** over `:latest` — immutable deploys, easy rollback
- **bcrypt cost 12** for passwords — OWASP recommendation
- **shadcn/ui + Tailwind CSS v3** for the frontend — components are copied into repo, zero runtime dependency
