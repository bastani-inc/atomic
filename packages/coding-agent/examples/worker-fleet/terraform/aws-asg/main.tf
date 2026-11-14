# An AWS Auto Scaling group of Spot instances that boot into `atomic worker start` (#4768), at desired capacity 0, and
# an IAM policy that lets the controller resize this group and terminate its instances only. Drive it with
# presets/aws-asg.json.
#
# No access key exists anywhere: the instances read the database token from Secrets Manager with their instance
# profile, and the controller's role is assumed through the AWS SDK's default credential chain: an instance profile on
# its EC2 instance, EKS Pod Identity (or IRSA) in a pod, or GitHub Actions OIDC through
# aws-actions/configure-aws-credentials.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "subnet_ids" { type = list(string) }
variable "ami_id" { description = "An Ubuntu 24.04 AMI" }
variable "database" { default = "libsql://pool.example.turso.io" }
variable "token_command" {
  default     = null
  description = "Overrides how an instance prints the database token. Default: `aws secretsmanager get-secret-value` with the instance profile"
}
variable "max_hosts" { default = 20 }
variable "token_secret_arn" { description = "The Secrets Manager secret holding the database token" }

locals {
  # The AWS CLI from its snap, then the instance profile through the default credential chain.
  token_command = coalesce(var.token_command, "(command -v aws >/dev/null || snap install aws-cli --classic >/dev/null) && aws secretsmanager get-secret-value --secret-id ${var.token_secret_arn} --query SecretString --output text")
}

# The workers' instance role: it reads the token secret and nothing else.
data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "workers" {
  name               = "atomic-workers"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy" "workers_token" {
  role = aws_iam_role.workers.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = var.token_secret_arn }]
  })
}

resource "aws_iam_instance_profile" "workers" {
  name = "atomic-workers"
  role = aws_iam_role.workers.name
}

resource "aws_launch_template" "workers" {
  name_prefix   = "atomic-workers-"
  image_id      = var.ami_id
  instance_type = "m7i.xlarge"
  iam_instance_profile {
    arn = aws_iam_instance_profile.workers.arn
  }
  metadata_options {
    http_tokens = "required"
  }
  user_data = base64encode(templatefile("${path.module}/../cloud-init.yaml.tftpl", {
    database = var.database
    slots    = 4
    # The instance id, through IMDSv2.
    provider_id_command = "curl -s -H \"X-aws-ec2-metadata-token: $(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)\" http://169.254.169.254/latest/meta-data/instance-id"
    token_command       = local.token_command
  }))
}

resource "aws_autoscaling_group" "workers" {
  name                = "atomic-workers"
  min_size            = 0
  max_size            = var.max_hosts
  desired_capacity    = 0
  vpc_zone_identifier = var.subnet_ids
  mixed_instances_policy {
    instances_distribution {
      on_demand_percentage_above_base_capacity = 0
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.workers.id
        version            = "$Latest"
      }
    }
  }
  # The controller owns the desired capacity.
  lifecycle { ignore_changes = [desired_capacity] }
}

data "aws_iam_policy_document" "controller" {
  statement {
    actions   = ["autoscaling:SetDesiredCapacity", "autoscaling:TerminateInstanceInAutoScalingGroup"]
    resources = [aws_autoscaling_group.workers.arn]
  }
  statement {
    # AWS does not scope Describe actions to a resource.
    actions   = ["autoscaling:DescribeAutoScalingGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "controller" {
  name   = "atomic-worker-fleet"
  policy = data.aws_iam_policy_document.controller.json
}

# The controller's role, for an EC2 instance (its instance profile) or an EKS pod (EKS Pod Identity). For IRSA or
# GitHub Actions OIDC, add your OIDC provider to this trust policy.
data "aws_iam_policy_document" "assume_controller" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "controller" {
  name               = "atomic-worker-controller"
  assume_role_policy = data.aws_iam_policy_document.assume_controller.json
}

resource "aws_iam_role_policy_attachment" "controller" {
  role       = aws_iam_role.controller.name
  policy_arn = aws_iam_policy.controller.arn
}

resource "aws_iam_instance_profile" "controller" {
  name = "atomic-worker-controller"
  role = aws_iam_role.controller.name
}

output "controller_role_arn" {
  description = "For an EKS Pod Identity association, IRSA, or aws-actions/configure-aws-credentials' role-to-assume"
  value       = aws_iam_role.controller.arn
}
