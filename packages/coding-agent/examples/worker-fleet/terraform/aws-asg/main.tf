# An AWS Auto Scaling group of Spot instances that boot into `atomic worker start` (#4768), at desired capacity 0, and
# an IAM policy that lets the controller resize this group and terminate its instances only. Drive it with
# presets/aws-asg.json.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "subnet_ids" { type = list(string) }
variable "ami_id" { description = "An Ubuntu 24.04 AMI" }
variable "database" { default = "libsql://pool.example.turso.io" }
variable "token_command" { description = "Prints the database token with the instance role, e.g. `aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text` (install the AWS CLI in the image)" }
variable "max_hosts" { default = 20 }
variable "token_secret_arn" { description = "The Secrets Manager secret holding the database token" }

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
    token_command       = var.token_command
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
