# A Google Cloud managed instance group of Spot VMs that boot into `atomic worker start` (#4768), at size 0, and a
# custom role for the controller's service account. Drive it with presets/gcp-mig.json.
#
# No service account key exists anywhere: the VMs read the database token from Secret Manager as their attached
# service account, and the controller runs as its own service account, attached to its VM, impersonated by a GKE
# Kubernetes ServiceAccount through Workload Identity Federation, or by GitHub Actions OIDC through
# google-github-actions/auth.
terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

variable "project" {}
variable "zone" { default = "us-central1-a" }
variable "network" { default = "default" }
variable "database" { default = "libsql://pool.example.turso.io" }
variable "token_secret" { default = "atomic-db-token" }
variable "token_command" {
  default     = null
  description = "Overrides how a VM prints the database token. Default: `gcloud secrets versions access` as the VM's service account"
}
variable "controller_member" {
  default     = null
  description = "Another identity for the controller, e.g. serviceAccount:fleet@PROJECT.iam.gserviceaccount.com. Default: the service account below"
}
variable "controller_gke_service_account" {
  default     = null
  description = "`<namespace>/<name>` of a GKE Kubernetes ServiceAccount that runs the controller through Workload Identity Federation"
}

locals {
  # gcloud ships in Google's Ubuntu images; it uses the VM's attached service account.
  token_command = coalesce(var.token_command, "gcloud secrets versions access latest --secret=${var.token_secret} --project=${var.project}")
}

# The VMs' identity: it reads the database token and nothing else.
resource "google_service_account" "workers" {
  project      = var.project
  account_id   = "atomic-workers"
  display_name = "Atomic worker hosts"
}

resource "google_secret_manager_secret_iam_member" "workers_token" {
  project   = var.project
  secret_id = var.token_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.workers.member
}

# The controller's identity.
resource "google_service_account" "controller" {
  project      = var.project
  account_id   = "atomic-worker-controller"
  display_name = "Atomic worker fleet controller"
}

resource "google_service_account_iam_member" "controller_gke" {
  count              = var.controller_gke_service_account == null ? 0 : 1
  service_account_id = google_service_account.controller.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project}.svc.id.goog[${coalesce(var.controller_gke_service_account, "-/-")}]"
}

resource "google_compute_instance_template" "workers" {
  name_prefix  = "atomic-workers-"
  project      = var.project
  machine_type = "n2-standard-4"
  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    instance_termination_action = "DELETE"
  }
  disk {
    source_image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
    boot         = true
  }
  network_interface {
    network = var.network
  }
  service_account {
    email  = google_service_account.workers.email
    scopes = ["cloud-platform"]
  }
  metadata = {
    user-data = templatefile("${path.module}/../cloud-init.yaml.tftpl", {
      database = var.database
      slots    = 4
      # The instance name, which the group's delete-instances takes.
      provider_id_command = "curl -s -H Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/name"
      token_command       = local.token_command
    })
  }
  lifecycle { create_before_destroy = true }
}

resource "google_compute_instance_group_manager" "workers" {
  name               = "atomic-workers"
  project            = var.project
  zone               = var.zone
  base_instance_name = "atomic-workers"
  target_size        = 0
  version {
    instance_template = google_compute_instance_template.workers.id
  }
  # The controller owns the size.
  lifecycle { ignore_changes = [target_size] }
}

resource "google_project_iam_custom_role" "fleet" {
  project     = var.project
  role_id     = "atomicWorkerFleet"
  title       = "Atomic worker fleet"
  permissions = ["compute.instanceGroupManagers.get", "compute.instanceGroupManagers.update", "compute.instances.delete"]
}

resource "google_project_iam_member" "controller" {
  project = var.project
  role    = google_project_iam_custom_role.fleet.id
  member  = coalesce(var.controller_member, google_service_account.controller.member)
  # Only this group.
  condition {
    title      = "atomic-workers only"
    expression = "resource.name == \"projects/${var.project}/zones/${var.zone}/instanceGroupManagers/atomic-workers\" || resource.name.matches(\"^projects/${var.project}/zones/${var.zone}/instances/atomic-workers-[a-z0-9]{4}$\")"
  }
}
