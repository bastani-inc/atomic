# The shared database: an Amazon RDS for PostgreSQL instance in the workers' subnets, reachable from their VPC only.
# Set `postgres = false` to keep the database URL in `var.database` (libSQL / Turso) and the token in
# `var.token_secret_arn` instead.
#
# The password goes to a Secrets Manager secret, which the workers' instance role may read; `token_command` defaults to
# reading it. The workers verify the server against the region's RDS certificate bundle (sslrootcert).

variable "postgres" {
  type        = bool
  default     = true
  description = "Create the RDS instance and point the workers at it"
}
variable "postgres_instance_class" {
  # About 1,700 connections on db.m7g.large. Size it for hosts × (slots + 2) with room to spare.
  default = "db.m7g.large"
}

data "aws_region" "current" {}

data "aws_subnet" "workers" {
  id = var.subnet_ids[0]
}

data "aws_vpc" "workers" {
  id = data.aws_subnet.workers.vpc_id
}

data "http" "rds_ca" {
  url = "https://truststore.pki.rds.amazonaws.com/${data.aws_region.current.name}/${data.aws_region.current.name}-bundle.pem"
}

resource "random_password" "postgres" {
  count   = var.postgres ? 1 : 0
  length  = 40
  special = false
}

# RDS needs subnets in at least two availability zones.
resource "aws_db_subnet_group" "pool" {
  count      = var.postgres ? 1 : 0
  name       = "atomic-pool"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "pool" {
  count       = var.postgres ? 1 : 0
  name        = "atomic-pool"
  description = "PostgreSQL from the workers' VPC"
  vpc_id      = data.aws_vpc.workers.id
  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.workers.cidr_block]
  }
}

resource "aws_db_instance" "pool" {
  count                     = var.postgres ? 1 : 0
  identifier                = "atomic-pool"
  engine                    = "postgres"
  engine_version            = "16"
  instance_class            = var.postgres_instance_class
  allocated_storage         = 50
  storage_encrypted         = true
  db_name                   = "atomic"
  username                  = "atomic"
  password                  = random_password.postgres[0].result
  db_subnet_group_name      = aws_db_subnet_group.pool[0].name
  vpc_security_group_ids    = [aws_security_group.pool[0].id]
  publicly_accessible       = false
  backup_retention_period   = 7
  final_snapshot_identifier = "atomic-pool-final"
}

resource "aws_secretsmanager_secret" "postgres" {
  count = var.postgres ? 1 : 0
  name  = "atomic-postgres-password"
}

resource "aws_secretsmanager_secret_version" "postgres" {
  count         = var.postgres ? 1 : 0
  secret_id     = aws_secretsmanager_secret.postgres[0].id
  secret_string = random_password.postgres[0].result
}

locals {
  database         = var.postgres ? "postgresql://atomic@${aws_db_instance.pool[0].address}:5432/atomic?sslmode=verify-full&sslrootcert=/etc/atomic/database-ca.pem" : var.database
  database_ca      = var.postgres ? data.http.rds_ca.response_body : ""
  token_secret_arn = var.postgres ? aws_secretsmanager_secret.postgres[0].arn : var.token_secret_arn
  token_command    = coalesce(var.token_command, "aws secretsmanager get-secret-value --region ${data.aws_region.current.name} --secret-id ${local.token_secret_arn} --query SecretString --output text")
}

output "database" {
  value       = local.database
  description = "The URL to join: `atomic storage join <url> --password-file <file holding the secret>`"
}
