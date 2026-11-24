# KAGURA runner isolation ACL rollback (Windows)
# Requires Administrator. Does NOT create/delete accounts or passwords.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/rollback-runner-isolation.ps1 -Manifest <path-to-manifest.json>
param([Parameter(Mandatory=True)][string])
Continue = "Stop"
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "This script must be run as Administrator."; exit 1
}
if (-not (Test-Path )) { Write-Error "Manifest not found: "; exit 1 }
 = Get-Content -Raw  | ConvertFrom-Json
if (-not .items) { Write-Error "Invalid manifest: missing items"; exit 1 }
 = @()
foreach ( in .items) {
   = [System.IO.Path]::GetFullPath(.path)
   = [System.IO.Path]::GetFullPath(.backupFile)
  if (-not (Test-Path )) {  += "Missing backup for : "; continue }
  Write-Host "Restoring ACL:  <= "
  icacls  /restore  /c | Out-Null
  if ( -ne 0) {  += "icacls restore failed for  (exit )" }
}
if (.Count -gt 0) {  | ForEach-Object { Write-Error  }; exit 1 }
Write-Host "Rollback complete. Review account/group membership separately; this script restores ACL backups only."
