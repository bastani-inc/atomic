# An Azure scale set of Spot VMs that boot into `atomic worker start` (#4768), at capacity 0, and a custom role that
# lets the controller's identity scale, read and delete instances of this scale set only. Drive it with
# presets/azure-vmss.json, or scale it on the metrics with your own automation.
#
# No secret is stored anywhere but Key Vault, and no identity has a client secret: the VMs read the database token
# with their system-assigned managed identity, and the controller runs as a user-assigned managed identity, attached to
# its VM (`az login --identity --client-id <controller_client_id>`) or federated with a workload (AKS Workload Identity,
# or GitHub Actions OIDC through azure/login), as Azure recommends over service principal secrets.
terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "azurerm" {
  features {}
}

variable "resource_group" { default = "atomic-rg" }
variable "location" { default = "eastus" }
variable "subnet_id" {}
variable "database" {
  default     = "libsql://pool.example.turso.io"
  description = "The shared database when `postgres` is false"
}
variable "key_vault_id" { description = "The Key Vault (RBAC authorization) holding the database token, or the PostgreSQL password postgres.tf writes" }
variable "token_secret_name" { default = "atomic-db-token" }
variable "token_command" {
  default     = null
  description = "Overrides how a VM prints the database token. Default: `az keyvault secret show` with the VM's managed identity"
}
variable "controller_principal_id" {
  default     = null
  description = "Another identity for `atomic worker controller`. Default: the user-assigned identity below"
}
variable "controller_federation" {
  default     = null
  description = "Federates the controller identity with a workload: an AKS cluster's OIDC issuer URL and `system:serviceaccount:<namespace>:<name>`, or `https://token.actions.githubusercontent.com` and `repo:<owner>/<repo>:environment:<name>`"
  type        = object({ issuer = string, subject = string })
}

locals {
  key_vault_name = element(split("/", var.key_vault_id), length(split("/", var.key_vault_id)) - 1)
  # Microsoft's installer for the Azure CLI, then the VM's managed identity: no credential on the VM.
  token_command = coalesce(var.token_command, "(command -v az >/dev/null || curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash >/dev/null) && az login --identity --allow-no-subscriptions >/dev/null && az keyvault secret show --vault-name ${local.key_vault_name} --name ${var.token_secret_name} --query value --output tsv")
}
variable "ssh_public_key" {}

resource "azurerm_linux_virtual_machine_scale_set" "workers" {
  name                = "atomic-workers"
  resource_group_name = var.resource_group
  location            = var.location
  sku                 = "Standard_D4s_v5"
  instances           = 0
  admin_username      = "azureuser"
  priority            = "Spot"
  eviction_policy     = "Delete"
  upgrade_mode        = "Manual"

  admin_ssh_key {
    username   = "azureuser"
    public_key = var.ssh_public_key
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }
  os_disk {
    storage_account_type = "Standard_LRS"
    caching              = "ReadWrite"
  }
  network_interface {
    name    = "workers"
    primary = true
    ip_configuration {
      name      = "internal"
      primary   = true
      subnet_id = var.subnet_id
    }
  }
  identity { type = "SystemAssigned" }
  custom_data = base64encode(templatefile("${path.module}/../cloud-init.yaml.tftpl", {
    database    = local.database
    database_ca = ""
    slots       = 4
    # The instance id: the end of the VM's name in a Uniform scale set.
    provider_id_command = "curl -s -H Metadata:true 'http://169.254.169.254/metadata/instance/compute/name?api-version=2021-02-01&format=text' | sed 's/.*_//'"
    token_command       = local.token_command
  }))

  # The controller owns the capacity.
  lifecycle { ignore_changes = [instances] }
}

resource "azurerm_role_definition" "fleet" {
  name        = "Atomic worker fleet"
  scope       = azurerm_linux_virtual_machine_scale_set.workers.id
  description = "Scale, read and delete the instances of one scale set."
  permissions {
    actions = [
      "Microsoft.Compute/virtualMachineScaleSets/read",
      "Microsoft.Compute/virtualMachineScaleSets/write",
      "Microsoft.Compute/virtualMachineScaleSets/delete/action",
      "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/read",
      "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/delete",
    ]
  }
  assignable_scopes = [azurerm_linux_virtual_machine_scale_set.workers.id]
}

# The VMs read the database token, and only that secret.
resource "azurerm_role_assignment" "workers_token" {
  scope                = "${var.key_vault_id}/secrets/${var.token_secret_name}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_linux_virtual_machine_scale_set.workers.identity[0].principal_id
  # With `postgres`, the secret is the password postgres.tf writes.
  depends_on = [azurerm_key_vault_secret.postgres]
}

# The controller's managed identity: no secret to store or rotate.
resource "azurerm_user_assigned_identity" "controller" {
  name                = "atomic-worker-controller"
  resource_group_name = var.resource_group
  location            = var.location
}

resource "azurerm_federated_identity_credential" "controller" {
  count               = var.controller_federation == null ? 0 : 1
  name                = "atomic-worker-controller"
  resource_group_name = var.resource_group
  parent_id           = azurerm_user_assigned_identity.controller.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = var.controller_federation.issuer
  subject             = var.controller_federation.subject
}

resource "azurerm_role_assignment" "controller" {
  scope              = azurerm_linux_virtual_machine_scale_set.workers.id
  role_definition_id = azurerm_role_definition.fleet.role_definition_resource_id
  principal_id       = coalesce(var.controller_principal_id, azurerm_user_assigned_identity.controller.principal_id)
}

output "controller_client_id" {
  description = "For `az login --identity --client-id`, azure/login's client-id, or the azure.workload.identity/client-id annotation"
  value       = azurerm_user_assigned_identity.controller.client_id
}
