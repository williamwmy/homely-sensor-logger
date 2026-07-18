output "public_ip" {
  description = "Offentlig IP til VM-en."
  value       = azurerm_public_ip.main.ip_address
}

output "ssh_command" {
  description = "Ferdig SSH-kommando."
  value       = "ssh ${var.admin_username}@${azurerm_public_ip.main.ip_address}"
}
