# A Google Cloud managed instance group of Spot VMs that boot into `atomic worker start` (#4768), at size 0, and a
# custom role for the controller's service account. Drive it with presets/gcp-mig.json.
terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

variable "project" {}
variable "zone" { default = "us-central1-a" }
variable "network" { default = "default" }
variable "database" { default = "libsql://pool.example.turso.io" }
variable "token_command" { description = "Prints the database token, e.g. `gcloud secrets versions access latest --secret=atomic-db-token`" }
variable "controller_member" { description = "The controller's identity, e.g. serviceAccount:fleet@PROJECT.iam.gserviceaccount.com" }

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
  metadata = {
    user-data = templatefile("${path.module}/../cloud-init.yaml.tftpl", {
      database = var.database
      slots    = 4
      # The instance name, which the group's delete-instances takes.
      provider_id_command = "curl -s -H Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/name"
      token_command       = var.token_command
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
  member  = var.controller_member
  # Only this group.
  condition {
    title      = "atomic-workers only"
    expression = "resource.name.startsWith(\"projects/${var.project}/zones/${var.zone}/instanceGroupManagers/atomic-workers\") || resource.name.startsWith(\"projects/${var.project}/zones/${var.zone}/instances/atomic-workers-\")"
  }
}
