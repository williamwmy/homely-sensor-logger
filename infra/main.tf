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
