terraform {
  required_version = ">= 1.5.0"

  # Remote state i Azure Storage, så staten følger kontoen og ikke maskinen.
  # Storage-kontoen opprettes én gang med ./bootstrap-state.sh før terraform init.
  # Autentiseres via samme az login-sesjon som provideren.
  backend "azurerm" {
    resource_group_name  = "tfstate-rg"
    storage_account_name = "williamwmytfstate"
    container_name       = "tfstate"
    key                  = "homely-logger.tfstate"
  }

  required_providers {
    azurerm = {
      # v3 autentiserer sømløst mot en eksisterende `az login`-sesjon;
      # v4 krever eksplisitt subscription_id og gir ingenting ekstra her.
      source  = "hashicorp/azurerm"
      version = "~> 3.116"
    }
  }
}

provider "azurerm" {
  features {}
}

data "azurerm_client_config" "current" {}

locals {
  # Globalt unikt, stabilt og uten at brukeren må velge et navn manuelt.
  backup_storage_account_name = "homelybackup${substr(md5(lower(data.azurerm_client_config.current.subscription_id)), 0, 10)}"
}

resource "azurerm_resource_group" "main" {
  name     = "homely-logger-rg"
  location = var.location
}

resource "azurerm_virtual_network" "main" {
  name                = "homely-logger-vnet"
  address_space       = ["10.10.0.0/16"]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_subnet" "main" {
  name                 = "homely-logger-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.10.1.0/24"]
}

resource "azurerm_network_security_group" "main" {
  name                = "homely-logger-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  # Ingen åpne porter — SSH går via Tailscale. Tom liste er eksplisitt med
  # vilje: den fjerner også regler lagt til utenfor Terraform, som den
  # midlertidige bootstrap-regelen (se terraform.tfvars.example).
  security_rule = []
}

resource "azurerm_subnet_network_security_group_association" "main" {
  subnet_id                 = azurerm_subnet.main.id
  network_security_group_id = azurerm_network_security_group.main.id
}

resource "azurerm_public_ip" "main" {
  name                = "homely-logger-pip"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "main" {
  name                = "homely-logger-nic"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.main.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.main.id
  }
}

resource "azurerm_linux_virtual_machine" "main" {
  name                  = "homely-logger-vm"
  location              = azurerm_resource_group.main.location
  resource_group_name   = azurerm_resource_group.main.name
  size                  = var.vm_size
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.main.id]

  disable_password_authentication = true

  identity {
    type = "SystemAssigned"
  }

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 32
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml", {
    admin_username = var.admin_username
  }))
}

# Offsite-lagring for daglige pg_dump-filer. Kun VM-ens managed identity får
# skrive fra applikasjonen; offentlig blob-tilgang er deaktivert og ingen
# kontonøkler distribueres til VM-en.
resource "azurerm_storage_account" "backups" {
  name                            = local.backup_storage_account_name
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  public_network_access_enabled   = true
  allow_nested_items_to_be_public = false
}

resource "azurerm_storage_container" "backups" {
  name                  = "backups"
  storage_account_name  = azurerm_storage_account.backups.name
  container_access_type = "private"
}

resource "azurerm_role_assignment" "backup_writer" {
  scope                = azurerm_storage_account.backups.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_virtual_machine.main.identity[0].principal_id
}

resource "azurerm_storage_management_policy" "backups" {
  storage_account_id = azurerm_storage_account.backups.id

  rule {
    name    = "delete-old-database-backups"
    enabled = true
    filters {
      prefix_match = ["backups/database/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = var.backup_retention_days
      }
    }
  }
}
