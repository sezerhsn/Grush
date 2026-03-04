terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "vpc" {
  source = "../modules"
  name   = "grush-dev"
  env    = "dev"
  aws_region = var.aws_region
}

# Placeholder: env seviyesinde modül çağrıları burada büyütülür.
# Örn: module "rds" { ... }, module "ecs" { ... }, module "waf" { ... }