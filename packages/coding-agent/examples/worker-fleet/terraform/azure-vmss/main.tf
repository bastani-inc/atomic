# An Azure scale set of Spot VMs that boot into `atomic worker start` (#4768), at capacity 0, and a custom role that
# lets the controller's identity scale, read and delete instances of this scale set only. Drive it with
# presets/azure-vmss.json, or scale it on the metrics with your own automation.
terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

provider "azurerm" {
  features {}
}

variable "resource_group" { default = "atomic-rg" }
variable "location" { default = "eastus" }
variable "subnet_id" {}
variable "database" { default = "libsql://pool.example.turso.io" }
variable "token_command" { description = "Prints the database token, e.g. an `az keyvault secret show` with the VM's managed identity" }
variable "controller_principal_id" { description = "The identity `atomic worker controller` runs as" }
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
    database = var.database
    slots    = 4
    # The instance id: the end of the VM's name in a Uniform scale set.
    provider_id_command = "curl -s -H Metadata:true 'http://169.254.169.254/metadata/instance/compute/name?api-version=2021-02-01&format=text' | sed 's/.*_//'"
    token_command       = var.token_command
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

resource "azurerm_role_assignment" "controller" {
  scope              = azurerm_linux_virtual_machine_scale_set.workers.id
  role_definition_id = azurerm_role_definition.fleet.role_definition_resource_id
  principal_id       = var.controller_principal_id
}
