# Infrastructure as Code — How and Why

This document explains the OpenTofu configuration in this folder from first principles.

---

## What is Infrastructure as Code?

Normally you'd provision cloud resources by clicking around the GCP console.
IaC means you write that same intent as code. OpenTofu reads the code, figures out what currently exists in GCP, and makes the minimum changes to reach the desired state.

The key idea: **the `.tf` files are the source of truth**, not the GCP console.

---

## How OpenTofu works (the basics)

```
tofu plan    →  "here is what I would do, nothing is changed yet"
tofu apply   →  "do it for real"
tofu destroy →  "delete everything managed by this config"
```

OpenTofu keeps track of what it has already created in a **state file** — a JSON file that maps each resource block in your `.tf` files to a real GCP resource ID. Without the state file, OpenTofu doesn't know what already exists.

### Why is the state file in GCS?

If the state file lived on your laptop, no one else on the team could run `tofu apply`, and you'd lose it if you reinstalled your machine. Storing it in a GCS bucket makes it shared and durable. This is why the first step was creating that bucket manually — the state bucket cannot manage itself.

---

## How providers work

At the top of `main.tf` you declare **providers**:

```hcl
provider "google" {
  project = var.project_id
  region  = var.region
}
```

A provider is a plugin that knows how to talk to a specific API. The `google` provider knows every GCP resource type. The `kubernetes` provider knows how to create Kubernetes objects. OpenTofu downloads them during `tofu init`.

---

## Variables and tfvars

`variables.tf` declares inputs — like function parameters:

```hcl
variable "project_id" {
  type = string
}
```

`terraform.tfvars` fills them in:

```hcl
project_id = "cloud-native-taskboard-495818"
```

This separates *what the config expects* from *the actual values*, which differ between environments (dev vs. prod). `terraform.tfvars` is gitignored because it contains your real project ID and bucket name.

---

## File-by-file walkthrough

### `network.tf` — The private network

Before anything else can talk to anything else, you need a network.

**VPC (Virtual Private Cloud):** A private network that only your resources can see. Think of it as your own section of GCP's data center.

```hcl
resource "google_compute_network" "main" {
  name                    = "taskboard-vpc"
  auto_create_subnetworks = false   # we define subnets ourselves
}
```

**Subnet:** A slice of the VPC with a specific IP address range. Your GKE nodes run inside this subnet.

```hcl
resource "google_compute_subnetwork" "main" {
  ip_cidr_range = "10.10.0.0/20"   # node IPs come from this range
  secondary_ip_range { ... }        # pod IPs  (10.20.0.0/14)
  secondary_ip_range { ... }        # service IPs (10.24.0.0/20)
}
```

GKE needs three separate IP ranges: one for nodes, one for pods (containers), one for Kubernetes Services. They must not overlap.

**Private Service Access:** Cloud SQL runs inside Google's own network, not yours. Private Service Access creates a VPC peering link so your GKE pods can reach Cloud SQL over a private IP — never over the public internet.

```
Your VPC  ←──── VPC peering ────→  Google's managed services VPC
 (GKE)                                  (Cloud SQL lives here)
```

---

### `gke.tf` — The Kubernetes cluster

```hcl
resource "google_container_cluster" "main" {
  enable_autopilot = true
  ...
}
```

**GKE Autopilot** is a mode where Google manages the underlying VMs (nodes) for you. You only describe *what* you want to run (Deployments, Services), and GKE figures out how many machines are needed. You pay per pod, not per node.

`private_cluster_config` with `enable_private_nodes = true` means the nodes have no public IP — they can't be reached from the internet directly. The cluster control plane still has a public endpoint (`enable_private_endpoint = false`) so you can run `kubectl` from your laptop.

---

### `database.tf` — Cloud SQL + secrets

**Random passwords:**

```hcl
resource "random_password" "db_password" {
  length  = 32
  special = false
}
```

OpenTofu generates a random 32-character password at apply time. You never have to invent or remember it.

**Secret Manager:** The generated passwords are stored in GCP Secret Manager — GCP's equivalent of a password vault. They never appear in plain text in a ConfigMap or environment variable that anyone could read.

```
random_password → Secret Manager secret → Kubernetes Secret → pod env var
```

**Cloud SQL instance:**

```hcl
resource "google_sql_database_instance" "main" {
  database_version = "POSTGRES_15"
  depends_on = [google_service_networking_connection.private_service]
  settings {
    ip_configuration {
      ipv4_enabled    = false      # no public IP at all
      private_network = ...        # only reachable inside the VPC
    }
  }
}
```

`depends_on` tells OpenTofu: "don't create the database until the VPC peering link exists." OpenTofu figures out most ordering automatically from references, but here there's no direct reference — just a requirement — so we state it explicitly.

---

### `registry.tf` — Container image storage

```hcl
resource "google_artifact_registry_repository" "taskboard" {
  format = "DOCKER"
}
```

Artifact Registry is GCP's private Docker Hub. When CI/CD builds your service images, it pushes them here. GKE pulls them from here. No image ever leaves your GCP project.

---

### `iam.tf` — Who can do what

IAM = Identity and Access Management. This file answers: "which identities are allowed to do which actions?"

**The problem it solves:** GitHub Actions needs to push Docker images and deploy to GKE. The naive solution is to create a service account key (a JSON file with credentials) and paste it into GitHub Secrets. The problem: that key never expires, is easy to leak, and is hard to rotate.

**Workload Identity Federation (WIF)** solves this without any keys:

```
GitHub Actions job runs
  → GitHub issues a short-lived OIDC token (a signed JWT proving "I am this repo")
  → WIF verifies the token with GitHub's public keys
  → WIF exchanges it for a short-lived GCP access token
  → GitHub Actions uses that token to push images / deploy
```

The token lasts only minutes and is tied to a specific repository:

```hcl
attribute_condition = "attribute.repository == \"${var.github_repo}\""
```

This means even if someone got the WIF provider ID, they couldn't use it from a different GitHub repository.

**Service account permissions (least privilege):**

```hcl
roles/artifactregistry.writer   # push images — nothing else
roles/container.developer       # deploy to GKE — nothing else
```

No `roles/editor`, no `roles/owner`. The deployer can only do exactly what it needs.

---

### `kubernetes.tf` — What runs inside the cluster

This file uses the `kubernetes` provider to create objects inside the GKE cluster that `gke.tf` provisioned. It's the bridge between "cloud infrastructure" and "app configuration."

**Namespace:** A logical grouping inside the cluster. All taskboard objects live in the `taskboard` namespace, isolated from any other workloads.

**ConfigMap:** Non-secret configuration key-value pairs mounted into pods as environment variables.

```hcl
DB_HOST = google_sql_database_instance.main.private_ip_address
```

Notice the reference: OpenTofu reads the Cloud SQL private IP from the database resource and writes it directly into the ConfigMap. You never have to copy-paste it.

**Secrets:** Like ConfigMap but base64-encoded and access-controlled. The DB password and JWT signing key are read from Secret Manager and written into Kubernetes Secrets:

```
Secret Manager → data source → kubernetes_secret → pod env var
```

**Deployments:** Tell Kubernetes "run 1 replica of this container image." Each deployment has:
- `liveness_probe`: if this fails, Kubernetes restarts the pod
- `readiness_probe`: if this fails, Kubernetes stops sending traffic to the pod until it recovers

**Services:** A stable internal DNS name and IP for a set of pods. Pods come and go (restarts, updates), but the Service IP stays the same. Other pods use the Service name, not the pod IP:

```
tasks-service pod  →  http://users-service:8080  →  users-service Service  →  users-service pod
```

**Ingress:** The single external entry point. A GCP load balancer is provisioned automatically and gets a public IP. All traffic enters through the Ingress, which routes to the frontend Service.

```
Internet → [GCP Load Balancer] → Ingress → frontend Service → frontend pod
                                              ↓
                                   frontend proxies /api/* to api-gateway Service
```

---

### `outputs.tf` — Values you need after apply

After `tofu apply` finishes, these values are printed and saved in state:

| Output | Why you need it |
|---|---|
| `cluster_name` | To run `kubectl` against the cluster |
| `artifact_registry_url` | Image prefix for docker push / CI |
| `wif_provider` | Paste into GitHub Actions variables |
| `deployer_sa_email` | Paste into GitHub Actions variables |
| `load_balancer_ip` | The public IP to access the app |

Run `tofu output` at any time to see them again.

---

## The dependency chain

OpenTofu builds a dependency graph and provisions resources in the right order:

```
network.tf
  ├── VPC
  └── Subnet
       └── Private Service Access (peering)
            └── database.tf
                 ├── Secret Manager (passwords)
                 └── Cloud SQL
                      └── kubernetes.tf
                           └── ConfigMap (DB_HOST = Cloud SQL IP)

gke.tf
  └── GKE cluster (uses VPC + Subnet)
       └── kubernetes.tf (all K8s objects — cluster must exist first)

registry.tf
  └── Artifact Registry (independent, no deps)

iam.tf
  └── WIF Pool + Provider + Service Account (independent)
```

Everything in `kubernetes.tf` implicitly depends on the GKE cluster because the `kubernetes` provider itself is configured with the cluster's endpoint — OpenTofu can't create any Kubernetes objects until that cluster exists.

---

## Why not just use `kubectl apply` for everything?

You could write raw Kubernetes YAML and apply it manually. OpenTofu's value is:

1. **It manages GCP resources too** — `kubectl` only knows Kubernetes, not Cloud SQL or Artifact Registry.
2. **State tracking** — OpenTofu knows what it created and can update or delete it precisely.
3. **Cross-resource references** — the Cloud SQL private IP flows automatically into the ConfigMap; you don't copy-paste it.
4. **Repeatable** — a second `tofu apply` on a clean GCP project produces the identical environment.

---

## Making changes after apply

No, you do not destroy and recreate everything. This is one of the main benefits of IaC.

**The workflow is always the same:**
1. Edit the `.tf` file
2. `tofu plan` — review what will change
3. `tofu apply` — apply only the delta

OpenTofu compares the `.tf` files against the state file and figures out the minimum set of changes. Most changes are in-place updates. For example:

| Change you make | What OpenTofu does |
|---|---|
| Increase `replicas` from 1 to 2 in a Deployment | Updates that one field in the existing Deployment |
| Add a new environment variable to a ConfigMap | Updates the ConfigMap, then restarts affected pods |
| Change the Cloud SQL tier from `db-f1-micro` to `db-g1-small` | Updates the instance in place (takes a few minutes) |
| Add a brand new resource block | Creates only that resource |
| Delete a resource block | Destroys only that resource |

**Some changes force a replacement instead of an update.** GCP doesn't allow certain properties to be changed on a live resource — for example, the VPC a Cloud SQL instance is attached to. OpenTofu will warn you in `tofu plan` output:

```
# google_sql_database_instance.main must be replaced
-/+ resource "google_sql_database_instance" "main" {
```

The `-/+` symbol means destroy-then-recreate. `tofu plan` always tells you before it happens — read the plan carefully before typing `yes`.

**The golden rule:** if `tofu plan` says `0 to add, 0 to change, 0 to destroy`, your infrastructure already matches the code. Nothing will happen when you apply.

---

## Shutting down to save money

`tofu destroy` deletes everything, but then you'd have to `tofu apply` the whole stack again (15+ minutes, and you lose your database data). There's a smarter approach.

### What actually costs money while idle?

| Resource | Cost when idle | Notes |
|---|---|---|
| GKE Autopilot | ~$0 if no pods are running | Autopilot charges per pod, not per node |
| Cloud SQL (`db-f1-micro`) | ~$7–10/month | Charges even when idle — this is the main cost |
| Artifact Registry | ~$0 | Cents per GB stored |
| Load Balancer | ~$18/month | Forwarding rule charges by the hour |
| VPC, Subnets, IAM | $0 | Free |

### Option 1: Scale pods to zero (cheapest, keeps everything else)

```bash
kubectl scale deployment users-service tasks-service api-gateway frontend \
  --replicas=0 -n taskboard
```

GKE Autopilot stops charging immediately when there are no pods. The cluster control plane itself has no extra cost in Autopilot. Scale back up when you need it:

```bash
kubectl scale deployment users-service tasks-service api-gateway frontend \
  --replicas=1 -n taskboard
```

This takes about 30 seconds. **Your database and all data are untouched.**

### Option 2: Delete only the expensive resources via Tofu

You can use `-target` to destroy specific resources without touching the rest:

```bash
# Destroy just the Cloud SQL instance (saves ~$10/month)
tofu destroy -target=google_sql_database_instance.main

# Destroy just the Kubernetes Ingress (removes the load balancer, saves ~$18/month)
tofu destroy -target=kubernetes_ingress_v1.frontend
```

When you want them back:
```bash
tofu apply -target=google_sql_database_instance.main
tofu apply -target=kubernetes_ingress_v1.frontend
```

> **Warning:** destroying Cloud SQL deletes all data. Only do this if you have a backup or the data doesn't matter yet.

### Option 3: Full destroy and full recreate

Only do this if you're done for a long period and don't care about the data.

```bash
tofu destroy    # deletes everything — prompts for confirmation
```

Later:
```bash
tofu apply      # recreates everything from scratch (~15 min)
```

### Recommended approach for development

Scale pods to zero (Option 1) when you finish a session. That eliminates GKE charges immediately. The Cloud SQL `db-f1-micro` costs about $7–10/month regardless — that's the baseline you pay for persistent storage between sessions. Delete the Ingress too if you're not sharing the app with anyone.
