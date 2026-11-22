# Atomic release archive installer for Windows PowerShell 5.1 and later.
#
# Usage:
#   irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11

& {
param(
    [string]$Ref,
    [switch]$Force,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$IsWindowsHost = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$ProgressPreference = "SilentlyContinue"

$helpText = @'
Atomic release archive installer for Windows PowerShell 5.1+

Usage:
  install.ps1 [-Ref <tag>] [-Force] [-Help]

Options:
  -Ref <tag>  Install the exact GitHub release tag. This overrides ATOMIC_VERSION.
  -Force      Reinstall even when the requested version is already installed and healthy.
  -Help       Show this help and exit.

An existing healthy install of the requested release (or of the latest release
when none is requested) is left untouched and nothing is downloaded.

Environment:
  ATOMIC_VERSION      Exact release tag when -Ref is not supplied.
  ATOMIC_FORCE_INSTALL
                      Set to 1 to behave like -Force.
  ATOMIC_INSTALL_DIR  Installation root.
  ATOMIC_BIN_DIR      Directory containing the atomic.cmd shim.
  GITHUB_TOKEN        Optional GitHub API token (preferred over GH_TOKEN).
  GH_TOKEN            Optional GitHub API token.
  NO_COLOR            Disable colour and progress output (plain mode).

Default install directory: $env:LOCALAPPDATA\atomic
Default bin directory: $env:LOCALAPPDATA\atomic\bin (the install directory's bin subdirectory)
'@

if ($Help) {
    Write-Output $helpText
    return
}

# Plain mode drops colour, the progress bar, and the logo. It is used when the host has no
# console, NO_COLOR or CI is set, or standard output is redirected.
$plainOutput = $false
try {
    if ($null -eq $Host.UI -or $null -eq $Host.UI.RawUI) {
        $plainOutput = $true
    }
}
catch {
    $plainOutput = $true
}
if ($null -ne $env:NO_COLOR -or $null -ne $env:CI) {
    $plainOutput = $true
}
try {
    if ([Console]::IsOutputRedirected) {
        $plainOutput = $true
    }
}
catch {
    $plainOutput = $true
}
# Windows Terminal renders UTF-8 reliably; legacy conhost code pages do not, so the bar and
# the logo use Unicode glyphs only under WT_SESSION.
$useUnicodeGlyphs = -not $plainOutput -and -not [string]::IsNullOrEmpty($env:WT_SESSION)
$progressFilledGlyph = "#"
$progressEmptyGlyph = "-"
if ($useUnicodeGlyphs) {
    $progressFilledGlyph = [string][char]0x25A0
    $progressEmptyGlyph = [string][char]0xFF65
}

function Write-AtomicMuted {
    param(
        [string]$Text,
        [switch]$NoNewline
    )

    if ($plainOutput) {
        Write-Host $Text -NoNewline:$NoNewline
    }
    else {
        Write-Host $Text -ForegroundColor DarkGray -NoNewline:$NoNewline
    }
}

function Write-AtomicLabeled {
    param(
        [string]$Label,
        [string]$Value,
        [string]$Suffix
    )

    if ($plainOutput) {
        Write-Host ($Label + $Value + $Suffix)
        return
    }
    Write-Host $Label -ForegroundColor DarkGray -NoNewline
    Write-Host $Value -NoNewline
    Write-Host $Suffix -ForegroundColor DarkGray
}

function Get-AtomicBannerLines {
    # ATOMIC_FORALL_BANNER_LINES from packages/coding-agent/src/modes/interactive/components/atomic-banner.ts.
    # This file stays ASCII so Windows PowerShell 5.1 reads it without a byte-order mark, so the
    # glyphs are placeholders here: # is U+2588, L is U+2599, R is U+259F, l is U+259B, r is U+259C.
    $template = @(
        "  ######L                  R######  ",
        "   ######L                R######   ",
        "    ######L              R######    ",
        "     ######L            R######     ",
        "      ########################      ",
        "       ######l        r######       ",
        "        ######l      r######        ",
        "         ######l    r######         ",
        "          ######l  r######          ",
        "            ############            "
    )
    $lines = @()
    foreach ($row in $template) {
        $lines += $row.Replace("#", [string][char]0x2588).Replace("L", [string][char]0x2599).Replace("R", [string][char]0x259F).Replace("l", [string][char]0x259B).Replace("r", [string][char]0x259C)
    }
    return ,$lines
}

function Format-AtomicMegabytes {
    param([long]$Bytes)

    return ([double]$Bytes / 1048576).ToString("0.0", [Globalization.CultureInfo]::InvariantCulture)
}

function Get-AtomicErrorDetail {
    param($ErrorRecord)

    $exception = $ErrorRecord.Exception
    if ($null -eq $exception) {
        return [string]$ErrorRecord
    }
    while ($null -ne $exception.InnerException) {
        $exception = $exception.InnerException
    }
    return $exception.Message
}

function Get-AtomicInstalledVersion {
    param([string]$LauncherPath)

    # Read the version from the directory `current` points at instead of running the installed atomic.exe: a hung or
    # broken install is exactly what a rerun repairs, so this probe must never block it.
    if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) {
        return $null
    }
    try {
        $currentTarget = Get-AtomicReparseTarget (Get-AtomicDirectoryEntry (Split-Path -Parent $LauncherPath))
        if ([string]::IsNullOrWhiteSpace($currentTarget)) {
            return $null
        }
        $version = [Uri]::UnescapeDataString((Split-Path -Leaf $currentTarget.TrimEnd([char[]]@('\', '/'))))
        if (-not (Test-AtomicReleaseTag $version)) {
            return $null
        }
        return $version
    }
    catch {
        return $null
    }
}

function Get-AtomicComparablePath {
    param([string]$Path)

    return (Get-AtomicPhysicalPath $Path).TrimEnd([char[]]@('\', '/'))
}

function Test-AtomicInstalledPayloadComplete {
    param([string]$CurrentPath)

    foreach ($requiredFile in @("package.json", "app.js", "native-modifiers.js", "native-module-path.js", "native-platform.js")) {
        if (-not (Test-Path -LiteralPath (Join-Path $CurrentPath $requiredFile) -PathType Leaf)) {
            return $false
        }
    }
    foreach ($requiredDirectory in @("builtin", "node_modules")) {
        if (-not (Test-Path -LiteralPath (Join-Path $CurrentPath $requiredDirectory) -PathType Container)) {
            return $false
        }
    }
    return $true
}

# Whether the installed atomic.exe matches the hash recorded at install time. False when the
# record is missing (an install from an older installer) or the launcher changed since.
function Test-AtomicLauncherMatchesRecord {
    param([string]$CurrentPath)

    $recordPath = Join-Path $CurrentPath ".atomic-launcher.sha256"
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
        return $false
    }
    $recorded = ([IO.File]::ReadAllText($recordPath)).Trim()
    if ($recorded -cnotmatch '^[0-9a-f]{64}\z') {
        return $false
    }
    $launcherPath = Join-Path $CurrentPath "atomic.exe"
    try {
        return ((Get-AtomicFileSha256 $launcherPath).ToLowerInvariant() -ceq $recorded)
    }
    catch {
        return $false
    }
}

# A healthy install whose launcher hash was recorded and still matches: it can be kept without
# asking GitHub anything. An install without the record resolves over the network.
function Test-AtomicInstallVerified {
    param(
        [AllowNull()][string]$InstalledVersion,
        [string]$ReleaseTag,
        [string]$InstallRoot,
        [string]$BinDir,
        [string]$ExpectedShimContent
    )

    $recordPath = Join-Path (Join-Path $InstallRoot "current") ".atomic-launcher.sha256"
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
        return $false
    }
    return (Test-AtomicInstallIntact $InstalledVersion $ReleaseTag $InstallRoot $BinDir $ExpectedShimContent)
}

function Test-AtomicInstallIntact {
    param(
        [AllowNull()][string]$InstalledVersion,
        [string]$ReleaseTag,
        [string]$InstallRoot,
        [string]$BinDir,
        [string]$ExpectedShimContent
    )

    if ($InstalledVersion -cne $ReleaseTag) {
        return $false
    }
    $currentTarget = Get-AtomicReparseTarget (Get-AtomicDirectoryEntry (Join-Path $InstallRoot "current"))
    $atomicCurrentTarget = Get-AtomicReparseTarget (Get-AtomicDirectoryEntry (Join-Path $BinDir "atomic-current"))
    if ([string]::IsNullOrWhiteSpace($currentTarget) -or [string]::IsNullOrWhiteSpace($atomicCurrentTarget)) {
        return $false
    }
    if ($currentTarget -ine $atomicCurrentTarget) {
        return $false
    }
    $expectedVersionPath = Join-Path (Join-Path $InstallRoot "versions") ([Uri]::EscapeDataString($ReleaseTag))
    if ((Get-AtomicComparablePath $currentTarget) -ine (Get-AtomicComparablePath $expectedVersionPath)) {
        return $false
    }
    if (-not (Test-AtomicInstalledPayloadComplete (Join-Path $InstallRoot "current"))) {
        return $false
    }
    $currentRoot = Join-Path $InstallRoot "current"
    $launcherItem = Get-Item -LiteralPath (Join-Path $currentRoot "atomic.exe") -Force -ErrorAction SilentlyContinue
    if ($null -eq $launcherItem -or $launcherItem.PSIsContainer -or $launcherItem.Length -eq 0) {
        return $false
    }
    if ((Test-Path -LiteralPath (Join-Path $currentRoot ".atomic-launcher.sha256") -PathType Leaf) -and
        -not (Test-AtomicLauncherMatchesRecord $currentRoot)) {
        return $false
    }
    $shimItem = Get-AtomicDirectoryEntry (Join-Path $BinDir "atomic.cmd")
    if ($null -eq $shimItem -or $shimItem.PSIsContainer) {
        return $false
    }
    return [IO.File]::ReadAllText($shimItem.FullName) -ceq $ExpectedShimContent
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

function Expand-AtomicReleaseArchive {
    param([string]$ArchivePath, [string]$DestinationPath)

    # The release archive holds ~19k files; Expand-Archive processes entries at
    # script speed under Windows PowerShell 5.1 and takes minutes for that many.
    # ZipFile.ExtractToDirectory is native, ships with .NET Framework 4.6.2+ and
    # PowerShell 7, and rejects entries that resolve outside the destination.
    # Expand-Archive remains only as the fallback when the assembly cannot load.
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    }
    catch {
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force
        return
    }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $DestinationPath)
}

function Test-AtomicReleaseTag {
    param([string]$Tag)

    if ([string]::IsNullOrWhiteSpace($Tag)) {
        return $false
    }

    return $Tag -cmatch '^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-alpha\.(?:[1-9][0-9]*))?\z'
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

# The HTTP response of a failed Invoke-WebRequest (WebException on Windows PowerShell,
# HttpResponseException on PowerShell 7), or $null when no response arrived.
function Get-AtomicErrorResponse {
    param($ErrorRecord)

    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
        $responseProperty = $exception.PSObject.Properties["Response"]
        if ($null -ne $responseProperty -and $null -ne $responseProperty.Value) {
            return $responseProperty.Value
        }
        $exception = $exception.InnerException
    }
    return $null
}

function Get-AtomicErrorStatusCode {
    param($ErrorRecord)

    $response = Get-AtomicErrorResponse $ErrorRecord
    if ($null -eq $response) {
        return 0
    }
    $statusProperty = $response.PSObject.Properties["StatusCode"]
    if ($null -eq $statusProperty -or $null -eq $statusProperty.Value) {
        return 0
    }
    try {
        return [int]$statusProperty.Value
    }
    catch {
        return 0
    }
}

# GitHub answers a rate-limited API request with 403 (or 429) and `X-RateLimit-Remaining: 0`
# or a message that names the rate limit.
function Test-AtomicRateLimitError {
    param($ErrorRecord, [int]$StatusCode)

    if ($StatusCode -eq 429) {
        return $true
    }
    if ($StatusCode -ne 403) {
        return $false
    }

    $remaining = $null
    $response = Get-AtomicErrorResponse $ErrorRecord
    if ($null -ne $response) {
        $headersProperty = $response.PSObject.Properties["Headers"]
        if ($null -ne $headersProperty -and $null -ne $headersProperty.Value) {
            $headers = $headersProperty.Value
            try {
                if ($null -ne $headers.PSObject.Methods["TryGetValues"]) {
                    $headerValues = $null
                    if ($headers.TryGetValues("X-RateLimit-Remaining", [ref]$headerValues)) {
                        $remaining = [string](@($headerValues)[0])
                    }
                }
                else {
                    $remaining = [string]$headers["X-RateLimit-Remaining"]
                }
            }
            catch {
                $remaining = $null
            }
        }
    }
    if ($remaining -eq "0") {
        return $true
    }

    $text = [string]$ErrorRecord.Exception.Message
    $detailsProperty = $ErrorRecord.PSObject.Properties["ErrorDetails"]
    if ($null -ne $detailsProperty -and $null -ne $detailsProperty.Value) {
        $text += " " + [string]$detailsProperty.Value.Message
    }
    return $text -match 'rate limit'
}

function Invoke-AtomicApiRequest {
    param(
        [string]$Uri,
        [hashtable]$Headers,
        [string]$RequestedTag
    )

    try {
        $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing -ErrorAction Stop
        return ($response.Content | ConvertFrom-Json)
    }
    catch {
        $statusCode = Get-AtomicErrorStatusCode $_
        if ($statusCode -eq 404 -and -not [string]::IsNullOrWhiteSpace($RequestedTag)) {
            throw "release $RequestedTag not found."
        }
        if (Test-AtomicRateLimitError $_ $statusCode) {
            if ($Headers.ContainsKey("Authorization")) {
                throw "Failed to query GitHub release API at ${Uri}: GitHub's API rate limit was reached for this token; try again later."
            }
            throw "Failed to query GitHub release API at ${Uri}: GitHub's API rate limit was reached for this network. Set GITHUB_TOKEN (for example `$env:GITHUB_TOKEN = gh auth token) or try again later."
        }
        throw "Failed to query GitHub release API at ${Uri}: $_"
    }
}

# Whether the requested release exists: github.com's own answer to a HEAD request for the
# release's SHA256SUMS, without following its redirect to the file storage. A 2xx or 3xx
# means "found", 404 "missing" (also for a tag with no published release), anything else
# "unknown". github.com is not subject to the REST API's 60-requests-an-hour limit for
# unauthenticated clients.
function Get-AtomicReleasePageStatus {
    param([string]$EncodedTag)

    $statusCode = 0
    try {
        $probeErrors = $null
        $response = Invoke-WebRequest -Uri "https://github.com/bastani-inc/atomic/releases/download/$EncodedTag/SHA256SUMS" -Method Head -MaximumRedirection 0 -UseBasicParsing -ErrorAction SilentlyContinue -ErrorVariable probeErrors
        if ($null -ne $response) {
            $statusProperty = $response.PSObject.Properties["StatusCode"]
            if ($null -ne $statusProperty -and $null -ne $statusProperty.Value) {
                $statusCode = [int]$statusProperty.Value
            }
        }
        if ($statusCode -eq 0 -and $null -ne $probeErrors -and @($probeErrors).Count -gt 0) {
            $statusCode = Get-AtomicErrorStatusCode @($probeErrors)[0]
        }
    }
    catch {
        $statusCode = Get-AtomicErrorStatusCode $_
    }
    if ($statusCode -ge 200 -and $statusCode -lt 400) {
        return "found"
    }
    if ($statusCode -eq 404) {
        return "missing"
    }
    return "unknown"
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

function Write-AtomicProgressLine {
    param(
        [long]$Received,
        [long]$Total,
        [int]$SpinnerFrame,
        [string]$AssetName,
        [int]$PreviousLength
    )

    if ($Total -gt 0) {
        $completed = $Received
        if ($completed -gt $Total) {
            $completed = $Total
        }
        $width = 50
        $filledCount = [int][Math]::Floor([double]$completed * $width / $Total)
        $percent = [int][Math]::Floor([double]$completed * 100 / $Total)
        $accent = ($progressFilledGlyph * $filledCount) + ($progressEmptyGlyph * ($width - $filledCount))
        $text = " {0,3}%  {1} / {2} MB" -f $percent, (Format-AtomicMegabytes $Received), (Format-AtomicMegabytes $Total)
    }
    else {
        $accent = @("|", "/", "-", "\")[$SpinnerFrame % 4]
        $text = " Downloading $AssetName  " + (Format-AtomicMegabytes $Received) + " MB"
    }

    $length = $accent.Length + $text.Length
    $padding = ""
    if ($length -lt $PreviousLength) {
        $padding = " " * ($PreviousLength - $length)
    }
    Write-Host ("`r" + $accent) -ForegroundColor DarkYellow -NoNewline
    Write-Host ($text + $padding) -NoNewline
    return $length
}

# Streams the release archive through HttpClient so the download can be drawn as it arrives.
# Returns $false, without touching the destination, when System.Net.Http cannot be loaded so
# the caller can fall back to Invoke-AtomicDownload. No Authorization header is ever attached.
function Invoke-AtomicDownloadWithProgress {
    param(
        [string]$Uri,
        [string]$Destination,
        [string]$AssetName
    )

    $client = $null
    try {
        Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
        $client = New-Object System.Net.Http.HttpClient
        # HttpClient.Timeout would cap the whole transfer, which a slow link can
        # legitimately exceed; the header wait and each body read are bounded
        # separately below so a stalled server still fails rather than hanging.
        $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    }
    catch {
        if ($null -ne $client) {
            $client.Dispose()
        }
        return $false
    }

    $response = $null
    $source = $null
    $target = $null
    $headerCancellation = $null
    $lineOpen = $false
    try {
        $headerCancellation = New-Object Threading.CancellationTokenSource([TimeSpan]::FromMilliseconds($downloadHeaderTimeoutMilliseconds))
        try {
            $response = $client.GetAsync($Uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $headerCancellation.Token).GetAwaiter().GetResult()
        }
        catch {
            if ($headerCancellation.IsCancellationRequested) {
                throw "no response headers within $($downloadHeaderTimeoutMilliseconds / 1000) seconds"
            }
            throw
        }
        $response.EnsureSuccessStatusCode() | Out-Null
        $totalBytes = [long]-1
        $contentLength = $response.Content.Headers.ContentLength
        if ($null -ne $contentLength) {
            $totalBytes = [long]$contentLength
        }
        $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()

        if ($plainOutput) {
            if ($totalBytes -gt 0) {
                Write-AtomicMuted -NoNewline ("Downloading $AssetName (" + (Format-AtomicMegabytes $totalBytes) + " MB) ... ")
            }
            else {
                Write-AtomicMuted -NoNewline "Downloading $AssetName ... "
            }
            $lineOpen = $true
        }

        $buffer = New-Object byte[] 65536
        $received = [long]0
        $spinnerFrame = 0
        $lineLength = 0
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $target = [IO.File]::Create($Destination)
        while ($true) {
            # Bound each read by an inactivity deadline. A server or proxy that
            # sends headers and then stops must surface as a download failure.
            $readTask = $source.ReadAsync($buffer, 0, $buffer.Length)
            if (-not $readTask.Wait($downloadStallTimeoutMilliseconds)) {
                throw "download stalled: no data received for $($downloadStallTimeoutMilliseconds / 1000) seconds"
            }
            $read = $readTask.Result
            if ($read -le 0) {
                break
            }
            $target.Write($buffer, 0, $read)
            $received += $read
            if (-not $plainOutput -and $stopwatch.ElapsedMilliseconds -ge 100) {
                $lineLength = Write-AtomicProgressLine $received $totalBytes $spinnerFrame $AssetName $lineLength
                $lineOpen = $true
                $spinnerFrame++
                $stopwatch.Restart()
            }
        }
        $target.Dispose()
        $target = $null

        if ($plainOutput) {
            Write-AtomicMuted "done"
        }
        else {
            $null = Write-AtomicProgressLine $received $totalBytes $spinnerFrame $AssetName $lineLength
            Write-Host ""
        }
        $lineOpen = $false
    }
    catch {
        throw "Failed to download ${Uri}: $(Get-AtomicErrorDetail $_)"
    }
    finally {
        if ($lineOpen) {
            Write-Host ""
        }
        if ($null -ne $target) {
            $target.Dispose()
        }
        if ($null -ne $source) {
            $source.Dispose()
        }
        if ($null -ne $response) {
            $response.Dispose()
        }
        if ($null -ne $headerCancellation) {
            $headerCancellation.Dispose()
        }
        $client.Dispose()
    }
    return $true
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

function Get-AtomicReparseTarget {
    param($Item)

    if ($null -eq $Item) {
        return $null
    }
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        return $null
    }
    $raw = $null
    if ($Item.PSObject.Properties["Target"] -and $null -ne $Item.Target) {
        if ($Item.Target -is [string]) {
            $raw = [string]$Item.Target
        }
        elseif ($Item.Target.Count -gt 0) {
            $raw = [string]$Item.Target[0]
        }
    }
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }
    if ($raw.StartsWith("\\?\UNC\", [StringComparison]::OrdinalIgnoreCase)) {
        $raw = "\\" + $raw.Substring(8)
    }
    elseif ($raw.StartsWith("\\?\", [StringComparison]::OrdinalIgnoreCase)) {
        $raw = $raw.Substring(4)
    }
    if (-not [IO.Path]::IsPathRooted($raw)) {
        $parent = [IO.Path]::GetDirectoryName($Item.FullName)
        $raw = [IO.Path]::Combine($parent, $raw)
    }
    return [IO.Path]::GetFullPath($raw)
}

function Get-AtomicPhysicalPath {
    param([string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    if ([string]::IsNullOrEmpty($root)) {
        return $full
    }
    $relative = ""
    if ($full.Length -gt $root.Length) {
        $relative = $full.Substring($root.Length)
    }
    $parts = @()
    if (-not [string]::IsNullOrEmpty($relative)) {
        $parts = $relative.Split(
            [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar),
            [StringSplitOptions]::RemoveEmptyEntries
        )
    }
    $current = $root
    $unresolved = New-Object System.Collections.ArrayList
    $pastExisting = $false
    foreach ($part in $parts) {
        if ($pastExisting) {
            [void]$unresolved.Add($part)
            continue
        }
        $next = [IO.Path]::Combine($current, $part)
        if (-not (Test-Path -LiteralPath $next)) {
            $pastExisting = $true
            [void]$unresolved.Add($part)
            continue
        }
        $item = Get-Item -LiteralPath $next -Force
        $target = Get-AtomicReparseTarget $item
        if (-not [string]::IsNullOrWhiteSpace($target)) {
            $current = $target
            continue
        }
        $current = $item.FullName
    }
    foreach ($part in $unresolved) {
        $current = [IO.Path]::Combine($current, $part)
    }
    return [IO.Path]::GetFullPath($current)
}

# Windows can refuse for a moment to rename a file or directory that was just written or run from (an antivirus scan,
# the search indexer, or a handle still closing). All transaction, rollback, and recovery moves stay inside the same
# parent directory, so Rename-Item keeps them atomic on both Windows PowerShell 5.1 and PowerShell 7 (where Move-Item
# falls back to a partial copy-and-delete when a file inside a directory is locked). Retry up to ~9.5 seconds with a
# capped linear backoff before failing.
function Move-AtomicItem {
    param(
        [string]$LiteralPath,
        [string]$Destination,
        [hashtable]$RetryBudget = $null
    )

    $normalizedSource = [IO.Path]::GetFullPath($LiteralPath).TrimEnd([char[]]@('\', '/'))
    $normalizedDestination = [IO.Path]::GetFullPath($Destination).TrimEnd([char[]]@('\', '/'))
    $sourceParent = [IO.Path]::GetDirectoryName($normalizedSource)
    $destinationParent = [IO.Path]::GetDirectoryName($normalizedDestination)
    $destinationLeaf = [IO.Path]::GetFileName($normalizedDestination)
    if ([string]::IsNullOrWhiteSpace($destinationLeaf) -or
        $destinationLeaf.IndexOfAny([char[]]@('\', '/')) -ge 0 -or
        ($IsWindowsHost -and ($sourceParent -ine $destinationParent)) -or
        (-not $IsWindowsHost -and ($sourceParent -cne $destinationParent))) {
        throw "Refusing non-local rename from '$LiteralPath' to '$Destination'."
    }
    if (($IsWindowsHost -and ($normalizedSource -ieq $normalizedDestination)) -or
        (-not $IsWindowsHost -and ($normalizedSource -ceq $normalizedDestination))) {
        throw "Source and destination path must be different: '$LiteralPath'."
    }

    $attemptLimit = 15
    for ($attempt = 1; ; $attempt++) {
        try {
            Rename-Item -LiteralPath $normalizedSource -NewName $destinationLeaf -ErrorAction Stop
            return
        }
        catch [System.IO.IOException], [System.UnauthorizedAccessException] {
            if (-not (Test-AtomicTransientFileSystemError $_) -or $attempt -ge $attemptLimit) {
                throw
            }
            $delayMilliseconds = [Math]::Min(100 * $attempt, 1000)
            if ($null -ne $RetryBudget) {
                if ($RetryBudget.RemainingMilliseconds -le 0) {
                    throw
                }
                $delayMilliseconds = [Math]::Min($delayMilliseconds, [int]$RetryBudget.RemainingMilliseconds)
                $RetryBudget.RemainingMilliseconds -= $delayMilliseconds
            }
            Start-Sleep -Milliseconds $delayMilliseconds
        }
    }
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

function Test-AtomicTransientFileSystemError {
    param($ErrorRecord)

    if ($null -eq $ErrorRecord) {
        return $false
    }
    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
        if ($exception -is [System.UnauthorizedAccessException]) {
            return $true
        }
        if ($exception -is [System.IO.IOException]) {
            if ($exception -is [System.IO.FileNotFoundException] -or
                $exception -is [System.IO.DirectoryNotFoundException] -or
                $exception -is [System.IO.PathTooLongException] -or
                $exception -is [System.IO.DriveNotFoundException]) {
                return $false
            }
            # Permanent Win32 IO errors: 39 (HANDLE_DISK_FULL), 80 (FILE_EXISTS), 112 (DISK_FULL), 183 (ALREADY_EXISTS).
            if ($exception.HResult -lt 0 -and
                ($exception.HResult -band 0x7FFF0000) -eq 0x00070000 -and
                ($exception.HResult -band 0xFFFF) -in @(39, 80, 112, 183)) {
                return $false
            }
            return $true
        }
        $exception = $exception.InnerException
    }
    return $false
}

function Remove-AtomicDirectoryLinkOrTree {
    param(
        [string]$Path,
        [int]$RetryLimit = 9,
        [int]$RetryDelayMilliseconds = 250,
        [hashtable]$RetryBudget = $null
    )

    $item = Get-AtomicDirectoryEntry $Path
    if ($null -eq $item) {
        return
    }

    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        [IO.Directory]::Delete($item.FullName)
        return
    }

    $removal = Remove-AtomicTreeWithRetry $item.FullName $RetryLimit $RetryDelayMilliseconds $RetryBudget
    if (-not $removal.Removed) {
        if ($null -ne $removal.LastError) {
            throw $removal.LastError
        }
        throw "Failed to remove $($item.FullName) after $($removal.Attempts) attempts."
    }
}

function Test-AtomicRemovalTargetExists {
    param([string]$Path)

    return ([IO.Directory]::Exists($Path) -or [IO.File]::Exists($Path))
}

function Remove-AtomicTreeWithRetry {
    param(
        [string]$Path,
        [int]$RetryLimit,
        [int]$RetryDelayMilliseconds,
        [hashtable]$RetryBudget = $null
    )

    $result = [pscustomobject]@{ Removed = $true; Attempts = 0; LastError = $null }
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-AtomicRemovalTargetExists $Path)) {
        return $result
    }

    while ($result.Attempts -lt $RetryLimit) {
        $result.Attempts++
        $isDirectory = [IO.Directory]::Exists($Path)

        try {
            $readOnlyCandidates = New-Object System.Collections.ArrayList
            [void]$readOnlyCandidates.Add($Path)
            if ($isDirectory) {
                foreach ($entry in [IO.Directory]::GetFileSystemEntries($Path, "*", [IO.SearchOption]::AllDirectories)) {
                    [void]$readOnlyCandidates.Add($entry)
                }
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
            $result.LastError = $_
        }

        try {
            Remove-Item -LiteralPath $Path -Recurse:$isDirectory -Force -ErrorAction Stop
        }
        catch {
            $result.LastError = $_
        }
        if (-not (Test-AtomicRemovalTargetExists $Path)) {
            return $result
        }

        try {
            if ($isDirectory) {
                [IO.Directory]::Delete($Path, $true)
            }
            else {
                [IO.File]::Delete($Path)
            }
        }
        catch {
            $result.LastError = $_
        }
        if (-not (Test-AtomicRemovalTargetExists $Path)) {
            return $result
        }

        if ($null -ne $result.LastError -and -not (Test-AtomicTransientFileSystemError $result.LastError)) {
            break
        }

        if ($result.Attempts -lt $RetryLimit) {
            if ($null -ne $RetryBudget) {
                if ($RetryBudget.RemainingMilliseconds -le 0) {
                    break
                }
                $sleepMilliseconds = [Math]::Min($RetryDelayMilliseconds * $result.Attempts, [int]$RetryBudget.RemainingMilliseconds)
                $RetryBudget.RemainingMilliseconds -= $sleepMilliseconds
                Start-Sleep -Milliseconds $sleepMilliseconds
            }
            else {
                Start-Sleep -Milliseconds ($RetryDelayMilliseconds * $result.Attempts)
            }
        }
    }

    $result.Removed = $false
    return $result
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

    $removal = Remove-AtomicTreeWithRetry $Path $RetryLimit $RetryDelayMilliseconds
    if ($removal.Removed) {
        return
    }

    $lastCleanupDetail = if ($null -eq $removal.LastError) {
        "the directory still existed after every verified removal attempt"
    }
    else {
        [string]$removal.LastError
    }
    throw "Failed to remove the temporary download directory ${Path} after $($removal.Attempts) attempts; last error: $lastCleanupDetail"
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
                Write-Warning -Message "Failed to remove transaction-created empty directory ${path}: $_" -WarningAction Continue
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
                $shimRemoval = Remove-AtomicTreeWithRetry $shimItem.FullName $tempCleanupRetryLimit $tempCleanupRetryDelayMilliseconds $Transaction.RollbackRetryBudget
                if (-not $shimRemoval.Removed) {
                    if ($null -ne $shimRemoval.LastError) {
                        throw $shimRemoval.LastError
                    }
                    throw "Failed to remove $($shimItem.FullName) after $($shimRemoval.Attempts) attempts."
                }
                $Transaction.ShimInstallIntended = $false
            }
        }
        catch { Write-Warning -Message "Failed to remove the unsuccessful atomic.cmd shim: $_" -WarningAction Continue }
    }
    if ($Transaction.ShimBackupIntended) {
        try {
            $shimBackupItem = Get-AtomicDirectoryEntry $Transaction.ShimBackupPath
            $shimDestinationItem = Get-AtomicDirectoryEntry $Transaction.ShimPath
            if ($null -ne $shimBackupItem -and $null -eq $shimDestinationItem) {
                Move-AtomicItem -LiteralPath $shimBackupItem.FullName -Destination $Transaction.ShimPath -RetryBudget $Transaction.RollbackRetryBudget
                $Transaction.ShimBackupIntended = $false
            }
            elseif ($null -eq $shimBackupItem -and $null -ne $shimDestinationItem) {
                $Transaction.ShimBackupIntended = $false
            }
        }
        catch { Write-Warning -Message "Failed to restore the previous atomic.cmd shim: $_" -WarningAction Continue }
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
        catch { Write-Warning -Message "Failed to remove the unsuccessful atomic-current pointer: $_" -WarningAction Continue }
    }
    if ($Transaction.AtomicCurrentBackupIntended) {
        try {
            $atomicCurrentBackupItem = Get-AtomicDirectoryEntry $Transaction.AtomicCurrentBackupPath
            $atomicCurrentDestinationItem = Get-AtomicDirectoryEntry $Transaction.AtomicCurrentPath
            if ($null -ne $atomicCurrentBackupItem -and $null -eq $atomicCurrentDestinationItem) {
                Move-AtomicItem -LiteralPath $atomicCurrentBackupItem.FullName -Destination $Transaction.AtomicCurrentPath -RetryBudget $Transaction.RollbackRetryBudget
                $Transaction.AtomicCurrentBackupIntended = $false
            }
            elseif ($null -eq $atomicCurrentBackupItem -and $null -ne $atomicCurrentDestinationItem) {
                $Transaction.AtomicCurrentBackupIntended = $false
            }
        }
        catch { Write-Warning -Message "Failed to restore the previous atomic-current pointer: $_" -WarningAction Continue }
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
        catch { Write-Warning -Message "Failed to remove the unsuccessful current pointer: $_" -WarningAction Continue }
    }
    if ($Transaction.CurrentBackupIntended) {
        try {
            $currentBackupItem = Get-AtomicDirectoryEntry $Transaction.CurrentBackupPath
            $currentDestinationItem = Get-AtomicDirectoryEntry $Transaction.CurrentPath
            if ($null -ne $currentBackupItem -and $null -eq $currentDestinationItem) {
                Move-AtomicItem -LiteralPath $currentBackupItem.FullName -Destination $Transaction.CurrentPath -RetryBudget $Transaction.RollbackRetryBudget
                $Transaction.CurrentBackupIntended = $false
            }
            elseif ($null -eq $currentBackupItem -and $null -ne $currentDestinationItem) {
                $Transaction.CurrentBackupIntended = $false
            }
        }
        catch { Write-Warning -Message "Failed to restore the previous current pointer: $_" -WarningAction Continue }
    }

    if ($Transaction.VersionInstallIntended) {
        try {
            $versionItem = Get-AtomicDirectoryEntry $Transaction.VersionPath
            if ($null -eq $versionItem) {
                $Transaction.VersionInstallIntended = $false
            }
            else {
                Remove-AtomicDirectoryLinkOrTree $versionItem.FullName $tempCleanupRetryLimit $tempCleanupRetryDelayMilliseconds $Transaction.RollbackRetryBudget
                $Transaction.VersionInstallIntended = $false
            }
        }
        catch { Write-Warning -Message "Failed to remove the unsuccessful version directory: $_" -WarningAction Continue }
    }
    if ($Transaction.VersionBackupIntended) {
        try {
            $versionBackupItem = Get-AtomicDirectoryEntry $Transaction.VersionBackupPath
            $versionDestinationItem = Get-AtomicDirectoryEntry $Transaction.VersionPath
            if ($null -ne $versionBackupItem -and $null -eq $versionDestinationItem) {
                Move-AtomicItem -LiteralPath $versionBackupItem.FullName -Destination $Transaction.VersionPath -RetryBudget $Transaction.RollbackRetryBudget
                $Transaction.VersionBackupIntended = $false
            }
            elseif ($null -eq $versionBackupItem -and $null -ne $versionDestinationItem) {
                $Transaction.VersionBackupIntended = $false
            }
        }
        catch { Write-Warning -Message "Failed to restore the previous version directory: $_" -WarningAction Continue }
    }

    if ($Transaction.CurrentPathChangeIntended) {
        try {
            $env:Path = $Transaction.OldCurrentPath
            $Transaction.CurrentPathChangeIntended = $false
        }
        catch { Write-Warning -Message "Failed to restore the current PATH after installation failure: $_" -WarningAction Continue }
    }
    if ($Transaction.UserPathChangeIntended) {
        try {
            Set-AtomicUserPathValue $Transaction.OldUserPath $Transaction.OldUserPathKind
            $Transaction.UserPathChangeIntended = $false
        }
        catch { Write-Warning -Message "Failed to restore the User PATH after installation failure: $_" -WarningAction Continue }
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
    param(
        [hashtable]$Transaction,
        [int]$RetryLimit,
        [int]$RetryDelayMilliseconds
    )

    if ($null -eq $Transaction) {
        return
    }

    $shimBackupItem = Get-AtomicDirectoryEntry $Transaction.ShimBackupPath
    if ($null -ne $shimBackupItem) {
        $removal = Remove-AtomicTreeWithRetry $shimBackupItem.FullName $RetryLimit $RetryDelayMilliseconds
        if (-not $removal.Removed) {
            Write-Warning -Message "Installed successfully, but could not remove the previous shim backup: $($removal.LastError)" -WarningAction Continue
        }
    }
    foreach ($backup in @(
        @{ Name = "atomic-current"; Path = $Transaction.AtomicCurrentBackupPath },
        @{ Name = "current"; Path = $Transaction.CurrentBackupPath },
        @{ Name = "version"; Path = $Transaction.VersionBackupPath }
    )) {
        $backupItem = Get-AtomicDirectoryEntry $backup.Path
        if ($null -eq $backupItem) {
            continue
        }
        if (($backupItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            try { [IO.Directory]::Delete($backupItem.FullName) }
            catch { Write-Warning -Message "Installed successfully, but could not remove the previous $($backup.Name) backup: $_" -WarningAction Continue }
            continue
        }
        $removal = Remove-AtomicTreeWithRetry $backupItem.FullName $RetryLimit $RetryDelayMilliseconds
        if (-not $removal.Removed) {
            Write-Warning -Message "Installed successfully, but could not remove the previous $($backup.Name) backup: $($removal.LastError)" -WarningAction Continue
        }
    }
}

# The User PATH as stored: unexpanded (%USERPROFILE%\bin stays as written) and with its registry type, so rewriting it
# never turns a REG_EXPAND_SZ value into literal paths.
function Get-AtomicUserPathValue {
    if (-not $IsWindowsHost) {
        return [pscustomobject]@{ Value = [Environment]::GetEnvironmentVariable("Path", "User"); Kind = $null }
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
    if ($null -eq $key) {
        return [pscustomobject]@{ Value = $null; Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    }
    try {
        $value = $key.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kind = if ($null -eq $value) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $key.GetValueKind("Path") }
        return [pscustomobject]@{ Value = $value; Kind = $kind }
    }
    finally {
        $key.Close()
    }
}

function Set-AtomicUserPathValue {
    # [object], not [string]: a [string] parameter turns $null into "", which would write an empty Path
    # instead of removing a value the user never had.
    param([AllowNull()][object]$Value, $Kind)

    if (-not $IsWindowsHost -or $null -eq $Kind) {
        [Environment]::SetEnvironmentVariable("Path", $Value, "User")
        return
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
    try {
        if ($null -eq $Value) {
            $key.DeleteValue("Path", $false)
        }
        else {
            $key.SetValue("Path", $Value, $Kind)
        }
    }
    finally {
        $key.Close()
    }
    # Tell running programs the environment changed, as SetEnvironmentVariable does.
    [Environment]::SetEnvironmentVariable("ATOMIC_INSTALL_PATH_REFRESH", $null, "User")
}

function Add-AtomicBinDirToPath {
    param([string]$BinDir)

    $userPathChanged = $false
    $userPathValue = Get-AtomicUserPathValue
    $userPath = $userPathValue.Value
    $expandedUserPath = if ($null -eq $userPath) { $null } else { [Environment]::ExpandEnvironmentVariables($userPath) }
    if (-not $binDirHasPathSeparator -and -not (Test-AtomicPathContains $expandedUserPath $BinDir)) {
        $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $BinDir } else { "$userPath;$BinDir" }
        Set-AtomicUserPathValue $newUserPath $userPathValue.Kind
        $userPathChanged = $true
    }
    if (-not $binDirHasPathSeparator -and -not (Test-AtomicPathContains $env:Path $BinDir)) {
        $env:Path = if ([string]::IsNullOrWhiteSpace($env:Path)) { $BinDir } else { "$env:Path;$BinDir" }
    }
    return $userPathChanged
}

# 0.9.42 is the first release whose `atomic intercom` is a subcommand: an older one reads `intercom upgrade` as a
# prompt for the model.
# One installer at a time per install root. The lock is a file held open exclusively and deleted when its handle
# closes, so the system releases it when an installer exits or is killed.
function Enter-AtomicInstallLock {
    param([string]$InstallRoot, [int]$TimeoutSeconds)

    $lockPath = Join-Path $InstallRoot ".install.lock"
    $waited = 0
    $announced = $false
    while ($true) {
        try {
            return [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
        }
        catch [IO.IOException] {
            if (-not $announced) {
                $announced = $true
                Write-AtomicMuted "Waiting for another atomic installer to finish..."
            }
            if ($waited -ge $TimeoutSeconds) {
                throw "Another atomic installer is still running for $InstallRoot; rerun after it finishes."
            }
            Start-Sleep -Seconds 1
            $waited++
        }
    }
}

# Under the lock no other installer is running, so what a killed installer left behind can go: staged copies and
# temporary links always (unless `current` points at one), backups once `current` points at a complete version. A
# `current` that a killed installer moved aside is put back first.
function Clear-AtomicInstallLeftovers {
    param([string]$InstallRoot, [string]$BinDir)

    $currentPath = Join-Path $InstallRoot "current"
    if ($null -eq (Get-AtomicDirectoryEntry $currentPath)) {
        foreach ($backup in @(Get-ChildItem -LiteralPath $InstallRoot -Force -Filter ".current-backup-*" -ErrorAction SilentlyContinue)) {
            $backupTarget = Get-AtomicReparseTarget $backup
            if (-not [string]::IsNullOrWhiteSpace($backupTarget) -and (Test-AtomicInstalledPayloadComplete $backup.FullName)) {
                Move-AtomicItem -LiteralPath $backup.FullName -Destination $currentPath
                break
            }
        }
    }
    $currentTarget = Get-AtomicReparseTarget (Get-AtomicDirectoryEntry $currentPath)
    $currentComparable = if ([string]::IsNullOrWhiteSpace($currentTarget)) { $null } else { Get-AtomicComparablePath $currentTarget }
    $healthy = $null -ne $currentComparable -and (Test-AtomicInstalledPayloadComplete $currentPath)
    $versionsDir = Join-Path $InstallRoot "versions"
    $candidates = @(
        @{ Dir = $versionsDir; Filter = ".stage-*"; Backup = $false },
        @{ Dir = $InstallRoot; Filter = ".current-*"; Backup = $false },
        # Only the bin directory's `atomic-current` junctions can be traced to this install root; other roots'
        # installers may share the bin directory, and their shims and junctions are not this run's to remove.
        @{ Dir = $BinDir; Filter = ".atomic-current-*"; Backup = $false },
        @{ Dir = $versionsDir; Filter = ".backup-*"; Backup = $true }
    )
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate.Dir -PathType Container)) {
            continue
        }
        foreach ($entry in @(Get-ChildItem -LiteralPath $candidate.Dir -Force -Filter $candidate.Filter -ErrorAction SilentlyContinue)) {
            $isBackup = $candidate.Backup -or $entry.Name -like ".current-backup-*" -or $entry.Name -like ".atomic-current-backup-*" -or
                $entry.Name -like ".atomic-backup-*"
            if ($isBackup -and -not $healthy) {
                continue
            }
            if ($candidate.Dir -eq $BinDir) {
                $junctionTarget = Get-AtomicReparseTarget $entry
                if ([string]::IsNullOrWhiteSpace($junctionTarget)) {
                    continue
                }
                $rootPrefix = (Get-AtomicComparablePath $InstallRoot).TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
                if (-not (Get-AtomicComparablePath $junctionTarget).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    continue
                }
            }
            if ($null -ne $currentComparable -and (Get-AtomicComparablePath $entry.FullName) -ieq $currentComparable) {
                continue
            }
            try {
                if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -and $entry.PSIsContainer) {
                    [IO.Directory]::Delete($entry.FullName)
                }
                else {
                    Remove-Item -LiteralPath $entry.FullName -Recurse -Force
                }
            }
            catch {
                Write-Warning -Message "Failed to remove a leftover from an earlier installer: $($entry.FullName): $_" -WarningAction Continue
            }
        }
    }
}

function Test-AtomicReleaseHasIntercomCommand {
    param([string]$Tag)

    return [version]($Tag -replace '-alpha\.[0-9]+$', '') -ge [version]'0.9.42'
}

# Whether the installed shim lists `atomic intercom upgrade` in its Intercom help. Every redirection happens inside
# cmd, so Windows PowerShell never turns the probe's stderr into an error record.
function Test-AtomicShimHasIntercomUpgrade {
    param([string]$ShimPath)

    $helpLines = @(& $env:ComSpec /d /c ('"' + $ShimPath + '" intercom --help <NUL 2>NUL'))
    if ($LASTEXITCODE -ne 0) {
        return $false
    }
    return @($helpLines | Where-Object { ([string]$_).Trim() -ceq 'atomic intercom upgrade' }).Count -gt 0
}

# Replace an Intercom broker the previous version left running, when that is safe (#4538). A release without the
# command skips it, and it reads no input. The install is already committed when this runs, so a failure only warns.
function Invoke-AtomicIntercomUpgrade {
    param([string]$ShimPath, [string]$ReleaseTag)

    try {
        if (-not (Test-AtomicReleaseHasIntercomCommand $ReleaseTag) -or -not (Test-AtomicShimHasIntercomUpgrade $ShimPath)) {
            return
        }
        $upgradeCommand = '"' + $ShimPath + '" intercom upgrade <NUL'
        & $env:ComSpec /d /c $upgradeCommand | Out-Host
        $upgradeExitCode = $LASTEXITCODE
        if ($upgradeExitCode -ne 0) {
            Write-Warning -Message "Installed atomic, but 'atomic intercom upgrade' exited with code $upgradeExitCode; run it manually if new sessions do not start." -WarningAction Continue
        }
    }
    catch {
        Write-Warning -Message "Installed atomic, but 'atomic intercom upgrade' failed: $_; run it manually if new sessions do not start." -WarningAction Continue
    }
}

function Write-AtomicInstallSummary {
    param([bool]$UserPathAdded)

    Write-Output "Installed to $shimPath"
    if ($useUnicodeGlyphs) {
        Write-Host ""
        foreach ($bannerLine in (Get-AtomicBannerLines)) {
            Write-Host $bannerLine
        }
    }
    if (-not $plainOutput) {
        Write-Host ""
        Write-Host "To start:"
        Write-Host ""
        Write-Host "cd <project>" -NoNewline
        Write-AtomicMuted "  # Open directory"
        Write-Host "atomic" -NoNewline
        Write-AtomicMuted "        # Run command"
        Write-Host ""
    }
    if ($binDirHasPathSeparator) {
        Write-Output "ATOMIC_BIN_DIR contains ';' and cannot be represented as one Windows PATH entry."
        Write-Output "Run Atomic directly: `"$shimPath`""
        Write-Output "Choose a semicolon-free ATOMIC_BIN_DIR to add Atomic to PATH."
    }
    elseif ($UserPathAdded) {
        Write-Output "Added $binDir to your User PATH; open a new terminal to use atomic."
    }
    if (-not $plainOutput -and ($binDirHasPathSeparator -or $UserPathAdded)) {
        Write-Host ""
    }
    Write-AtomicMuted "For more information visit https://docs.bastani.ai/quickstart"
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
$tempCleanupRetryLimit = 9
$tempCleanupRetryDelayMilliseconds = 250
$downloadHeaderTimeoutMilliseconds = 60000
$downloadStallTimeoutMilliseconds = 60000
$primaryError = $null
$tempCleanupError = $null

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
$physicalInstallRoot = Get-AtomicPhysicalPath $installRoot
$physicalBinDir = Get-AtomicPhysicalPath $binDir
$ownedInstallPaths = @(
    (Join-Path $installRoot "current"),
    (Join-Path $installRoot "versions"),
    (Join-Path $physicalInstallRoot "current"),
    (Join-Path $physicalInstallRoot "versions")
)
$binCandidates = @($binDir, $physicalBinDir)
foreach ($ownedInstallPath in $ownedInstallPaths) {
    $ownedInstallPrefix = $ownedInstallPath.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
    foreach ($binCandidate in $binCandidates) {
        if ($binCandidate -ieq $ownedInstallPath -or
            $binCandidate.StartsWith($ownedInstallPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "ATOMIC_BIN_DIR cannot be inside ATOMIC_INSTALL_DIR\current or ATOMIC_INSTALL_DIR\versions"
        }
    }
}

$previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
try {
    [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$forceInstall = $Force.IsPresent -or $env:ATOMIC_FORCE_INSTALL -eq "1"
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


$binDirHasPathSeparator = $binDir.Contains(";")
$atomicCurrentPath = Join-Path $binDir "atomic-current"
$shimPath = Join-Path $binDir "atomic.cmd"
$shimContent = "@echo off`r`n`"%~dp0atomic-current\atomic.exe`" %*`r`nexit /b %ERRORLEVEL%`r`n"
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
# The programs this installer starts (atomic.exe, cmd.exe) never see the token; the caller's variables come back at exit.
$savedTokenVariables = @{ GITHUB_TOKEN = $env:GITHUB_TOKEN; GH_TOKEN = $env:GH_TOKEN }
$env:GITHUB_TOKEN = $null
$env:GH_TOKEN = $null
$token = $null

$installLockTimeout = 1800
if (-not [string]::IsNullOrWhiteSpace($env:ATOMIC_INSTALL_LOCK_TIMEOUT)) {
    if (-not [int]::TryParse($env:ATOMIC_INSTALL_LOCK_TIMEOUT, [ref]$installLockTimeout) -or $installLockTimeout -lt 0) {
        throw "ATOMIC_INSTALL_LOCK_TIMEOUT must be a whole number of seconds."
    }
}
# The lock lives in the install root; directories created for it are removed again when nothing gets installed.
$lockCreatedDirectories = New-Object System.Collections.ArrayList
Add-AtomicMissingDirectoryPaths $lockCreatedDirectories $installRoot
if ($lockCreatedDirectories.Count -gt 0) {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
}
$installLock = Enter-AtomicInstallLock $installRoot $installLockTimeout
Clear-AtomicInstallLeftovers $installRoot $binDir

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
    $pinnedInstalledVersion = $null
    if (-not $forceInstall) {
        $pinnedInstalledVersion = Get-AtomicInstalledVersion (Join-Path (Join-Path $installRoot "current") "atomic.exe")
    }
    $releasePageStatus = $null
    if (-not [string]::IsNullOrWhiteSpace($pinnedInstalledVersion) -and
        (Test-AtomicInstallVerified $pinnedInstalledVersion $requestedRef $installRoot $binDir $shimContent)) {
        # The pinned release is already installed and healthy: it needs no network request.
        $releasePageStatus = "installed"
    }
    # An exact tag is confirmed on github.com by its release's SHA256SUMS; the REST API, limited to 60 requests an
    # hour per address without a token, is asked only when github.com cannot tell.
    if ($null -eq $releasePageStatus) {
        $releasePageStatus = Get-AtomicReleasePageStatus $encodedRequestedRef
    }
    if ($releasePageStatus -eq "found" -or $releasePageStatus -eq "installed") {
        $releaseTag = $requestedRef
    }
    elseif ($releasePageStatus -eq "missing") {
        throw "release $requestedRef not found."
    }
    else {
        $release = Invoke-AtomicApiRequest "$tagsApiBase/$encodedRequestedRef" $apiHeaders $requestedRef
    }
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

$platformLabel = ($assetName -replace '^atomic-', '') -replace '\.zip$', ''
Write-AtomicLabeled "Installing atomic version: " $releaseTag " ($platformLabel)"
$installedVersion = Get-AtomicInstalledVersion (Join-Path (Join-Path $installRoot "current") "atomic.exe")
if (-not [string]::IsNullOrWhiteSpace($installedVersion)) {
    if (-not $forceInstall -and (Test-AtomicInstallIntact $installedVersion $releaseTag $installRoot $binDir $shimContent)) {
        Write-AtomicMuted "atomic $releaseTag is already installed; skipping download (use -Force to reinstall)"
        $userPathAdded = Add-AtomicBinDirToPath $binDir
        Write-AtomicInstallSummary $userPathAdded
        return
    }
    if ($installedVersion -ceq $releaseTag) {
        Write-AtomicLabeled "Version " $releaseTag " already installed"
    }
    else {
        Write-AtomicMuted "Installed version: $installedVersion"
    }
}

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("atomic-install-" + [Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $tempDir $assetName
$checksumsPath = Join-Path $tempDir "SHA256SUMS"
$payloadPath = Join-Path $tempDir "payload"

try {
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    if (-not (Invoke-AtomicDownloadWithProgress "$releaseBase/$assetName" $archivePath $assetName)) {
        Write-AtomicMuted -NoNewline "Downloading $assetName ... "
        try {
            Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath
        }
        catch {
            Write-Host ""
            throw
        }
        Write-AtomicMuted "done"
    }
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
    Expand-AtomicReleaseArchive $archivePath $payloadPath
    $stagedAtomic = Join-Path $payloadPath "atomic.exe"
    if (-not (Test-Path -LiteralPath $stagedAtomic -PathType Leaf)) {
        throw "Release archive $assetName does not contain atomic.exe at its root."
    }

    $null = & $stagedAtomic "--version"
    $stagedExitCode = $LASTEXITCODE
    if ($stagedExitCode -ne 0) {
        throw "Staged atomic.exe --version failed with exit code $stagedExitCode."
    }
    # The launcher's hash, recorded beside it, lets a later run confirm the installed payload
    # without the network (see Test-AtomicInstallVerified).
    $launcherSha256 = (Get-AtomicFileSha256 $stagedAtomic).ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $payloadPath ".atomic-launcher.sha256"), $launcherSha256 + "`n")
    Write-AtomicMuted "Verified SHA256, extracted, and checked atomic --version"

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
    $oldUserPathValue = Get-AtomicUserPathValue
    $oldUserPath = $oldUserPathValue.Value
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
        OldUserPathKind = $oldUserPathValue.Kind
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
        RollbackRetryBudget = @{ RemainingMilliseconds = 9500 }
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
            Move-AtomicItem -LiteralPath $previousVersionItem.FullName -Destination $versionBackupPath
        }
        $transaction.VersionInstallIntended = $true
        Move-AtomicItem -LiteralPath $versionStagePath -Destination $versionPath

        New-Item -ItemType Junction -Path $currentNextPath -Target $versionPath | Out-Null
        $previousCurrentItem = Get-AtomicDirectoryEntry $currentPath
        if ($null -ne $previousCurrentItem) {
            $transaction.CurrentBackupIntended = $true
            Move-AtomicItem -LiteralPath $previousCurrentItem.FullName -Destination $currentBackupPath
        }
        $transaction.CurrentInstallIntended = $true
        Move-AtomicItem -LiteralPath $currentNextPath -Destination $currentPath

        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        New-Item -ItemType Junction -Path $atomicCurrentNextPath -Target $versionPath | Out-Null
        Set-Content -LiteralPath $shimNextPath -Value $shimContent -Encoding ASCII -NoNewline

        $previousAtomicCurrentItem = Get-AtomicDirectoryEntry $atomicCurrentPath
        if ($null -ne $previousAtomicCurrentItem) {
            $transaction.AtomicCurrentBackupIntended = $true
            Move-AtomicItem -LiteralPath $previousAtomicCurrentItem.FullName -Destination $atomicCurrentBackupPath
        }
        $previousShimItem = Get-AtomicDirectoryEntry $shimPath
        if ($null -ne $previousShimItem) {
            $transaction.ShimBackupIntended = $true
            Move-AtomicItem -LiteralPath $previousShimItem.FullName -Destination $shimBackupPath
        }
        $transaction.AtomicCurrentInstallIntended = $true
        Move-AtomicItem -LiteralPath $atomicCurrentNextPath -Destination $atomicCurrentPath
        $transaction.ShimInstallIntended = $true
        Move-AtomicItem -LiteralPath $shimNextPath -Destination $shimPath

        $expandedOldUserPath = if ($null -eq $oldUserPath) { $null } else { [Environment]::ExpandEnvironmentVariables($oldUserPath) }
        if (-not $binDirHasPathSeparator -and -not (Test-AtomicPathContains $expandedOldUserPath $binDir)) {
            $newUserPath = if ([string]::IsNullOrWhiteSpace($oldUserPath)) { $binDir } else { "$oldUserPath;$binDir" }
            $transaction.UserPathChangeIntended = $true
            Set-AtomicUserPathValue $newUserPath $oldUserPathValue.Kind
        }
        if (-not $binDirHasPathSeparator -and -not (Test-AtomicPathContains $env:Path $binDir)) {
            $transaction.CurrentPathChangeIntended = $true
            $env:Path = if ([string]::IsNullOrWhiteSpace($env:Path)) { $binDir } else { "$env:Path;$binDir" }
        }

        $shimCommand = '"' + $shimPath + '" --version'
        $null = & $env:ComSpec /d /c $shimCommand
        $finalExitCode = $LASTEXITCODE
        if ($finalExitCode -ne 0) {
            throw "Installed atomic.cmd --version failed with exit code $finalExitCode."
        }

        $transactionCommitted = $true
        Remove-AtomicTransactionBackups $transaction $tempCleanupRetryLimit $tempCleanupRetryDelayMilliseconds
    }
    catch {
        $commitError = $_
        if (-not $transactionCommitted) {
            Invoke-AtomicTransactionRollback $transaction
        }
        throw $commitError
    }

    Invoke-AtomicIntercomUpgrade $shimPath $releaseTag
    Write-AtomicInstallSummary $transaction.UserPathChangeIntended
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
            Write-Warning -Message "Installation rollback remains incomplete after $rollbackRetryLimit final cleanup attempts; transaction backups were retained for recovery." -WarningAction Continue
        }
    }
    if ($null -ne $transaction -and $transactionCommitted) {
        Remove-AtomicTransactionBackups $transaction $tempCleanupRetryLimit $tempCleanupRetryDelayMilliseconds
    }

    if ($null -ne $shimNextPath -and $null -ne (Get-AtomicDirectoryEntry $shimNextPath)) {
        $null = Remove-AtomicTreeWithRetry $shimNextPath $tempCleanupRetryLimit $tempCleanupRetryDelayMilliseconds
    }
    if ($null -ne $atomicCurrentNextPath -and $null -ne (Get-AtomicDirectoryEntry $atomicCurrentNextPath)) {
        try { Remove-AtomicDirectoryLinkOrTree $atomicCurrentNextPath }
        catch { Write-Warning -Message "Failed to remove temporary atomic-current pointer ${atomicCurrentNextPath}: $_" -WarningAction Continue }
    }
    if ($null -ne $currentNextPath -and $null -ne (Get-AtomicDirectoryEntry $currentNextPath)) {
        try { Remove-AtomicDirectoryLinkOrTree $currentNextPath }
        catch { Write-Warning -Message "Failed to remove temporary current pointer ${currentNextPath}: $_" -WarningAction Continue }
    }
    if ($null -ne $versionStagePath -and $null -ne (Get-AtomicDirectoryEntry $versionStagePath)) {
        $null = Remove-AtomicTreeWithRetry $versionStagePath $tempCleanupRetryLimit $tempCleanupRetryDelayMilliseconds
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
            Write-Warning -Message "Temporary download directory cleanup remains incomplete: $tempCleanupError" -WarningAction Continue
        }
        else {
            throw $tempCleanupError
        }
    }
}
}
finally {
    if ($null -ne (Get-Variable -Name installLock -ValueOnly -ErrorAction SilentlyContinue)) {
        $installLock.Dispose()
        if (-not (Get-Variable -Name transactionCommitted -ValueOnly -ErrorAction SilentlyContinue)) {
            $createdForThisRun = New-Object System.Collections.ArrayList
            foreach ($createdList in @((Get-Variable -Name lockCreatedDirectories -ValueOnly -ErrorAction SilentlyContinue),
                    (Get-Variable -Name transactionMissingDirectories -ValueOnly -ErrorAction SilentlyContinue))) {
                if ($null -ne $createdList) {
                    foreach ($createdPath in $createdList) { [void]$createdForThisRun.Add($createdPath) }
                }
            }
            Remove-AtomicCreatedEmptyDirectories $createdForThisRun
        }
    }
    if ($null -ne (Get-Variable -Name savedTokenVariables -ValueOnly -ErrorAction SilentlyContinue)) {
        $env:GITHUB_TOKEN = $savedTokenVariables.GITHUB_TOKEN
        $env:GH_TOKEN = $savedTokenVariables.GH_TOKEN
    }
    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
    }
    catch {
        Write-Warning -Message "Failed to restore the caller's TLS protocol setting: $_" -WarningAction Continue
    }
}
} @args
