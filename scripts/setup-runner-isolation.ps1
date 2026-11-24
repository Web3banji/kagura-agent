# KAGURA runner OS-level isolation setup (Windows)
#
# PURPOSE
#   Creates a dedicated, restricted Windows standard user account that Kane/Chrome
#   jobs submitted by ordinary users run under. This is a genuine OS security
#   boundary enforced by the Windows kernel (token + NTFS ACLs), not merely a
#   separate folder on disk.
#
# PREREQUISITES
#   - Windows 10/11 Pro, Enterprise, or Education (Home lacks some local-group /
#     ACL tooling and is not recommended for the runner host).
#   - Run this script as Administrator (creating local users requires elevation).
#   - The KAGURA runner service/process must run under an account that can read
#     KAGURA_RUNNER_SANDBOX_PASSWORD (it is never logged and never passed on a
#     command line).
#
# ENVIRONMENT VARIABLES (set before running, e.g. in .env.runner)
#   KAGURA_RUNNER_SANDBOX_USER      Sandbox account name. Default: KAGURA_SANDBOX
#   KAGURA_RUNNER_SANDBOX_PASSWORD  Password for the sandbox account (required)
#   KAGURA_RUNNER_WORKSPACE_ROOT    Dedicated workspace root OUTSIDE the repo.
#                                   Default: C:\KaguraRunner\workspaces
#   KAGURA_RUNNER_REPO_ROOT         KAGURA application root. Default: %CD%

param([switch]$Force)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -eq "Core") { Write-Warning "PowerShell Core detected; LocalAccounts cmdlets may be unavailable. Use Windows PowerShell 5.1+." }
if (-not (Get-Command Get-LocalUser -ErrorAction SilentlyContinue)) { Write-Error "Get-LocalUser unavailable. Install/enable Microsoft.PowerShell.LocalAccounts (Windows PowerShell 5.1, supported Windows edition)."; exit 1 }
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "This script must be run as Administrator."
  exit 1
}

$userName = if ($env:KAGURA_RUNNER_SANDBOX_USER) { $env:KAGURA_RUNNER_SANDBOX_USER } else { "KAGURA_SANDBOX" }
$password = $env:KAGURA_RUNNER_SANDBOX_PASSWORD
if (-not $password) { Write-Error "KAGURA_RUNNER_SANDBOX_PASSWORD is not set (required; provide via secure operator env, not command line)."; exit 1 }
$workspaceRoot = if ($env:KAGURA_RUNNER_WORKSPACE_ROOT) { $env:KAGURA_RUNNER_WORKSPACE_ROOT } else { "C:\KaguraRunner\workspaces" }
$profilesRoot = if ($env:KAGURA_RUNNER_PROFILE_ROOT) { $env:KAGURA_RUNNER_PROFILE_ROOT } else { "C:\KaguraRunner\profiles" }
$repoRoot = if ($env:KAGURA_RUNNER_REPO_ROOT) { $env:KAGURA_RUNNER_REPO_ROOT } else { (Get-Location).Path }
$aclBackupDir = Join-Path $repoRoot "data\verification\isolation-acl-backups"
$secretFiles = @(".env.local", ".env.runner", ".env", ".env.development.local", ".env.production.local", ".env.test.local") |
  ForEach-Object { Join-Path $repoRoot $_ } | Where-Object { Test-Path $_ }

# Fail closed on unsafe path layout.
$resolvedRepo = [System.IO.Path]::GetFullPath($repoRoot)
$resolvedWs = [System.IO.Path]::GetFullPath($workspaceRoot)
$resolvedPf = [System.IO.Path]::GetFullPath($profilesRoot)
if ($resolvedWs -eq $resolvedRepo -or $resolvedPf -eq $resolvedRepo) { Write-Error "Workspace/profile roots must not equal repo root."; exit 1 }
if ($resolvedWs.StartsWith($resolvedRepo + [System.IO.Path]::DirectorySeparatorChar) -or $resolvedPf.StartsWith($resolvedRepo + [System.IO.Path]::DirectorySeparatorChar)) { Write-Error "Workspace/profile roots must not be inside repo root."; exit 1 }
if ($resolvedRepo.StartsWith($resolvedWs + [System.IO.Path]::DirectorySeparatorChar) -or $resolvedRepo.StartsWith($resolvedPf + [System.IO.Path]::DirectorySeparatorChar)) { Write-Error "Repo root must not be inside workspace/profile roots."; exit 1 }
if ($resolvedWs -eq $resolvedPf) { Write-Error "Workspace and profile roots must differ."; exit 1 }

New-Item -ItemType Directory -Path $aclBackupDir -Force | Out-Null
$backupStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$manifest = [ordered]@{ version = 1; stamp = $backupStamp; backupDir = $aclBackupDir; repoRoot = $resolvedRepo; workspaceRoot = $resolvedWs; profileRoot = $resolvedPf; sandboxUser = $userName; items = @() }
function Add-ManifestItem($name,$path,$backup,$kind) { $script:manifest.items += [ordered]@{ name=$name; path=[System.IO.Path]::GetFullPath($path); backupFile=[System.IO.Path]::GetFullPath($backup); kind=$kind } }
Write-Host "Creating restricted sandbox account '$userName' (host boundary; not per-job/user OS isolation) ..."

# 1) Create the account as a standard (non-administrator) user.
#    Credential safety: never pass password on command line. Use LocalUser APIs where available.
$existing = Get-LocalUser -Name $userName -ErrorAction SilentlyContinue
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
if (-not $existing) {
  New-LocalUser -Name $userName -Password $securePassword -Description "KAGURA Kane runner sandbox - restricted standard user" -PasswordNeverExpires:$true -UserMayNotChangePassword:$true | Out-Null
} elseif ($Force) {
  Set-LocalUser -Name $userName -Password $securePassword -Description "KAGURA Kane runner sandbox - restricted standard user" | Out-Null
} else {
  Write-Host "Account '$userName' already exists (use -Force to update password)."
}
# Clear plaintext variable ASAP (best effort; does not erase prior process memory/history outside script control).
Remove-Variable password -ErrorAction SilentlyContinue

# 2) Guarantee the account is NOT an administrator (genuine OS restriction).
net localgroup Administrators $userName /delete 2>$null | Out-Null
net localgroup Users $userName /add 2>$null | Out-Null

# 3) Verify it is a standard user (not in Administrators).
$members = net localgroup Administrators 2>$null
if ($members -match $userName) {
  Write-Error "$userName is still a member of Administrators; isolation cannot be safe."
  exit 1
}
Write-Host "Confirmed: $userName is NOT an administrator."

# 4) Dedicated workspace/profile roots OUTSIDE the repository; grant the sandbox account
#    full control only there. Jobs never write into the repo.
foreach ($root in @($workspaceRoot, $profilesRoot)) {
  if (-not (Test-Path $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
  $backup = Join-Path $aclBackupDir ("acl-" + $backupStamp + "-" + [IO.Path]::GetFileName($root.TrimEnd('\')) + ".txt")
  icacls $root /save $backup /t /c | Out-Null
  icacls $root /inheritance:e | Out-Null
  icacls $root /grant "$userName:(OI)(CI)F" | Out-Null
  Write-Host "Workspace/profile root granted to $userName: $root (ACL backup: $backup)"
}

# 5) Deny the sandbox account access to credential files so a job cannot read
#    runner tokens, GitHub tokens, or database credentials. Best effort: also protect
#    process env secrets by not exposing them to the sandboxed job process (runner does this).
foreach ($f in $secretFiles) {
  $backup = Join-Path $aclBackupDir ("acl-" + $backupStamp + "-" + [IO.Path]::GetFileName($f) + ".txt")
  icacls $f /save $backup /c | Out-Null
  Add-ManifestItem ([IO.Path]::GetFileName($f)) $f $backup "file"
  icacls $f /deny "$userName:(R)" | Out-Null
  Write-Host "Denied read to $userName: $f (ACL backup: $backup)"
}

# 6) The sandbox account needs read+execute on node.exe and the kane-cli entry so
#    Kane can launch. Grant read+execute on the repo's node_modules subtree (code
#    is not secret; credentials are handled in step 5). Granting this subtree does
#    not grant write, so jobs cannot modify the application.
$nodeModules = Join-Path $repoRoot "node_modules"
if (Test-Path $nodeModules) {
  $backup = Join-Path $aclBackupDir ("acl-" + $backupStamp + "-node_modules.txt")
  icacls $nodeModules /save $backup /t /c | Out-Null
  Add-ManifestItem "node_modules" $nodeModules $backup "directory"
  icacls $nodeModules /grant "$userName:(OI)(CI)RX" | Out-Null
  Write-Host "Read+execute granted on node_modules to $userName (ACL backup: $backup)"
}
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
if ($nodeExe -and (Test-Path $nodeExe)) {
  icacls $nodeExe /grant "$userName:(RX)" | Out-Null
  Write-Host "Read+execute granted on node executable to $userName: $nodeExe"
} else {
  Write-Warning "Node executable not found; verify sandbox can execute Node before enabling isolation."
}

Write-Host ""
Write-Host "Setup complete (HOST boundary only; single sandbox account is not per-job/user OS isolation)."
Write-Host "Configure runner env:"
Write-Host "  KAGURA_RUNNER_ISOLATION=account"
Write-Host "  KAGURA_RUNNER_SANDBOX_USER=$userName"
Write-Host "  KAGURA_RUNNER_SANDBOX_PASSWORD=<secure operator-managed secret; do not pass on command line>"
Write-Host "  KAGURA_RUNNER_WORKSPACE_ROOT=$workspaceRoot"
Write-Host "  KAGURA_RUNNER_PROFILE_ROOT=$profilesRoot"
Write-Host ""
Write-Host "Verification commands:"
Write-Host "  Get-LocalUser $userName"
Write-Host "  net localgroup Administrators $userName"
Write-Host "  icacls $workspaceRoot"
Write-Host "  icacls $profilesRoot"
$manifestPath = Join-Path $aclBackupDir ("manifest-" + $backupStamp + ".json")
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $manifestPath
Write-Host "ACL backup manifest: $manifestPath"
Write-Host "Rollback (operator-reviewed): use scripts/rollback-runner-isolation.ps1 -Manifest $manifestPath"
