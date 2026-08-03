import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const installerPath = join(root, "install.ps1");

function installerSource(): string {
	return readFileSync(installerPath, "utf8");
}

test("Windows installer declares the PowerShell 5.1 archive installation contract", () => {
	const source = installerSource();

	assert.match(source, /param\([\s\S]*\[string\]\$Ref[\s\S]*\[switch\]\$Help[\s\S]*\)/u);
	assert.match(source, /ATOMIC_VERSION/u);
	assert.match(source, /ATOMIC_INSTALL_DIR/u);
	assert.match(source, /ATOMIC_BIN_DIR/u);
	const explicitRef = source.indexOf('$PSBoundParameters.ContainsKey("Ref")');
	const versionFallback = source.indexOf("$env:ATOMIC_VERSION", explicitRef);
	assert.ok(explicitRef >= 0 && versionFallback > explicitRef);
	const githubToken = source.indexOf("$env:GITHUB_TOKEN");
	const ghToken = source.indexOf("$env:GH_TOKEN", githubToken);
	assert.ok(githubToken >= 0 && ghToken > githubToken);
	assert.match(source, /https:\/\/github\.com\/bastani-inc\/atomic\/releases\/latest/u);
	assert.match(source, /\/repos\/bastani-inc\/atomic\/releases\/latest/u);
	assert.match(source, /\/repos\/bastani-inc\/atomic\/releases\/tags/u);
	const redirectAttempt = source.indexOf("$redirectTag = Get-AtomicRedirectTag");
	const latestApiFallback = source.indexOf("Invoke-AtomicApiRequest $latestApi");
	assert.ok(redirectAttempt >= 0 && latestApiFallback > redirectAttempt);
	assert.match(source, /\$releaseTag\s*=\s*\[string\]\$release\.tag_name/u);

	const wow64Architecture = source.indexOf("PROCESSOR_ARCHITEW6432");
	const processArchitecture = source.indexOf("PROCESSOR_ARCHITECTURE");
	assert.ok(wow64Architecture >= 0 && processArchitecture > wow64Architecture);
	assert.match(source, /atomic-windows-x64\.zip/u);
	assert.match(source, /atomic-windows-arm64\.zip/u);

	assert.match(source, /Invoke-WebRequest[\s\S]*-UseBasicParsing/u);
	assert.match(source, /Get-FileHash\s+-LiteralPath\s+\$archivePath\s+-Algorithm\s+SHA256/u);
	assert.match(source, /Expand-Archive\s+-LiteralPath\s+\$archivePath/u);
	assert.doesNotMatch(source, /ConvertFrom-Json\s+-AsHashtable/u);
	assert.doesNotMatch(source, /\?\?|ForEach-Object\s+-Parallel|\?\s+[^:\r\n]+\s+:/u);
	assert.doesNotMatch(source, /\b(?:npm|pnpm|yarn|bun|node|git|jq)(?:\.exe)?\b/iu);
	assert.match(source, /\^\(\[A-Fa-f0-9\]\{64\}\) \(\[ \*\]\)\(\[\^\\\\\/\\r\\n\]\+\)\$/u);
	assert.match(source, /\$checksumAssetRows\.Count\s+-ne\s+1/u);

	const checksumComparison = source.indexOf("Checksum verification failed");
	const installMutation = source.indexOf("New-Item -ItemType Directory -Path $versionsDir");
	assert.ok(checksumComparison >= 0 && installMutation > checksumComparison);
	assert.match(source, /New-Item\s+-ItemType\s+Junction/u);
	assert.match(source, /\[Environment\]::SetEnvironmentVariable\("Path",\s*\$newUserPath,\s*"User"\)/u);
	assert.match(source, /&\s+\$stagedAtomic\s+"--version"[\s\S]*\$LASTEXITCODE/u);
	assert.match(source, /&\s+\$env:ComSpec\s+\/d\s+\/c\s+\$shimCommand[\s\S]*\$LASTEXITCODE/u);

	assert.match(source, /LOCALAPPDATA[\\/]atomic/u);
	assert.match(source, /Default bin directory:[^\r\n]*LOCALAPPDATA[\\/]atomic[\\/]bin/u);
	assert.match(source, /Restart your terminal/u);
});

test("Windows installer uses a successful latest redirect without querying the GitHub API", () => {
	const source = installerSource();
	const redirectAttempt = source.indexOf("$redirectTag = Get-AtomicRedirectTag");
	const latestApiFallback = source.indexOf("Invoke-AtomicApiRequest $latestApi", redirectAttempt);
	const redirectSuccessStart = source.indexOf("else {", latestApiFallback);
	const requestedRefStart = source.indexOf("\nelse {", redirectSuccessStart + 1);
	assert.ok(
		redirectAttempt >= 0 && latestApiFallback > redirectAttempt && redirectSuccessStart > latestApiFallback,
		"latest release resolution branches were not found",
	);
	assert.ok(requestedRefStart > redirectSuccessStart, "explicit ref resolution branch was not found");

	const redirectSuccess = source.slice(redirectSuccessStart, requestedRefStart);
	assert.match(redirectSuccess, /\$releaseTag\s*=\s*\$redirectTag/u);
	assert.doesNotMatch(redirectSuccess, /Invoke-AtomicApiRequest|api\.github\.com/u);

	const apiRequest = source.slice(
		source.indexOf("function Invoke-AtomicApiRequest"),
		source.indexOf("function Invoke-AtomicDownload"),
	);
	const assetDownload = source.slice(
		source.indexOf("function Invoke-AtomicDownload"),
		source.indexOf("function Test-AtomicPathContains"),
	);
	assert.match(apiRequest, /Invoke-WebRequest[^\r\n]+-Headers\s+\$Headers/u);
	assert.doesNotMatch(assetDownload, /-Headers/u);
});

test("Windows installer writes an exact ASCII shim through a sibling atomic-current junction", () => {
	const source = installerSource();
	const expectedShimAssignment =
		'$shimContent = "@echo off`r`n`"%~dp0atomic-current\\atomic.exe`" %*`r`nexit /b %ERRORLEVEL%`r`n"';
	assert.ok(source.includes(expectedShimAssignment), "shim source is not the exact relative atomic-current command");

	const shimWrite = source.match(/Set-Content\s+-LiteralPath\s+\$shimNextPath[^\r\n]*/u)?.[0] ?? "";
	assert.match(shimWrite, /-Encoding\s+ASCII/u);
	assert.doesNotMatch(shimWrite, /-Encoding\s+Unicode/iu);
	assert.match(source, /\$atomicCurrentPath\s*=\s*Join-Path\s+\$binDir\s+"atomic-current"/u);
	assert.match(source, /New-Item\s+-ItemType\s+Junction\s+-Path\s+\$atomicCurrentNextPath\s+-Target\s+\$versionPath/u);
});

test("Windows installer finds and removes junctions through their parent directory entries", () => {
	const source = installerSource();
	const entryLookup = source.slice(
		source.indexOf("function Get-AtomicDirectoryEntry"),
		source.indexOf("function Remove-AtomicDirectoryLinkOrTree"),
	);
	const linkRemoval = source.slice(
		source.indexOf("function Remove-AtomicDirectoryLinkOrTree"),
		source.indexOf("$requestedRef = $null"),
	);

	assert.match(entryLookup, /Get-ChildItem\s+-LiteralPath\s+\$parentPath\s+-Force/u);
	assert.match(entryLookup, /\.Name\s+-ieq\s+\$leafName/u);
	assert.match(linkRemoval, /\$item\s*=\s*Get-AtomicDirectoryEntry\s+\$Path/u);
	assert.match(linkRemoval, /\[IO\.Directory\]::Delete\(\$item\.FullName\)/u);
	assert.match(source, /Get-AtomicDirectoryEntry\s+\$currentPath/u);
	assert.match(source, /Get-AtomicDirectoryEntry\s+\$currentNextPath/u);
	assert.match(source, /Remove-AtomicDirectoryLinkOrTree\s+\$currentBackupPath/u);
	assert.doesNotMatch(source, /Test-Path\s+-LiteralPath\s+\$(?:currentPath|currentNextPath|currentBackupPath)\b/u);
});

test("Windows installer removes staged children before only empty transaction-created parents", () => {
	const source = installerSource();
	const emptyDirectoryRemoval = source.slice(
		source.indexOf("function Remove-AtomicEmptyDirectory"),
		source.indexOf("$requestedRef = $null"),
	);
	assert.match(emptyDirectoryRemoval, /\[IO\.Directory\]::Delete\(\$item\.FullName,\s*\$false\)/u);
	assert.doesNotMatch(emptyDirectoryRemoval, /Remove-Item|-Recurse/u);

	const cleanup = source.slice(source.indexOf("finally {"));
	const shimStageCleanup = cleanup.indexOf("$shimNextPath");
	const junctionStageCleanup = cleanup.indexOf("$atomicCurrentNextPath", shimStageCleanup);
	const versionStageCleanup = cleanup.indexOf("$versionStagePath", junctionStageCleanup);
	const downloadCleanup = cleanup.indexOf("$tempDir", versionStageCleanup);
	const binParentCleanup = cleanup.indexOf("Remove-AtomicEmptyDirectory $binDir", downloadCleanup);
	const versionsParentCleanup = cleanup.indexOf("Remove-AtomicEmptyDirectory $versionsDir", binParentCleanup);
	const rootParentCleanup = cleanup.indexOf("Remove-AtomicEmptyDirectory $installRoot", versionsParentCleanup);
	assert.ok(
		shimStageCleanup >= 0 &&
			junctionStageCleanup > shimStageCleanup &&
			versionStageCleanup > junctionStageCleanup &&
			downloadCleanup > versionStageCleanup &&
			binParentCleanup > downloadCleanup &&
			versionsParentCleanup > binParentCleanup &&
			rootParentCleanup > versionsParentCleanup,
		"cleanup does not remove staged children and downloads before parent directories",
	);
	assert.match(cleanup, /if \(\$binDirCreated\)[\s\S]*if \(\$versionsDirCreated\)[\s\S]*if \(\$installRootCreated\)/u);
	assert.doesNotMatch(source, /Remove-Item\s+-LiteralPath\s+\$(?:binDir|versionsDir|installRoot)\b/u);

	const versionsCreation = source.indexOf("New-Item -ItemType Directory -Path $versionsDir -Force");
	const versionsCreatedFlag = source.indexOf("$versionsDirCreated = -not $versionsDirExisted", versionsCreation);
	const versionStageCreation = source.indexOf(
		"New-Item -ItemType Directory -Path $versionStagePath",
		versionsCreatedFlag,
	);
	const binCreation = source.indexOf("New-Item -ItemType Directory -Path $binDir -Force", versionStageCreation);
	const binCreatedFlag = source.indexOf("$binDirCreated = -not $binDirExisted", binCreation);
	const junctionCreation = source.indexOf("New-Item -ItemType Junction -Path $atomicCurrentNextPath", binCreatedFlag);
	assert.ok(
		versionsCreation >= 0 &&
			versionsCreatedFlag > versionsCreation &&
			versionStageCreation > versionsCreatedFlag &&
			binCreation > versionStageCreation &&
			binCreatedFlag > binCreation &&
			junctionCreation > binCreatedFlag,
		"transaction-created parent flags are recorded too late for failure cleanup",
	);
});

function findWindowsPowerShell(): string | undefined {
	if (process.platform !== "win32") return undefined;
	const candidates = ["powershell.exe", "powershell"];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const candidate of candidates) {
			const path = join(directory, candidate);
			if (existsSync(path)) return path;
		}
	}
	return undefined;
}

const powershellExecutable = findWindowsPowerShell();
const powershellTest = powershellExecutable === undefined ? test.skip : test;
const POWERSHELL_FIXTURE_TIMEOUT_MS = 120_000;
const TRANSACTION_FAILURE_FIXTURE_STRUCTURAL_TIMEOUT_MS = 130_000;

const fixtureHarness = String.raw`
param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][string]$Scenario
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) {
    throw "Dynamic installer fixtures require Windows PowerShell 5.1."
}

function Assert-Fixture {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Fixture assertion failed: $Message" }
}

function Test-ExactPathEntry {
    param([AllowNull()][string]$PathValue, [string]$Entry)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return $false }
    $target = $Entry.Trim().Trim('"').TrimEnd([char[]]@('\', '/'))
    foreach ($candidate in ($PathValue -split ';')) {
        if ($candidate.Trim().Trim('"').TrimEnd([char[]]@('\', '/')) -ieq $target) { return $true }
    }
    return $false
}

function Get-ExactPathEntryCount {
    param([AllowNull()][string]$PathValue, [string]$Entry)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return 0 }
    $target = $Entry.Trim().Trim('"').TrimEnd([char[]]@('\', '/'))
    $count = 0
    foreach ($candidate in ($PathValue -split ';')) {
        if ($candidate.Trim().Trim('"').TrimEnd([char[]]@('\', '/')) -ieq $target) { $count++ }
    }
    return $count
}

function Assert-NoTransactionResidue {
    param([string]$InstallRoot, [string]$BinDir)
    $versionsDir = Join-Path $InstallRoot "versions"
    if ([IO.Directory]::Exists($versionsDir)) {
        Assert-Fixture (@(Get-ChildItem -LiteralPath $versionsDir -Force | Where-Object { $_.Name -like ".stage-*" -or $_.Name -like ".backup-*" }).Count -eq 0) "version transaction artifacts were not cleaned"
    }
    if ([IO.Directory]::Exists($InstallRoot)) {
        Assert-Fixture (@(Get-ChildItem -LiteralPath $InstallRoot -Force | Where-Object { $_.Name -like ".current-*" }).Count -eq 0) "current transaction artifacts were not cleaned"
    }
    if ([IO.Directory]::Exists($BinDir)) {
        Assert-Fixture (@(Get-ChildItem -LiteralPath $BinDir -Force | Where-Object { $_.Name -like ".atomic-*" }).Count -eq 0) "shim transaction artifacts were not cleaned"
    }
}

function Test-ByteSequence {
    param([byte[]]$Bytes, [byte[]]$Sequence)
    if ($Sequence.Length -eq 0 -or $Bytes.Length -lt $Sequence.Length) { return $false }
    for ($offset = 0; $offset -le $Bytes.Length - $Sequence.Length; $offset++) {
        $matches = $true
        for ($index = 0; $index -lt $Sequence.Length; $index++) {
            if ($Bytes[$offset + $index] -ne $Sequence[$index]) {
                $matches = $false
                break
            }
        }
        if ($matches) { return $true }
    }
    return $false
}

function Invoke-FixtureShim {
    param([string]$ShimPath, [string]$ArgumentText)
    $commandLine = '"' + $ShimPath + '"'
    if (-not [string]::IsNullOrWhiteSpace($ArgumentText)) {
        $commandLine += " $ArgumentText"
    }
    $cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe"
    $output = & $cmdExe /d /c $commandLine
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = (($output | Out-String).Trim())
    }
}

$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$assetRoot = Join-Path $workspace "releases"
$installRoot = if ($Scenario -eq "unicode") { Join-Path $workspace "安装-Δοκιμή" } else { Join-Path $workspace "install root" }
$binDir = if ($Scenario -eq "unicode") { Join-Path $workspace "自訂-bin-Δ" } else { Join-Path $workspace "bin root" }
$fixtureTemp = Join-Path $workspace "temp"
New-Item -ItemType Directory -Path $assetRoot, $fixtureTemp -Force | Out-Null

$fixtureExecutable = Join-Path $workspace "fixture-atomic.exe"
$fixtureSource = @'
using System;
using System.IO;
using System.Reflection;

public static class Program
{
    public static int Main(string[] args)
    {
        string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string version = File.ReadAllText(Path.Combine(directory, "version.txt")).Trim();
        string failVersion = Environment.GetEnvironmentVariable("ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION");
        if (String.Equals(version, failVersion, StringComparison.Ordinal) &&
            directory.IndexOf("atomic-install-", StringComparison.OrdinalIgnoreCase) < 0)
        {
            return 23;
        }
        if (args.Length == 1 && args[0] == "--version")
        {
            Console.WriteLine(version);
            return 0;
        }
        if (args.Length == 2 && args[0] == "--exit")
        {
            return Int32.Parse(args[1]);
        }
        Console.WriteLine(version + ":" + String.Join("|", args));
        return 0;
    }
}
'@
Add-Type -TypeDefinition $fixtureSource -OutputAssembly $fixtureExecutable -OutputType ConsoleApplication

function New-FixtureRelease {
    param([string]$Tag)

    $releaseDir = Join-Path $assetRoot $Tag
    $payloadDir = Join-Path $workspace ("payload-" + $Tag)
    New-Item -ItemType Directory -Path (Join-Path $payloadDir "nested") -Force | Out-Null
    Copy-Item -LiteralPath $fixtureExecutable -Destination (Join-Path $payloadDir "atomic.exe")
    Set-Content -LiteralPath (Join-Path $payloadDir "version.txt") -Value $Tag -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $payloadDir "nested\full-payload.txt") -Value ("payload-" + $Tag) -Encoding ASCII -NoNewline
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

    $rows = @()
    foreach ($assetName in @("atomic-windows-x64.zip", "atomic-windows-arm64.zip")) {
        Set-Content -LiteralPath (Join-Path $payloadDir "asset.txt") -Value $assetName -Encoding ASCII -NoNewline
        $archivePath = Join-Path $releaseDir $assetName
        Compress-Archive -Path (Join-Path $payloadDir "*") -DestinationPath $archivePath -CompressionLevel Optimal
        $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $rows += "$hash  $assetName"
    }
    Set-Content -LiteralPath (Join-Path $releaseDir "SHA256SUMS") -Value ($rows -join [Environment]::NewLine) -Encoding ASCII -NoNewline
    Remove-Item -LiteralPath $payloadDir -Recurse -Force
}

New-FixtureRelease "1.0.0"
New-FixtureRelease "2.0.0"

$global:AtomicFixtureAssetRoot = $assetRoot
$global:AtomicFixtureRequests = New-Object System.Collections.ArrayList
$global:AtomicFixtureBadChecksumTag = $null
$global:AtomicFixtureLastAssetName = $null
$global:AtomicFixtureFailApi = $false
$global:AtomicFixtureRedirectFails = $false

function global:Invoke-WebRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Uri,
        [string]$OutFile,
        [hashtable]$Headers,
        [switch]$UseBasicParsing,
        [int]$MaximumRedirection
    )

    $authorization = $null
    if ($null -ne $Headers -and $Headers.ContainsKey("Authorization")) {
        $authorization = [string]$Headers["Authorization"]
    }
    [void]$global:AtomicFixtureRequests.Add([pscustomobject]@{ Uri = $Uri; Authorization = $authorization })

    if ($Uri -eq "https://github.com/bastani-inc/atomic/releases/latest") {
        if ($global:AtomicFixtureRedirectFails) {
            return [pscustomobject]@{
                Headers = @{}
                BaseResponse = [pscustomobject]@{ ResponseUri = [Uri]"https://github.com/bastani-inc/atomic/releases/latest" }
            }
        }
        return [pscustomobject]@{
            Headers = @{ Location = "/bastani-inc/atomic/releases/tag/2.0.0" }
            BaseResponse = [pscustomobject]@{ ResponseUri = [Uri]"https://github.com/bastani-inc/atomic/releases/latest" }
        }
    }

    if ($Uri -match '^https://api\.github\.com/') {
        if ($global:AtomicFixtureFailApi) { throw "GitHub API is unavailable in this fixture scenario: $Uri" }
        if ($Uri -match '/repos/bastani-inc/atomic/releases/latest$') {
            return [pscustomobject]@{ Content = '{"tag_name":"2.0.0"}'; Headers = @{} }
        }
        if ($Uri -match '/repos/bastani-inc/atomic/releases/tags/([^/]+)$') {
            $requestedTag = [Uri]::UnescapeDataString($Matches[1])
            $canonicalTag = if ($requestedTag -eq "requested-alias") { "1.0.0" } else { $requestedTag }
            return [pscustomobject]@{ Content = ('{"tag_name":"' + $canonicalTag + '"}'); Headers = @{} }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($OutFile) -and $Uri -match '/releases/download/([^/]+)/([^/]+)$') {
        $tag = [Uri]::UnescapeDataString($Matches[1])
        $fileName = $Matches[2]
        if ($fileName -eq "SHA256SUMS" -and $global:AtomicFixtureBadChecksumTag -eq $tag) {
            $badHash = "0" * 64
            Set-Content -LiteralPath $OutFile -Value "$badHash  $global:AtomicFixtureLastAssetName" -Encoding ASCII -NoNewline
        }
        else {
            Copy-Item -LiteralPath (Join-Path (Join-Path $global:AtomicFixtureAssetRoot $tag) $fileName) -Destination $OutFile
            if ($fileName -ne "SHA256SUMS") { $global:AtomicFixtureLastAssetName = $fileName }
        }
        return [pscustomobject]@{ StatusCode = 200; Headers = @{} }
    }

    throw "Unexpected fixture request: $Uri"
}

$global:AtomicFixturePayloadCopyCount = 0
$global:AtomicFixtureFailurePoint = $null

function global:New-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$ItemType,
        [Parameter(Mandatory=$true)][string]$Path,
        [string]$Target,
        [switch]$Force
    )

    $leafName = [IO.Path]::GetFileName($Path)
    if ($global:AtomicFixtureFailurePoint -eq "current-create" -and
        $ItemType -eq "Junction" -and $leafName -match '^\.current-[0-9a-f]{32}$') {
        Microsoft.PowerShell.Management\New-Item -ItemType $ItemType -Path $Path -Target $Target -Force:$Force | Out-Null
        throw "Injected transaction failure: current-create"
    }
    if ($global:AtomicFixtureFailurePoint -eq "atomic-current-create" -and
        $ItemType -eq "Junction" -and $leafName -match '^\.atomic-current-[0-9a-f]{32}$') {
        Microsoft.PowerShell.Management\New-Item -ItemType $ItemType -Path $Path -Target $Target -Force:$Force | Out-Null
        throw "Injected transaction failure: atomic-current-create"
    }
    if ($ItemType -eq "Junction") {
        return Microsoft.PowerShell.Management\New-Item -ItemType $ItemType -Path $Path -Target $Target -Force:$Force
    }
    return Microsoft.PowerShell.Management\New-Item -ItemType $ItemType -Path $Path -Force:$Force
}

function global:Copy-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [Parameter(Mandatory=$true)][string]$Destination,
        [switch]$Recurse,
        [switch]$Force
    )

    $destinationLeaf = [IO.Path]::GetFileName($Destination)
    if ($global:AtomicFixtureFailurePoint -eq "payload-copy" -and
        $destinationLeaf -match '^\.stage-[0-9a-f]{32}$') {
        $global:AtomicFixturePayloadCopyCount++
        if ($global:AtomicFixturePayloadCopyCount -ge 2) {
            throw "Injected transaction failure: payload-copy"
        }
    }
    Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Recurse:$Recurse -Force:$Force
}

function global:Set-Content {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [Parameter(Mandatory=$true)]$Value,
        [string]$Encoding,
        [switch]$NoNewline
    )

    $leafName = [IO.Path]::GetFileName($LiteralPath)
    if ($global:AtomicFixtureFailurePoint -eq "shim-stage" -and
        $leafName -match '^\.atomic-[0-9a-f]{32}\.cmd$') {
        Microsoft.PowerShell.Management\Set-Content -LiteralPath $LiteralPath -Value "partial-shim" -Encoding ASCII -NoNewline
        throw "Injected transaction failure: shim-stage"
    }
    if ([string]::IsNullOrWhiteSpace($Encoding)) {
        return Microsoft.PowerShell.Management\Set-Content -LiteralPath $LiteralPath -Value $Value -NoNewline:$NoNewline
    }
    Microsoft.PowerShell.Management\Set-Content -LiteralPath $LiteralPath -Value $Value -Encoding $Encoding -NoNewline:$NoNewline
}

function global:Move-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [Parameter(Mandatory=$true)][string]$Destination
    )

    $leafName = [IO.Path]::GetFileName($LiteralPath)
    if ($global:AtomicFixtureFailurePoint -eq "current-move" -and
        $leafName -match '^\.current-[0-9a-f]{32}$') {
        throw "Injected transaction failure: current-move"
    }
    if ($global:AtomicFixtureFailurePoint -eq "atomic-current-move" -and
        $leafName -match '^\.atomic-current-[0-9a-f]{32}$') {
        throw "Injected transaction failure: atomic-current-move"
    }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}

$environmentNames = @(
    "ATOMIC_INSTALL_DIR", "ATOMIC_BIN_DIR", "ATOMIC_VERSION", "GITHUB_TOKEN", "GH_TOKEN",
    "PROCESSOR_ARCHITEW6432", "PROCESSOR_ARCHITECTURE", "TEMP", "TMP",
    "ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION"
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")

try {
    $env:ATOMIC_INSTALL_DIR = $installRoot
    $env:ATOMIC_BIN_DIR = $binDir
    $env:TEMP = $fixtureTemp
    $env:TMP = $fixtureTemp
    $env:GITHUB_TOKEN = "github-token"
    $env:GH_TOKEN = "gh-token"
    $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null

    if ($Scenario -eq "install") {
        $helpOutput = & $InstallerPath -Help | Out-String
        Assert-Fixture ($helpOutput -match 'Usage:[\s\S]+-Ref <tag>[\s\S]+-Help') "-Help did not describe supported parameters"
        Assert-Fixture ($helpOutput -match 'Default bin directory:.*LOCALAPPDATA\\atomic\\bin') "-Help did not document the bin default"
        Assert-Fixture ($global:AtomicFixtureRequests.Count -eq 0) "-Help performed a network request"

        $env:ATOMIC_VERSION = "environment-must-not-win"
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "ARM64"
        & $InstallerPath -Ref "requested-alias" | Out-Null

        $versionOne = Join-Path $installRoot "versions\1.0.0"
        $current = Join-Path $installRoot "current"
        $atomicCurrent = Join-Path $binDir "atomic-current"
        $shim = Join-Path $binDir "atomic.cmd"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $versionOne "nested\full-payload.txt")) "flat ZIP full payload was not retained"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $current "atomic.exe")) "current pointer does not resolve atomic.exe"
        Assert-Fixture (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "current is not a junction"
        Assert-Fixture (((Get-Item -LiteralPath $atomicCurrent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "atomic-current is not a sibling junction"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $atomicCurrent "version.txt") -Raw) -eq "1.0.0") "atomic-current does not target the installed version"
        $expectedShimContent = '@echo off' + [Environment]::NewLine + '"%~dp0atomic-current\atomic.exe" %*' + [Environment]::NewLine + 'exit /b %ERRORLEVEL%' + [Environment]::NewLine
        Assert-Fixture ((Get-Content -LiteralPath $shim -Raw) -ceq $expectedShimContent) "shim source is not the exact relative atomic-current command"
        $versionProbe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($versionProbe.ExitCode -eq 0 -and $versionProbe.Output -eq "1.0.0") "cmd.exe shim --version failed"
        $argumentProbe = Invoke-FixtureShim $shim '--probe "hello world"'
        Assert-Fixture ($argumentProbe.ExitCode -eq 0 -and $argumentProbe.Output -eq "1.0.0:--probe|hello world") "cmd.exe shim did not forward arguments"
        $exitProbe = Invoke-FixtureShim $shim "--exit 37"
        Assert-Fixture ($exitProbe.ExitCode -eq 37) "shim did not preserve atomic.exe exit status"
        Assert-Fixture (Test-ExactPathEntry ([Environment]::GetEnvironmentVariable("Path", "User")) $binDir) "User PATH was not persisted"
        Assert-Fixture (Test-ExactPathEntry $env:Path $binDir) "current PATH was not refreshed"

        $firstApiRequest = @($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/tags/requested-alias$' })[0]
        Assert-Fixture ($null -ne $firstApiRequest) "explicit -Ref did not use the exact tag endpoint"
        Assert-Fixture ($firstApiRequest.Authorization -eq "Bearer github-token") "GITHUB_TOKEN did not win over GH_TOKEN"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/download/1\.0\.0/' }).Count -eq 2) "explicit -Ref did not use canonical API tag_name for downloads"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match 'environment-must-not-win' }).Count -eq 0) "ATOMIC_VERSION overrode explicit -Ref"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match 'atomic-windows-x64\.zip$' }).Count -eq 1) "WOW64 architecture did not select x64"

        Set-Content -LiteralPath (Join-Path $versionOne "stale.txt") -Value "stale"
        $env:GITHUB_TOKEN = $null
        $env:GH_TOKEN = "gh-token"
        $env:ATOMIC_VERSION = "1.0.0"
        & $InstallerPath | Out-Null
        Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $versionOne "stale.txt"))) "same-version reinstall was not clean"
        $fallbackApiRequests = @($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/tags/1\.0\.0$' })
        Assert-Fixture ($fallbackApiRequests[$fallbackApiRequests.Count - 1].Authorization -eq "Bearer gh-token") "GH_TOKEN was not used when GITHUB_TOKEN was unset"

        $env:PROCESSOR_ARCHITEW6432 = $null
        $env:PROCESSOR_ARCHITECTURE = "ARM64"
        & $InstallerPath -Ref "2.0.0" | Out-Null
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $installRoot "versions\1.0.0\atomic.exe")) "upgrade removed the older version"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $current "version.txt") -Raw) -eq "2.0.0") "upgrade did not repoint current"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $current "asset.txt") -Raw) -eq "atomic-windows-arm64.zip") "ARM64 archive was not extracted"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match 'atomic-windows-arm64\.zip$' }).Count -eq 1) "ARM64 architecture did not select arm64"

        $env:ATOMIC_VERSION = $null
        $defaultRequestStart = $global:AtomicFixtureRequests.Count
        $global:AtomicFixtureFailApi = $true
        & $InstallerPath | Out-Null
        $defaultRequests = @($global:AtomicFixtureRequests | Select-Object -Skip $defaultRequestStart)
        Assert-Fixture (@($defaultRequests | Where-Object { $_.Uri -eq 'https://github.com/bastani-inc/atomic/releases/latest' }).Count -eq 1) "default install did not try the stable release redirect"
        Assert-Fixture (@($defaultRequests | Where-Object { $_.Uri -match '^https://api\.github\.com/' }).Count -eq 0) "successful stable redirect queried the GitHub API"
        Assert-Fixture (@($defaultRequests | Where-Object { $_.Uri -match '/releases/download/2\.0\.0/' -and $null -ne $_.Authorization }).Count -eq 0) "token header leaked to release downloads"

        $global:AtomicFixtureFailApi = $false
        $global:AtomicFixtureRedirectFails = $true
        $fallbackRequestStart = $global:AtomicFixtureRequests.Count
        & $InstallerPath | Out-Null
        $fallbackRequests = @($global:AtomicFixtureRequests | Select-Object -Skip $fallbackRequestStart)
        Assert-Fixture (@($fallbackRequests | Where-Object { $_.Uri -match '/repos/bastani-inc/atomic/releases/latest$' }).Count -eq 1) "failed stable redirect did not query the latest release API"
        Assert-Fixture (@($fallbackRequests | Where-Object { $_.Uri -match '/repos/bastani-inc/atomic/releases/latest$' -and $_.Authorization -eq 'Bearer gh-token' }).Count -eq 1) "latest API fallback did not use the configured token"
        $global:AtomicFixtureRedirectFails = $false

        Assert-Fixture ((Get-ExactPathEntryCount ([Environment]::GetEnvironmentVariable("Path", "User")) $binDir) -eq 1) "User PATH contains duplicate bin entries"
        Assert-Fixture ((Get-ExactPathEntryCount $env:Path $binDir) -eq 1) "current PATH contains duplicate bin entries"
        Assert-Fixture (@(Get-ChildItem -LiteralPath (Join-Path $installRoot "versions") -Force | Where-Object { $_.Name -like ".stage-*" -or $_.Name -like ".backup-*" }).Count -eq 0) "version transaction artifacts were not cleaned"
        Assert-Fixture (@(Get-ChildItem -LiteralPath $installRoot -Force | Where-Object { $_.Name -like ".current-*" }).Count -eq 0) "current transaction artifacts were not cleaned"
        Assert-Fixture (@(Get-ChildItem -LiteralPath $binDir -Force | Where-Object { $_.Name -like ".atomic-*" }).Count -eq 0) "shim transaction artifacts were not cleaned"
    }
    elseif ($Scenario -eq "checksum") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        & $InstallerPath -Ref "1.0.0" | Out-Null
        $oldMarker = Join-Path $installRoot "versions\1.0.0\preserve.txt"
        Set-Content -LiteralPath $oldMarker -Value "old-state" -Encoding ASCII -NoNewline
        $global:AtomicFixtureBadChecksumTag = "2.0.0"

        $failure = $null
        try { & $InstallerPath -Ref "2.0.0" | Out-Null }
        catch { $failure = $_ }
        Assert-Fixture ($null -ne $failure -and $failure.Exception.Message -match 'Checksum verification failed') "bad checksum was not rejected"
        Assert-Fixture ((Get-Content -LiteralPath $oldMarker -Raw) -eq "old-state") "checksum rejection mutated the old version"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $installRoot "current\version.txt") -Raw) -eq "1.0.0") "checksum rejection changed current"
        Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $installRoot "versions\2.0.0"))) "checksum rejection installed the new version"
    }
    elseif ($Scenario -eq "final-smoke") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $beforeUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $beforeProcessPath = $env:Path
        $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = "2.0.0"

        $failure = $null
        try { & $InstallerPath -Ref "2.0.0" | Out-Null }
        catch { $failure = $_ }
        Assert-Fixture ($null -ne $failure -and $failure.Exception.Message -match 'Installed atomic\.cmd --version failed') "final shim smoke failure was not reported"
        Assert-Fixture ([Environment]::GetEnvironmentVariable("Path", "User") -eq $beforeUserPath) "failed final smoke did not restore User PATH"
        Assert-Fixture ($env:Path -eq $beforeProcessPath) "failed final smoke did not restore current PATH"
        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "failed final smoke left a new installation"
        Assert-Fixture (-not (Test-Path -LiteralPath $binDir)) "failed final smoke left a new bin directory"
    }
    elseif ($Scenario -eq "unicode") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        & $InstallerPath -Ref "1.0.0" | Out-Null

        $current = Join-Path $installRoot "current"
        $atomicCurrent = Join-Path $binDir "atomic-current"
        $shim = Join-Path $binDir "atomic.cmd"
        $expectedShimContent = '@echo off' + [Environment]::NewLine + '"%~dp0atomic-current\atomic.exe" %*' + [Environment]::NewLine + 'exit /b %ERRORLEVEL%' + [Environment]::NewLine
        $shimBytes = [IO.File]::ReadAllBytes($shim)
        Assert-Fixture ($installRoot.Contains("安装") -and $installRoot.Contains("Δοκιμή")) "Unicode fixture root lost CJK or Greek text"
        Assert-Fixture ($binDir.Contains("自訂") -and -not $binDir.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) "Unicode fixture did not use a separate custom bin directory"
        Assert-Fixture (-not (Test-ByteSequence $shimBytes ([byte[]]@(0xFF, 0xFE)))) "shim retained a UTF-16LE BOM"
        Assert-Fixture (-not (Test-ByteSequence $shimBytes ([byte[]]@(0xEF, 0xBB, 0xBF)))) "shim retained a UTF-8 BOM"
        Assert-Fixture (@($shimBytes | Where-Object { $_ -eq 0 }).Count -eq 0) "shim contains NUL bytes"
        Assert-Fixture (@($shimBytes | Where-Object { $_ -gt 0x7F }).Count -eq 0) "shim contains non-ASCII bytes"
        Assert-Fixture (([Text.Encoding]::ASCII.GetString($shimBytes)) -ceq $expectedShimContent) "shim bytes do not decode to the exact relative command"
        Assert-Fixture (((Get-Item -LiteralPath $atomicCurrent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "custom bin atomic-current is not a junction"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $atomicCurrent "version.txt") -Raw) -eq "1.0.0") "custom bin atomic-current does not target the installed version"
        $versionProbe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($versionProbe.ExitCode -eq 0 -and $versionProbe.Output -eq "1.0.0") "Unicode install shim --version failed through cmd.exe"
        $argumentProbe = Invoke-FixtureShim $shim '--probe "hello world"'
        Assert-Fixture ($argumentProbe.ExitCode -eq 0 -and $argumentProbe.Output -eq "1.0.0:--probe|hello world") "Unicode install shim did not forward arguments through cmd.exe"

        $oldShimContent = '@rem rollback-marker' + [Environment]::NewLine + $expectedShimContent
        Set-Content -LiteralPath $shim -Value $oldShimContent -Encoding ASCII -NoNewline
        $oldShimBytes = [IO.File]::ReadAllBytes($shim)
        $oldPairProbe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($oldPairProbe.ExitCode -eq 0 -and $oldPairProbe.Output -eq "1.0.0") "old shim and junction pair was not executable before rollback test"
        $beforeUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $beforeProcessPath = $env:Path
        $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = "2.0.0"
        $failure = $null
        try { & $InstallerPath -Ref "2.0.0" | Out-Null }
        catch { $failure = $_ }
        Assert-Fixture ($null -ne $failure -and $failure.Exception.Message -match 'Installed atomic\.cmd --version failed') "Unicode-path final shim smoke failure was not reported"
        Assert-Fixture ([Environment]::GetEnvironmentVariable("Path", "User") -eq $beforeUserPath) "Unicode-path rollback changed User PATH"
        Assert-Fixture ($env:Path -eq $beforeProcessPath) "Unicode-path rollback changed current PATH"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $current "version.txt") -Raw) -eq "1.0.0") "Unicode-path rollback did not restore current"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $atomicCurrent "version.txt") -Raw) -eq "1.0.0") "Unicode-path rollback did not restore the old atomic-current junction"
        Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes($shim)) -ceq [Convert]::ToBase64String($oldShimBytes)) "Unicode-path rollback did not restore the old shim bytes"
        Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $installRoot "versions\2.0.0"))) "Unicode-path rollback retained the failed version"
        $rollbackProbe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($rollbackProbe.ExitCode -eq 0 -and $rollbackProbe.Output -eq "1.0.0") "Unicode-path rollback did not restore the executable shim and junction pair"
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "dangling-junction") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        & $InstallerPath -Ref "1.0.0" | Out-Null

        $versionOne = Join-Path $installRoot "versions\1.0.0"
        $current = Join-Path $installRoot "current"
        $atomicCurrent = Join-Path $binDir "atomic-current"
        $shim = Join-Path $binDir "atomic.cmd"
        Remove-Item -LiteralPath $versionOne -Recurse -Force
        $danglingCurrent = @(Get-ChildItem -LiteralPath $installRoot -Force | Where-Object { $_.Name -eq "current" })
        Assert-Fixture ($danglingCurrent.Count -eq 1) "deleting the version also removed the current junction entry"
        Assert-Fixture (($danglingCurrent[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "dangling current entry is not a junction"
        Assert-Fixture (-not [IO.Directory]::Exists($current)) "current junction target was not deleted"

        $danglingAtomicCurrent = @(Get-ChildItem -LiteralPath $binDir -Force | Where-Object { $_.Name -eq "atomic-current" })
        Assert-Fixture ($danglingAtomicCurrent.Count -eq 1 -and ($danglingAtomicCurrent[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "deleting the version did not leave the atomic-current junction dangling"

        & $InstallerPath -Ref "1.0.0" | Out-Null
        $repairedCurrent = @(Get-ChildItem -LiteralPath $installRoot -Force | Where-Object { $_.Name -eq "current" })
        Assert-Fixture ($repairedCurrent.Count -eq 1) "same-version reinstall did not leave one current entry"
        Assert-Fixture (($repairedCurrent[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "same-version reinstall did not recreate current as a junction"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $current "atomic.exe")) "recreated current junction does not resolve atomic.exe"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $atomicCurrent "version.txt") -Raw) -eq "1.0.0") "recreated atomic-current junction does not resolve the installed version"
        $reinstallProbe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($reinstallProbe.ExitCode -eq 0 -and $reinstallProbe.Output -eq "1.0.0") "shim failed through cmd.exe after dangling junction recovery"
        Assert-NoTransactionResidue $installRoot $binDir
        $global:AtomicFixtureFailurePoint = "current-move"
        $failure = $null
        try { & $InstallerPath -Ref "2.0.0" | Out-Null }
        catch { $failure = $_ }
        $global:AtomicFixtureFailurePoint = $null
        Assert-Fixture ($null -ne $failure -and $failure.Exception.Message -match 'Injected transaction failure: current-move') "temporary current failure was not injected"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $current "version.txt") -Raw) -eq "1.0.0") "failed transaction did not restore current"
        Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $installRoot "versions\2.0.0"))) "failed transaction retained the new version"
        $rollbackProbe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($rollbackProbe.ExitCode -eq 0 -and $rollbackProbe.Output -eq "1.0.0") "shim failed through cmd.exe after temporary dangling junction cleanup"
        Assert-NoTransactionResidue $installRoot $binDir
    }

    elseif ($Scenario -eq "transaction-failures") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $failurePoints = @("payload-copy", "current-create", "current-move", "atomic-current-create", "atomic-current-move", "shim-stage")
        foreach ($state in @("fresh", "existing")) {
            foreach ($failurePoint in $failurePoints) {
                $installRoot = Join-Path $workspace ("transaction-" + $state + "-" + $failurePoint + "-install")
                $binDir = Join-Path $workspace ("transaction-" + $state + "-" + $failurePoint + "-bin")
                $env:ATOMIC_INSTALL_DIR = $installRoot
                $env:ATOMIC_BIN_DIR = $binDir
                $global:AtomicFixturePayloadCopyCount = 0
                $global:AtomicFixtureFailurePoint = $null
                $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null

                $oldShimBytes = $null
                if ($state -eq "existing") {
                    & $InstallerPath -Ref "1.0.0" | Out-Null
                    Set-Content -LiteralPath (Join-Path $installRoot "preserve-root.txt") -Value "old-root" -Encoding ASCII -NoNewline
                    Set-Content -LiteralPath (Join-Path $binDir "preserve-bin.txt") -Value "old-bin" -Encoding ASCII -NoNewline
                    Set-Content -LiteralPath (Join-Path $installRoot "versions\1.0.0\preserve-version.txt") -Value "old-version" -Encoding ASCII -NoNewline
                    $oldShim = Join-Path $binDir "atomic.cmd"
                    $oldShimContent = '@rem old-pair-' + $failurePoint + [Environment]::NewLine + '@echo off' + [Environment]::NewLine + '"%~dp0atomic-current\atomic.exe" %*' + [Environment]::NewLine + 'exit /b %ERRORLEVEL%' + [Environment]::NewLine
                    Set-Content -LiteralPath $oldShim -Value $oldShimContent -Encoding ASCII -NoNewline
                    $oldShimBytes = [IO.File]::ReadAllBytes($oldShim)
                    $oldProbe = Invoke-FixtureShim $oldShim "--version"
                    Assert-Fixture ($oldProbe.ExitCode -eq 0 -and $oldProbe.Output -eq "1.0.0") "old pair was not executable before $failurePoint failure"
                }

                $global:AtomicFixtureFailurePoint = $failurePoint
                $failure = $null
                try { & $InstallerPath -Ref "2.0.0" | Out-Null }
                catch { $failure = $_ }
                $global:AtomicFixtureFailurePoint = $null
                Assert-Fixture ($null -ne $failure -and $failure.Exception.Message -match ("Injected transaction failure: " + $failurePoint)) "$state $failurePoint failure was not injected"

                if ($state -eq "fresh") {
                    Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "fresh $failurePoint failure left the install root"
                    Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $installRoot "versions"))) "fresh $failurePoint failure left versions"
                    Assert-Fixture (-not (Test-Path -LiteralPath $binDir)) "fresh $failurePoint failure left the bin directory"
                }
                else {
                    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $installRoot "preserve-root.txt") -Raw) -eq "old-root") "existing $failurePoint failure recursed into the install root"
                    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $binDir "preserve-bin.txt") -Raw) -eq "old-bin") "existing $failurePoint failure recursed into the bin directory"
                    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $installRoot "versions\1.0.0\preserve-version.txt") -Raw) -eq "old-version") "existing $failurePoint failure did not preserve the old version"
                    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $installRoot "current\version.txt") -Raw) -eq "1.0.0") "existing $failurePoint failure did not preserve current"
                    Assert-Fixture ((Get-Content -LiteralPath (Join-Path $binDir "atomic-current\version.txt") -Raw) -eq "1.0.0") "existing $failurePoint failure did not preserve atomic-current"
                    Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $binDir "atomic.cmd"))) -ceq [Convert]::ToBase64String($oldShimBytes)) "existing $failurePoint failure did not preserve the old shim"
                    Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $installRoot "versions\2.0.0"))) "existing $failurePoint failure retained the failed version"
                    $rollbackProbe = Invoke-FixtureShim (Join-Path $binDir "atomic.cmd") "--version"
                    Assert-Fixture ($rollbackProbe.ExitCode -eq 0 -and $rollbackProbe.Output -eq "1.0.0") "existing $failurePoint failure did not leave the old pair executable"
                }

                Assert-NoTransactionResidue $installRoot $binDir
                Assert-Fixture (@(Get-ChildItem -LiteralPath $fixtureTemp -Filter "atomic-install-*" -Force).Count -eq 0) "$state $failurePoint failure left a temporary download directory"
                Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    else {
        throw "Unknown fixture scenario: $Scenario"
    }

    Assert-Fixture (@(Get-ChildItem -LiteralPath $fixtureTemp -Filter "atomic-install-*" -Force).Count -eq 0) "temporary installer directory was not cleaned"
    Write-Output "SCENARIO_OK:$Scenario"
}
finally {
    [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")
    }
    Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
}
`;

test("Windows PowerShell 5.1 fixtures enforce shim bytes, cmd execution, rollback, and failure cleanup", () => {
	assert.match(fixtureHarness, /安装-Δοκιμή/u);
	assert.match(fixtureHarness, /自訂-bin-Δ/u);
	assert.match(fixtureHarness, /\[IO\.File\]::ReadAllBytes\(\$shim\)/u);
	assert.match(fixtureHarness, /0xFF,\s*0xFE/u);
	assert.match(fixtureHarness, /0xEF,\s*0xBB,\s*0xBF/u);
	assert.match(fixtureHarness, /Where-Object\s*\{\s*\$_\s+-eq\s+0\s*\}/u);
	assert.match(fixtureHarness, /Where-Object\s*\{\s*\$_\s+-gt\s+0x7F\s*\}/u);
	assert.doesNotMatch(fixtureHarness, /&\s+\$shim\b/u);
	assert.match(fixtureHarness, /&\s+\$cmdExe\s+\/d\s+\/c\s+\$commandLine/u);
	assert.match(fixtureHarness, /--probe "hello world"/u);
	assert.match(fixtureHarness, /--exit 37/u);
	assert.match(fixtureHarness, /rollback-marker[\s\S]+old atomic-current junction[\s\S]+old shim bytes/u);
	assert.match(
		fixtureHarness,
		/@\("payload-copy", "current-create", "current-move", "atomic-current-create", "atomic-current-move", "shim-stage"\)/u,
	);
	assert.match(fixtureHarness, /FailurePoint\s+-eq\s+"current-create"[\s\S]+\\\.current-/u);
	assert.match(fixtureHarness, /FailurePoint\s+-eq\s+"current-move"[\s\S]+\\\.current-/u);
	assert.match(fixtureHarness, /FailurePoint\s+-eq\s+"atomic-current-create"[\s\S]+\\\.atomic-current-/u);
	assert.match(fixtureHarness, /FailurePoint\s+-eq\s+"atomic-current-move"[\s\S]+\\\.atomic-current-/u);
	assert.doesNotMatch(fixtureHarness, /"junction-(?:create|move)"/u);
	assert.match(fixtureHarness, /foreach \(\$state in @\("fresh", "existing"\)\)/u);
	assert.match(fixtureHarness, /fresh \$failurePoint failure left the install root/u);
	assert.match(fixtureHarness, /existing \$failurePoint failure recursed into the bin directory/u);
	assert.match(fixtureHarness, /existing \$failurePoint failure did not preserve the old version/u);
	assert.match(fixtureHarness, /existing \$failurePoint failure did not leave the old pair executable/u);
	assert.match(fixtureHarness, /Assert-NoTransactionResidue \$installRoot \$binDir/u);
	assert.match(
		fixtureHarness,
		/AtomicFixtureFailApi\s*=\s*\$true[\s\S]+successful stable redirect queried the GitHub API/u,
	);
});

function runPowerShellFixture(
	scenario: "install" | "checksum" | "final-smoke" | "unicode" | "dangling-junction" | "transaction-failures",
): string {
	assert.ok(powershellExecutable);
	const workspace = mkdtempSync(join(tmpdir(), `atomic-ps-fixture-${scenario}-`));
	const harnessPath = join(workspace, "fixture.ps1");
	writeFileSync(harnessPath, `\uFEFF${fixtureHarness}`, "utf16le");
	try {
		const result = spawnSyncCollect(
			[
				powershellExecutable,
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				harnessPath,
				"-InstallerPath",
				installerPath,
				"-Scenario",
				scenario,
			],
			{ timeout: POWERSHELL_FIXTURE_TIMEOUT_MS },
		);
		const stdout = result.stdout.toString();
		const stderr = result.stderr.toString();
		assert.equal(
			result.exitCode,
			0,
			`PowerShell fixture ${scenario} failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
		assert.match(stdout, new RegExp(`SCENARIO_OK:${scenario}`, "u"));
		return stdout;
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

powershellTest("PowerShell 5.1 fixture installs exact refs for both architectures and is idempotent", () => {
	runPowerShellFixture("install");
});

powershellTest("PowerShell 5.1 fixture rejects a checksum mismatch without mutating the old install", () => {
	runPowerShellFixture("checksum");
});

powershellTest("PowerShell 5.1 fixture rolls back a failing final shim smoke and PATH changes", () => {
	runPowerShellFixture("final-smoke");
});

powershellTest("PowerShell 5.1 fixture preserves Unicode install paths and rolls back final smoke failure", () => {
	runPowerShellFixture("unicode");
});

powershellTest("PowerShell 5.1 fixture repairs and cleans up dangling junctions", () => {
	runPowerShellFixture("dangling-junction");
});

powershellTest(
	"PowerShell 5.1 fixture rolls back fresh and existing installs at every staged transaction failure",
	() => {
		runPowerShellFixture("transaction-failures");
	},
	TRANSACTION_FAILURE_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);
