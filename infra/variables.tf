variable "location" {
  description = "Azure-region for alle ressurser."
  type        = string
  default     = "norwayeast"
}

variable "allowed_ssh_cidr" {
  description = "CIDR som får SSH-tilgang til VM-en, f.eks. \"203.0.113.7/32\"."
  type        = string

  validation {
    condition     = can(cidrhost(var.allowed_ssh_cidr, 0))
    error_message = "allowed_ssh_cidr må være gyldig CIDR-notasjon, f.eks. \"203.0.113.7/32\"."
  }
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
