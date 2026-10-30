variable "name" {
  description = "Base name for all resources"
  type        = string
  default     = "memories-bot"
}

variable "aws_region" {
  type    = string
  default = "us-east-2"
}

# --- Discord ---------------------------------------------------------------

variable "discord_token" {
  description = "Bot token (Developer Portal > Bot)"
  type        = string
  sensitive   = true
}

variable "discord_client_id" {
  description = "Application ID (Developer Portal > General Information)"
  type        = string
}

variable "discord_public_key" {
  description = "Public key used to verify interaction signatures (Developer Portal > General Information)"
  type        = string
}

variable "guild_id" {
  type = string
}

variable "scan_channel_ids" {
  description = "Channels to scan for images"
  type        = list(string)
}

variable "memories_channel_id" {
  type = string
}

# --- Behaviour -------------------------------------------------------------

variable "timezone" {
  description = "IANA timezone for 'on this day' matching and the repost schedule"
  type        = string
  default     = "America/New_York"
}

variable "repost_cron" {
  description = "EventBridge cron for reposting (6 fields). Default: daily at 10:00"
  type        = string
  default     = "cron(0 10 * * ? *)"
}

variable "poll_rate" {
  description = "How often to scan channels for new images"
  type        = string
  default     = "rate(15 minutes)"
}

variable "repost_cooldown_days" {
  type    = number
  default = 90
}

variable "min_age_days" {
  type    = number
  default = 30
}

variable "log_retention_days" {
  type    = number
  default = 14
}
