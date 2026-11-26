# KAGURA runner isolation ACL rollback (Windows)
# Requires Administrator. Does NOT create/delete accounts or passwords.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/rollback-runner-isolation.ps1 -Manifest <path-to-manifest.json>
param([Parameter(Mandatory = $true)][string]$Manifest)

$ErrorActionPreference = "Stop"

if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "This script must be run as Administrator."
  exit 1
}

if (-not (Test-Path -LiteralPath $Manifest)) {
  Write-Error "Manifest not found: $Manifest"
  exit 1
}

try {
  $manifest = Get-Content -Raw -LiteralPath $Manifest | ConvertFrom-Json
} catch {
  Write-Error "Manifest is not valid JSON: $($_.Exception.Message)"
  exit 1
}

if (-not $manifest -or -not $manifest.items) {
  Write-Error "Invalid manifest: missing items"
  exit 1
}

$failures = @()
foreach ($item in $manifest.items) {
  $target = [System.IO.Path]::GetFullPath($item.path)
  $backup = [System.IO.Path]::GetFullPath($item.backupFile)
  if (-not (Test-Path -LiteralPath $backup)) {
    $failures += "Missing backup for $target : $backup"
    continue
  }
  Write-Host "Restoring ACL: $target <= $backup"
  & icacls $target /restore $backup /c | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $failures += "icacls restore failed for $target (exit $LASTEXITCODE)"
  }
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  Write-Warning "Rollback incomplete. Review each failure and restore manually; no user files or accounts were deleted."
  exit 1
}

Write-Host "Rollback complete. Review account/group membership separately; this script restores ACL backups only."
Write-Warning "Manual follow-up: this script does not delete the sandbox account or change group membership. Review with Get-LocalUser and net localgroup Administrators."