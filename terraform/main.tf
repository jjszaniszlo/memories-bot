data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  lambda_arn = "arn:aws:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.name}"
}

# --- DynamoDB ----------------------------------------------------------------
# Provisioned mode so it sits inside the Always Free allowance
# (25 RCU / 25 WCU / 25 GB across all tables and indexes in the account).

resource "aws_dynamodb_table" "memories" {
  name         = var.name
  billing_mode = "PROVISIONED"
  hash_key     = "id"

  read_capacity  = 5
  write_capacity = 10

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "month_day"
    type = "S"
  }

  attribute {
    name = "channel_id"
    type = "S"
  }

  attribute {
    name = "posted_at"
    type = "N"
  }

  # Sparse index: only memory items have month_day, cursors don't.
  global_secondary_index {
    name            = "by-month-day"
    projection_type = "ALL"
    key_schema {
      attribute_name = "month_day"
      key_type       = "HASH"
    }
    read_capacity  = 5
    write_capacity = 5
  }

  # Neighbouring posts in the same channel, for reposting a burst together.
  global_secondary_index {
    name            = "by-channel-time"
    hash_key        = "channel_id"
    range_key       = "posted_at"
    projection_type = "ALL"
    read_capacity   = 5
    write_capacity  = 5
  }

  point_in_time_recovery {
    enabled = false
  }
}

# --- Lambda ------------------------------------------------------------------

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../dist"
  output_path = "${path.module}/.build/lambda.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lambda" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }

  statement {
    sid = "DynamoDB"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ]
    resources = [
      aws_dynamodb_table.memories.arn,
      "${aws_dynamodb_table.memories.arn}/index/*",
    ]
  }

  # Deferred slash commands re-invoke this function asynchronously.
  statement {
    sid       = "SelfInvoke"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.lambda_arn]
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${var.name}-lambda"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_lambda_function" "bot" {
  function_name = var.name
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs22.x"
  handler       = "handler.handler"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 900

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      DISCORD_TOKEN        = var.discord_token
      DISCORD_CLIENT_ID    = var.discord_client_id
      DISCORD_PUBLIC_KEY   = var.discord_public_key
      GUILD_ID             = var.guild_id
      SCAN_CHANNEL_IDS     = join(",", var.scan_channel_ids)
      MEMORIES_CHANNEL_ID  = var.memories_channel_id
      TABLE_NAME           = aws_dynamodb_table.memories.name
      BOT_TIMEZONE         = var.timezone
      REPOST_COOLDOWN_DAYS = tostring(var.repost_cooldown_days)
      MIN_AGE_DAYS         = tostring(var.min_age_days)
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.lambda]
}

# Public HTTPS endpoint for Discord to call. Requests are authenticated by
# Discord's Ed25519 signature inside the function, not by AWS IAM.
resource "aws_lambda_function_url" "interactions" {
  function_name      = aws_lambda_function.bot.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "public_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.bot.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# --- Schedules ---------------------------------------------------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.bot.arn]
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${var.name}-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule_group" "bot" {
  name = var.name
}

resource "aws_scheduler_schedule" "poll" {
  name                = "${var.name}-poll"
  group_name          = aws_scheduler_schedule_group.bot.name
  schedule_expression = var.poll_rate

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.bot.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ job = "poll" })
  }
}

resource "aws_scheduler_schedule" "repost" {
  name                         = "${var.name}-repost"
  group_name                   = aws_scheduler_schedule_group.bot.name
  schedule_expression          = var.repost_cron
  schedule_expression_timezone = var.timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.bot.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ job = "repost" })
  }
}

# --- Spend guardrail -----------------------------------------------------------
# Tracks gross usage with credits excluded, so it fires if anything in the
# account would have cost money even while credits are covering it.

resource "aws_budgets_budget" "zero_spend" {
  count = var.billing_alert_email == "" ? 0 : 1

  name         = "${var.name}-zero-spend"
  budget_type  = "COST"
  limit_amount = "1"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit             = false
    include_refund             = false
    include_discount           = true
    include_subscription       = true
    include_tax                = true
    include_support            = true
    include_upfront            = true
    include_recurring          = true
    include_other_subscription = true
    use_amortized              = false
    use_blended                = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 1
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.billing_alert_email]
  }
}
