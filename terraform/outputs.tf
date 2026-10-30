output "interactions_endpoint_url" {
  description = "Paste into Discord Developer Portal > General Information > Interactions Endpoint URL"
  value       = aws_lambda_function_url.interactions.function_url
}

output "lambda_function_name" {
  value = aws_lambda_function.bot.function_name
}

output "dynamodb_table" {
  value = aws_dynamodb_table.memories.name
}
