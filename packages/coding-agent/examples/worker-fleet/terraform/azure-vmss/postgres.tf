# The shared database: an Azure Database for PostgreSQL flexible server on a private subnet, which the workers reach
# through the VNet. Set `postgres = false` to keep the database URL in `var.database` (libSQL / Turso) instead.
#
# The password goes to the Key Vault secret `var.token_secret_name`, which the scale set's managed identity reads as it
# reads a libSQL token. Azure's server certificates chain to public roots, so verify-full needs no CA file.
variable "postgres" {
  type        = bool
  default     = true
  description = "Create the flexible server and point the workers at it"
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
  # Each host can open up to 8 × (slots + 2) connections: size max_connections for the fleet, or enable the built-in
  # PgBouncer and connect to port 6432.
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
  name         = var.token_secret_name
  value        = random_password.postgres[0].result
  key_vault_id = var.key_vault_id
}

locals {
  database = var.postgres ? "postgresql://atomic@${azurerm_postgresql_flexible_server.pool[0].fqdn}:5432/atomic" : var.database
}

output "database" {
  value       = local.database
  description = "The URL to join: `atomic storage join '<url>' --password-file <file holding the Key Vault secret>`"
}
