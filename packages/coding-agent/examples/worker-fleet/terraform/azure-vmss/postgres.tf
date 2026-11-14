# The shared database: an Azure Database for PostgreSQL Flexible Server on a private subnet, which the workers reach
# through the VNet. Set `postgres = false` to keep the database URL in `var.database` (libSQL / Turso) instead.
#
# The password goes to a Key Vault secret (in a vault that uses Azure RBAC), which the scale set's managed identity
# may read. Set `token_command` to read it, e.g. `az login --identity >/dev/null && az keyvault secret show --vault-name <vault>
# --name atomic-postgres-password --query value -o tsv`.
variable "postgres" {
  type        = bool
  default     = true
  description = "Create the Flexible Server and point the workers at it"
}
variable "postgres_server_name" {
  default     = "atomic-pool"
  description = "Globally unique; the server's host name is <name>.postgres.database.azure.com"
}
variable "postgres_subnet_id" {
  default     = null
  description = "A subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers, in the workers' VNet"
}
variable "postgres_private_dns_zone_id" {
  default     = null
  description = "A privatelink.postgres.database.azure.com zone linked to the workers' VNet"
}
variable "key_vault_id" {
  default     = null
  description = "The Key Vault that holds the database password"
}

resource "random_password" "postgres" {
  count   = var.postgres ? 1 : 0
  length  = 40
  special = false
}

resource "azurerm_postgresql_flexible_server" "pool" {
  count               = var.postgres ? 1 : 0
  name                = var.postgres_server_name
  resource_group_name = var.resource_group
  location            = var.location
  version             = "16"
  # General Purpose: about 850 connections. Size it for hosts × (slots + 2) with room to spare.
  sku_name                      = "GP_Standard_D2ds_v5"
  storage_mb                    = 65536
  backup_retention_days         = 7
  delegated_subnet_id           = var.postgres_subnet_id
  private_dns_zone_id           = var.postgres_private_dns_zone_id
  public_network_access_enabled = false
  administrator_login           = "atomic"
  administrator_password        = random_password.postgres[0].result

  # Azure picks the zone; a later plan must not move the server.
  lifecycle { ignore_changes = [zone] }
}

resource "azurerm_postgresql_flexible_server_database" "atomic" {
  count     = var.postgres ? 1 : 0
  name      = "atomic"
  server_id = azurerm_postgresql_flexible_server.pool[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_key_vault_secret" "postgres" {
  count        = var.postgres ? 1 : 0
  name         = "atomic-postgres-password"
  value        = random_password.postgres[0].result
  key_vault_id = var.key_vault_id
}

resource "azurerm_role_assignment" "workers_password" {
  count                = var.postgres ? 1 : 0
  scope                = azurerm_key_vault_secret.postgres[0].resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_linux_virtual_machine_scale_set.workers.identity[0].principal_id
}

locals {
  # Azure's server certificates chain to public roots, so verify-full needs no CA file.
  database = var.postgres ? "postgresql://atomic@${azurerm_postgresql_flexible_server.pool[0].fqdn}:5432/atomic?sslmode=verify-full" : var.database
}

output "database" {
  value       = local.database
  description = "The URL to join: `atomic storage join <url> --password-file <file holding the Key Vault secret>`"
}
