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
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "This script must be run as Administrator."
  exit 1
}

$userName = $env:KAGURA_RUNNER_SANDBOX_USER -or "KAGURA_SANDBOX"
$password = $env:KAGURA_RUNNER_SANDBOX_PASSWORD
if (-not $password) { Write-Error "KAGURA_RUNNER_SANDBOX_PASSWORD is not set."; exit 1 }
$workspaceRoot = $env:KAGURA_RUNNER_WORKSPACE_ROOT -or "C:\KaguraRunner\workspaces"
$repoRoot = $env:KAGURA_RUNNER_REPO_ROOT -or (Get-Location).Path

Write-Host "Creating restricted sandbox account '$userName' ..."

# 1) Create the account as a standard (non-administrator) user.
#    net user /add creates a local account; membership is limited to "Users".
$existing = net user $userName 2>$null
if ($LASTEXITCODE -ne 0) {
  net user $userName $password /add /comment:"KAGURA Kane runner sandbox - restricted standard user" | Out-Null
} elseif ($Force) {
  net user $userName $password /comment:"KAGURA Kane runner sandbox - restricted standard user" | Out-Null
} else {
  Write-Host "Account '$userName' already exists (use -Force to update password)."
}

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

# 4) Dedicated workspace root OUTSIDE the repository; grant the sandbox account
#    full control only there. Jobs never write into the repo.
if (-not (Test-Path $workspaceRoot)) { New-Item -ItemType Directory -Path $workspaceRoot -Force | Out-Null }
icacls $workspaceRoot /grant "$userName:(OI)(CI)F" /inheritance:r | Out-Null
Write-Host "Workspace root granted to $userName: $workspaceRoot"

# 5) Deny the sandbox account access to credential files so a job cannot read
#    runner tokens, GitHub tokens, or database credentials.
$credFiles = @(".env.local", ".env.runner", ".env") | ForEach-Object { Join-Path $repoRoot $_ } | Where-Object { Test-Path $_ }
foreach ($f in $credFiles) {
  icacls $f /deny "$userName:(R)" | Out-Null
  Write-Host "Denied read to $userName: $f"
}

# 6) The sandbox account needs read+execute on node.exe and the kane-cli entry so
#    Kane can launch. Grant read+execute on the repo's node_modules subtree (code
#    is not secret; credentials are handled in step 5). Granting this subtree does
#    not grant write, so jobs cannot modify the application.
$nodeModules = Join-Path $repoRoot "node_modules"
if (Test-Path $nodeModules) {
  icacls $nodeModules /grant "$userName:(OI)(CI)RX" | Out-Null
  Write-Host "Read+execute granted on node_modules to $userName"
}

Write-Host ""
Write-Host "Setup complete. Now configure the runner:"
Write-Host "  set KAGURA_RUNNER_ISOLATION=account"
Write-Host "  set KAGURA_RUNNER_SANDBOX_USER=$userName"
Write-Host "  set KAGURA_RUNNER_SANDBOX_PASSWORD=<the password used above>"
Write-Host "  set KAGURA_RUNNER_WORKSPACE_ROOT=$workspaceRoot"
Write-Host ""
Write-Host "Verification commands:"
Write-Host "  net user $userName"
Write-Host "  net localgroup Administrators $userName"
Write-Host "  icacls $workspaceRoot"
