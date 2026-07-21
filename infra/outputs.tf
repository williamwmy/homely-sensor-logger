output "public_ip" {
  description = "Offentlig IP til VM-en."
  value       = azurerm_public_ip.main.ip_address
}

output "ssh_command" {
  description = "Ferdig SSH-kommando (via Tailscale — port 22 er stengt offentlig)."
  value       = "ssh ${var.admin_username}@homely-logger-vm"
}

output "backup_storage_account_name" {
  description = "Privat Storage Account som mottar daglige databasebackuper."
  value       = azurerm_storage_account.backups.name
}
