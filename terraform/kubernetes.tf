locals {
  registry = "${var.region}-docker.pkg.dev/${var.project_id}/taskboard"
  # Images are set to :bootstrap initially; CI/CD replaces them with git-SHA tags.
  bootstrap_tag = "bootstrap"
}

data "google_secret_manager_secret_version" "db_password" {
  secret     = google_secret_manager_secret.db_password.secret_id
  version    = "latest"
  depends_on = [google_secret_manager_secret_version.db_password]
}

data "google_secret_manager_secret_version" "jwt_signing_key" {
  secret     = google_secret_manager_secret.jwt_signing_key.secret_id
  version    = "latest"
  depends_on = [google_secret_manager_secret_version.jwt_signing_key]
}

resource "kubernetes_namespace" "taskboard" {
  metadata {
    name = "taskboard"
  }
}

resource "kubernetes_secret" "db_credentials" {
  metadata {
    name      = "db-credentials"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  data = {
    password = data.google_secret_manager_secret_version.db_password.secret_data
  }
}

resource "kubernetes_secret" "jwt_signing_key" {
  metadata {
    name      = "jwt-signing-key"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  data = {
    key = data.google_secret_manager_secret_version.jwt_signing_key.secret_data
  }
}

resource "kubernetes_config_map" "app_config" {
  metadata {
    name      = "app-config"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  data = {
    DB_HOST           = google_sql_database_instance.main.private_ip_address
    DB_PORT           = "5432"
    DB_NAME           = "taskboard"
    DB_USER           = "app"
    USERS_SERVICE_URL = "http://users-service.taskboard.svc.cluster.local:8080"
    TASKS_SERVICE_URL = "http://tasks-service.taskboard.svc.cluster.local:8080"
  }
}

resource "kubernetes_deployment" "users_service" {
  metadata {
    name      = "users-service"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = "users-service" }
    }
    template {
      metadata {
        labels = { app = "users-service" }
      }
      spec {
        container {
          name  = "users-service"
          image = "${local.registry}/users-service:${local.bootstrap_tag}"
          port {
            container_port = 8080
          }
          env_from {
            config_map_ref {
              name = kubernetes_config_map.app_config.metadata[0].name
            }
          }
          env {
            name = "DB_PASSWORD"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.db_credentials.metadata[0].name
                key  = "password"
              }
            }
          }
          env {
            name = "JWT_SIGNING_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.jwt_signing_key.metadata[0].name
                key  = "key"
              }
            }
          }
          liveness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }
          readiness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            initial_delay_seconds = 5
            period_seconds        = 5
          }
        }
      }
    }
  }
}

resource "kubernetes_deployment" "tasks_service" {
  metadata {
    name      = "tasks-service"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = "tasks-service" }
    }
    template {
      metadata {
        labels = { app = "tasks-service" }
      }
      spec {
        container {
          name  = "tasks-service"
          image = "${local.registry}/tasks-service:${local.bootstrap_tag}"
          port {
            container_port = 8080
          }
          env_from {
            config_map_ref {
              name = kubernetes_config_map.app_config.metadata[0].name
            }
          }
          env {
            name = "DB_PASSWORD"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.db_credentials.metadata[0].name
                key  = "password"
              }
            }
          }
          liveness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }
          readiness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            initial_delay_seconds = 5
            period_seconds        = 5
          }
        }
      }
    }
  }
}

resource "kubernetes_deployment" "api_gateway" {
  metadata {
    name      = "api-gateway"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = "api-gateway" }
    }
    template {
      metadata {
        labels = { app = "api-gateway" }
      }
      spec {
        container {
          name  = "api-gateway"
          image = "${local.registry}/api-gateway:${local.bootstrap_tag}"
          port {
            container_port = 8080
          }
          env_from {
            config_map_ref {
              name = kubernetes_config_map.app_config.metadata[0].name
            }
          }
          env {
            name = "JWT_SIGNING_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.jwt_signing_key.metadata[0].name
                key  = "key"
              }
            }
          }
          liveness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }
          readiness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            initial_delay_seconds = 5
            period_seconds        = 5
          }
        }
      }
    }
  }
}

resource "kubernetes_deployment" "frontend" {
  metadata {
    name      = "frontend"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  spec {
    replicas = 1
    selector {
      match_labels = { app = "frontend" }
    }
    template {
      metadata {
        labels = { app = "frontend" }
      }
      spec {
        container {
          name  = "frontend"
          image = "${local.registry}/frontend:${local.bootstrap_tag}"
          port {
            container_port = 80
          }
          liveness_probe {
            http_get {
              path = "/"
              port = 80
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "users_service" {
  metadata {
    name      = "users-service"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  spec {
    selector = { app = "users-service" }
    port {
      port        = 8080
      target_port = 8080
    }
    type = "ClusterIP"
  }
}

resource "kubernetes_service" "tasks_service" {
  metadata {
    name      = "tasks-service"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  spec {
    selector = { app = "tasks-service" }
    port {
      port        = 8080
      target_port = 8080
    }
    type = "ClusterIP"
  }
}

resource "kubernetes_service" "api_gateway" {
  metadata {
    name      = "api-gateway"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  spec {
    selector = { app = "api-gateway" }
    port {
      port        = 8080
      target_port = 8080
    }
    type = "ClusterIP"
  }
}

resource "kubernetes_service" "frontend" {
  metadata {
    name      = "frontend"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  spec {
    selector = { app = "frontend" }
    port {
      port        = 80
      target_port = 80
    }
    type = "NodePort"
  }
}

resource "kubernetes_ingress_v1" "frontend" {
  metadata {
    name      = "taskboard-ingress"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
    annotations = {
      "kubernetes.io/ingress.class" = "gce"
    }
  }
  spec {
    default_backend {
      service {
        name = kubernetes_service.frontend.metadata[0].name
        port {
          number = 80
        }
      }
    }
  }
}
