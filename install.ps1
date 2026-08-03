# Atomic release archive installer for Windows PowerShell 5.1 and later.
#
# Usage:
#   irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11

param(
    [string]$Ref,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$helpText = @'
Atomic release archive installer for Windows PowerShell 5.1+

Usage:
  install.ps1 [-Ref <tag>] [-Help]

Options:
  -Ref <tag>  Install the exact GitHub release tag. This overrides ATOMIC_VERSION.
  -Help       Show this help and exit.

Environment:
  ATOMIC_VERSION      Exact release tag when -Ref is not supplied.
  ATOMIC_INSTALL_DIR  Installation root.
  ATOMIC_BIN_DIR      Directory containing the atomic.cmd shim.
  GITHUB_TOKEN        Optional GitHub API token (preferred over GH_TOKEN).
  GH_TOKEN            Optional GitHub API token.

Default install directory: $env:LOCALAPPDATA\atomic
Default bin directory: $env:LOCALAPPDATA\atomic\bin (the install directory's bin subdirectory)
'@

if ($Help) {
    Write-Output $helpText
    return
}

function Get-AtomicRedirectTag {
    param([string]$Uri)

    $response = $null
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
    }
    catch {
        if ($null -ne $_.Exception -and $null -ne $_.Exception.Response) {
            $response = $_.Exception.Response
        }
    }

    if ($null -eq $response) {
        return $null
    }

    $location = $null
    try {
        $location = [string]$response.Headers["Location"]
    }
    catch {
        $location = $null
    }

    if ([string]::IsNullOrWhiteSpace($location)) {
        try {
            $location = [string]$response.BaseResponse.ResponseUri.AbsoluteUri
        }
        catch {
            $location = $null
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($location) -and $location -match '/releases/tag/([^/?#]+)') {
        return [Uri]::UnescapeDataString($Matches[1])
    }

    return $null
}

function Invoke-AtomicApiRequest {
    param(
        [string]$Uri,
        [hashtable]$Headers
    )

    try {
        $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing -ErrorAction Stop
        return ($response.Content | ConvertFrom-Json)
    }
    catch {
        throw "Failed to query GitHub release API at ${Uri}: $_"
    }
}

function Invoke-AtomicDownload {
    param(
        [string]$Uri,
        [string]$Destination
    )

    try {
        Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing -ErrorAction Stop | Out-Null
    }
    catch {
        throw "Failed to download ${Uri}: $_"
    }
}

function Test-AtomicPathContains {
    param(
        [AllowNull()][string]$PathValue,
        [string]$Entry
    )

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $false
    }

    $target = [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"')).TrimEnd([char[]]@('\', '/'))
    foreach ($candidate in ($PathValue -split ';')) {
        $normalized = [Environment]::ExpandEnvironmentVariables($candidate.Trim().Trim('"')).TrimEnd([char[]]@('\', '/'))
        if ($normalized -ieq $target) {
            return $true
        }
    }

    return $false
}

function Get-AtomicDirectoryEntry {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    $fullPath = [IO.Path]::GetFullPath($Path)
    $parentPath = [IO.Path]::GetDirectoryName($fullPath)
    $leafName = [IO.Path]::GetFileName($fullPath.TrimEnd([char[]]@('\', '/')))
    if ([string]::IsNullOrWhiteSpace($parentPath) -or -not [IO.Directory]::Exists($parentPath)) {
        return $null
    }

    foreach ($item in (Get-ChildItem -LiteralPath $parentPath -Force)) {
        if ($item.Name -ieq $leafName) {
            return $item
        }
    }

    return $null
}

function Remove-AtomicDirectoryLinkOrTree {
    param([string]$Path)

    $item = Get-AtomicDirectoryEntry $Path
    if ($null -eq $item) {
        return
    }

    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        [IO.Directory]::Delete($item.FullName)
        return
    }

    Remove-Item -LiteralPath $item.FullName -Recurse -Force
}

function Remove-AtomicEmptyDirectory {
    param([string]$Path)

    $item = Get-AtomicDirectoryEntry $Path
    if ($null -eq $item -or -not $item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return
    }

    [IO.Directory]::Delete($item.FullName, $false)
}

$requestedRef = $null
if ($PSBoundParameters.ContainsKey("Ref")) {
    if ([string]::IsNullOrWhiteSpace($Ref)) {
        throw "-Ref requires a non-empty release tag."
    }
    $requestedRef = $Ref
}
elseif (-not [string]::IsNullOrWhiteSpace($env:ATOMIC_VERSION)) {
    $requestedRef = $env:ATOMIC_VERSION
}

$architecture = $env:PROCESSOR_ARCHITEW6432
if ([string]::IsNullOrWhiteSpace($architecture)) {
    $architecture = $env:PROCESSOR_ARCHITECTURE
}
if ([string]::IsNullOrWhiteSpace($architecture)) {
    throw "Unable to determine the Windows processor architecture."
}

switch ($architecture.ToUpperInvariant()) {
    "AMD64" { $assetName = "atomic-windows-x64.zip" }
    "X86_64" { $assetName = "atomic-windows-x64.zip" }
    "ARM64" { $assetName = "atomic-windows-arm64.zip" }
    default { throw "Unsupported Windows processor architecture: $architecture" }
}

$installRoot = $env:ATOMIC_INSTALL_DIR
if ([string]::IsNullOrWhiteSpace($installRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is not set; set ATOMIC_INSTALL_DIR explicitly."
    }
    $installRoot = Join-Path $env:LOCALAPPDATA "atomic"
}
$installRoot = [IO.Path]::GetFullPath($installRoot)

$binDir = $env:ATOMIC_BIN_DIR
if ([string]::IsNullOrWhiteSpace($binDir)) {
    $binDir = Join-Path $installRoot "bin"
}
$binDir = [IO.Path]::GetFullPath($binDir)

$apiHeaders = @{ Accept = "application/vnd.github+json" }
$token = $env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    $token = $env:GH_TOKEN
}
if (-not [string]::IsNullOrWhiteSpace($token)) {
    $apiHeaders["Authorization"] = "Bearer $token"
}

$latestApi = "https://api.github.com/repos/bastani-inc/atomic/releases/latest"
$tagsApiBase = "https://api.github.com/repos/bastani-inc/atomic/releases/tags"
$release = $null
$releaseTag = $null
if ([string]::IsNullOrWhiteSpace($requestedRef)) {
    $redirectTag = Get-AtomicRedirectTag "https://github.com/bastani-inc/atomic/releases/latest"
    if ([string]::IsNullOrWhiteSpace($redirectTag)) {
        $release = Invoke-AtomicApiRequest $latestApi $apiHeaders
    }
    else {
        $releaseTag = $redirectTag
    }
}
else {
    $encodedRequestedRef = [Uri]::EscapeDataString($requestedRef)
    $release = Invoke-AtomicApiRequest "$tagsApiBase/$encodedRequestedRef" $apiHeaders
}

if ([string]::IsNullOrWhiteSpace($releaseTag)) {
    if ($null -eq $release -or $null -eq $release.PSObject.Properties["tag_name"]) {
        throw "GitHub release API response did not include tag_name."
    }
    $releaseTag = [string]$release.tag_name
    if ([string]::IsNullOrWhiteSpace($releaseTag)) {
        throw "GitHub release API returned an empty tag_name."
    }
}

$encodedReleaseTag = [Uri]::EscapeDataString($releaseTag)
$releaseBase = "https://github.com/bastani-inc/atomic/releases/download/$encodedReleaseTag"
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("atomic-install-" + [Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $tempDir $assetName
$checksumsPath = Join-Path $tempDir "SHA256SUMS"
$payloadPath = Join-Path $tempDir "payload"

$versionStagePath = $null
$currentNextPath = $null
$atomicCurrentNextPath = $null
$shimNextPath = $null
$transactionFailed = $false
$installRootCreated = $false
$versionsDirCreated = $false
$binDirCreated = $false

New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath
    Invoke-AtomicDownload "$releaseBase/SHA256SUMS" $checksumsPath

    $checksumAssetRows = @()
    $assetRowPattern = '(^|[ \t])' + [regex]::Escape($assetName) + '[ \t]*$'
    foreach ($line in (Get-Content -LiteralPath $checksumsPath)) {
        if ($line -match $assetRowPattern) {
            $checksumAssetRows += $line
        }
    }
    if ($checksumAssetRows.Count -ne 1) {
        throw "SHA256SUMS must contain exactly one row for $assetName."
    }

    $checksumLine = $checksumAssetRows[0]
    if ($checksumLine -notmatch '^([A-Fa-f0-9]{64}) ([ *])([^\\/\r\n]+)$' -or $Matches[3] -cne $assetName) {
        throw "SHA256SUMS row for $assetName is malformed."
    }
    $expectedChecksum = $Matches[1].ToLowerInvariant()
    $actualChecksum = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualChecksum -ne $expectedChecksum) {
        throw "Checksum verification failed for $assetName (expected $expectedChecksum, got $actualChecksum)."
    }

    New-Item -ItemType Directory -Path $payloadPath | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $payloadPath -Force
    $stagedAtomic = Join-Path $payloadPath "atomic.exe"
    if (-not (Test-Path -LiteralPath $stagedAtomic -PathType Leaf)) {
        throw "Release archive $assetName does not contain atomic.exe at its root."
    }

    & $stagedAtomic "--version"
    $stagedExitCode = $LASTEXITCODE
    if ($stagedExitCode -ne 0) {
        throw "Staged atomic.exe --version failed with exit code $stagedExitCode."
    }

    $versionsDir = Join-Path $installRoot "versions"
    $versionDirectoryName = [Uri]::EscapeDataString($releaseTag)
    $versionPath = Join-Path $versionsDir $versionDirectoryName
    $currentPath = Join-Path $installRoot "current"
    $atomicCurrentPath = Join-Path $binDir "atomic-current"
    $shimPath = Join-Path $binDir "atomic.cmd"
    $transactionId = [Guid]::NewGuid().ToString("N")
    $versionStagePath = Join-Path $versionsDir (".stage-" + $transactionId)
    $versionBackupPath = Join-Path $versionsDir (".backup-" + $transactionId)
    $currentNextPath = Join-Path $installRoot (".current-" + $transactionId)
    $currentBackupPath = Join-Path $installRoot (".current-backup-" + $transactionId)
    $atomicCurrentNextPath = Join-Path $binDir (".atomic-current-" + $transactionId)
    $atomicCurrentBackupPath = Join-Path $binDir (".atomic-current-backup-" + $transactionId)
    $shimNextPath = Join-Path $binDir (".atomic-" + $transactionId + ".cmd")
    $shimBackupPath = Join-Path $binDir (".atomic-backup-" + $transactionId + ".cmd")

    $installRootExisted = Test-Path -LiteralPath $installRoot
    $versionsDirExisted = Test-Path -LiteralPath $versionsDir
    $binDirExisted = Test-Path -LiteralPath $binDir
    $installRootCreated = $false
    $versionsDirCreated = $false
    $binDirCreated = $false
    $oldUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $oldCurrentPath = $env:Path

    $previousVersionMoved = $false
    $versionInstalled = $false
    $previousCurrentMoved = $false
    $currentInstalled = $false
    $previousAtomicCurrentMoved = $false
    $atomicCurrentInstalled = $false
    $previousShimMoved = $false
    $shimInstalled = $false
    $userPathChanged = $false
    $currentPathChanged = $false

    try {
        New-Item -ItemType Directory -Path $versionsDir -Force | Out-Null
        $installRootCreated = -not $installRootExisted -and [IO.Directory]::Exists($installRoot)
        $versionsDirCreated = -not $versionsDirExisted -and [IO.Directory]::Exists($versionsDir)
        New-Item -ItemType Directory -Path $versionStagePath | Out-Null
        foreach ($payloadItem in (Get-ChildItem -LiteralPath $payloadPath -Force)) {
            Copy-Item -LiteralPath $payloadItem.FullName -Destination $versionStagePath -Recurse -Force
        }
        if (Test-Path -LiteralPath $versionPath) {
            Move-Item -LiteralPath $versionPath -Destination $versionBackupPath
            $previousVersionMoved = $true
        }
        Move-Item -LiteralPath $versionStagePath -Destination $versionPath
        $versionStagePath = $null
        $versionInstalled = $true

        New-Item -ItemType Junction -Path $currentNextPath -Target $versionPath | Out-Null
        if ($null -ne (Get-AtomicDirectoryEntry $currentPath)) {
            Move-Item -LiteralPath $currentPath -Destination $currentBackupPath
            $previousCurrentMoved = $true
        }
        Move-Item -LiteralPath $currentNextPath -Destination $currentPath
        $currentNextPath = $null
        $currentInstalled = $true

        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        $binDirCreated = -not $binDirExisted -and [IO.Directory]::Exists($binDir)
        New-Item -ItemType Junction -Path $atomicCurrentNextPath -Target $versionPath | Out-Null
        $shimContent = "@echo off`r`n`"%~dp0atomic-current\atomic.exe`" %*`r`nexit /b %ERRORLEVEL%`r`n"
        Set-Content -LiteralPath $shimNextPath -Value $shimContent -Encoding ASCII -NoNewline

        if ($null -ne (Get-AtomicDirectoryEntry $atomicCurrentPath)) {
            Move-Item -LiteralPath $atomicCurrentPath -Destination $atomicCurrentBackupPath
            $previousAtomicCurrentMoved = $true
        }
        if (Test-Path -LiteralPath $shimPath) {
            Move-Item -LiteralPath $shimPath -Destination $shimBackupPath
            $previousShimMoved = $true
        }
        Move-Item -LiteralPath $atomicCurrentNextPath -Destination $atomicCurrentPath
        $atomicCurrentNextPath = $null
        $atomicCurrentInstalled = $true
        Move-Item -LiteralPath $shimNextPath -Destination $shimPath
        $shimNextPath = $null
        $shimInstalled = $true

        if (-not (Test-AtomicPathContains $oldUserPath $binDir)) {
            $newUserPath = if ([string]::IsNullOrWhiteSpace($oldUserPath)) { $binDir } else { "$oldUserPath;$binDir" }
            [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
            $userPathChanged = $true
        }
        if (-not (Test-AtomicPathContains $env:Path $binDir)) {
            $env:Path = if ([string]::IsNullOrWhiteSpace($env:Path)) { $binDir } else { "$env:Path;$binDir" }
            $currentPathChanged = $true
        }

        $shimCommand = '"' + $shimPath + '" --version'
        & $env:ComSpec /d /c $shimCommand
        $finalExitCode = $LASTEXITCODE
        if ($finalExitCode -ne 0) {
            throw "Installed atomic.cmd --version failed with exit code $finalExitCode."
        }

        if ($previousShimMoved) {
            try {
                Remove-Item -LiteralPath $shimBackupPath -Force
                $previousShimMoved = $false
            }
            catch { Write-Warning "Installed successfully, but could not remove the previous shim backup: $_" }
        }
        if ($previousAtomicCurrentMoved) {
            try {
                Remove-AtomicDirectoryLinkOrTree $atomicCurrentBackupPath
                $previousAtomicCurrentMoved = $false
            }
            catch { Write-Warning "Installed successfully, but could not remove the previous atomic-current backup: $_" }
        }
        if ($previousCurrentMoved) {
            try {
                Remove-AtomicDirectoryLinkOrTree $currentBackupPath
                $previousCurrentMoved = $false
            }
            catch { Write-Warning "Installed successfully, but could not remove the previous current backup: $_" }
        }
        if ($previousVersionMoved) {
            try {
                Remove-Item -LiteralPath $versionBackupPath -Recurse -Force
                $previousVersionMoved = $false
            }
            catch { Write-Warning "Installed successfully, but could not remove the previous version backup: $_" }
        }
    }
    catch {
        $commitError = $_
        $transactionFailed = $true

        if ($currentPathChanged) {
            $env:Path = $oldCurrentPath
        }
        if ($userPathChanged) {
            try {
                [Environment]::SetEnvironmentVariable("Path", $oldUserPath, "User")
            }
            catch {
                Write-Warning "Failed to restore the User PATH after installation failure: $_"
            }
        }

        if ($shimInstalled) {
            Remove-Item -LiteralPath $shimPath -Force -ErrorAction SilentlyContinue
        }
        if ($atomicCurrentInstalled) {
            try { Remove-AtomicDirectoryLinkOrTree $atomicCurrentPath }
            catch { Write-Warning "Failed to remove the unsuccessful atomic-current pointer: $_" }
        }
        if ($previousAtomicCurrentMoved) {
            try { Move-Item -LiteralPath $atomicCurrentBackupPath -Destination $atomicCurrentPath }
            catch { Write-Warning "Failed to restore the previous atomic-current pointer: $_" }
        }
        if ($previousShimMoved) {
            try { Move-Item -LiteralPath $shimBackupPath -Destination $shimPath }
            catch { Write-Warning "Failed to restore the previous atomic.cmd shim: $_" }
        }
        if ($currentInstalled) {
            try { Remove-AtomicDirectoryLinkOrTree $currentPath }
            catch { Write-Warning "Failed to remove the unsuccessful current pointer: $_" }
        }
        if ($versionInstalled) {
            Remove-Item -LiteralPath $versionPath -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($previousVersionMoved) {
            try { Move-Item -LiteralPath $versionBackupPath -Destination $versionPath }
            catch { Write-Warning "Failed to restore the previous version directory: $_" }
        }
        if ($previousCurrentMoved) {
            try { Move-Item -LiteralPath $currentBackupPath -Destination $currentPath }
            catch { Write-Warning "Failed to restore the previous current pointer: $_" }
        }

        throw $commitError
    }

    Write-Output "Atomic $releaseTag installed successfully."
    Write-Output "Shim: $shimPath"
    Write-Output "Restart your terminal so other processes pick up the updated User PATH."
}
finally {
    if ($null -ne $shimNextPath -and (Test-Path -LiteralPath $shimNextPath)) {
        Remove-Item -LiteralPath $shimNextPath -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $atomicCurrentNextPath -and $null -ne (Get-AtomicDirectoryEntry $atomicCurrentNextPath)) {
        try { Remove-AtomicDirectoryLinkOrTree $atomicCurrentNextPath }
        catch { Write-Warning "Failed to remove temporary atomic-current pointer ${atomicCurrentNextPath}: $_" }
    }
    if ($null -ne $currentNextPath -and $null -ne (Get-AtomicDirectoryEntry $currentNextPath)) {
        try { Remove-AtomicDirectoryLinkOrTree $currentNextPath }
        catch { Write-Warning "Failed to remove temporary current pointer ${currentNextPath}: $_" }
    }
    if ($null -ne $versionStagePath -and (Test-Path -LiteralPath $versionStagePath)) {
        Remove-Item -LiteralPath $versionStagePath -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($transactionFailed) {
        if ($binDirCreated) {
            try { Remove-AtomicEmptyDirectory $binDir }
            catch { Write-Warning "Failed to remove the empty bin directory created by the unsuccessful transaction: $_" }
        }
        if ($versionsDirCreated) {
            try { Remove-AtomicEmptyDirectory $versionsDir }
            catch { Write-Warning "Failed to remove the empty versions directory created by the unsuccessful transaction: $_" }
        }
        if ($installRootCreated) {
            try { Remove-AtomicEmptyDirectory $installRoot }
            catch { Write-Warning "Failed to remove the empty install root created by the unsuccessful transaction: $_" }
        }
    }
}
