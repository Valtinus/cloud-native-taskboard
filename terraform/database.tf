# Secret Manager holds the *containers*; values are seeded out-of-band via
# scripts/bootstrap-secrets.sh so nothing sensitive ever lands in tfstate.
resource "google_secret_manager_secret" "db_password" {
  secret_id = "db-password"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "jwt_signing_key" {
  secret_id = "jwt-signing-key"
  replication {
    auto {}
  }
}

resource "google_sql_database_instance" "main" {
  name             = "taskboard-postgres"
  database_version = "POSTGRES_15"
  region           = var.region

  depends_on = [google_service_networking_connection.private_service]

  settings {
    tier = "db-f1-micro"

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
    }

    backup_configuration {
      enabled = true
    }
  }

  deletion_protection = false
}

resource "google_sql_database" "taskboard" {
  name     = "taskboard"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = "app"
  instance = google_sql_database_instance.main.name
  # Bootstrap value only. Real password is set out-of-band via
  # `gcloud sql users set-password` to match Secret Manager.
  password = "bootstrap-replaced-by-gcloud"

  lifecycle {
    ignore_changes = [password]
  }
}
