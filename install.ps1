# Atomic release archive installer for Windows PowerShell 5.1 and later.
#
# Usage:
#   irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11

& {
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

function Get-AtomicFileSha256 {
    param([string]$Path)

    if ($null -ne (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    }

    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "")
    }
    finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Test-AtomicReleaseTag {
    param([string]$Tag)

    if ([string]::IsNullOrWhiteSpace($Tag)) {
        return $false
    }

    return $Tag -cmatch '^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-alpha\.(?:[1-9][0-9]*))?$'
}

function Get-AtomicRedirectTag {
    param([string]$Uri)

    $response = $null
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -MaximumRedirection 0 -ErrorAction SilentlyContinue
    }
    catch {
        if ($null -ne $_.Exception) {
            try {
                $response = $_.Exception.Response
            }
            catch {
                $response = $null
            }
        }
    }

    if ($null -eq $response) {
        return $null
    }

    $location = $null
    try {
        $location = [string]$response.Headers.Location
    }
    catch {
        $location = $null
    }

    if ([string]::IsNullOrWhiteSpace($location)) {
        try {
            if ($null -ne $response.Headers.PSObject.Methods["TryGetValues"]) {
                $headerValues = $null
                if ($response.Headers.TryGetValues("Location", [ref]$headerValues)) {
                    $values = @($headerValues)
                    if ($values.Count -gt 0) {
                        $location = [string]$values[0]
                    }
                }
            }
        }
        catch {
            $location = $null
        }
    }

    if ([string]::IsNullOrWhiteSpace($location)) {
        try {
            if ($null -ne $response.Headers.PSObject.Methods["GetValues"]) {
                $values = @($response.Headers.GetValues("Location"))
                if ($values.Count -gt 0) {
                    $location = [string]$values[0]
                }
            }
        }
        catch {
            $location = $null
        }
    }

    if ([string]::IsNullOrWhiteSpace($location)) {
        try {
            $location = [string]$response.Headers["Location"]
        }
        catch {
            $location = $null
        }
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

function Get-AtomicShimShadowingExtensions {
    $shadowing = New-Object System.Collections.ArrayList
    $cmdSeen = $false
    $pathExtValue = $env:PATHEXT
    if ([string]::IsNullOrWhiteSpace($pathExtValue)) {
        $pathExtValue = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
    }
    foreach ($pathExtEntry in ($pathExtValue -split ';')) {
        $extension = $pathExtEntry.Trim().Trim('"').Trim()
        if ([string]::IsNullOrWhiteSpace($extension)) {
            continue
        }
        if (-not $extension.StartsWith(".")) {
            $extension = "." + $extension
        }
        $extension = $extension.ToUpperInvariant()
        if ($extension -eq ".CMD") {
            $cmdSeen = $true
            break
        }
        if (-not $shadowing.Contains($extension)) {
            [void]$shadowing.Add($extension)
        }
    }
    if (-not $cmdSeen) {
        throw "PATHEXT does not include .CMD; bare atomic cannot resolve the installed atomic.cmd shim. Add .CMD to PATHEXT and rerun the installer."
    }
    return $shadowing
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

function Remove-AtomicTemporaryDirectory {
    param(
        [string]$Path,
        [int]$RetryLimit,
        [int]$RetryDelayMilliseconds
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Directory]::Exists($Path)) {
        return
    }

    $attempt = 0
    $lastCleanupError = $null
    while ($attempt -lt $RetryLimit) {
        $attempt++

        try {
            $readOnlyCandidates = New-Object System.Collections.ArrayList
            [void]$readOnlyCandidates.Add($Path)
            foreach ($entry in [IO.Directory]::GetFileSystemEntries($Path, "*", [IO.SearchOption]::AllDirectories)) {
                [void]$readOnlyCandidates.Add($entry)
            }
            foreach ($candidate in $readOnlyCandidates) {
                $candidateAttributes = [IO.File]::GetAttributes($candidate)
                if (($candidateAttributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
                    [IO.File]::SetAttributes(
                        $candidate,
                        [IO.FileAttributes]([int]$candidateAttributes -band (-bnot [int][IO.FileAttributes]::ReadOnly)))
                }
            }
        }
        catch {
            $lastCleanupError = $_
        }

        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        }
        catch {
            $lastCleanupError = $_
        }
        if (-not [IO.Directory]::Exists($Path)) {
            return
        }

        try {
            [IO.Directory]::Delete($Path, $true)
        }
        catch {
            $lastCleanupError = $_
        }
        if (-not [IO.Directory]::Exists($Path)) {
            return
        }

        if ($attempt -lt $RetryLimit) {
            Start-Sleep -Milliseconds ($RetryDelayMilliseconds * $attempt)
        }
    }

    $lastCleanupDetail = if ($null -eq $lastCleanupError) {
        "the directory still existed after every verified removal attempt"
    }
    else {
        [string]$lastCleanupError
    }
    throw "Failed to remove the temporary download directory ${Path} after $attempt attempts; last error: $lastCleanupDetail"
}

function Remove-AtomicEmptyDirectory {
    param([string]$Path)

    $item = Get-AtomicDirectoryEntry $Path
    if ($null -eq $item -or -not $item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $false
    }
    if (@(Get-ChildItem -LiteralPath $item.FullName -Force).Count -ne 0) {
        return $false
    }

    [IO.Directory]::Delete($item.FullName, $false)
    return $true
}

function Add-AtomicMissingDirectoryPaths {
    param(
        [System.Collections.ArrayList]$MissingPaths,
        [string]$Path
    )

    $candidate = [IO.Path]::GetFullPath($Path)
    while (-not [string]::IsNullOrWhiteSpace($candidate)) {
        $trimmedCandidate = $candidate.TrimEnd([char[]]@('\', '/'))
        $trimmedRoot = [IO.Path]::GetPathRoot($candidate).TrimEnd([char[]]@('\', '/'))
        if ($trimmedCandidate -ieq $trimmedRoot) {
            break
        }
        if ($null -ne (Get-AtomicDirectoryEntry $candidate)) {
            break
        }

        $alreadyRecorded = $false
        foreach ($recordedPath in $MissingPaths) {
            if ($recordedPath -ieq $candidate) {
                $alreadyRecorded = $true
                break
            }
        }
        if (-not $alreadyRecorded) {
            [void]$MissingPaths.Add($candidate)
        }

        $parentPath = [IO.Path]::GetDirectoryName($trimmedCandidate)
        if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -ieq $candidate) {
            break
        }
        $candidate = $parentPath
    }
}

function Remove-AtomicCreatedEmptyDirectories {
    param([System.Collections.ArrayList]$MissingPaths)

    $orderedPaths = @($MissingPaths | Sort-Object -Property Length -Descending)
    do {
        $removedDirectory = $false
        foreach ($path in $orderedPaths) {
            try {
                if (Remove-AtomicEmptyDirectory $path) {
                    $removedDirectory = $true
                }
            }
            catch {
                Write-Warning "Failed to remove transaction-created empty directory ${path}: $_"
            }
        }
    } while ($removedDirectory)
}

function Invoke-AtomicTransactionRollback {
    param([hashtable]$Transaction)

    if ($null -eq $Transaction -or $Transaction.RollbackCompleted) {
        return
    }

    if ($Transaction.ShimInstallIntended) {
        try {
            $shimItem = Get-AtomicDirectoryEntry $Transaction.ShimPath
            if ($null -eq $shimItem) {
                $Transaction.ShimInstallIntended = $false
            }
            else {
                Remove-Item -LiteralPath $shimItem.FullName -Force
                $Transaction.ShimInstallIntended = $false
            }
        }
        catch { Write-Warning "Failed to remove the unsuccessful atomic.cmd shim: $_" }
    }
    if ($Transaction.ShimBackupIntended) {
        try {
            $shimBackupItem = Get-AtomicDirectoryEntry $Transaction.ShimBackupPath
            $shimDestinationItem = Get-AtomicDirectoryEntry $Transaction.ShimPath
            if ($null -ne $shimBackupItem -and $null -eq $shimDestinationItem) {
                Move-Item -LiteralPath $shimBackupItem.FullName -Destination $Transaction.ShimPath
                $Transaction.ShimBackupIntended = $false
            }
            elseif ($null -eq $shimBackupItem -and $null -ne $shimDestinationItem) {
                $Transaction.ShimBackupIntended = $false
            }
        }
        catch { Write-Warning "Failed to restore the previous atomic.cmd shim: $_" }
    }

    if ($Transaction.AtomicCurrentInstallIntended) {
        try {
            $atomicCurrentItem = Get-AtomicDirectoryEntry $Transaction.AtomicCurrentPath
            if ($null -eq $atomicCurrentItem) {
                $Transaction.AtomicCurrentInstallIntended = $false
            }
            else {
                Remove-AtomicDirectoryLinkOrTree $atomicCurrentItem.FullName
                $Transaction.AtomicCurrentInstallIntended = $false
            }
        }
        catch { Write-Warning "Failed to remove the unsuccessful atomic-current pointer: $_" }
    }
    if ($Transaction.AtomicCurrentBackupIntended) {
        try {
            $atomicCurrentBackupItem = Get-AtomicDirectoryEntry $Transaction.AtomicCurrentBackupPath
            $atomicCurrentDestinationItem = Get-AtomicDirectoryEntry $Transaction.AtomicCurrentPath
            if ($null -ne $atomicCurrentBackupItem -and $null -eq $atomicCurrentDestinationItem) {
                Move-Item -LiteralPath $atomicCurrentBackupItem.FullName -Destination $Transaction.AtomicCurrentPath
                $Transaction.AtomicCurrentBackupIntended = $false
            }
            elseif ($null -eq $atomicCurrentBackupItem -and $null -ne $atomicCurrentDestinationItem) {
                $Transaction.AtomicCurrentBackupIntended = $false
            }
        }
        catch { Write-Warning "Failed to restore the previous atomic-current pointer: $_" }
    }

    if ($Transaction.CurrentInstallIntended) {
        try {
            $currentItem = Get-AtomicDirectoryEntry $Transaction.CurrentPath
            if ($null -eq $currentItem) {
                $Transaction.CurrentInstallIntended = $false
            }
            else {
                Remove-AtomicDirectoryLinkOrTree $currentItem.FullName
                $Transaction.CurrentInstallIntended = $false
            }
        }
        catch { Write-Warning "Failed to remove the unsuccessful current pointer: $_" }
    }
    if ($Transaction.CurrentBackupIntended) {
        try {
            $currentBackupItem = Get-AtomicDirectoryEntry $Transaction.CurrentBackupPath
            $currentDestinationItem = Get-AtomicDirectoryEntry $Transaction.CurrentPath
            if ($null -ne $currentBackupItem -and $null -eq $currentDestinationItem) {
                Move-Item -LiteralPath $currentBackupItem.FullName -Destination $Transaction.CurrentPath
                $Transaction.CurrentBackupIntended = $false
            }
            elseif ($null -eq $currentBackupItem -and $null -ne $currentDestinationItem) {
                $Transaction.CurrentBackupIntended = $false
            }
        }
        catch { Write-Warning "Failed to restore the previous current pointer: $_" }
    }

    if ($Transaction.VersionInstallIntended) {
        try {
            $versionItem = Get-AtomicDirectoryEntry $Transaction.VersionPath
            if ($null -eq $versionItem) {
                $Transaction.VersionInstallIntended = $false
            }
            else {
                Remove-AtomicDirectoryLinkOrTree $versionItem.FullName
                $Transaction.VersionInstallIntended = $false
            }
        }
        catch { Write-Warning "Failed to remove the unsuccessful version directory: $_" }
    }
    if ($Transaction.VersionBackupIntended) {
        try {
            $versionBackupItem = Get-AtomicDirectoryEntry $Transaction.VersionBackupPath
            $versionDestinationItem = Get-AtomicDirectoryEntry $Transaction.VersionPath
            if ($null -ne $versionBackupItem -and $null -eq $versionDestinationItem) {
                Move-Item -LiteralPath $versionBackupItem.FullName -Destination $Transaction.VersionPath
                $Transaction.VersionBackupIntended = $false
            }
            elseif ($null -eq $versionBackupItem -and $null -ne $versionDestinationItem) {
                $Transaction.VersionBackupIntended = $false
            }
        }
        catch { Write-Warning "Failed to restore the previous version directory: $_" }
    }

    if ($Transaction.CurrentPathChangeIntended) {
        try {
            $env:Path = $Transaction.OldCurrentPath
            $Transaction.CurrentPathChangeIntended = $false
        }
        catch { Write-Warning "Failed to restore the current PATH after installation failure: $_" }
    }
    if ($Transaction.UserPathChangeIntended) {
        try {
            [Environment]::SetEnvironmentVariable("Path", $Transaction.OldUserPath, "User")
            $Transaction.UserPathChangeIntended = $false
        }
        catch { Write-Warning "Failed to restore the User PATH after installation failure: $_" }
    }

    $rollbackIncomplete = $false
    foreach ($intentName in @(
        "ShimInstallIntended", "ShimBackupIntended",
        "AtomicCurrentInstallIntended", "AtomicCurrentBackupIntended",
        "CurrentInstallIntended", "CurrentBackupIntended",
        "VersionInstallIntended", "VersionBackupIntended",
        "CurrentPathChangeIntended", "UserPathChangeIntended"
    )) {
        if ($Transaction[$intentName]) {
            $rollbackIncomplete = $true
            break
        }
    }
    $Transaction.RollbackCompleted = -not $rollbackIncomplete
}

function Remove-AtomicTransactionBackups {
    param([hashtable]$Transaction)

    if ($null -eq $Transaction) {
        return
    }

    $shimBackupItem = Get-AtomicDirectoryEntry $Transaction.ShimBackupPath
    if ($null -ne $shimBackupItem) {
        try { Remove-Item -LiteralPath $shimBackupItem.FullName -Force }
        catch { Write-Warning "Installed successfully, but could not remove the previous shim backup: $_" }
    }
    foreach ($backup in @(
        @{ Name = "atomic-current"; Path = $Transaction.AtomicCurrentBackupPath },
        @{ Name = "current"; Path = $Transaction.CurrentBackupPath },
        @{ Name = "version"; Path = $Transaction.VersionBackupPath }
    )) {
        if ($null -ne (Get-AtomicDirectoryEntry $backup.Path)) {
            try { Remove-AtomicDirectoryLinkOrTree $backup.Path }
            catch { Write-Warning "Installed successfully, but could not remove the previous $($backup.Name) backup: $_" }
        }
    }
}

$tempDir = $null
$versionStagePath = $null
$currentNextPath = $null
$atomicCurrentNextPath = $null
$shimNextPath = $null
$transaction = $null
$transactionCommitted = $false
$transactionMissingDirectories = New-Object System.Collections.ArrayList
$rollbackRetryLimit = 3
$tempCleanupRetryLimit = 5
$tempCleanupRetryDelayMilliseconds = 125
$primaryError = $null
$tempCleanupError = $null

$previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
try {
    [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
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
if (-not [string]::IsNullOrWhiteSpace($requestedRef) -and -not (Test-AtomicReleaseTag $requestedRef)) {
    throw "unsupported release tag: expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-alpha.REVISION"
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
$binDirHasPathSeparator = $binDir.Contains(";")
$atomicCurrentPath = Join-Path $binDir "atomic-current"
$shimPath = Join-Path $binDir "atomic.cmd"
$existingShimItem = Get-AtomicDirectoryEntry $shimPath
if ($null -ne $existingShimItem -and $existingShimItem.PSIsContainer) {
    throw "ATOMIC_BIN_DIR contains an unexpected atomic.cmd directory; refusing to replace it."
}
$existingAtomicCurrentItem = Get-AtomicDirectoryEntry $atomicCurrentPath
if ($null -ne $existingAtomicCurrentItem -and
    ($existingAtomicCurrentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    throw "ATOMIC_BIN_DIR contains an unexpected atomic-current entry; refusing to replace it."
}
$currentPath = Join-Path $installRoot "current"
$existingCurrentItem = Get-AtomicDirectoryEntry $currentPath
if ($null -ne $existingCurrentItem -and
    ($existingCurrentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    throw "ATOMIC_INSTALL_DIR contains an unexpected current entry; refusing to replace it."
}
foreach ($shadowingExtension in @(Get-AtomicShimShadowingExtensions)) {
    $shadowingItem = Get-AtomicDirectoryEntry (Join-Path $binDir ("atomic" + $shadowingExtension))
    if ($null -ne $shadowingItem) {
        throw "ATOMIC_BIN_DIR contains $($shadowingItem.Name), which PATHEXT resolves before atomic.cmd; remove it and rerun the installer."
    }
}

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
    if (-not [string]::IsNullOrWhiteSpace($requestedRef) -and $releaseTag -cne $requestedRef) {
        throw "GitHub returned release $releaseTag for requested tag $requestedRef."
    }
}

if (-not (Test-AtomicReleaseTag $releaseTag)) {
    throw "unsupported release tag: expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-alpha.REVISION"
}
$encodedReleaseTag = [Uri]::EscapeDataString($releaseTag)
$releaseBase = "https://github.com/bastani-inc/atomic/releases/download/$encodedReleaseTag"
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("atomic-install-" + [Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $tempDir $assetName
$checksumsPath = Join-Path $tempDir "SHA256SUMS"
$payloadPath = Join-Path $tempDir "payload"

try {
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath
    Invoke-AtomicDownload "$releaseBase/SHA256SUMS" $checksumsPath

    $checksumAssetRows = @()
    $assetRowPattern = '(^|[ \t*])' + [regex]::Escape($assetName) + '[ \t]*$'
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
    $actualChecksum = (Get-AtomicFileSha256 $archivePath).ToLowerInvariant()
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
    $oldUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $oldCurrentPath = $env:Path

    $transaction = @{
        VersionPath = $versionPath
        VersionBackupPath = $versionBackupPath
        CurrentPath = $currentPath
        CurrentBackupPath = $currentBackupPath
        AtomicCurrentPath = $atomicCurrentPath
        AtomicCurrentBackupPath = $atomicCurrentBackupPath
        ShimPath = $shimPath
        ShimBackupPath = $shimBackupPath
        OldUserPath = $oldUserPath
        OldCurrentPath = $oldCurrentPath
        VersionBackupIntended = $false
        VersionInstallIntended = $false
        CurrentBackupIntended = $false
        CurrentInstallIntended = $false
        AtomicCurrentBackupIntended = $false
        AtomicCurrentInstallIntended = $false
        ShimBackupIntended = $false
        ShimInstallIntended = $false
        UserPathChangeIntended = $false
        CurrentPathChangeIntended = $false
        RollbackCompleted = $false
    }

    Add-AtomicMissingDirectoryPaths $transactionMissingDirectories $versionsDir
    Add-AtomicMissingDirectoryPaths $transactionMissingDirectories $binDir

    try {
        New-Item -ItemType Directory -Path $versionsDir -Force | Out-Null
        New-Item -ItemType Directory -Path $versionStagePath | Out-Null
        foreach ($payloadItem in (Get-ChildItem -LiteralPath $payloadPath -Force)) {
            Copy-Item -LiteralPath $payloadItem.FullName -Destination $versionStagePath -Recurse -Force
        }

        $previousVersionItem = Get-AtomicDirectoryEntry $versionPath
        if ($null -ne $previousVersionItem) {
            $transaction.VersionBackupIntended = $true
            Move-Item -LiteralPath $previousVersionItem.FullName -Destination $versionBackupPath
        }
        $transaction.VersionInstallIntended = $true
        Move-Item -LiteralPath $versionStagePath -Destination $versionPath

        New-Item -ItemType Junction -Path $currentNextPath -Target $versionPath | Out-Null
        $previousCurrentItem = Get-AtomicDirectoryEntry $currentPath
        if ($null -ne $previousCurrentItem) {
            $transaction.CurrentBackupIntended = $true
            Move-Item -LiteralPath $previousCurrentItem.FullName -Destination $currentBackupPath
        }
        $transaction.CurrentInstallIntended = $true
        Move-Item -LiteralPath $currentNextPath -Destination $currentPath

        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        New-Item -ItemType Junction -Path $atomicCurrentNextPath -Target $versionPath | Out-Null
        $shimContent = "@echo off`r`n`"%~dp0atomic-current\atomic.exe`" %*`r`nexit /b %ERRORLEVEL%`r`n"
        Set-Content -LiteralPath $shimNextPath -Value $shimContent -Encoding ASCII -NoNewline

        $previousAtomicCurrentItem = Get-AtomicDirectoryEntry $atomicCurrentPath
        if ($null -ne $previousAtomicCurrentItem) {
            $transaction.AtomicCurrentBackupIntended = $true
            Move-Item -LiteralPath $previousAtomicCurrentItem.FullName -Destination $atomicCurrentBackupPath
        }
        $previousShimItem = Get-AtomicDirectoryEntry $shimPath
        if ($null -ne $previousShimItem) {
            $transaction.ShimBackupIntended = $true
            Move-Item -LiteralPath $previousShimItem.FullName -Destination $shimBackupPath
        }
        $transaction.AtomicCurrentInstallIntended = $true
        Move-Item -LiteralPath $atomicCurrentNextPath -Destination $atomicCurrentPath
        $transaction.ShimInstallIntended = $true
        Move-Item -LiteralPath $shimNextPath -Destination $shimPath

        if (-not $binDirHasPathSeparator -and -not (Test-AtomicPathContains $oldUserPath $binDir)) {
            $newUserPath = if ([string]::IsNullOrWhiteSpace($oldUserPath)) { $binDir } else { "$oldUserPath;$binDir" }
            $transaction.UserPathChangeIntended = $true
            [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
        }
        if (-not $binDirHasPathSeparator -and -not (Test-AtomicPathContains $env:Path $binDir)) {
            $transaction.CurrentPathChangeIntended = $true
            $env:Path = if ([string]::IsNullOrWhiteSpace($env:Path)) { $binDir } else { "$env:Path;$binDir" }
        }

        $shimCommand = '"' + $shimPath + '" --version'
        & $env:ComSpec /d /c $shimCommand
        $finalExitCode = $LASTEXITCODE
        if ($finalExitCode -ne 0) {
            throw "Installed atomic.cmd --version failed with exit code $finalExitCode."
        }

        $transactionCommitted = $true
        Remove-AtomicTransactionBackups $transaction
    }
    catch {
        $commitError = $_
        if (-not $transactionCommitted) {
            Invoke-AtomicTransactionRollback $transaction
        }
        throw $commitError
    }

    Write-Output "Atomic $releaseTag installed successfully."
    Write-Output "Shim: $shimPath"
    if ($binDirHasPathSeparator) {
        Write-Output "ATOMIC_BIN_DIR contains ';' and cannot be represented as one Windows PATH entry."
        Write-Output "Run Atomic directly: `"$shimPath`""
        Write-Output "Choose a semicolon-free ATOMIC_BIN_DIR to add Atomic to PATH."
    }
    else {
        Write-Output "Restart your terminal so other processes pick up the updated User PATH."
    }
}
catch {
    $primaryError = $_
    throw $primaryError
}
finally {
    if ($null -ne $transaction -and -not $transactionCommitted) {
        $rollbackAttempt = 0
        while ($rollbackAttempt -lt $rollbackRetryLimit -and -not $transaction.RollbackCompleted) {
            $rollbackAttempt++
            Invoke-AtomicTransactionRollback $transaction
        }
        if (-not $transaction.RollbackCompleted) {
            Write-Warning "Installation rollback remains incomplete after $rollbackRetryLimit final cleanup attempts; transaction backups were retained for recovery."
        }
    }
    if ($null -ne $transaction -and $transactionCommitted) {
        Remove-AtomicTransactionBackups $transaction
    }

    if ($null -ne $shimNextPath -and $null -ne (Get-AtomicDirectoryEntry $shimNextPath)) {
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
    if ($null -ne $versionStagePath -and $null -ne (Get-AtomicDirectoryEntry $versionStagePath)) {
        Remove-Item -LiteralPath $versionStagePath -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $tempDir -and (Test-Path -LiteralPath $tempDir)) {
        try {
            Remove-AtomicTemporaryDirectory $tempDir $tempCleanupRetryLimit $tempCleanupRetryDelayMilliseconds
        }
        catch {
            $tempCleanupError = $_
        }
    }

    if ($null -ne $transaction -and -not $transactionCommitted) {
        Remove-AtomicCreatedEmptyDirectories $transactionMissingDirectories
    }

    if ($null -ne $tempCleanupError) {
        if ($null -ne $primaryError) {
            Write-Warning "Temporary download directory cleanup remains incomplete: $tempCleanupError"
        }
        else {
            throw $tempCleanupError
        }
    }
}
}
finally {
    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
    }
    catch {
        Write-Warning "Failed to restore the caller's TLS protocol setting: $_"
    }
}
} @args
