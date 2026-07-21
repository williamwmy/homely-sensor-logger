variable "location" {
  description = "Azure-region for alle ressurser."
  type        = string
  default     = "norwayeast"
}

variable "ssh_public_key" {
  description = "Offentlig SSH-nøkkel for admin-brukeren (innholdet i f.eks. ~/.ssh/id_ed25519.pub)."
  type        = string
}

variable "admin_username" {
  description = "Brukernavn på VM-en."
  type        = string
  default     = "azureuser"
}

variable "vm_size" {
  description = "VM-størrelse."
  type        = string
  default     = "Standard_B2s"
}

variable "backup_retention_days" {
  description = "Antall dager databasebackuper beholdes i Azure Blob Storage."
  type        = number
  default     = 30

  validation {
    condition     = var.backup_retention_days >= 7
    error_message = "backup_retention_days må være minst 7."
  }
}
