# Cloud Infrastructure Project: Go Microservices on GKE

> Reference document for a university cloud infrastructure assignment.
> Stack: Go microservices + React frontend, deployed to GKE via OpenTofu, with GitHub Actions CI/CD on Google Cloud Platform.

---

## Table of Contents

1. [Assignment Requirements](#assignment-requirements)
2. [Technology Choices & Justifications](#technology-choices--justifications)
3. [The Application: "TaskBoard"](#the-application-taskboard)
4. [Architecture Overview](#architecture-overview)
5. [Repository Structure](#repository-structure)
6. [Phase 0: Setup & Prerequisites](#phase-0-setup--prerequisites-days-1-2)
7. [Phase 1: Build the App Locally](#phase-1-build-the-app-locally-days-3-6)
8. [Phase 2: Infrastructure with Terraform](#phase-2-infrastructure-with-terraform-days-7-13)
9. [Phase 3: CI/CD Pipeline](#phase-3-cicd-pipeline-days-14-18)
10. [Phase 4: Documentation](#phase-4-documentation-days-19-23)
11. [Phase 5: Polish & Demo Rehearsal](#phase-5-polish--demo-rehearsal-days-24-30)
12. [Risks & Mitigations](#risks--mitigations)
13. [Definition of Done](#definition-of-done)

---

## Assignment Requirements

### Task Breakdown

1. **Choose an Application** — must have a web frontend and a backend database
2. **Provision Cloud Infrastructure Using IaC** — single command (e.g. `terraform apply`); deployment can be VM, PaaS, or Kubernetes
3. **Implement a CI/CD Pipeline** — auto-trigger on push, build → test → deploy with no manual steps
4. **Cloud Platform** — using GCP (alternative cloud → automatic "A" grade)

### Deliverables

- Cloud Infrastructure Documentation (architecture + IaC explanation + justifications)
- CI/CD Pipeline Documentation (steps + tools + how it ensures auto-deploy)
- Live Demo (working app in cloud, IaC provisioning in one command, CI/CD pipeline in action)

### Constraints

- Timeline: ~1 month from start to demo
- Budget: GCP free tier + $300 / 90-day trial credit (more than enough for one month)
- Microservices in Go, frontend in React

---

## Technology Choices & Justifications

These are the answers to expect during the demo defense.

| Choice | What & Why |
|---|---|
| **Cloud provider** | **GCP** — automatic "A" grade for non-Azure; $300 credit covers 1 month easily; Cloud Run + Firestore would be free forever, but we picked GKE for learning |
| **Compute platform** | **GKE Autopilot** — microservices benefit from service discovery, declarative scaling, rolling updates; Autopilot lets Google manage nodes so we focus on workloads, not cluster ops |
| **Database** | **Cloud SQL (PostgreSQL)** — DBaaS gives automated backups, patching, HA option; private IP only, accessed by GKE pods over Private Service Access; production-realistic security boundary |
| **App authentication** | **JWT (HS256) + bcrypt** — stateless tokens validated at the API gateway, no session store needed; bcrypt for password hashing per OWASP guidance; signing key stored in Secret Manager and mounted into pods as a file |
| **Password hashing** | **bcrypt cost 12** — slow-by-design, future-proof against GPU brute force; standard `golang.org/x/crypto/bcrypt` |
| **IaC** | **OpenTofu** with GCS backend — open-source, MPL-2.0 licensed fork of Terraform maintained by the Linux Foundation; identical HCL syntax and provider ecosystem; `tofu` CLI replaces `terraform`; GCS backend has versioning enabled |
| **CI/CD** | **GitHub Actions** — code lives on GitHub; free for public repos; OIDC for keyless auth (Workload Identity Federation) |
| **Container registry** | **Artifact Registry** — native GCP, integrated with GKE for image pulls, IAM-based access |
| **Auth between GitHub & GCP** | **Workload Identity Federation** — no long-lived service account keys to leak; follows GCP security best practice |
| **Image tagging** | **Git SHA tags** (not `:latest`) — immutable deployments, easy rollback via `kubectl rollout undo` |
| **Networking** | Private GKE cluster + private IP Cloud SQL — only the public LoadBalancer is internet-exposed; defense in depth |
| **UI component library** | **shadcn/ui** — unstyled-by-default Radix primitives with Tailwind; components are copied into the repo (not a runtime dependency), so the production image has zero extra JS payload; accessible out of the box |
| **Theming** | **Tailwind CSS v3 dark-mode class strategy** — `dark:` variants controlled by toggling a `dark` class on `<html>`; user preference stored in `localStorage` and initialized before first paint to avoid flash of wrong theme |

---

## The Application: "TaskBoard"

A Trello-like task board where each user owns one or more boards. Each board has user-defined columns; tasks live in columns; tasks can have deadlines and subtasks. Business logic is still small enough to fit in a few hundred lines per service — graders evaluate the infrastructure, not the app — but the app is now realistic enough to demonstrate auth, multi-tenant data isolation, and a non-trivial domain model.

### Functional Scope

**Authentication & accounts**
- Register with name + email + password; passwords hashed with bcrypt (cost 12)
- Log in with email + password → receive a JWT access token (24h expiry, HS256, signed with a secret from Secret Manager)
- API gateway validates the JWT on every request and forwards `X-User-ID` to backend services
- Backend services trust the gateway header (they're not internet-exposed) — defense-in-depth via private cluster + ClusterIP services

**Boards** (owned per user)
- A user can create / list / rename / delete their own boards
- Each board has an `owner_id`; only the owner can read or modify the board and its contents (returns `403`/`404` to others)
- A new board is seeded with three default columns (`To Do`, `In Progress`, `Done`) so it's usable immediately

**Custom columns** (per board, with rules)
- Each column has a name (1–50 chars) and a position (integer, unique within the board)
- A board must have **at least 1** and **at most 10** columns at all times — last-column delete is rejected, 11th-column add is rejected
- Reorder by `PUT /columns/{id}` with a new `position` (server compacts positions)
- Deleting a column with tasks is rejected — caller must move/delete the tasks first (avoids accidental data loss)

**Tasks**
- Live in exactly one column; moving a task = updating its `column_id`
- Fields: `id`, `title`, `description`, `assigned_user_id` (nullable), `deadline` (nullable timestamp), `column_id`, `position`, `created_at`
- `assigned_user_id` must reference a real user (validated by calling users-service), but for v1 the assignee is just any user — board sharing/membership is out of scope

**Subtasks** (one level deep, no recursion)
- A subtask belongs to exactly one parent task (`parent_task_id`)
- Subtasks have `title` + `completed` boolean only — no nested subtasks, no own deadlines
- Deleting the parent cascades to its subtasks (`ON DELETE CASCADE`)

**Frontend**
- Login + register pages
- "My boards" landing page (list, create, delete)
- Board view: columns side-by-side, tasks listed under each, click a task → modal with description, deadline, assignee dropdown, subtask checklist
- Column management: add column, rename column, delete column (button greyed when rules forbid)
- Light / dark mode toggle (sun/moon icon in the top navbar); preference persisted to `localStorage` and applied before first paint to prevent flash of wrong theme
- Built with **shadcn/ui** components throughout (Button, Card, Dialog, Input, Select, Checkbox, Badge, DropdownMenu, Separator, Tooltip, etc.) on top of Tailwind CSS

### Microservices Breakdown

The app is split into 3 backend services + 1 frontend, all in their own containers. This split is still somewhat artificial for an app this size, but the auth + multi-tenant boards make it more defensible than the original "tasks only" version.

| Service | Language | Responsibility | Endpoints | DB tables |
|---|---|---|---|---|
| **`api-gateway`** | Go | Routes incoming HTTP requests; validates JWT on protected routes and injects `X-User-ID` header; only public-facing service besides the frontend | `/api/auth/*` → users-service (no JWT required); `/api/users/*` → users-service (JWT required); `/api/boards/*`, `/api/columns/*`, `/api/tasks/*`, `/api/subtasks/*` → tasks-service (JWT required); `/healthz` | none |
| **`users-service`** | Go | Registration, login (issues JWTs), and user CRUD | `POST /auth/register`, `POST /auth/login`, `GET /users/me`, `GET /users/{id}` (basic profile), `PUT /users/me`, `DELETE /users/me`, `/healthz` | `users` |
| **`tasks-service`** | Go | Boards, columns, tasks, subtasks. Enforces ownership (`owner_id == X-User-ID`) on every read/write. Calls users-service to validate `assigned_user_id`. Despite its name (kept for continuity), it owns the entire board domain. | `GET/POST /boards`, `GET/PUT/DELETE /boards/{id}`, `GET/POST /boards/{id}/columns`, `PUT/DELETE /columns/{id}`, `POST /columns/{id}/tasks`, `GET/PUT/DELETE /tasks/{id}`, `POST /tasks/{id}/subtasks`, `PUT/DELETE /subtasks/{id}`, `/healthz` | `boards`, `board_columns`, `tasks`, `subtasks` |
| **`frontend`** | React (Vite) + nginx | Static SPA: login/register → board list → board detail → task modal. Stores JWT in `localStorage`, sends it as `Authorization: Bearer …` on every request. | n/a (static files) | none |

### Authorization model (in one place, so it's easy to defend)

1. **Gateway is the only JWT validator.** It checks the `Authorization: Bearer …` header, verifies the HS256 signature with the secret from Secret Manager, and writes the user id into `X-User-ID`. Invalid/missing token on a protected route → `401`.
2. **Backend services trust `X-User-ID`.** They are ClusterIP-only — there is no path from the internet to them that bypasses the gateway. This is the same trust boundary as the private DB.
3. **Ownership is checked per resource.** Every `boards/columns/tasks/subtasks` handler resolves the board (walking `subtask → task → column → board` if needed) and rejects the request if `board.owner_id != X-User-ID`. Returns `404` (not `403`) to avoid leaking the existence of other users' resources.
4. **Auth endpoints are unauthenticated.** `POST /auth/register` and `POST /auth/login` are reachable without a token; everything else requires one.

### Why this design satisfies the rubric

- **Multiple services** — 3 backend services + 1 frontend = 4 deployments in K8s
- **Inter-service communication** — tasks-service calls users-service over cluster DNS (`http://users-service.default.svc.cluster.local:8080`) to validate `assigned_user_id`; gateway calls both services for routing — demonstrates service discovery
- **Database** — Cloud SQL Postgres, accessed only by users-service and tasks-service via private IP
- **Independent deployability** — each service has its own Dockerfile, its own GitHub Actions path filter, its own image in Artifact Registry; pushing a change to `services/users-service/` only rebuilds that one
- **Health checks** — every service exposes `/healthz` for Kubernetes liveness/readiness probes
- **Realistic security boundary** — JWT signing key in Secret Manager → mounted as a file into the gateway pod only; bcrypt password hashes never leave users-service; backend services unreachable from the internet

### Data Model

```sql
CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(100) NOT NULL,
  email          VARCHAR(255) UNIQUE NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,            -- bcrypt
  created_at     TIMESTAMP DEFAULT NOW()
);

CREATE TABLE boards (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- "columns" is reserved-ish in SQL contexts (information_schema.columns); use a non-clashing name.
CREATE TABLE board_columns (
  id          SERIAL PRIMARY KEY,
  board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name        VARCHAR(50) NOT NULL,
  position    INTEGER NOT NULL,                    -- 0-based, contiguous within a board
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (board_id, position)
);

CREATE TABLE tasks (
  id                SERIAL PRIMARY KEY,
  column_id         INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title             VARCHAR(200) NOT NULL,
  description       TEXT,
  assigned_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deadline          TIMESTAMP,                     -- nullable
  position          INTEGER NOT NULL,              -- order within the column
  created_at        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE subtasks (
  id              SERIAL PRIMARY KEY,
  parent_task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title           VARCHAR(200) NOT NULL,
  completed       BOOLEAN NOT NULL DEFAULT FALSE,
  position        INTEGER NOT NULL,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_boards_owner ON boards(owner_id);
CREATE INDEX idx_columns_board ON board_columns(board_id);
CREATE INDEX idx_tasks_column ON tasks(column_id);
CREATE INDEX idx_subtasks_parent ON subtasks(parent_task_id);
```

**Invariants enforced in service code (not just SQL):**
- A board always has between 1 and 10 columns.
- A column cannot be deleted if it still has tasks.
- A subtask cannot itself have subtasks (the schema simply has no `parent_subtask_id` — design choice, not check constraint).
- `assigned_user_id` is validated by an HTTP call from tasks-service to users-service before insert/update.

### Per-service technical notes

#### `users-service` (Go)
- Stdlib `net/http` + `github.com/jackc/pgx/v5` for Postgres + `golang.org/x/crypto/bcrypt` + `github.com/golang-jwt/jwt/v5`
- Reads `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` from env; reads `DB_PASSWORD` and `JWT_SIGNING_KEY` from files mounted from Kubernetes Secrets (which are sourced from Secret Manager)
- ~300 lines of code total (auth roughly doubles the original size)
- Listens on `:8080`
- On startup: ping DB, run `CREATE TABLE IF NOT EXISTS` migration for `users`, start server
- `POST /auth/register`: validates email format + password length (≥8), bcrypts the password, inserts user, returns the new user (no token — client must log in)
- `POST /auth/login`: looks up user by email, compares with bcrypt, on success issues a JWT with `sub=user_id`, `exp=now+24h`, signed HS256 with `JWT_SIGNING_KEY`
- `GET /users/me`: trusts `X-User-ID` from gateway, returns that user's profile (without `password_hash`)

#### `tasks-service` (Go)
- Same base stack as users-service; does NOT need the JWT key (gateway has already validated)
- On startup: runs migrations for `boards`, `board_columns`, `tasks`, `subtasks`
- Every handler reads `X-User-ID` and resolves the requested resource up to its owning board to authorize:
  - `subtask → task → column → board.owner_id`
  - Returns `404` if owner mismatch (don't leak existence)
- Has an HTTP client that calls `http://users-service:8080/users/{id}` to validate `assigned_user_id` before insert/update
- Enforces column rules (1–10 per board, no delete with tasks) at the handler level — these are app-logic, not DB constraints
- Demonstrates service-to-service communication inside the cluster

#### `api-gateway` (Go)
- Stdlib `httputil.ReverseProxy` + `github.com/golang-jwt/jwt/v5`
- Routes by URL prefix
- Reads upstream service URLs from env (`USERS_SERVICE_URL`, `TASKS_SERVICE_URL`) and `JWT_SIGNING_KEY` from a file mounted from a Kubernetes Secret
- Middleware: on protected routes, parses the `Authorization: Bearer …` header, verifies signature + expiry, extracts `sub`, sets `X-User-ID` on the proxied request (and strips any `X-User-ID` the client tried to inject)
- `POST /api/auth/register` and `POST /api/auth/login` are explicitly unauthenticated — the only public endpoints
- The only backend service exposed via the LoadBalancer Ingress

#### `frontend` (React)
- `npm create vite@latest -- --template react-ts` (TypeScript for safer props with shadcn/ui)
- Add Tailwind CSS v3, then `npx shadcn@latest init` — copies component source into `src/components/ui/`; no runtime shadcn dependency in the final bundle
- Pages: `/login`, `/register`, `/boards` (list), `/boards/:id` (detail with columns + tasks), task detail in a Dialog modal
- Uses `react-router-dom` for the small handful of routes
- Stores JWT in `localStorage`; a small `fetch` wrapper attaches `Authorization: Bearer <token>` and redirects to `/login` on `401`
- Theme: a `ThemeProvider` context wraps the app; toggling adds/removes the `dark` class on `<html>`. A `<ModeToggle>` button (shadcn DropdownMenu with Sun/Moon icons from `lucide-react`) sits in the top-right of the navbar. Initial theme is read from `localStorage` in an inline `<script>` in `index.html` before React loads — this prevents the flash of wrong theme on page load.
- Build output served by nginx in the container; nginx config proxies `/api/*` to `api-gateway` service

**Key shadcn/ui components used:**

| Screen | shadcn components |
|---|---|
| Login / Register | `Card`, `CardHeader`, `CardContent`, `Input`, `Button`, `Label` |
| Board list | `Card`, `CardTitle`, `Button`, `Dialog` (create board form), `AlertDialog` (confirm delete) |
| Board view | `Badge` (task status), `Button`, `Separator`, `Tooltip` (deadline warning) |
| Task modal | `Dialog`, `DialogContent`, `Input`, `Textarea`, `Select` (assignee), `Checkbox` (subtasks), `Button` |
| Navbar | `DropdownMenu` (theme toggle), `Button`, `Separator` |

### Dockerfile Patterns

**Go services** — multi-stage build, final image ~15–20 MB:
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

**Frontend** — multi-stage with nginx:
```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### Local Development with `docker-compose.yml`

Bring up the entire stack on `localhost:8080`:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: taskboard
      POSTGRES_USER: app
      POSTGRES_PASSWORD: dev
    volumes:
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql
    ports: ["5432:5432"]

  users-service:
    build: ./services/users-service
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: taskboard
      DB_USER: app
      DB_PASSWORD: dev
      JWT_SIGNING_KEY: dev-only-not-for-prod-please-rotate    # in K8s this is read from a file
    depends_on: [postgres]

  tasks-service:
    build: ./services/tasks-service
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: taskboard
      DB_USER: app
      DB_PASSWORD: dev
      USERS_SERVICE_URL: http://users-service:8080
    depends_on: [postgres, users-service]

  api-gateway:
    build: ./services/api-gateway
    environment:
      USERS_SERVICE_URL: http://users-service:8080
      TASKS_SERVICE_URL: http://tasks-service:8080
      JWT_SIGNING_KEY: dev-only-not-for-prod-please-rotate    # must match users-service
    depends_on: [users-service, tasks-service]

  frontend:
    build: ./services/frontend
    ports: ["8080:80"]
    depends_on: [api-gateway]
```

---

## Architecture Overview

```
                 Internet
                    │
                    ▼
        ┌─────────────────────┐
        │ GCP Load Balancer   │  (Kubernetes Ingress)
        └──────────┬──────────┘
                   │
                   ▼
        ┌──────────────────────────────────────────────────┐
        │              GKE Autopilot Cluster               │
        │                                                  │
        │   ┌─────────┐                                    │
        │   │frontend │  (nginx, serves SPA                │
        │   │  pod    │   + proxies /api/*)                │
        │   └────┬────┘                                    │
        │        │                                         │
        │        ▼                                         │
        │   ┌──────────────┐   ── verifies JWT ──┐         │
        │   │api-gw pod    │   (HS256, key from  │         │
        │   │ + JWT mw     │    Secret Manager)  │         │
        │   └────┬─────────┘   sets X-User-ID ───┘         │
        │        │                                         │
        │   ┌────┴─────┐                                   │
        │   ▼          ▼                                   │
        │ ┌─────┐   ┌─────┐                                │
        │ │users│   │tasks│  ── tasks calls ──┐            │
        │ │ pod │   │ pod │ ◄── users for ────┘            │
        │ └──┬──┘   └──┬──┘    assignee validation         │
        │    │         │                                   │
        │    │         │   tasks-pod authorizes per call:  │
        │    │         │   subtask→task→column→board.owner │
        │    │         │                                   │
        └────┼─────────┼───────────────────────────────────┘
             │         │
             │  Private Service Access (VPC peering)
             ▼         ▼
        ┌─────────────────────┐         ┌──────────────────┐
        │  Cloud SQL Postgres │         │  Secret Manager  │
        │  (private IP only)  │         │  db-pwd, jwt-key │
        └─────────────────────┘         └──────────────────┘
                                          ▲
                                          │ mounted as files
                                          │ into gw + users
                                          │ pods only
```

---

## Repository Structure

```
project-root/
├── .github/workflows/
│   ├── tofu.yml              # infra pipeline (tofu plan/apply)
│   └── deploy.yml            # app build + deploy to GKE
├── terraform/
│   ├── main.tf               # provider, backend
│   ├── variables.tf
│   ├── outputs.tf
│   ├── network.tf            # VPC, subnet, private service access
│   ├── gke.tf                # Autopilot cluster
│   ├── database.tf           # Cloud SQL + secrets
│   ├── registry.tf           # Artifact Registry
│   ├── iam.tf                # Workload Identity Federation for GitHub
│   └── kubernetes.tf         # k8s namespace, deployments, services, ingress
├── services/
│   ├── api-gateway/
│   │   ├── cmd/server/main.go
│   │   ├── go.mod
│   │   └── Dockerfile
│   ├── users-service/
│   │   ├── cmd/server/main.go
│   │   ├── go.mod
│   │   └── Dockerfile
│   ├── tasks-service/
│   │   ├── cmd/server/main.go
│   │   ├── go.mod
│   │   └── Dockerfile
│   └── frontend/
│       ├── src/
│       ├── package.json
│       ├── vite.config.js
│       ├── nginx.conf
│       └── Dockerfile
├── k8s/                      # raw manifests (referenced by terraform/kubernetes.tf or applied directly)
│   ├── namespace.yaml
│   ├── deployments.yaml
│   ├── services.yaml
│   └── ingress.yaml
├── db/
│   └── init.sql              # schema for local dev
├── docker-compose.yml        # local dev environment
└── README.md
```

---

## Phase 0: Setup & Prerequisites (Days 1-2)

**Goal**: Working dev environment, GCP account ready, repo structure decided.

### Tasks
- Create new GCP account → claim $300 credit → create project (e.g. `taskboard-cloud-2026`)
- Install locally: `gcloud`, `tofu` (≥1.7 — install via `brew install opentofu` or the official installer at opentofu.org), `kubectl`, `docker`, `go` (≥1.22), `node` (≥20)
- Set up budget alert at $50 (GCP Console → Billing → Budgets & alerts)
- Enable required GCP APIs:
  - `compute.googleapis.com`
  - `container.googleapis.com`
  - `sqladmin.googleapis.com`
  - `artifactregistry.googleapis.com`
  - `iam.googleapis.com`
  - `iamcredentials.googleapis.com`
  - `cloudresourcemanager.googleapis.com`
  - `servicenetworking.googleapis.com`
  - `secretmanager.googleapis.com`
- Create the GitHub repo with the structure above
- Run `gcloud auth application-default login` so Terraform can authenticate locally

### Deliverable
Empty repo with the structure committed. `gcloud auth login` working locally. Can run `gcloud projects describe <project-id>`.

---

## Phase 1: Build the App Locally (Days 3-6)

**Goal**: All services running on the laptop with `docker compose up`. Don't touch the cloud yet.

The auth + boards work makes Phase 1 the second-longest phase. Build it in this order so each step is testable:

### 1a. Schema and users-service auth (Day 3)
- Write `db/init.sql` with all 5 tables (`users`, `boards`, `board_columns`, `tasks`, `subtasks`) and indexes
- Write `users-service`: register, login, `GET /users/me`, `GET /users/{id}` — bcrypt + JWT issuance only
- Write its `Dockerfile`
- Test in isolation: `curl POST /auth/register`, `curl POST /auth/login` → JWT, decode JWT at jwt.io to confirm shape

### 1b. tasks-service: boards + columns (Day 4)
- Implement boards CRUD (with the "default 3 columns on create" seeding)
- Implement column add/rename/reorder/delete with the 1–10 rule and the "no delete with tasks" rule
- Every handler authorizes against `X-User-ID`
- Test in isolation against a hardcoded `X-User-ID: 1`: create board, list columns, attempt to delete the last column → expect `409`

### 1c. tasks-service: tasks + subtasks (Day 5)
- Tasks CRUD scoped to a column; deadline accepted/returned as RFC3339
- Subtasks CRUD nested under a task
- Cross-service call: `assigned_user_id` validation against users-service
- Test: create task with deadline, add 3 subtasks, mark one completed, delete the parent → subtasks gone too

### 1d. api-gateway with JWT middleware (Day 5)
- Stdlib reverse proxy + JWT verification middleware
- Strip any client-supplied `X-User-ID` (security: client must not impersonate)
- Public routes: `/api/auth/*` and `/healthz`; everything else requires a valid token
- Test: hit `/api/boards` without a token → `401`; with a fresh token from `/api/auth/login` → `200`

### 1e. Frontend (Day 6)
- Vite + React + react-router; `/login`, `/register`, `/boards`, `/boards/:id`
- `fetch` wrapper that attaches the JWT and redirects to `/login` on `401`
- Board view: columns side-by-side, task list per column, click → modal with deadline picker + subtask checklist
- Test the full flow end-to-end in a browser at `http://localhost:8080`

### 1f. Glue
- Write `docker-compose.yml` (above)
- Verify `docker compose up` brings up the whole app
- Manually test the golden path:
  - Register → login → create board → rename a column → add a task with a deadline → add 2 subtasks → tick one off → log out → log back in → state persisted

### Deliverable
`docker compose up` from repo root brings up the working app at `http://localhost:8080`. A second user logging in cannot see the first user's boards (verify this — it's the easiest auth bug to ship). Commit everything. Tag as `v0.1-local`.

---

## Phase 2: Infrastructure with OpenTofu (Days 7-13)

**Goal**: `tofu apply` creates the entire cloud environment from nothing.

This is the longest phase. Build it in layers, applying after each layer works.

### 2a. Bootstrap state backend (Day 7)
- Manually create one GCS bucket for OpenTofu state with versioning enabled
  - This is the only manual cloud step — you can't bootstrap state in IaC
- Configure `backend "gcs"` in `main.tf`
- Run `tofu init`

### 2b. Networking + Registry + Database (Days 7-9)
- VPC with one subnet (e.g. `10.10.0.0/20`)
- Secondary IP ranges on the subnet for GKE pods (`10.20.0.0/14`) and services (`10.24.0.0/20`)
- Private Service Access setup (`google_compute_global_address` + `google_service_networking_connection`)
- Artifact Registry repository named `taskboard`
- Cloud SQL instance: PostgreSQL 15, db-f1-micro, private IP only, no public IP
- `random_password` resource for the DB password, stored in Secret Manager
- Second `random_password` (length 64, special chars on) for the JWT signing key, stored in Secret Manager as `jwt-signing-key`
- Database and user resources inside the Cloud SQL instance

**Test**: `tofu apply` succeeds. Cloud SQL appears in console with private IP. Artifact Registry visible.

### 2c. GKE Autopilot cluster (Days 9-10)
- Regional GKE Autopilot cluster (`google_container_cluster` with `enable_autopilot = true`)
- Use the same VPC and the secondary IP ranges
- Workload Identity is automatic on Autopilot
- Output the cluster name and endpoint

**Test**: `gcloud container clusters get-credentials <name> --region <region>` works. `kubectl get nodes` returns nodes.

### 2d. Workload Identity Federation for GitHub (Days 10-11) — *the tricky one*
- `google_iam_workload_identity_pool`
- `google_iam_workload_identity_pool_provider` for `token.actions.githubusercontent.com` with attribute condition that pins to your repo:
  ```
  attribute.repository == "your-username/your-repo-name"
  ```
- `google_service_account` named `github-deployer`
- IAM roles on the SA:
  - `roles/artifactregistry.writer` (push images)
  - `roles/container.developer` (deploy to GKE)
  - `roles/iam.serviceAccountTokenCreator` (impersonation)
- IAM binding: `roles/iam.workloadIdentityUser` from `principalSet://...subject == repo:owner/name:ref:refs/heads/main` to the SA

**Outputs to expose**: provider name, service account email — these become GitHub Actions repo variables/secrets.

**Test before continuing**: write a tiny throwaway workflow that just runs `gcloud projects describe $PROJECT_ID` using these credentials. If it works, the setup is solid. If not, debug now — don't carry this risk into Phase 3.

### 2e. Kubernetes resources via Terraform (Days 11-13)
- Use the `kubernetes` and `kubectl` Terraform providers (configured with the cluster credentials from `gke.tf`)
- Resources:
  - Namespace `taskboard`
  - ConfigMap with non-secret config (DB host, port, name, service URLs)
  - Secret `db-credentials` with DB password (sourced from Secret Manager via `data` block, or `kubernetes_secret` directly)
  - Secret `jwt-signing-key` (sourced from Secret Manager) — mounted as a file into **`api-gateway` and `users-service` pods only**; tasks-service deliberately does NOT get this secret (least privilege)
  - Deployments for all 4 services (initially with placeholder image tags like `:bootstrap`, since the real images don't exist yet)
  - Services (ClusterIP for backend, the frontend exposed via Ingress)
  - Ingress for external access → creates the GCP Load Balancer

**Critical ordering issue**: Terraform must wait for the cluster to exist, then push placeholder images to Artifact Registry, then apply k8s manifests (otherwise pods crash with `ImagePullBackOff`).

**Two ways to handle this**:
1. *Recommended*: in Phase 1, build & push a placeholder `:bootstrap` image manually once. Terraform references this tag. The CI/CD pipeline replaces images on push.
2. Use a `null_resource` with `local-exec` that runs `docker build && docker push` before the k8s resources, with `depends_on` on the registry.

**Deliverable**: `tofu destroy && tofu apply` rebuilds everything in ~10-15 minutes. `kubectl get pods -n taskboard` shows all pods running with placeholder images. The LoadBalancer has a public IP.

---

## Phase 3: CI/CD Pipeline (Days 14-18)

**Goal**: `git push` to main automatically builds, tests, and deploys.

### 3a. OpenTofu workflow (`.github/workflows/tofu.yml`)
Triggers: push or PR affecting `terraform/**`.

Steps:
- Checkout
- Authenticate via Workload Identity Federation (`google-github-actions/auth`)
- Install OpenTofu via `opentofu/setup-opentofu` action
- `tofu fmt -check`
- `tofu init`
- `tofu validate`
- `tofu plan` (always; comment plan to PR if it's a PR)
- `tofu apply -auto-approve` (only on push to main)

### 3b. App deploy workflow (`.github/workflows/deploy.yml`)
Triggers: push to main affecting `services/**`.

```yaml
permissions:
  id-token: write    # for Workload Identity Federation
  contents: read

jobs:
  detect-changes:
    # Use dorny/paths-filter to detect which services changed
    outputs:
      users: ${{ steps.filter.outputs.users }}
      tasks: ${{ steps.filter.outputs.tasks }}
      gateway: ${{ steps.filter.outputs.gateway }}
      frontend: ${{ steps.filter.outputs.frontend }}

  build-and-deploy:
    needs: detect-changes
    strategy:
      matrix:
        service: [users-service, tasks-service, api-gateway, frontend]
    steps:
      - Checkout
      - Auth via WIF (google-github-actions/auth)
      - Configure docker for Artifact Registry
      - go test ./... (for Go services)
      - docker build -t $REGION-docker.pkg.dev/$PROJECT/taskboard/$SERVICE:$GITHUB_SHA
      - docker push
      - gcloud container clusters get-credentials
      - kubectl set image deployment/$SERVICE $SERVICE=$NEW_IMAGE -n taskboard
      - kubectl rollout status deployment/$SERVICE -n taskboard --timeout=5m
```

### Key decisions to defend in the demo
- **Why git SHA tags, not `:latest`?** — Immutable deployments, easy rollback (`kubectl rollout undo`), traceable to a commit
- **Why path filters?** — Don't rebuild everything when only one service changed; faster pipeline
- **Why `kubectl set image` not `kubectl apply`?** — Apply would fight Terraform over ownership of the Deployment resource; `set image` only mutates the image field
- **Why OpenTofu over Terraform?** — OpenTofu is MPL-2.0 (truly open-source), maintained by the Linux Foundation, 100% CLI-compatible with Terraform HCL; no BSL license concerns for academic or commercial use
- **Why two separate workflows?** — Infra and app have different cadences and review needs; infra changes are riskier and rarer

### 3c. Test the full loop
- Make a trivial change (e.g. change a string in users-service)
- Push to main
- Watch Actions tab → see build job → see deploy job → curl the LoadBalancer IP → see the change
- Make an OpenTofu change (e.g. add a label to the cluster) → push → watch infra workflow run

### Deliverable
Working end-to-end automation. A commit triggers a deploy that lands in GKE within ~3-4 minutes. Document the flow with a sequence diagram.

---

## Phase 4: Documentation (Days 19-23)

**Goal**: Two well-written documents that defend every choice.

### Document 1: Infrastructure Documentation
Sections:
- **Architecture diagram** (use [draw.io](https://draw.io) or [Excalidraw](https://excalidraw.com))
- **Component breakdown** of each Terraform file:
  - `network.tf` — what it provisions, why
  - `database.tf` — Cloud SQL config, security boundary
  - `gke.tf` — Autopilot rationale, networking integration
  - `iam.tf` — Workload Identity Federation flow
  - `kubernetes.tf` — k8s resources managed by TF vs. by CI/CD
- **Justification section** (graders care about this most):
  - Why GKE over Cloud Run/VM? — *Microservices benefit from service discovery, declarative scaling, rolling updates, and standard k8s manifests are portable across clouds*
  - Why Autopilot over Standard? — *Reduces operational overhead, fits learning timeline, Google manages node security and upgrades*
  - Why Cloud SQL over self-hosted in a pod? — *DBaaS gives automated backups, patching, HA option; security boundary properly enforced; production-realistic*
  - Why private cluster + private IP DB? — *Defense in depth, only the LoadBalancer is publicly exposed*
  - Why JWT validation at the gateway only? — *Single trust boundary, backend services don't need the signing key, simpler to rotate; backends are unreachable from the internet so trusting `X-User-ID` from the gateway is safe*
  - Why bcrypt over SHA-256 + salt? — *bcrypt is slow-by-design and adaptive (cost factor), the OWASP-recommended default for passwords*
  - Why store the JWT signing key in Secret Manager (not a ConfigMap or env literal)? — *Rotatable without rebuilding images, audited access, never visible in `kubectl get configmap` output*
- **How to run** — single-command instructions:
  - One-time setup: enable APIs, create state bucket, set GitHub repo variables
  - `terraform init && terraform apply`
- **How to destroy** — `terraform destroy`

### Document 2: CI/CD Documentation
Sections:
- **Pipeline diagram** (GitHub → Actions runner → Artifact Registry → GKE)
- **Workflow file walkthrough** — annotated YAML for both `terraform.yml` and `deploy.yml`
- **Justification section**:
  - Why GitHub Actions? — *Native to where the code lives, free for public repos, OIDC for keyless auth*
  - Why Workload Identity Federation? — *No long-lived service account keys to leak, follows GCP security best practice; trust scoped to specific repo + branch*
  - Why OpenTofu over Terraform? — *MPL-2.0 open-source, Linux Foundation governed, identical HCL syntax and provider ecosystem, no BSL license restrictions*
  - Why separate OpenTofu and app workflows? — *Different concerns, different cadences, infra changes need more review*
  - Why path-filtered builds? — *Don't rebuild what didn't change*
- **How to test the pipeline** — make a change, observe the run, verify the deployment

---

## Phase 5: Polish & Demo Rehearsal (Days 24-30)

**Goal**: Smooth, confident 10-minute demo.

### Days 24-26: Trial run from scratch
- `terraform destroy` everything
- Walk through the README from scratch as if first time
- Time the full provisioning (~10-15 min for GKE) — fill that time in the demo with explanation
- Fix any rough edges, missing docs, broken commands

### Days 27-28: Demo script

Write the demo as a script. Plan exactly what to show:

| Step | Time | Action |
|---|---|---|
| 1 | 1 min | Show empty GCP project: "nothing here" |
| 2 | 1 min | Run `tofu apply` — let it start |
| 3 | 5-7 min | **While it runs**: walk through architecture diagram, OpenTofu file structure, GitHub Actions YAML, security model (WIF, private cluster, private DB). This is the bulk of the demo. |
| 4 | 1 min | Show GKE cluster running, `kubectl get pods -n taskboard`, all green |
| 5 | 1 min | Open the app in browser, click around, add a task |
| 6 | 30 sec | Make a code change live (e.g. change a string in frontend or a response message in Go) |
| 7 | 2-3 min | Push to main, switch to Actions tab, narrate while pipeline runs |
| 8 | 30 sec | Refresh the app, show the change live |
| 9 | optional | `tofu destroy` to prove it's reversible (or do this off-camera afterwards) |

### Days 29-30: Buffer
**Don't underestimate this.** Something will break. GitHub Actions will rate-limit. A Terraform provider will have a breaking version. Cloud SQL will provision slower than expected. Have buffer.

Backup plans:
- Record a video of a successful end-to-end run, in case live demo fails
- Have screenshots of every key moment
- Have the Terraform output and `kubectl` commands ready in a shell history

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| GKE provisioning takes 10+ min and breaks demo flow | Pre-warm: provision before the demo, or use the wait time to explain architecture |
| Workload Identity Federation misconfigured (most common failure mode) | Test with a dummy "hello world" workflow first, before connecting the real pipeline |
| OpenTofu state gets corrupted | GCS backend has versioning enabled; commit `.terraform.lock.hcl` (OpenTofu uses the same lock file name) |
| Cloud SQL private IP networking is fiddly | Build it in isolation first with a test VM that can reach the DB |
| Forgot to destroy resources, credit drains | $50 budget alert email + a manually-triggered `tofu destroy` workflow |
| Demo machine has no internet at presentation | Recorded video backup of the full flow |
| `:bootstrap` placeholder image strategy breaks first apply | Build & push the placeholder image manually before first `terraform apply` |
| Inter-service DNS doesn't resolve in cluster | Confirm with `kubectl exec -it <pod> -- nslookup users-service` early |
| Ingress takes 2-3 min to get a public IP after creation | Don't panic; check `kubectl describe ingress` for events |

---

## Definition of Done

- [ ] One command (`terraform apply`) creates everything from a clean GCP project (after one-time bucket bootstrap)
- [ ] Push to main triggers a build that deploys within ~3-4 minutes
- [ ] App is reachable at a public LoadBalancer IP/hostname
- [ ] A user can register, log in, and receive a JWT
- [ ] A logged-in user can create a board, customise its columns (within the 1–10 rule), add tasks with deadlines, and add subtasks
- [ ] A second user logging in cannot see or modify the first user's boards (verified manually before the demo)
- [ ] Invalid/expired JWTs return `401`; missing JWTs on protected routes return `401`
- [ ] Both Go backend services have passing tests run by the pipeline
- [ ] Two clean documentation files (Infrastructure + CI/CD)
- [ ] Frontend uses shadcn/ui components; light/dark toggle works and persists across page reloads without flash
- [ ] Architecture diagram included (showing JWT flow + ownership boundary)
- [ ] Practiced demo that fits in the time slot
- [ ] `terraform destroy` cleanly removes everything
- [ ] Budget alert configured at $50
- [ ] Backup video recording of a successful end-to-end run

---

## Quick Reference: Common Commands

```bash
# Local dev
docker compose up
docker compose down -v

# GCP auth
gcloud auth application-default login
gcloud config set project <project-id>

# OpenTofu
cd terraform/
tofu init
tofu plan
tofu apply
tofu destroy

# Kubernetes
gcloud container clusters get-credentials <cluster> --region <region>
kubectl get pods -n taskboard
kubectl logs -n taskboard deployment/users-service
kubectl rollout status deployment/users-service -n taskboard
kubectl rollout undo deployment/users-service -n taskboard  # rollback

# Manual image push (for the bootstrap placeholder)
gcloud auth configure-docker <region>-docker.pkg.dev
docker build -t <region>-docker.pkg.dev/<project>/taskboard/users-service:bootstrap services/users-service
docker push <region>-docker.pkg.dev/<project>/taskboard/users-service:bootstrap
```

---

## When Asking Claude for Help on This Project

When asking for help with code or infrastructure, share this document and reference:
- The phase you're currently in (e.g. "I'm in Phase 2c, GKE cluster")
- The specific service or file (e.g. "writing `terraform/iam.tf`")
- The choices already made above (don't re-litigate Cloud Run vs GKE — it's settled)

Stack at a glance: **Go microservices + React + shadcn/ui + Postgres + Docker + OpenTofu + GKE Autopilot + Cloud SQL + GitHub Actions + Workload Identity Federation on GCP**.
