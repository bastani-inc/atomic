# The shared database: a Cloud SQL for PostgreSQL instance on a private IP in the workers' network. Set
# `postgres = false` to keep the database URL in `var.database` (libSQL / Turso) instead.
#
# The password goes to a Secret Manager secret, which the workers' service account may read; `token_command` defaults
# to reading it. The workers verify the server against the instance's own CA (sslmode=verify-ca with sslrootcert,
# because a private IP is not in the server certificate's names).

variable "postgres" {
  type        = bool
  default     = true
  description = "Create the Cloud SQL instance and point the workers at it"
}
variable "region" { default = "us-central1" }
variable "postgres_tier" {
  # 2 vCPUs, 7.5 GB: 400 connections by default. Size it for hosts × (slots + 2) with room to spare.
  default = "db-custom-2-7680"
}

data "google_project" "this" {
  project_id = var.project
}

data "google_compute_network" "workers" {
  project = var.project
  name    = var.network
}

# Private services access for the network. Skip these two if the network has it already.
resource "google_compute_global_address" "pool" {
  count         = var.postgres ? 1 : 0
  project       = var.project
  name          = "atomic-pool-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = data.google_compute_network.workers.id
}

resource "google_service_networking_connection" "pool" {
  count                   = var.postgres ? 1 : 0
  network                 = data.google_compute_network.workers.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.pool[0].name]
}

resource "random_password" "postgres" {
  count   = var.postgres ? 1 : 0
  length  = 40
  special = false
}

resource "google_sql_database_instance" "pool" {
  count            = var.postgres ? 1 : 0
  project          = var.project
  name             = "atomic-pool"
  region           = var.region
  database_version = "POSTGRES_16"
  settings {
    tier = var.postgres_tier
    ip_configuration {
      ipv4_enabled    = false
      private_network = data.google_compute_network.workers.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled = true
    }
  }
  depends_on = [google_service_networking_connection.pool]
}

resource "google_sql_database" "atomic" {
  count    = var.postgres ? 1 : 0
  project  = var.project
  name     = "atomic"
  instance = google_sql_database_instance.pool[0].name
}

resource "google_sql_user" "atomic" {
  count    = var.postgres ? 1 : 0
  project  = var.project
  name     = "atomic"
  instance = google_sql_database_instance.pool[0].name
  password = random_password.postgres[0].result
}

resource "google_secret_manager_secret" "postgres" {
  count     = var.postgres ? 1 : 0
  project   = var.project
  secret_id = "atomic-postgres-password"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "postgres" {
  count       = var.postgres ? 1 : 0
  secret      = google_secret_manager_secret.postgres[0].id
  secret_data = random_password.postgres[0].result
}

# The workers run as the project's default compute service account.
resource "google_secret_manager_secret_iam_member" "workers" {
  count     = var.postgres ? 1 : 0
  project   = var.project
  secret_id = google_secret_manager_secret.postgres[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

locals {
  database      = var.postgres ? "postgresql://atomic@${google_sql_database_instance.pool[0].private_ip_address}:5432/atomic?sslmode=verify-ca&sslrootcert=/etc/atomic/database-ca.pem" : var.database
  database_ca   = var.postgres ? google_sql_database_instance.pool[0].server_ca_cert[0].cert : ""
  token_command = coalesce(var.token_command, "gcloud secrets versions access latest --project=${var.project} --secret=atomic-postgres-password")
}

output "database" {
  value       = local.database
  description = "The URL to join: `atomic storage join <url> --password-file <file holding the secret>`"
}
