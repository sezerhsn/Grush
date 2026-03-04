variable "name" { type = string }
variable "env"  { type = string }
variable "aws_region" { type = string }

locals {
  tags = {
    Project = var.name
    Env     = var.env
  }
}

# Minimal VPC skeleton (placeholder)
resource "aws_vpc" "this" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = merge(local.tags, { Name = "${var.name}-vpc" })
}