output "public_ip" {
  description = "Offentlig IP til VM-en."
  value       = azurerm_public_ip.main.ip_address
}

output "ssh_command" {
  description = "Ferdig SSH-kommando (via Tailscale — port 22 er stengt offentlig)."
  value       = "ssh ${var.admin_username}@homely-logger-vm"
}
