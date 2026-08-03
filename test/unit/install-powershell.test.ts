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
	assert.match(source, /&\s+\$shimPath\s+"--version"[\s\S]*\$LASTEXITCODE/u);

	assert.match(source, /LOCALAPPDATA[\\/]atomic/u);
	assert.match(source, /Default bin directory:[^\r\n]*LOCALAPPDATA[\\/]atomic[\\/]bin/u);
	assert.match(source, /Restart your terminal/u);
});

function findWindowsPowerShell(): string | undefined {
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
const POWERSHELL_FIXTURE_TIMEOUT_MS = 25_000;

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

$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$assetRoot = Join-Path $workspace "releases"
$installRoot = Join-Path $workspace "install root"
$binDir = Join-Path $workspace "bin root"
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
        return [pscustomobject]@{
            Headers = @{ Location = "/bastani-inc/atomic/releases/tag/2.0.0" }
            BaseResponse = [pscustomobject]@{ ResponseUri = [Uri]"https://github.com/bastani-inc/atomic/releases/latest" }
        }
    }

    if ($Uri -match '/repos/bastani-inc/atomic/releases/latest$') {
        return [pscustomobject]@{ Content = '{"tag_name":"2.0.0"}'; Headers = @{} }
    }
    if ($Uri -match '/repos/bastani-inc/atomic/releases/tags/([^/]+)$') {
        $tag = [Uri]::UnescapeDataString($Matches[1])
        return [pscustomobject]@{ Content = ('{"tag_name":"' + $tag + '"}'); Headers = @{} }
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
        & $InstallerPath -Ref "1.0.0" | Out-Null

        $versionOne = Join-Path $installRoot "versions\1.0.0"
        $current = Join-Path $installRoot "current"
        $shim = Join-Path $binDir "atomic.cmd"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $versionOne "nested\full-payload.txt")) "flat ZIP full payload was not retained"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $current "atomic.exe")) "current pointer does not resolve atomic.exe"
        Assert-Fixture (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "current is not a junction"
        $expectedShimCommand = '"' + (Join-Path $current "atomic.exe") + '" %*'
        Assert-Fixture ((Get-Content -LiteralPath $shim -Raw).Contains($expectedShimCommand)) "shim is not absolute and quoted"
        $probeOutput = & $shim "--probe" "hello world"
        $probeExitCode = $LASTEXITCODE
        Assert-Fixture ($probeExitCode -eq 0) "shim execution failed"
        Assert-Fixture (($probeOutput -join [Environment]::NewLine) -eq "1.0.0:--probe|hello world") "shim did not forward arguments"
        Assert-Fixture (Test-ExactPathEntry ([Environment]::GetEnvironmentVariable("Path", "User")) $binDir) "User PATH was not persisted"
        Assert-Fixture (Test-ExactPathEntry $env:Path $binDir) "current PATH was not refreshed"

        $firstApiRequest = @($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/tags/1\.0\.0$' })[0]
        Assert-Fixture ($null -ne $firstApiRequest) "explicit -Ref did not use the exact tag endpoint"
        Assert-Fixture ($firstApiRequest.Authorization -eq "Bearer github-token") "GITHUB_TOKEN did not win over GH_TOKEN"
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
        & $InstallerPath | Out-Null
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -eq 'https://github.com/bastani-inc/atomic/releases/latest' }).Count -eq 1) "default install did not try the stable release redirect"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/tags/2\.0\.0$' }).Count -ge 2) "stable redirect tag was not resolved through the release API"
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

function runPowerShellFixture(scenario: "install" | "checksum" | "final-smoke"): string {
	assert.ok(powershellExecutable);
	const workspace = mkdtempSync(join(tmpdir(), `atomic-ps-fixture-${scenario}-`));
	const harnessPath = join(workspace, "fixture.ps1");
	writeFileSync(harnessPath, fixtureHarness);
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
