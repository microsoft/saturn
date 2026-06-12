#!/usr/bin/env pwsh
# Deploy Saturn to Azure Container Apps behind Microsoft Entra ID (Easy Auth).
#
# This is a STARTING SCAFFOLD - review and fill in the parameters, and read the credential prerequisites.
# Easy Auth requires every visitor to sign in with Microsoft and injects the `x-ms-client-principal-name`
# header that Saturn reads (the image sets SATURN_BEHIND_PROXY=true) for per-user identity + owner gating.
#
# Credential prerequisites the running container needs (Saturn shells out to all three):
#   - GitHub Copilot CLI auth (the review model) - provide a token so `copilot` runs headlessly.
#   - Azure DevOps access - grant the Container App's managed identity access to the target ADO org, or
#     supply a PAT-based git credential. Saturn mints ADO tokens via the Azure CLI.
#   - Persistent storage for /root/.saturn (reviews/feedback/totals) via an Azure Files mount.

[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $Acr,           # Azure Container Registry name (e.g. myregistry)
  [Parameter(Mandatory)] [string] $Owner,          # SATURN_OWNER UPN, e.g. you@contoso.com
  [Parameter(Mandatory)] [string] $TenantId,       # Entra tenant to restrict sign-in to
  [Parameter(Mandatory)] [string] $AppClientId,    # Entra app registration (client) id for Easy Auth
  [string] $Location = 'westus3',
  [string] $Environment = 'saturn-env',
  [string] $AppName = 'saturn'
)

$ErrorActionPreference = 'Stop'
$image = "$Acr.azurecr.io/saturn:latest"

# 1. Build + push the image to ACR (uses this directory's Dockerfile).
az acr build --registry $Acr --image saturn:latest .

# 2. Ensure the Container Apps environment exists.
az containerapp env create --name $Environment --resource-group $ResourceGroup --location $Location

# 3. Create the Container App with external ingress on the dashboard port and a system-assigned identity.
#    Also set SATURN_ADO_* and SATURN_FEEDBACK_URL (to the app's https URL + /feedback) here or via a mount.
az containerapp create `
  --name $AppName --resource-group $ResourceGroup --environment $Environment `
  --image $image --target-port 6789 --ingress external --system-assigned `
  --env-vars SATURN_BEHIND_PROXY=true "SATURN_OWNER=$Owner"

# 4. Require Microsoft (Entra) sign-in - this is what gives real per-user identities + owner gating.
az containerapp auth microsoft update `
  --name $AppName --resource-group $ResourceGroup `
  --client-id $AppClientId --tenant-id $TenantId --yes
az containerapp auth update `
  --name $AppName --resource-group $ResourceGroup `
  --unauthenticated-client-action RedirectToLoginPage

Write-Host "Deployed $AppName. Next: grant its managed identity access to your Azure DevOps org, provide the"
Write-Host "Copilot CLI credential, set SATURN_FEEDBACK_URL to the app's https URL + /feedback, and mount Azure Files at /root/.saturn."
