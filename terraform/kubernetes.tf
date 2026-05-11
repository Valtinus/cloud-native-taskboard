resource "kubernetes_namespace" "taskboard" {
  metadata {
    name = "taskboard"
  }
}

# Self-signed TLS cert for the GCE Ingress.
# The private key is stored in Terraform state — acceptable for a self-signed cert.
# Replace with cert-manager + Let's Encrypt for a real domain.
resource "tls_private_key" "frontend" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "frontend" {
  private_key_pem = tls_private_key.frontend.private_key_pem

  subject {
    common_name  = "taskboard"
    organization = "TaskBoard"
  }

  validity_period_hours = 8760

  allowed_uses = [
    "key_encipherment",
    "digital_signature",
    "server_auth",
  ]
}

resource "kubernetes_secret" "frontend_tls" {
  metadata {
    name      = "frontend-tls"
    namespace = kubernetes_namespace.taskboard.metadata[0].name
  }
  type = "kubernetes.io/tls"
  data = {
    "tls.crt" = tls_self_signed_cert.frontend.cert_pem
    "tls.key" = tls_private_key.frontend.private_key_pem
  }
}

resource "helm_release" "external_secrets" {
  name             = "external-secrets"
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  version          = "0.9.20"
  namespace        = "external-secrets"
  create_namespace = true

  # Annotate the ESO Kubernetes SA so GKE Workload Identity binds it to the GCP SA.
  set {
    name  = "serviceAccount.annotations.iam\\.gke\\.io/gcp-service-account"
    value = google_service_account.eso.email
  }

  depends_on = [google_container_cluster.main]
}
