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
  name   = "grush"
  env    = "prod"
  aws_region = var.aws_region
}

# Prod’de burada:
# - rds (Postgres)
# - ecs (api/indexer/worker)
# - cdn + waf
# - secrets (SSM/Secrets Manager)
# - observability (CloudWatch/OTel)
# çağrıları eklenir.