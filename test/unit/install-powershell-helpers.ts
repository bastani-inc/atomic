import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runThenRemoveFixtureTree, runThenRemoveFixtureTreeAsync } from "../helpers/fixture-removal.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const installerPath = join(root, "install.ps1");

export function installerSource(): string {
	return readFileSync(installerPath, "utf8");
}

export interface PowerShellEngine {
	executable: string;
	major: number;
	label: string;
}

function findPowerShellEngines(): PowerShellEngine[] {
	const candidates = ["powershell.exe", "powershell", "pwsh.exe", "pwsh"];
	const engines: PowerShellEngine[] = [];
	const visited = new Set<string>();
	for (const directoryEntry of (process.env.PATH ?? "").split(delimiter)) {
		const directory = directoryEntry.trim().replace(/^"(.*)"$/u, "$1");
		if (!directory) continue;
		for (const candidate of candidates) {
			const path = join(directory, candidate);
			const identity = process.platform === "win32" ? path.toLowerCase() : path;
			if (!existsSync(path) || visited.has(identity)) continue;
			visited.add(identity);
			const probe = spawnSyncCollect(
				[
					path,
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					'[Console]::Write("ENGINE:" + $PSVersionTable.PSVersion.Major)',
				],
				{ timeout: 10_000 },
			);
			const match = probe.stdout.toString().match(/ENGINE:(\d+)/u);
			if (probe.exitCode === 0 && match) {
				const major = Number.parseInt(match[1] ?? "", 10);
				if (major === 5 || major >= 7) {
					engines.push({
						executable: path,
						major,
						label: major === 5 ? "Windows PowerShell 5.1" : `PowerShell ${major}`,
					});
				}
			}
		}
	}
	return engines;
}

export const powershellEngines = findPowerShellEngines();
export const powershellExecutable = powershellEngines.find(
	(engine) => process.platform === "win32" && engine.major === 5,
)?.executable;
export const powershell7Executable = powershellEngines.find(
	(engine) => process.platform === "win32" && engine.major >= 7,
)?.executable;
export const POWERSHELL_FIXTURE_TIMEOUT_MS = 120_000;
export const TRANSACTION_FAILURE_FIXTURE_STRUCTURAL_TIMEOUT_MS = 240_000;
export const ROLLBACK_RETRY_FIXTURE_STRUCTURAL_TIMEOUT_MS = 300_000;
export const CTRL_C_FIXTURE_STRUCTURAL_TIMEOUT_MS = 360_000;
export const TEMP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS = 180_000;
export const BACKUP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS = 180_000;

export interface AsyncProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export function spawnCollectAsync(
	command: string,
	args: string[],
	timeout: number,
	label = "PowerShell redirect fixture",
): Promise<AsyncProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeout);
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (exitCode) => {
			clearTimeout(timer);
			const result = {
				exitCode,
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
			};
			if (timedOut) {
				reject(new Error(`${label} timed out.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`));
				return;
			}
			resolve(result);
		});
	});
}

export const fixtureHarness = String.raw`
param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][string]$Scenario,
    [string]$IsolatedHkcuRunId = "",
    [int]$IsolatedHkcuOwnerPid = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    $PSVersionTable.PSVersion.Major -lt 5 -or
    ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -lt 1)) {
    throw "Dynamic installer fixtures require Windows PowerShell 5.1 or PowerShell 7+ on Windows."
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

function Reset-FixtureInstallState {
    param([string[]]$Paths)
    # A just-executed atomic.exe can stay delete-pending on Windows (for example while
    # Defender scans it), so a single silenced removal can leave versions\<tag> behind.
    foreach ($path in $Paths) {
        $lastError = $null
        for ($attempt = 1; $attempt -le 20 -and (Test-Path -LiteralPath $path); $attempt++) {
            try { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }
            catch { $lastError = $_ }
            if (Test-Path -LiteralPath $path) { Start-Sleep -Milliseconds (50 * $attempt) }
        }
        Assert-Fixture (-not (Test-Path -LiteralPath $path)) "fixture could not reset $path before the next install: $lastError"
    }
}

function Get-TempResidueReport {
    param([string]$Root)
    $entries = @(Get-ChildItem -LiteralPath $Root -Filter "atomic-install-*" -Force)
    return [pscustomobject]@{
        Count = $entries.Count
        Paths = (($entries | ForEach-Object { $_.FullName }) -join '; ')
    }
}

function Assert-FixtureProcessesExited {
    param([string]$Root, [int]$WaitMilliseconds)
    $prefix = $Root.TrimEnd('\') + '\'
    $outlived = New-Object System.Collections.ArrayList
    foreach ($process in [Diagnostics.Process]::GetProcesses()) {
        try { $imagePath = $process.MainModule.FileName }
        catch { $imagePath = $null }
        if ($null -ne $imagePath -and $imagePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            $exited = $process.WaitForExit($WaitMilliseconds)
            [void]$outlived.Add("$($process.Id) $imagePath (exited after waiting: $exited)")
        }
    }
    Assert-Fixture ($outlived.Count -eq 0) "processes started from the fixture workspace outlived the scenario: $($outlived -join '; ')"
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
        if (args.Length == 2 && args[0] == "intercom" && args[1] == "--help")
        {
            AppendIntercomLog("help " + version);
            if (version == "0.9.41")
            {
                Console.WriteLine("Usage: atomic [options] [@files...] [messages...]");
                return 0;
            }
            Console.WriteLine("Usage:");
            Console.WriteLine("  atomic intercom status");
            Console.WriteLine("  atomic intercom restart");
            if (version != "0.9.71")
            {
                Console.WriteLine("  atomic intercom upgrade");
            }
            return 0;
        }
        if (args.Length == 2 && args[0] == "intercom" && args[1] == "upgrade" && version == "0.9.41")
        {
            AppendIntercomLog("prompt " + version);
            Console.Error.WriteLine("No API key found for the selected model.");
            return 1;
        }
        if (args.Length == 2 && args[0] == "intercom" && args[1] == "upgrade" && version == "0.9.71")
        {
            AppendIntercomLog("unknown " + version);
            Console.Error.WriteLine("Unknown intercom command \"upgrade\".");
            return 1;
        }
        if (args.Length == 2 && args[0] == "intercom" && args[1] == "upgrade")
        {
            AppendIntercomLog("upgrade " + version + " redirected=" + Console.IsInputRedirected);
            string upgradeLog = Environment.GetEnvironmentVariable("ATOMIC_FIXTURE_UPGRADE_LOG");
            if (!String.IsNullOrEmpty(upgradeLog))
            {
                File.AppendAllText(upgradeLog, version + Environment.NewLine);
            }
            string upgradeExit = Environment.GetEnvironmentVariable("ATOMIC_FIXTURE_UPGRADE_EXIT");
            return String.IsNullOrEmpty(upgradeExit) ? 0 : Int32.Parse(upgradeExit);
        }
        Console.WriteLine(version + ":" + String.Join("|", args));
        return 0;
    }

    private static void AppendIntercomLog(string line)
    {
        string intercomLog = Environment.GetEnvironmentVariable("ATOMIC_FIXTURE_INTERCOM_LOG");
        if (!String.IsNullOrEmpty(intercomLog))
        {
            File.AppendAllText(intercomLog, line + Environment.NewLine);
        }
    }
}
'@
if ($PSVersionTable.PSEdition -eq "Desktop") {
    Add-Type -TypeDefinition $fixtureSource -OutputAssembly $fixtureExecutable -OutputType ConsoleApplication
}
else {
    $compilerScript = Join-Path $workspace "compile-fixture-atomic.ps1"
    [IO.File]::WriteAllText($compilerScript, @'
param([string]$SourcePath, [string]$OutputPath)
Add-Type -TypeDefinition ([IO.File]::ReadAllText($SourcePath)) -OutputAssembly $OutputPath -OutputType ConsoleApplication
'@)
    $compilerSource = Join-Path $workspace "fixture-atomic.cs"
    [IO.File]::WriteAllText($compilerSource, $fixtureSource)
    try {
        $winPs = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
        & $winPs -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $compilerScript -SourcePath $compilerSource -OutputPath $fixtureExecutable
        Assert-Fixture ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $fixtureExecutable -PathType Leaf)) "failed to compile fixture-atomic.exe for PowerShell 7"
    }
    finally {
        Remove-Item -LiteralPath $compilerScript, $compilerSource -Force -ErrorAction SilentlyContinue
    }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AtomicTestHkcuOverride
{
    public static readonly IntPtr HKEY_CURRENT_USER = new IntPtr(unchecked((int)0x80000001));

    [DllImport("advapi32.dll")]
    public static extern int RegOverridePredefKey(IntPtr hKey, IntPtr hNewHKey);
}
'@

function Test-IsolatedOwnerProcessAlive {
    param([int]$ProcessId, [long]$ExpectedStartTicks)

    if ($ProcessId -le 0) {
        return $false
    }
    try {
        $proc = [Diagnostics.Process]::GetProcessById($ProcessId)
    }
    catch [ArgumentException], [InvalidOperationException] {
        return $false
    }
    catch {
        return $true
    }
    try {
        if ($proc.HasExited) {
            return $false
        }
        return ($proc.StartTime.ToUniversalTime().Ticks -eq $ExpectedStartTicks)
    }
    catch [InvalidOperationException] {
        return $false
    }
    catch {
        return $true
    }
    finally {
        $proc.Dispose()
    }
}

function Clear-DeadIsolatedHkcuKeys {
    param($ParentKey, [string]$SelfRunId)

    foreach ($candidateId in @($ParentKey.GetSubKeyNames())) {
        if ($candidateId -ieq $SelfRunId) {
            continue
        }
        $candidateKey = $null
        $metaReady = $null
        $rawFixturePid = $null
        $rawFixtureTicks = $null
        $rawOwnerPid = $null
        $rawOwnerTicks = $null
        try {
            $candidateKey = $ParentKey.OpenSubKey($candidateId, $false)
            if ($null -eq $candidateKey) {
                continue
            }
            $metaReady = $candidateKey.GetValue("MetadataReady", $null)
            $rawFixturePid = $candidateKey.GetValue("FixturePid", $null)
            $rawFixtureTicks = $candidateKey.GetValue("FixtureStartTicks", $null)
            $rawOwnerPid = $candidateKey.GetValue("OwnerPid", $null)
            $rawOwnerTicks = $candidateKey.GetValue("OwnerStartTicks", $null)
        }
        catch {
            continue
        }
        finally {
            if ($null -ne $candidateKey) {
                $candidateKey.Close()
            }
        }
        if ($null -eq $metaReady -or ([string]$metaReady) -cne "1") {
            continue
        }
        $fixturePid = 0
        $fixtureTicks = [long]0
        if ($null -eq $rawFixturePid -or $null -eq $rawFixtureTicks -or
            -not [int]::TryParse([string]$rawFixturePid, [ref]$fixturePid) -or
            -not [long]::TryParse([string]$rawFixtureTicks, [ref]$fixtureTicks)) {
            continue
        }
        if (Test-IsolatedOwnerProcessAlive $fixturePid $fixtureTicks) {
            continue
        }
        if ($null -ne $rawOwnerPid -and -not [string]::IsNullOrWhiteSpace([string]$rawOwnerPid)) {
            $ownerPid = 0
            $ownerTicks = [long]0
            if ($null -eq $rawOwnerTicks -or
                -not [int]::TryParse([string]$rawOwnerPid, [ref]$ownerPid) -or
                -not [long]::TryParse([string]$rawOwnerTicks, [ref]$ownerTicks)) {
                continue
            }
            if (Test-IsolatedOwnerProcessAlive $ownerPid $ownerTicks) {
                continue
            }
        }
        try {
            $ParentKey.DeleteSubKeyTree($candidateId, $false)
        }
        catch {
        }
    }
}

function Get-FixtureSha256 {
    param([string]$Path)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function New-FixtureRelease {
    param([string]$Tag)

    $releaseDir = Join-Path $assetRoot $Tag
    $payloadDir = Join-Path $workspace ("payload-" + $Tag)
    New-Item -ItemType Directory -Path (Join-Path $payloadDir "nested") -Force | Out-Null
    Copy-Item -LiteralPath $fixtureExecutable -Destination (Join-Path $payloadDir "atomic.exe")
    Set-Content -LiteralPath (Join-Path $payloadDir "version.txt") -Value $Tag -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $payloadDir "nested\full-payload.txt") -Value ("payload-" + $Tag) -Encoding ASCII -NoNewline
    New-Item -ItemType Directory -Path (Join-Path $payloadDir "builtin"), (Join-Path $payloadDir "node_modules") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $payloadDir "builtin\payload.txt") -Value ("builtin-" + $Tag) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $payloadDir "node_modules\payload.txt") -Value ("modules-" + $Tag) -Encoding ASCII -NoNewline
    foreach ($companionFile in @("package.json", "app.js", "native-modifiers.js", "native-module-path.js", "native-platform.js")) {
        Set-Content -LiteralPath (Join-Path $payloadDir $companionFile) -Value ("fixture-" + $companionFile + "-" + $Tag) -Encoding ASCII -NoNewline
    }
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

    $rows = @()
    foreach ($assetName in @("atomic-windows-x64.zip", "atomic-windows-arm64.zip")) {
        Set-Content -LiteralPath (Join-Path $payloadDir "asset.txt") -Value $assetName -Encoding ASCII -NoNewline
        $archivePath = Join-Path $releaseDir $assetName
        Compress-Archive -Path (Join-Path $payloadDir "*") -DestinationPath $archivePath -CompressionLevel Optimal
        $hash = Get-FixtureSha256 $archivePath
        $marker = if ($assetName -eq "atomic-windows-arm64.zip") { " *" } else { "  " }
        $rows += "$hash$marker$assetName"
    }
    Set-Content -LiteralPath (Join-Path $releaseDir "SHA256SUMS") -Value ($rows -join [Environment]::NewLine) -Encoding ASCII -NoNewline
    Remove-Item -LiteralPath $payloadDir -Recurse -Force
}

New-FixtureRelease "1.0.0"
New-FixtureRelease "2.0.0"
if ($Scenario -eq "tag-grammar") {
    New-FixtureRelease "1.0.0-alpha.1"
}
if ($Scenario -eq "install") {
    New-FixtureRelease "0.9.41"
    New-FixtureRelease "0.9.71"
}

$global:AtomicFixtureAssetRoot = $assetRoot
$global:AtomicFixtureRequests = New-Object System.Collections.ArrayList
$global:AtomicFixtureBadChecksumTag = $null
$global:AtomicFixtureLastAssetName = $null
$global:AtomicFixtureFailApi = $false
$global:AtomicFixtureRedirectFails = $false
$global:AtomicFixtureRedirectTag = "2.0.0"
$global:AtomicFixtureLatestApiTag = "2.0.0"
# Off by default: the github.com release page is then unknown to the fixture, so an exact tag
# falls back to the REST API as when github.com gives no clear answer.
$global:AtomicFixtureWebPages = $false
$global:AtomicFixtureApiRateLimited = $false
$global:AtomicFixtureProbes = New-Object System.Collections.ArrayList

# An HTTP error shaped like Invoke-WebRequest's: the exception carries the response status and headers.
function global:New-AtomicFixtureHttpError {
    param([int]$StatusCode, [hashtable]$ResponseHeaders, [string]$ResponseUri = "https://api.github.com/")
    $exception = New-Object System.Exception ("The remote server returned an error: (" + $StatusCode + ").")
    Add-Member -InputObject $exception -NotePropertyName Response -NotePropertyValue ([pscustomobject]@{ StatusCode = $StatusCode; Headers = $ResponseHeaders; ResponseUri = [Uri]$ResponseUri })
    return $exception
}

function global:Invoke-WebRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Uri,
        [string]$OutFile,
        [hashtable]$Headers,
        [switch]$UseBasicParsing,
        [int]$MaximumRedirection,
        [string]$Method
    )

    # The release probe (HEAD of a release's SHA256SUMS, no redirects) is recorded apart, so the
    # request counts of the scenarios below stay those of resolution and downloads.
    if ($Method -eq "Head" -and $Uri -match '^https://github\.com/bastani-inc/atomic/releases/download/([^/]+)/SHA256SUMS$') {
        [void]$global:AtomicFixtureProbes.Add($Uri)
        if (-not $global:AtomicFixtureWebPages) { throw "github.com gives no answer in this fixture scenario: $Uri" }
        $probeTag = [Uri]::UnescapeDataString($Matches[1])
        if (Test-Path -LiteralPath (Join-Path (Join-Path $global:AtomicFixtureAssetRoot $probeTag) "SHA256SUMS")) {
            return [pscustomobject]@{ StatusCode = 302; Headers = @{} }
        }
        throw (New-AtomicFixtureHttpError 404 @{} $Uri)
    }

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
            Headers = @{ Location = "/bastani-inc/atomic/releases/tag/" + $global:AtomicFixtureRedirectTag }
            BaseResponse = [pscustomobject]@{ ResponseUri = [Uri]"https://github.com/bastani-inc/atomic/releases/latest" }
        }
    }

    if ($Uri -match '^https://api\.github\.com/') {
        if ($global:AtomicFixtureFailApi) { throw "GitHub API is unavailable in this fixture scenario: $Uri" }
        if ($global:AtomicFixtureApiRateLimited) { throw (New-AtomicFixtureHttpError 403 @{ "X-RateLimit-Remaining" = "0" }) }
        if ($Uri -match '/repos/bastani-inc/atomic/releases/latest$') {
            return [pscustomobject]@{ Content = ('{"tag_name":"' + $global:AtomicFixtureLatestApiTag + '"}'); Headers = @{} }
        }
        if ($Uri -match '/repos/bastani-inc/atomic/releases/tags/([^/]+)$') {
            $requestedTag = [Uri]::UnescapeDataString($Matches[1])
            $canonicalTag = if ($requestedTag -eq "1.0.1") { "1.0.0" } else { $requestedTag }
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

# The installer streams the release archive through System.Net.Http.HttpClient, which this
# fixture cannot intercept. Refusing to load that assembly puts the archive download on the
# installer's documented fallback, Invoke-AtomicDownload, so every release request still
# reaches the Invoke-WebRequest fixture above and is recorded in AtomicFixtureRequests.
$global:AtomicFixtureHttpAssemblyRefusals = 0
function global:Add-Type {
    [CmdletBinding()]
    param(
        [string]$AssemblyName,
        [string]$TypeDefinition,
        [string]$Path,
        [string]$OutputAssembly,
        [string]$OutputType
    )

    if ($AssemblyName -eq "System.Net.Http") {
        $global:AtomicFixtureHttpAssemblyRefusals++
        throw "System.Net.Http is unavailable in this fixture scenario."
    }
    Microsoft.PowerShell.Utility\Add-Type @PSBoundParameters
}

$global:AtomicFixturePayloadCopyCount = 0
$global:AtomicFixtureFailurePoint = $null
$global:AtomicFixtureBusyStageMoveRefusals = 0
$global:AtomicFixtureRollbackFailurePoint = $null
$global:AtomicFixtureRollbackFailureDelivered = $false
$global:AtomicFixtureRollbackArmed = $false
$global:AtomicFixtureTempLockMode = $null
$global:AtomicFixtureTempLockPath = $null
$global:AtomicFixtureTempLockStream = $null
$global:AtomicFixtureTempRemovalAttempts = 0
$global:AtomicFixtureBackupLockMode = $null
$global:AtomicFixtureBackupLockPath = $null
$global:AtomicFixtureBackupLockStream = $null
$global:AtomicFixtureBackupRemovalAttempts = 0
$global:AtomicFixtureMoveLockTarget = $null
$global:AtomicFixtureMoveLockMode = $null
$global:AtomicFixtureMoveLockStream = $null
$global:AtomicFixtureMoveLockAttempts = 0
$global:AtomicFixtureMoveLockSplitObserved = $false
$global:AtomicFixtureRollbackMoveLockArmed = $false
$global:AtomicFixtureRemoveLockTarget = $null
$global:AtomicFixtureRemoveLockMode = $null
$global:AtomicFixtureRemoveLockStream = $null
$global:AtomicFixtureRemoveLockAttempts = 0
$global:AtomicFixtureRollbackRemoveLockArmed = $false
$global:AtomicFixtureStageCleanupLockedDir = $null
$global:AtomicFixtureNonLockAttempts = 0
$global:AtomicFixtureNonLockCollisionDir = $null
$global:AtomicFixtureDualRollbackLockArmed = $false
$global:AtomicFixtureDualRollbackLockStreams = New-Object System.Collections.ArrayList
$global:AtomicFixtureDualRollbackRestoreAttempts = 0
$global:AtomicFixtureDualRollbackBackupPaths = New-Object System.Collections.ArrayList
$global:AtomicFixtureWarnings = New-Object System.Collections.ArrayList

function global:Write-Warning {
    param(
        [string]$Message,
        [string]$WarningAction
    )

    [void]$global:AtomicFixtureWarnings.Add($Message)
    if ([string]::IsNullOrWhiteSpace($WarningAction)) {
        Microsoft.PowerShell.Utility\Write-Warning -Message $Message
    }
    else {
        Microsoft.PowerShell.Utility\Write-Warning -Message $Message -WarningAction $WarningAction
    }
}

function global:Remove-Item {
    param(
        [string]$LiteralPath,
        [switch]$Recurse,
        [switch]$Force,
        [string]$ErrorAction
    )

    if ([IO.Path]::GetFileName($LiteralPath) -match '^atomic-install-[0-9a-f]{32}$') {
        $global:AtomicFixtureTempRemovalAttempts++
        if ($global:AtomicFixtureTempLockMode -eq "one-shot" -and
            $global:AtomicFixtureTempRemovalAttempts -ge 2 -and
            $null -ne $global:AtomicFixtureTempLockStream) {
            $global:AtomicFixtureTempLockStream.Dispose()
            $global:AtomicFixtureTempLockStream = $null
        }
    }

    if ([IO.Path]::GetFileName($LiteralPath) -match '^\.backup-[0-9a-f]{32}$') {
        $global:AtomicFixtureBackupRemovalAttempts++
        if ($global:AtomicFixtureBackupLockMode -eq "one-shot" -and
            $global:AtomicFixtureBackupRemovalAttempts -ge 2 -and
            $null -ne $global:AtomicFixtureBackupLockStream) {
            $global:AtomicFixtureBackupLockStream.Dispose()
            $global:AtomicFixtureBackupLockStream = $null
        }
    }

    $removeLeaf = [IO.Path]::GetFileName($LiteralPath)
    $matchesRemoveLock = $false
    if ($global:AtomicFixtureRemoveLockTarget -eq "rollback-version" -and $removeLeaf -eq "1.0.0") {
        $matchesRemoveLock = $true
    }
    elseif ($global:AtomicFixtureRemoveLockTarget -eq "stage-cleanup" -and $removeLeaf -match '^\.stage-[0-9a-f]{32}$') {
        $matchesRemoveLock = $true
    }
    if ($matchesRemoveLock) {
        $global:AtomicFixtureRemoveLockAttempts++
        if ($global:AtomicFixtureRemoveLockMode -eq "one-shot" -and
            $global:AtomicFixtureRemoveLockAttempts -ge 2 -and
            $null -ne $global:AtomicFixtureRemoveLockStream) {
            $global:AtomicFixtureRemoveLockStream.Dispose()
            $global:AtomicFixtureRemoveLockStream = $null
        }
    }

    $effectiveErrorAction = if ([string]::IsNullOrWhiteSpace($ErrorAction)) { $ErrorActionPreference } else { $ErrorAction }
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force -ErrorAction $effectiveErrorAction
}

function global:Get-ChildItem {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [string]$Filter,
        [switch]$Force
    )

    if ($global:AtomicFixtureRollbackArmed -and
        -not $global:AtomicFixtureRollbackFailureDelivered -and
        $global:AtomicFixtureRollbackFailurePoint -like "*-remove") {
        $requestedLeaf = $null
        try { $requestedLeaf = [string](Get-Variable -Name leafName -Scope 1 -ValueOnly -ErrorAction Stop) }
        catch { $requestedLeaf = $null }
        $failureLeaf = switch ($global:AtomicFixtureRollbackFailurePoint) {
            "shim-remove" { "atomic.cmd" }
            "atomic-current-remove" { "atomic-current" }
            "current-remove" { "current" }
            "version-remove" { "2.0.0" }
            default { $null }
        }
        if (-not [string]::IsNullOrWhiteSpace($failureLeaf) -and $requestedLeaf -ieq $failureLeaf) {
            $global:AtomicFixtureRollbackFailureDelivered = $true
            throw "Injected one-shot rollback removal failure: $($global:AtomicFixtureRollbackFailurePoint)"
        }
    }

    if ([string]::IsNullOrWhiteSpace($Filter)) {
        return Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -Force:$Force
    }
    return Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -Filter $Filter -Force:$Force
}

function global:New-Item {
    [CmdletBinding(SupportsShouldProcess=$true)]
    param(
        [Alias("Type")]
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
    if (-not [string]::IsNullOrWhiteSpace($global:AtomicFixtureTempLockMode) -and
        $ItemType -eq "Directory" -and $leafName -match '^atomic-install-[0-9a-f]{32}$') {
        $createdTempDirectory = Microsoft.PowerShell.Management\New-Item -ItemType $ItemType -Path $Path -Force:$Force
        $lockPath = Join-Path $Path "fixture-open-handle.bin"
        [IO.File]::WriteAllText($lockPath, "fixture-open-handle")
        $global:AtomicFixtureTempLockPath = $lockPath
        $global:AtomicFixtureTempLockStream = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        return $createdTempDirectory
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

function global:Rename-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [Parameter(Mandatory=$true)][string]$NewName
    )

    $leafName = [IO.Path]::GetFileName($LiteralPath)
    $destinationLeaf = $NewName
    $destination = Join-Path ([IO.Path]::GetDirectoryName($LiteralPath)) $NewName
    if ($global:AtomicFixtureFailurePoint -eq "busy-stage-move" -and
        $leafName -match '^\.stage-[0-9a-f]{32}$' -and
        $global:AtomicFixtureBusyStageMoveRefusals -lt 2) {
        $global:AtomicFixtureBusyStageMoveRefusals++
        throw [System.IO.IOException]::new("Injected busy stage move")
    }
    if ($global:AtomicFixtureFailurePoint -eq "current-move" -and
        $leafName -match '^\.current-[0-9a-f]{32}$') {
        throw "Injected transaction failure: current-move"
    }
    if ($global:AtomicFixtureFailurePoint -eq "atomic-current-move" -and
        $leafName -match '^\.atomic-current-[0-9a-f]{32}$') {
        throw "Injected transaction failure: atomic-current-move"
    }
    if ($global:AtomicFixtureFailurePoint -eq "stage-cleanup-probe" -and
        $leafName -eq "1.0.0" -and
        $destinationLeaf -match '^\.backup-[0-9a-f]{32}$') {
        $versionsParent = [IO.Path]::GetDirectoryName($LiteralPath)
        $stageEntry = @(Get-ChildItem -LiteralPath $versionsParent -Filter ".stage-*" -Force)[0]
        if ($null -ne $stageEntry) {
            $stageExe = Join-Path $stageEntry.FullName "atomic.exe"
            $global:AtomicFixtureStageCleanupLockedDir = $stageEntry.FullName
            $global:AtomicFixtureRemoveLockStream = [IO.File]::Open($stageExe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        }
        throw "Injected transaction failure: stage-cleanup-probe"
    }
    if ($global:AtomicFixtureFailurePoint -eq "nonlock-exists-probe" -and
        $leafName -eq "1.0.0" -and
        $destinationLeaf -match '^\.backup-[0-9a-f]{32}$') {
        $global:AtomicFixtureNonLockAttempts++
        if (-not (Test-Path -LiteralPath $destination)) {
            $global:AtomicFixtureNonLockCollisionDir = $destination
            Microsoft.PowerShell.Management\New-Item -ItemType Directory -Path $destination | Out-Null
        }
    }

    $restoreName = $null
    if ($leafName -match '^\.atomic-backup-[0-9a-f]{32}\.cmd$' -and $destinationLeaf -eq "atomic.cmd") { $restoreName = "shim-restore" }
    elseif ($leafName -match '^\.atomic-current-backup-[0-9a-f]{32}$' -and $destinationLeaf -eq "atomic-current") { $restoreName = "atomic-current-restore" }
    elseif ($leafName -match '^\.current-backup-[0-9a-f]{32}$' -and $destinationLeaf -eq "current") { $restoreName = "current-restore" }
    elseif ($leafName -match '^\.backup-[0-9a-f]{32}$' -and $destinationLeaf -eq "2.0.0") { $restoreName = "version-restore" }
    if ($global:AtomicFixtureRollbackArmed -and
        -not $global:AtomicFixtureRollbackFailureDelivered -and
        $global:AtomicFixtureRollbackFailurePoint -eq $restoreName) {
        $global:AtomicFixtureRollbackFailureDelivered = $true
        throw "Injected one-shot rollback restore failure: $restoreName"
    }

    $matchesMoveLock = $false
    if ($global:AtomicFixtureMoveLockTarget -eq "version-backup" -and
        $leafName -eq "1.0.0" -and $destinationLeaf -match '^\.backup-[0-9a-f]{32}$') {
        $matchesMoveLock = $true
    }
    elseif ($global:AtomicFixtureMoveLockTarget -eq "shim-backup" -and
        $leafName -eq "atomic.cmd" -and $destinationLeaf -match '^\.atomic-backup-[0-9a-f]{32}\.cmd$') {
        $matchesMoveLock = $true
    }
    elseif ($global:AtomicFixtureMoveLockTarget -eq "version-restore" -and
        $leafName -match '^\.backup-[0-9a-f]{32}$' -and $destinationLeaf -eq "1.0.0") {
        $matchesMoveLock = $true
    }
    if ($global:AtomicFixtureMoveLockTarget -eq "dual-rollback-restore" -and
        (($leafName -match '^\.backup-[0-9a-f]{32}$' -and $destinationLeaf -eq "1.0.0") -or
         ($leafName -match '^\.atomic-backup-[0-9a-f]{32}\.cmd$' -and $destinationLeaf -eq "atomic.cmd"))) {
        $global:AtomicFixtureDualRollbackRestoreAttempts++
    }
    if ($matchesMoveLock) {
        $global:AtomicFixtureMoveLockAttempts++
        if ($global:AtomicFixtureMoveLockMode -eq "one-shot" -and
            $global:AtomicFixtureMoveLockAttempts -ge 2 -and
            $null -ne $global:AtomicFixtureMoveLockStream) {
            $global:AtomicFixtureMoveLockStream.Dispose()
            $global:AtomicFixtureMoveLockStream = $null
        }
    }

    try {
        Microsoft.PowerShell.Management\Rename-Item -LiteralPath $LiteralPath -NewName $NewName -ErrorAction Stop
    }
    catch {
        if ($matchesMoveLock -and (Test-Path -LiteralPath $destination)) {
            $global:AtomicFixtureMoveLockSplitObserved = $true
        }
        throw
    }

    if ($global:AtomicFixtureDualRollbackLockArmed) {
        if ($destinationLeaf -match '^\.backup-[0-9a-f]{32}$') {
            $verBackupExe = Join-Path $destination "atomic.exe"
            if ([IO.File]::Exists($verBackupExe)) {
                [void]$global:AtomicFixtureDualRollbackBackupPaths.Add($destination)
                [void]$global:AtomicFixtureDualRollbackLockStreams.Add(
                    [IO.File]::Open($verBackupExe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
                )
            }
        }
        elseif ($destinationLeaf -match '^\.atomic-backup-[0-9a-f]{32}\.cmd$') {
            if ([IO.File]::Exists($destination)) {
                [void]$global:AtomicFixtureDualRollbackBackupPaths.Add($destination)
                [void]$global:AtomicFixtureDualRollbackLockStreams.Add(
                    [IO.File]::Open($destination, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
                )
            }
        }
    }
    if ($global:AtomicFixtureRollbackMoveLockArmed -and
        $destinationLeaf -match '^\.backup-[0-9a-f]{32}$' -and
        $null -eq $global:AtomicFixtureMoveLockStream) {
        $rollbackLockPath = Join-Path $destination "atomic.exe"
        if ([IO.File]::Exists($rollbackLockPath)) {
            $global:AtomicFixtureMoveLockStream = [IO.File]::Open($rollbackLockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            $global:AtomicFixtureRollbackMoveLockArmed = $false
        }
    }
    if ($global:AtomicFixtureRollbackRemoveLockArmed -and
        $leafName -match '^\.stage-[0-9a-f]{32}$' -and
        $destinationLeaf -eq "1.0.0" -and
        $null -eq $global:AtomicFixtureRemoveLockStream) {
        $rollbackRemoveLockPath = Join-Path $destination "atomic.exe"
        if ([IO.File]::Exists($rollbackRemoveLockPath)) {
            $global:AtomicFixtureRemoveLockStream = [IO.File]::Open($rollbackRemoveLockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            $global:AtomicFixtureRollbackRemoveLockArmed = $false
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($global:AtomicFixtureBackupLockMode) -and
        $destinationLeaf -match '^\.backup-[0-9a-f]{32}$' -and
        $null -eq $global:AtomicFixtureBackupLockStream) {
        $backupLockPath = Join-Path $destination "atomic.exe"
        if ([IO.File]::Exists($backupLockPath)) {
            $global:AtomicFixtureBackupLockPath = $backupLockPath
            $global:AtomicFixtureBackupLockStream = [IO.File]::Open($backupLockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($global:AtomicFixtureRollbackFailurePoint) -and
        $leafName -match '^\.atomic-[0-9a-f]{32}\.cmd$' -and $destinationLeaf -eq "atomic.cmd") {
        $global:AtomicFixtureRollbackArmed = $true
    }
}

$environmentNames = @(
    "ATOMIC_INSTALL_DIR", "ATOMIC_BIN_DIR", "ATOMIC_VERSION", "GITHUB_TOKEN", "GH_TOKEN",
    "PROCESSOR_ARCHITEW6432", "PROCESSOR_ARCHITECTURE", "TEMP", "TMP", "SystemTemp", "PATHEXT",
    "ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION", "ATOMIC_FORCE_INSTALL", "ATOMIC_FIXTURE_UPGRADE_LOG", "ATOMIC_FIXTURE_UPGRADE_EXIT", "ATOMIC_FIXTURE_INTERCOM_LOG"
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$isolatedHkcuParentPath = "Software\AtomicTestIsolatedHkcu"
$isolatedHkcuRunId = if ([string]::IsNullOrWhiteSpace($IsolatedHkcuRunId)) { "run-" + [Guid]::NewGuid().ToString("N") } else { $IsolatedHkcuRunId }
if ($isolatedHkcuRunId.Contains("\") -or $isolatedHkcuRunId.Contains("/")) {
    throw "IsolatedHkcuRunId must be a single registry key name: $isolatedHkcuRunId"
}
$isolatedHkcuSubKey = "$isolatedHkcuParentPath\$isolatedHkcuRunId"
$isolatedHkcuKey = $null
$isolatedHkcuActive = $false
$isolatedSeedUserPath = "%SystemRoot%\AtomicFixtureSeedPath"

try {
    $isolatedHkcuParentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($isolatedHkcuParentPath)
    Assert-Fixture ($null -ne $isolatedHkcuParentKey) "failed to open isolated HKCU parent key $isolatedHkcuParentPath"
    try {
        $isolatedHkcuKey = $isolatedHkcuParentKey.CreateSubKey(
            $isolatedHkcuRunId,
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
            [Microsoft.Win32.RegistryOptions]::Volatile
        )
        Assert-Fixture ($null -ne $isolatedHkcuKey) "failed to create isolated volatile HKCU registry key $isolatedHkcuSubKey"
        $selfProcess = [Diagnostics.Process]::GetCurrentProcess()
        try {
            $isolatedHkcuKey.SetValue("FixturePid", [string]$PID, [Microsoft.Win32.RegistryValueKind]::String)
            $isolatedHkcuKey.SetValue("FixtureStartTicks", [string]$selfProcess.StartTime.ToUniversalTime().Ticks, [Microsoft.Win32.RegistryValueKind]::String)
        }
        finally {
            $selfProcess.Dispose()
        }
        if ($IsolatedHkcuOwnerPid -gt 0) {
            try {
                $ownerProcess = [Diagnostics.Process]::GetProcessById($IsolatedHkcuOwnerPid)
                try {
                    $isolatedHkcuKey.SetValue("OwnerPid", [string]$IsolatedHkcuOwnerPid, [Microsoft.Win32.RegistryValueKind]::String)
                    $isolatedHkcuKey.SetValue("OwnerStartTicks", [string]$ownerProcess.StartTime.ToUniversalTime().Ticks, [Microsoft.Win32.RegistryValueKind]::String)
                }
                finally {
                    $ownerProcess.Dispose()
                }
            }
            catch {
            }
        }
        $isolatedHkcuKey.SetValue("MetadataReady", "1", [Microsoft.Win32.RegistryValueKind]::String)

        $isolatedEnvKey = $isolatedHkcuKey.CreateSubKey(
            "Environment",
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
            [Microsoft.Win32.RegistryOptions]::Volatile
        )
        Assert-Fixture ($null -ne $isolatedEnvKey) "failed to create isolated volatile Environment subkey under $isolatedHkcuSubKey"
        try {
            $isolatedEnvKey.SetValue("Path", $isolatedSeedUserPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        }
        finally {
            $isolatedEnvKey.Close()
        }

        Clear-DeadIsolatedHkcuKeys $isolatedHkcuParentKey $isolatedHkcuRunId
    }
    finally {
        $isolatedHkcuParentKey.Close()
    }
    $overrideRc = [AtomicTestHkcuOverride]::RegOverridePredefKey(
        [AtomicTestHkcuOverride]::HKEY_CURRENT_USER,
        $isolatedHkcuKey.Handle.DangerousGetHandle()
    )
    Assert-Fixture ($overrideRc -eq 0) "RegOverridePredefKey enable failed with Win32 error $overrideRc"
    $isolatedHkcuActive = $true

    $env:ATOMIC_INSTALL_DIR = $installRoot
    $env:ATOMIC_BIN_DIR = $binDir
    $env:TEMP = $fixtureTemp
    $env:TMP = $fixtureTemp
    $env:GITHUB_TOKEN = "github-token"
    $env:GH_TOKEN = "gh-token"
    $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null
    $upgradeLog = Join-Path $workspace "upgrade.log"
    $env:ATOMIC_FIXTURE_UPGRADE_LOG = $upgradeLog
    $env:ATOMIC_FIXTURE_UPGRADE_EXIT = $null
    $intercomLog = Join-Path $workspace "intercom.log"
    $env:ATOMIC_FIXTURE_INTERCOM_LOG = $intercomLog
    $env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
    if ($Scenario -eq "hash-fallback") {
        function global:Get-Command {
            [CmdletBinding()]
            param([string]$Name)
            if ($Name -eq "Get-FileHash") {
                return $null
            }
            throw "Unexpected Get-Command lookup: $Name"
        }
    }

    if ($Scenario -eq "install") {
        $helpOutput = & $InstallerPath -Help | Out-String
        Assert-Fixture ($helpOutput -match 'Usage:[\s\S]+-Ref <tag>[\s\S]+-Help') "-Help did not describe supported parameters"
        Assert-Fixture ($helpOutput -match 'Default bin directory:.*LOCALAPPDATA\\atomic\\bin') "-Help did not document the bin default"
        Assert-Fixture ($global:AtomicFixtureRequests.Count -eq 0) "-Help performed a network request"

        $env:ATOMIC_VERSION = "environment-must-not-win"
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "ARM64"
        $firstInstallOutput = & $InstallerPath -Ref "1.0.0" | Out-String

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
        $installedEnvKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
        try {
            $rawInstalledUserPath = $installedEnvKey.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $installedUserPathKind = $installedEnvKey.GetValueKind("Path")
        }
        finally {
            $installedEnvKey.Close()
        }
        Assert-Fixture ($rawInstalledUserPath -ceq "$isolatedSeedUserPath;$binDir") "User PATH did not preserve unexpanded seed entry: [$rawInstalledUserPath]"
        Assert-Fixture ($installedUserPathKind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) "User PATH lost REG_EXPAND_SZ registry kind: [$installedUserPathKind]"
        Assert-Fixture (Test-ExactPathEntry $env:Path $binDir) "current PATH was not refreshed"
        Assert-Fixture ($firstInstallOutput -match ('(?m)^Installed to ' + [regex]::Escape($shim) + '\s*$')) "first install did not report the installed launcher path"
        Assert-Fixture ($firstInstallOutput -match ('(?m)^Added ' + [regex]::Escape($binDir) + ' to your User PATH; open a new terminal to use atomic\.\s*$')) "first install did not report the User PATH update"
        Assert-Fixture ($global:AtomicFixtureHttpAssemblyRefusals -ge 1) "the archive download did not attempt the HttpClient stream before falling back"
        Assert-Fixture ((@(Get-Content -LiteralPath $upgradeLog) -join ",") -ceq "1.0.0") "the first install did not run 'intercom upgrade' once through the new shim"

        $firstApiRequest = @($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/tags/1\.0\.0$' })[0]
        Assert-Fixture ($null -ne $firstApiRequest) "explicit -Ref did not use the exact tag endpoint"
        Assert-Fixture ($firstApiRequest.Authorization -eq "Bearer github-token") "GITHUB_TOKEN did not win over GH_TOKEN"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/download/1\.0\.0/' }).Count -eq 2) "explicit -Ref did not download the requested release"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match 'environment-must-not-win' }).Count -eq 0) "ATOMIC_VERSION overrode explicit -Ref"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match 'atomic-windows-x64\.zip$' }).Count -eq 1) "WOW64 architecture did not select x64"

        Set-Content -LiteralPath (Join-Path $versionOne "stale.txt") -Value "stale"
        $env:GITHUB_TOKEN = $null
        $env:GH_TOKEN = "gh-token"
        $env:ATOMIC_VERSION = "1.0.0"
        $skipRequestStart = $global:AtomicFixtureRequests.Count
        $reinstallOutput = & $InstallerPath | Out-String
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $versionOne "stale.txt")) "a healthy same-version rerun was not skipped"
        Assert-Fixture ($reinstallOutput -match ('(?m)^Installed to ' + [regex]::Escape($shim) + '\s*$')) "same-version rerun did not report the installed launcher path"
        Assert-Fixture ($reinstallOutput -notmatch 'to your User PATH') "same-version rerun claimed a User PATH update although the entry already existed"
        Assert-Fixture (@(Get-Content -LiteralPath $upgradeLog).Count -eq 1) "a skipped same-version rerun ran 'intercom upgrade'"
        Assert-Fixture (@($global:AtomicFixtureRequests | Select-Object -Skip $skipRequestStart | Where-Object { $_.Uri -match '/releases/download/' }).Count -eq 0) "a healthy same-version rerun still downloaded release assets"
        Assert-Fixture (@($global:AtomicFixtureRequests | Select-Object -Skip $skipRequestStart).Count -eq 0) "a healthy same-version rerun made a network request"
        $forcedOutput = & $InstallerPath -Force | Out-String
        $fallbackApiRequests = @($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/tags/1\.0\.0$' })
        Assert-Fixture ($fallbackApiRequests[$fallbackApiRequests.Count - 1].Authorization -eq "Bearer gh-token") "GH_TOKEN was not used when GITHUB_TOKEN was unset"
        Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $versionOne "stale.txt"))) "forced same-version reinstall was not clean"
        Assert-Fixture ($forcedOutput -match ('(?m)^Installed to ' + [regex]::Escape($shim) + '\s*$')) "forced reinstall did not report the installed launcher path"

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

        # A failing 'intercom upgrade' after the commit only warns: the install stays and the installer succeeds.
        $env:ATOMIC_FIXTURE_UPGRADE_EXIT = "1"
        $upgradeCallsBefore = @(Get-Content -LiteralPath $upgradeLog).Count
        $warningOutput = & $InstallerPath -Force 3>&1 | Out-String
        $env:ATOMIC_FIXTURE_UPGRADE_EXIT = $null
        Assert-Fixture (@(Get-Content -LiteralPath $upgradeLog).Count -eq ($upgradeCallsBefore + 1)) "the forced reinstall did not run 'intercom upgrade' once"
        Assert-Fixture ($warningOutput -match "intercom upgrade' exited with code 1") "a failing 'intercom upgrade' was not reported as a warning: $warningOutput"
        Assert-Fixture ($warningOutput -match ('(?m)^Installed to ' + [regex]::Escape($shim) + '\s*$')) "a failing 'intercom upgrade' stopped the installer before its summary"
        $upgradeFailureProbe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($upgradeFailureProbe.ExitCode -eq 0 -and $upgradeFailureProbe.Output -eq "2.0.0") "a failing 'intercom upgrade' damaged the committed install"
        Assert-Fixture (@(Get-Content -LiteralPath $intercomLog | Where-Object { $_ -like "upgrade *" -and $_ -notlike "* redirected=True" }).Count -eq 0) "'intercom upgrade' read the installer's input"

        # A release without 'intercom upgrade' is asked at most for its help, never runs it, and the installer does not warn.
        Remove-Item -LiteralPath $intercomLog -Force
        $upgradeCallsBefore = @(Get-Content -LiteralPath $upgradeLog).Count
        $withoutUpgradeOutput = & $InstallerPath -Ref 0.9.71 3>&1 | Out-String
        Assert-Fixture ((@(Get-Content -LiteralPath $intercomLog) -join ",") -ceq "help 0.9.71") "0.9.71 was asked for more than its Intercom help: $(@(Get-Content -LiteralPath $intercomLog) -join ',')"
        Assert-Fixture ($withoutUpgradeOutput -notmatch "intercom upgrade") "installing 0.9.71 warned about 'intercom upgrade': $withoutUpgradeOutput"
        $promptOutput = & $InstallerPath -Ref 0.9.41 3>&1 | Out-String
        Assert-Fixture ((@(Get-Content -LiteralPath $intercomLog) -join ",") -ceq "help 0.9.71") "0.9.41 was asked an Intercom command: $(@(Get-Content -LiteralPath $intercomLog) -join ',')"
        Assert-Fixture ($promptOutput -notmatch "intercom upgrade") "installing 0.9.41 warned about 'intercom upgrade': $promptOutput"
        Assert-Fixture (@(Get-Content -LiteralPath $upgradeLog).Count -eq $upgradeCallsBefore) "a release without 'intercom upgrade' ran it"
        $oldReleaseProbe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($oldReleaseProbe.ExitCode -eq 0 -and $oldReleaseProbe.Output -eq "0.9.41") "the pinned 0.9.41 install did not complete"
    }
    elseif ($Scenario -eq "tag-grammar") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"

        foreach ($invalidTag in @("v1.0.0", "1.0", "1.0.0.0", "1.0.0-alpha.0", "1.0.0-beta.1", "1.0.0-alpha", "01.0.0", "release/1.0", "hash#tag", "percent%tag")) {
            $requestStart = @($global:AtomicFixtureRequests).Count
            $rejected = $null
            try { & $InstallerPath -Ref $invalidTag | Out-Null }
            catch { $rejected = $_ }
            Assert-Fixture ($null -ne $rejected) "explicit ref $invalidTag was accepted"
            Assert-Fixture ($rejected.Exception.Message -match 'unsupported release tag: expected MAJOR\.MINOR\.PATCH or MAJOR\.MINOR\.PATCH-alpha\.REVISION') "explicit ref $invalidTag was rejected for the wrong reason: $($rejected.Exception.Message)"
            Assert-Fixture (@($global:AtomicFixtureRequests).Count -eq $requestStart) "explicit ref $invalidTag performed a request"
            Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "explicit ref $invalidTag created an install root"
            Assert-Fixture (-not (Test-Path -LiteralPath $binDir)) "explicit ref $invalidTag created a bin directory"
            Assert-Fixture (@(Get-ChildItem -LiteralPath $fixtureTemp -Filter "atomic-install-*" -Force).Count -eq 0) "explicit ref $invalidTag created transaction temp state"
        }

        $env:ATOMIC_VERSION = "not-a-tag"
        $envRejected = $null
        $envRequestStart = @($global:AtomicFixtureRequests).Count
        try { & $InstallerPath | Out-Null }
        catch { $envRejected = $_ }
        Assert-Fixture ($null -ne $envRejected) "ATOMIC_VERSION was not validated"
        Assert-Fixture ($envRejected.Exception.Message -match 'unsupported release tag') "ATOMIC_VERSION rejection used the wrong message"
        Assert-Fixture (@($global:AtomicFixtureRequests).Count -eq $envRequestStart) "ATOMIC_VERSION rejection performed a request"
        $env:ATOMIC_VERSION = $null

        foreach ($validTag in @("1.0.0", "1.0.0-alpha.1")) {
            & $InstallerPath -Ref $validTag | Out-Null
            Assert-Fixture (Test-Path -LiteralPath (Join-Path $installRoot ("versions\" + [Uri]::EscapeDataString($validTag) + "\atomic.exe"))) "valid tag $validTag did not install"
            Assert-NoTransactionResidue $installRoot $binDir
        }
        Reset-FixtureInstallState @($installRoot, $binDir)

        $global:AtomicFixtureRedirectTag = "release/1.0"
        $redirectRequestStart = @($global:AtomicFixtureRequests).Count
        $redirectRejected = $null
        try { & $InstallerPath | Out-Null }
        catch { $redirectRejected = $_ }
        Assert-Fixture ($null -ne $redirectRejected) "an unsupported latest redirect tag was accepted"
        Assert-Fixture ($redirectRejected.Exception.Message -match 'unsupported release tag') "latest redirect rejection used the wrong message"
        $redirectRequests = @($global:AtomicFixtureRequests | Select-Object -Skip $redirectRequestStart)
        Assert-Fixture (@($redirectRequests | Where-Object { $_.Uri -match '/releases/download/' }).Count -eq 0) "an unsupported latest redirect tag still downloaded a release"
        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "an unsupported latest redirect tag created an install root"
        $global:AtomicFixtureRedirectTag = "2.0.0"

        $global:AtomicFixtureRedirectFails = $true
        $global:AtomicFixtureLatestApiTag = "not-a-tag"
        $apiRequestStart = @($global:AtomicFixtureRequests).Count
        $apiRejected = $null
        try { & $InstallerPath | Out-Null }
        catch { $apiRejected = $_ }
        Assert-Fixture ($null -ne $apiRejected) "an unsupported latest API tag_name was accepted"
        Assert-Fixture ($apiRejected.Exception.Message -match 'unsupported release tag') "latest API rejection used the wrong message"
        $apiRequests = @($global:AtomicFixtureRequests | Select-Object -Skip $apiRequestStart)
        Assert-Fixture (@($apiRequests | Where-Object { $_.Uri -match '/releases/download/' }).Count -eq 0) "an unsupported latest API tag_name still downloaded a release"
        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "an unsupported latest API tag_name created an install root"
        $global:AtomicFixtureLatestApiTag = "2.0.0"
        $global:AtomicFixtureRedirectFails = $false
    }
    elseif ($Scenario -eq "missing-cmd-pathext") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $env:PATHEXT = ".EXE;.BAT"
        $requestStart = @($global:AtomicFixtureRequests).Count
        $rejected = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $rejected = $_ }
        Assert-Fixture ($null -ne $rejected) "a PATHEXT without .CMD reported success"
        Assert-Fixture ($rejected.Exception.Message -match '\.CMD') "the missing-.CMD rejection did not name .CMD"
        Assert-Fixture ($rejected.Exception.Message -match 'bare atomic') "the missing-.CMD rejection did not name bare atomic"
        Assert-Fixture (@($global:AtomicFixtureRequests).Count -eq $requestStart) "the missing-.CMD rejection performed a request"
        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "the missing-.CMD rejection created an install root"
        Assert-Fixture (-not (Test-Path -LiteralPath $binDir)) "the missing-.CMD rejection created a bin directory"
        $rejectionResidue = Get-TempResidueReport $fixtureTemp
        Assert-Fixture ($rejectionResidue.Count -eq 0) "the missing-.CMD rejection created transaction temp state: $($rejectionResidue.Paths)"

        foreach ($acceptedPathExt in @(".cmd;.EXE", '  " .CMD " ; ".EXE"  ', ".EXE;.CMD;.BAT", $null)) {
            Reset-FixtureInstallState @($installRoot, $binDir)
            $env:PATHEXT = $acceptedPathExt
            & $InstallerPath -Ref "1.0.0" | Out-Null
            Assert-Fixture (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd")) "PATHEXT '$acceptedPathExt' blocked a valid install"
            Assert-NoTransactionResidue $installRoot $binDir
        }
        $env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
    }
    elseif ($Scenario -eq "pointer-conflicts") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"

        foreach ($case in @(
            [pscustomobject]@{ Label = "current directory"; Parent = "install"; Name = "current"; Kind = "Directory"; Message = 'ATOMIC_INSTALL_DIR contains an unexpected current entry' },
            [pscustomobject]@{ Label = "current file"; Parent = "install"; Name = "current"; Kind = "File"; Message = 'ATOMIC_INSTALL_DIR contains an unexpected current entry' },
            [pscustomobject]@{ Label = "atomic-current directory"; Parent = "bin"; Name = "atomic-current"; Kind = "Directory"; Message = 'ATOMIC_BIN_DIR contains an unexpected atomic-current entry' },
            [pscustomobject]@{ Label = "atomic-current file"; Parent = "bin"; Name = "atomic-current"; Kind = "File"; Message = 'ATOMIC_BIN_DIR contains an unexpected atomic-current entry' }
        )) {
            Reset-FixtureInstallState @($installRoot, $binDir)
            $parentPath = if ($case.Parent -eq "install") { $installRoot } else { $binDir }
            New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
            $conflictPath = Join-Path $parentPath $case.Name
            if ($case.Kind -eq "Directory") {
                New-Item -ItemType Directory -Path $conflictPath -Force | Out-Null
                Set-Content -LiteralPath (Join-Path $conflictPath "marker.txt") -Value "caller-data" -Encoding ASCII -NoNewline
            }
            else {
                Set-Content -LiteralPath $conflictPath -Value "caller-data" -Encoding ASCII -NoNewline
            }

            $requestStart = @($global:AtomicFixtureRequests).Count
            $rejected = $null
            try { & $InstallerPath -Ref "1.0.0" | Out-Null }
            catch { $rejected = $_ }
            Assert-Fixture ($null -ne $rejected) "a regular $($case.Label) was accepted"
            Assert-Fixture ($rejected.Exception.Message -match $case.Message) "the $($case.Label) rejection used the wrong message: $($rejected.Exception.Message)"
            Assert-Fixture (@($global:AtomicFixtureRequests).Count -eq $requestStart) "the $($case.Label) rejection performed a request"
            if ($case.Kind -eq "Directory") {
                Assert-Fixture ((Get-Content -LiteralPath (Join-Path $conflictPath "marker.txt") -Raw) -eq "caller-data") "the $($case.Label) marker data was not preserved"
            }
            else {
                Assert-Fixture ((Get-Content -LiteralPath $conflictPath -Raw) -eq "caller-data") "the $($case.Label) file content was not preserved"
            }
            Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $installRoot "versions"))) "the $($case.Label) rejection created a versions directory"
            Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd"))) "the $($case.Label) rejection created a shim"
            Assert-Fixture (@(Get-ChildItem -LiteralPath $fixtureTemp -Filter "atomic-install-*" -Force).Count -eq 0) "the $($case.Label) rejection created transaction temp state"
            Assert-NoTransactionResidue $installRoot $binDir
        }

        Reset-FixtureInstallState @($installRoot, $binDir)
        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd")) "the reparse-point control install did not complete"
        & $InstallerPath -Ref "2.0.0" | Out-Null
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $installRoot "current\version.txt") -Raw) -eq "2.0.0") "an installer-owned current junction was not replaced"
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "preflight-errors") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        $stalePath = Join-Path $binDir "atomic.exe"
        Copy-Item -LiteralPath $fixtureExecutable -Destination $stalePath

        $requestStart = @($global:AtomicFixtureRequests).Count
        $preflightError = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $preflightError = $_ }
        Assert-Fixture ($null -ne $preflightError) "the preflight blocker did not fail"
        Assert-Fixture ($preflightError.Exception.Message -ceq "ATOMIC_BIN_DIR contains atomic.exe, which PATHEXT resolves before atomic.cmd; remove it and rerun the installer.") "the preflight error was replaced: $($preflightError.Exception.Message)"
        Assert-Fixture ($preflightError.Exception.Message -notmatch 'variable') "the preflight error mentions an uninitialized variable"
        Assert-Fixture (@($global:AtomicFixtureRequests).Count -eq $requestStart) "the preflight blocker performed a request"
        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "the preflight blocker created an install root"
        Remove-Item -LiteralPath $stalePath -Force

        $global:AtomicFixtureFailApi = $true
        $global:AtomicFixtureRedirectFails = $true
        $apiError = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $apiError = $_ }
        $global:AtomicFixtureFailApi = $false
        $global:AtomicFixtureRedirectFails = $false
        Assert-Fixture ($null -ne $apiError) "the failing API request did not fail the install"
        Assert-Fixture ($apiError.Exception.Message -match 'Failed to query GitHub release API at https://api\.github\.com/repos/bastani-inc/atomic/releases/tags/1\.0\.0') "the API error was replaced: $($apiError.Exception.Message)"
        Assert-Fixture ($apiError.Exception.Message -notmatch 'variable') "the API error mentions an uninitialized variable"
        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "the failing API request created an install root"
        Assert-Fixture (@(Get-ChildItem -LiteralPath $fixtureTemp -Filter "atomic-install-*" -Force).Count -eq 0) "the failing API request created transaction temp state"
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

        # A user who has no User Path value keeps having none after a rollback (not an empty one).
        $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        $savedRawPath = $environmentKey.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $savedPathKind = if ($null -ne $savedRawPath) { $environmentKey.GetValueKind("Path") } else { $null }
        try {
            $environmentKey.DeleteValue("Path", $false)
            $failure = $null
            try { & $InstallerPath -Ref "2.0.0" | Out-Null }
            catch { $failure = $_ }
            Assert-Fixture ($null -ne $failure) "the second final smoke failure was not reported"
            $rolledBackPath = $environmentKey.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            Assert-Fixture ($null -eq $rolledBackPath) "rollback wrote a User Path value for a user who had none: [$rolledBackPath]"
        }
        finally {
            if ($null -ne $savedRawPath) { $environmentKey.SetValue("Path", $savedRawPath, $savedPathKind) }
            $environmentKey.Close()
        }
    }
    elseif ($Scenario -eq "busy-stage-move") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $global:AtomicFixtureFailurePoint = "busy-stage-move"
        & $InstallerPath -Ref "2.0.0" | Out-Null
        $global:AtomicFixtureFailurePoint = $null
        Assert-Fixture ($global:AtomicFixtureBusyStageMoveRefusals -eq 2) "the staged version move was not refused twice"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $installRoot "current\version.txt") -Raw) -eq "2.0.0") "a staged version move refused twice did not install the version"
        $probe = Invoke-FixtureShim (Join-Path $binDir "atomic.cmd") "--version"
        Assert-Fixture ($probe.ExitCode -eq 0 -and $probe.Output -eq "2.0.0") "shim failed after a staged version move was refused twice"
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "locked-version-backup") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $versionOne = Join-Path $installRoot "versions\1.0.0"
        $exeOne = Join-Path $versionOne "atomic.exe"
        $shim = Join-Path $binDir "atomic.cmd"

        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-Fixture (Test-Path -LiteralPath $exeOne -PathType Leaf) "seed 1.0.0 install did not complete"

        # 1. Brief real OS read handle (FileShare.ReadWrite, like antivirus/indexer) on versions\1.0.0\atomic.exe
        #    during version backup rename: attempt 1 fails atomically (no split), attempt 2 releases handle and succeeds.
        $global:AtomicFixtureMoveLockTarget = "version-backup"
        $global:AtomicFixtureMoveLockMode = "one-shot"
        $global:AtomicFixtureMoveLockAttempts = 0
        $global:AtomicFixtureMoveLockSplitObserved = $false
        $global:AtomicFixtureMoveLockStream = [IO.File]::Open($exeOne, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        }
        finally {
            $global:AtomicFixtureMoveLockTarget = $null
            $global:AtomicFixtureMoveLockMode = $null
            if ($null -ne $global:AtomicFixtureMoveLockStream) {
                $global:AtomicFixtureMoveLockStream.Dispose()
                $global:AtomicFixtureMoveLockStream = $null
            }
        }
        Assert-Fixture ($global:AtomicFixtureMoveLockAttempts -ge 2) "a real briefly locked versions\1.0.0 did not force a rename retry ($($global:AtomicFixtureMoveLockAttempts) attempts)"
        Assert-Fixture (-not $global:AtomicFixtureMoveLockSplitObserved) "a failed version backup rename created a partial destination directory"
        $probe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($probe.ExitCode -eq 0 -and $probe.Output -eq "1.0.0") "shim failed after recovering from a locked version backup"
        Assert-NoTransactionResidue $installRoot $binDir

        # 2. Brief real OS read handle (FileShare.Read, without Delete) on atomic.cmd during shim backup rename.
        $global:AtomicFixtureMoveLockTarget = "shim-backup"
        $global:AtomicFixtureMoveLockMode = "one-shot"
        $global:AtomicFixtureMoveLockAttempts = 0
        $global:AtomicFixtureMoveLockSplitObserved = $false
        $global:AtomicFixtureMoveLockStream = [IO.File]::Open($shim, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        }
        finally {
            $global:AtomicFixtureMoveLockTarget = $null
            $global:AtomicFixtureMoveLockMode = $null
            if ($null -ne $global:AtomicFixtureMoveLockStream) {
                $global:AtomicFixtureMoveLockStream.Dispose()
                $global:AtomicFixtureMoveLockStream = $null
            }
        }
        Assert-Fixture ($global:AtomicFixtureMoveLockAttempts -ge 2) "a real briefly locked atomic.cmd did not force a rename retry ($($global:AtomicFixtureMoveLockAttempts) attempts)"
        $probe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($probe.ExitCode -eq 0 -and $probe.Output -eq "1.0.0") "shim failed after recovering from a locked shim backup"
        Assert-NoTransactionResidue $installRoot $binDir

        # 3. Brief real OS handle on .backup-*\atomic.exe during rollback restore after a failing final smoke.
        Set-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Value "rollback-preserved" -NoNewline
        $global:AtomicFixtureWarnings.Clear()
        $global:AtomicFixtureMoveLockTarget = "version-restore"
        $global:AtomicFixtureMoveLockMode = "one-shot"
        $global:AtomicFixtureMoveLockAttempts = 0
        $global:AtomicFixtureMoveLockSplitObserved = $false
        $global:AtomicFixtureRollbackMoveLockArmed = $true
        $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = "1.0.0"
        $rollbackSmokeFailure = $null
        try {
            & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        }
        catch {
            $rollbackSmokeFailure = $_
        }
        finally {
            $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null
            $global:AtomicFixtureRollbackMoveLockArmed = $false
            $global:AtomicFixtureMoveLockTarget = $null
            $global:AtomicFixtureMoveLockMode = $null
            if ($null -ne $global:AtomicFixtureMoveLockStream) {
                $global:AtomicFixtureMoveLockStream.Dispose()
                $global:AtomicFixtureMoveLockStream = $null
            }
        }
        Assert-Fixture ($null -ne $rollbackSmokeFailure) "a failing final smoke reported success"
        Assert-Fixture ($global:AtomicFixtureMoveLockAttempts -ge 2) "a real briefly locked version backup during rollback did not force a restore retry ($($global:AtomicFixtureMoveLockAttempts) attempts)"
        Assert-Fixture (-not $global:AtomicFixtureMoveLockSplitObserved) "a failed rollback restore rename created a partial destination directory"
        $rollbackWarnings = @($global:AtomicFixtureWarnings | Where-Object { $_ -match 'Failed to restore|rollback remains incomplete' })
        Assert-Fixture ($rollbackWarnings.Count -eq 0) "a recovered rollback restore still warned: $($rollbackWarnings -join '; ')"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Raw) -ceq "rollback-preserved") "rollback did not restore the previous version directory"
        Assert-NoTransactionResidue $installRoot $binDir

        # 4. Permanent real OS handle on versions\1.0.0\atomic.exe: exhausts bounded retries, fails cleanly,
        #    and leaves versions\1.0.0 completely intact (no split, no incomplete rollback, runnable shim).
        $global:AtomicFixtureWarnings.Clear()
        $global:AtomicFixtureMoveLockTarget = "version-backup"
        $global:AtomicFixtureMoveLockMode = "sticky"
        $global:AtomicFixtureMoveLockAttempts = 0
        $global:AtomicFixtureMoveLockSplitObserved = $false
        $global:AtomicFixtureMoveLockStream = [IO.File]::Open($exeOne, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $permanentFailure = $null
        try {
            & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        }
        catch {
            $permanentFailure = $_
        }
        finally {
            $global:AtomicFixtureMoveLockTarget = $null
            $global:AtomicFixtureMoveLockMode = $null
            if ($null -ne $global:AtomicFixtureMoveLockStream) {
                $global:AtomicFixtureMoveLockStream.Dispose()
                $global:AtomicFixtureMoveLockStream = $null
            }
        }
        Assert-Fixture ($null -ne $permanentFailure) "a permanently locked versions\1.0.0 unexpectedly succeeded"
        Assert-Fixture ($global:AtomicFixtureMoveLockAttempts -eq 15) "a permanently locked version backup did not exhaust the bounded retry budget ($($global:AtomicFixtureMoveLockAttempts) attempts)"
        Assert-Fixture (-not $global:AtomicFixtureMoveLockSplitObserved) "a permanently locked version backup split files into a partial backup directory"
        $permanentRollbackWarnings = @($global:AtomicFixtureWarnings | Where-Object { $_ -match 'rollback remains incomplete' })
        Assert-Fixture ($permanentRollbackWarnings.Count -eq 0) "a permanently locked version backup left rollback incomplete: $($permanentRollbackWarnings -join '; ')"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Raw) -ceq "rollback-preserved") "a permanently locked version backup damaged the existing version payload"
        foreach ($requiredFile in @("atomic.exe", "package.json", "app.js", "native-modifiers.js", "native-module-path.js", "native-platform.js", ".atomic-launcher.sha256")) {
            Assert-Fixture (Test-Path -LiteralPath (Join-Path $versionOne $requiredFile) -PathType Leaf) "a permanently locked version backup removed $requiredFile from versions\1.0.0"
        }
        $probe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($probe.ExitCode -eq 0 -and $probe.Output -eq "1.0.0") "shim failed after a permanently locked reinstall rolled back"
        Assert-NoTransactionResidue $installRoot $binDir

        # 5. Brief real OS handle (FileShare.ReadWrite) on newly-installed versions\1.0.0\atomic.exe during
        #    rollback version removal (Invoke-AtomicTransactionRollback -> Remove-AtomicDirectoryLinkOrTree):
        #    attempt 1 fails with real OS lock, attempt 2 releases handle and completes rollback cleanly.
        $global:AtomicFixtureWarnings.Clear()
        $global:AtomicFixtureRemoveLockTarget = "rollback-version"
        $global:AtomicFixtureRemoveLockMode = "one-shot"
        $global:AtomicFixtureRemoveLockAttempts = 0
        $global:AtomicFixtureRollbackRemoveLockArmed = $true
        $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = "1.0.0"
        $rollbackRemoveFailure = $null
        try {
            & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        }
        catch {
            $rollbackRemoveFailure = $_
        }
        finally {
            $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null
            $global:AtomicFixtureRollbackRemoveLockArmed = $false
            $global:AtomicFixtureRemoveLockTarget = $null
            $global:AtomicFixtureRemoveLockMode = $null
            if ($null -ne $global:AtomicFixtureRemoveLockStream) {
                $global:AtomicFixtureRemoveLockStream.Dispose()
                $global:AtomicFixtureRemoveLockStream = $null
            }
        }
        Assert-Fixture ($null -ne $rollbackRemoveFailure) "a failing final smoke with locked rollback removal reported success"
        Assert-Fixture ($global:AtomicFixtureRemoveLockAttempts -ge 2) "a real briefly locked rollback version directory did not force a removal retry ($($global:AtomicFixtureRemoveLockAttempts) attempts)"
        $rollbackRemoveWarnings = @($global:AtomicFixtureWarnings | Where-Object { $_ -match 'Failed to remove the unsuccessful version directory|Failed to restore|rollback remains incomplete' })
        Assert-Fixture ($rollbackRemoveWarnings.Count -eq 0) "a recovered rollback version removal still warned: $($rollbackRemoveWarnings -join '; ')"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Raw) -ceq "rollback-preserved") "rollback did not restore the previous version directory after retrying version removal"
        $probe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($probe.ExitCode -eq 0 -and $probe.Output -eq "1.0.0") "shim failed after retrying rollback version removal"
        Assert-NoTransactionResidue $installRoot $binDir

        # 6a. Brief real OS handle (FileShare.ReadWrite) on versions\.stage-*\atomic.exe during finally stage cleanup:
        #     attempt 1 fails with real OS lock, attempt 2 releases handle and leaves no stage residue.
        $global:AtomicFixtureWarnings.Clear()
        $global:AtomicFixtureFailurePoint = "stage-cleanup-probe"
        $global:AtomicFixtureRemoveLockTarget = "stage-cleanup"
        $global:AtomicFixtureRemoveLockMode = "one-shot"
        $global:AtomicFixtureRemoveLockAttempts = 0
        $global:AtomicFixtureStageCleanupLockedDir = $null
        $stageOneShotFailure = $null
        try {
            & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        }
        catch {
            $stageOneShotFailure = $_
        }
        finally {
            $global:AtomicFixtureFailurePoint = $null
            $global:AtomicFixtureRemoveLockTarget = $null
            $global:AtomicFixtureRemoveLockMode = $null
            if ($null -ne $global:AtomicFixtureRemoveLockStream) {
                $global:AtomicFixtureRemoveLockStream.Dispose()
                $global:AtomicFixtureRemoveLockStream = $null
            }
        }
        Assert-Fixture ($null -ne $stageOneShotFailure -and $stageOneShotFailure.Exception.Message -match 'Injected transaction failure: stage-cleanup-probe') "the stage-cleanup-probe failure was lost: $stageOneShotFailure"
        Assert-Fixture ($global:AtomicFixtureRemoveLockAttempts -ge 2) "a real briefly locked stage directory in finally did not force a removal retry ($($global:AtomicFixtureRemoveLockAttempts) attempts)"
        Assert-Fixture (-not (Test-Path -LiteralPath $global:AtomicFixtureStageCleanupLockedDir)) "finally left the briefly locked stage directory behind: $($global:AtomicFixtureStageCleanupLockedDir)"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Raw) -ceq "rollback-preserved") "a stage-cleanup failure altered the existing version"
        Assert-NoTransactionResidue $installRoot $binDir

        # 6b. Sticky real OS handle on versions\.stage-*\atomic.exe during finally stage cleanup:
        #     exhausts bounded retries, preserves best-effort SilentlyContinue semantics (never masks primary error
        #     or blocks temp cleanup), and leaves the existing install intact.
        $global:AtomicFixtureWarnings.Clear()
        $global:AtomicFixtureFailurePoint = "stage-cleanup-probe"
        $global:AtomicFixtureRemoveLockTarget = "stage-cleanup"
        $global:AtomicFixtureRemoveLockMode = "sticky"
        $global:AtomicFixtureRemoveLockAttempts = 0
        $global:AtomicFixtureStageCleanupLockedDir = $null
        $stageStickyFailure = $null
        try {
            & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        }
        catch {
            $stageStickyFailure = $_
        }
        finally {
            $global:AtomicFixtureFailurePoint = $null
            $global:AtomicFixtureRemoveLockTarget = $null
            $global:AtomicFixtureRemoveLockMode = $null
            if ($null -ne $global:AtomicFixtureRemoveLockStream) {
                $global:AtomicFixtureRemoveLockStream.Dispose()
                $global:AtomicFixtureRemoveLockStream = $null
            }
        }
        Assert-Fixture ($null -ne $stageStickyFailure -and $stageStickyFailure.Exception.Message -match 'Injected transaction failure: stage-cleanup-probe') "an exhausted best-effort stage cleanup replaced the primary error: $stageStickyFailure"
        Assert-Fixture ($global:AtomicFixtureRemoveLockAttempts -eq 9) "a permanently locked stage directory did not exhaust the bounded removal retry budget ($($global:AtomicFixtureRemoveLockAttempts) attempts)"
        $stickyStageTempResidue = Get-TempResidueReport $fixtureTemp
        Assert-Fixture ($stickyStageTempResidue.Count -eq 0) "an exhausted stage cleanup blocked temp directory cleanup: $($stickyStageTempResidue.Paths)"
        if ($null -ne $global:AtomicFixtureStageCleanupLockedDir -and (Test-Path -LiteralPath $global:AtomicFixtureStageCleanupLockedDir)) {
            Remove-Item -LiteralPath $global:AtomicFixtureStageCleanupLockedDir -Recurse -Force
        }
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Raw) -ceq "rollback-preserved") "an exhausted stage cleanup altered the existing version"
        Assert-NoTransactionResidue $installRoot $binDir

        # 7. Non-lock IOException (ERROR_ALREADY_EXISTS 0x800700B7) fails fast on attempt 1 with 0 retries.
        $global:AtomicFixtureFailurePoint = "nonlock-exists-probe"
        $global:AtomicFixtureNonLockAttempts = 0
        $global:AtomicFixtureNonLockCollisionDir = $null
        $nonLockFailure = $null
        try {
            & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        }
        catch {
            $nonLockFailure = $_
        }
        finally {
            $global:AtomicFixtureFailurePoint = $null
        }
        Assert-Fixture ($null -ne $nonLockFailure) "an existing backup destination unexpectedly succeeded"
        Assert-Fixture ($global:AtomicFixtureNonLockAttempts -eq 1) "a non-lock ERROR_ALREADY_EXISTS IOException was retried ($($global:AtomicFixtureNonLockAttempts) attempts)"
        if ($null -ne $global:AtomicFixtureNonLockCollisionDir -and (Test-Path -LiteralPath $global:AtomicFixtureNonLockCollisionDir)) {
            Remove-Item -LiteralPath $global:AtomicFixtureNonLockCollisionDir -Recurse -Force
        }
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Raw) -ceq "rollback-preserved") "a non-lock collision altered the existing version"
        Assert-NoTransactionResidue $installRoot $binDir

        # 8. Two permanently locked rollback restores share one bounded rollback retry sleep budget across
        #    catch + all finally rollback passes (never compounding 4x per item).
        $global:AtomicFixtureWarnings.Clear()
        $global:AtomicFixtureMoveLockTarget = "dual-rollback-restore"
        $global:AtomicFixtureDualRollbackLockArmed = $true
        $global:AtomicFixtureDualRollbackLockStreams.Clear()
        $global:AtomicFixtureDualRollbackBackupPaths.Clear()
        $global:AtomicFixtureDualRollbackRestoreAttempts = 0
        $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = "1.0.0"
        $dualRollbackFailure = $null
        try {
            & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        }
        catch {
            $dualRollbackFailure = $_
        }
        finally {
            $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null
            $global:AtomicFixtureMoveLockTarget = $null
            $global:AtomicFixtureDualRollbackLockArmed = $false
            foreach ($lockedStream in @($global:AtomicFixtureDualRollbackLockStreams)) {
                if ($null -ne $lockedStream) { $lockedStream.Dispose() }
            }
            $global:AtomicFixtureDualRollbackLockStreams.Clear()
        }
        Assert-Fixture ($null -ne $dualRollbackFailure) "a failing final smoke with locked rollback backups reported success"
        # With one shared 9.5 s budget across catch + 3 finally passes: first locked restore exhausts the budget (~15 attempts),
        # and every remaining item/pass still makes 1 attempt without sleeping (~22 total vs ~130 without a shared budget).
        Assert-Fixture ($global:AtomicFixtureDualRollbackRestoreAttempts -ge 15 -and $global:AtomicFixtureDualRollbackRestoreAttempts -le 25) "two permanently locked rollback restores did not share one bounded retry budget ($($global:AtomicFixtureDualRollbackRestoreAttempts) attempts)"
        $dualIncompleteWarnings = @($global:AtomicFixtureWarnings | Where-Object { $_ -match 'rollback remains incomplete' })
        Assert-Fixture ($dualIncompleteWarnings.Count -eq 1) "a permanently locked rollback did not report incomplete rollback once ($($dualIncompleteWarnings.Count))"
        # Clean up retained backups from the deliberately incomplete rollback and restore a clean install.
        foreach ($retainedBackup in @($global:AtomicFixtureDualRollbackBackupPaths)) {
            if (-not [string]::IsNullOrWhiteSpace($retainedBackup) -and (Test-Path -LiteralPath $retainedBackup)) {
                Remove-Item -LiteralPath $retainedBackup -Recurse -Force
            }
        }
        $global:AtomicFixtureDualRollbackBackupPaths.Clear()
        Reset-FixtureInstallState @($installRoot, $binDir)
        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-NoTransactionResidue $installRoot $binDir
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
        Assert-Fixture (-not [IO.Directory]::Exists($versionOne)) "version target was not deleted"

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
    elseif ($Scenario -eq "rollback-retries") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $rollbackFailurePoints = @(
            "shim-remove", "shim-restore",
            "atomic-current-remove", "atomic-current-restore",
            "current-remove", "current-restore",
            "version-remove", "version-restore"
        )
        $caseIndex = 0
        foreach ($rollbackFailurePoint in $rollbackFailurePoints) {
            $caseIndex++
            $caseRoot = Join-Path $workspace ("rollback-retry-" + $rollbackFailurePoint)
            $installRoot = Join-Path $caseRoot "install-root"
            $binDir = Join-Path $caseRoot "bin-root"
            $caseTemp = Join-Path $caseRoot "temp"
            New-Item -ItemType Directory -Path $caseTemp -Force | Out-Null
            $env:ATOMIC_INSTALL_DIR = $installRoot
            $env:ATOMIC_BIN_DIR = $binDir
            $env:TEMP = $caseTemp
            $env:TMP = $caseTemp
            $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null
            $global:AtomicFixtureRollbackFailurePoint = $null
            $global:AtomicFixtureRollbackFailureDelivered = $false
            $global:AtomicFixtureRollbackArmed = $false

            $beforeCaseUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
            $beforeCaseProcessPath = $env:Path
            & $InstallerPath -Ref "2.0.0" | Out-Null
            $versionPath = Join-Path $installRoot "versions\2.0.0"
            $currentPath = Join-Path $installRoot "current"
            $atomicCurrentPath = Join-Path $binDir "atomic-current"
            $shimPath = Join-Path $binDir "atomic.cmd"
            $payloadMarker = Join-Path $versionPath "rollback-payload.bin"
            [IO.File]::WriteAllBytes($payloadMarker, [byte[]]@(0, 3, 17, 127, 128, 244, 255))
            $oldPayloadBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($payloadMarker))
            $oldAtomicBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $versionPath "atomic.exe")))
            $oldShimContent = '@rem rollback-retry-' + $rollbackFailurePoint + [Environment]::NewLine + '@echo off' + [Environment]::NewLine + '"%~dp0atomic-current\atomic.exe" %*' + [Environment]::NewLine + 'exit /b %ERRORLEVEL%' + [Environment]::NewLine
            Set-Content -LiteralPath $shimPath -Value $oldShimContent -Encoding ASCII -NoNewline
            $oldShimBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($shimPath))
            $oldUserPath = "C:\AtomicRollbackUser-$caseIndex"
            $oldProcessPath = "C:\AtomicRollbackProcess-$caseIndex"
            [Environment]::SetEnvironmentVariable("Path", $oldUserPath, "User")
            $env:Path = $oldProcessPath

            $global:AtomicFixtureRollbackFailurePoint = $rollbackFailurePoint
            $global:AtomicFixtureRollbackFailureDelivered = $false
            $global:AtomicFixtureRollbackArmed = $false
            $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = "2.0.0"
            $failure = $null
            try { & $InstallerPath -Ref "2.0.0" | Out-Null }
            catch { $failure = $_ }
            $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null

            Assert-Fixture ($null -ne $failure -and $failure.Exception.Message -match 'Installed atomic\.cmd --version failed') "$rollbackFailurePoint did not reach the real final smoke failure"
            Assert-Fixture ($global:AtomicFixtureRollbackFailureDelivered) "$rollbackFailurePoint one-shot rollback failure was not delivered"
            Assert-Fixture ([Environment]::GetEnvironmentVariable("Path", "User") -ceq $oldUserPath) "$rollbackFailurePoint did not restore User PATH on a later rollback attempt"
            Assert-Fixture ($env:Path -ceq $oldProcessPath) "$rollbackFailurePoint did not restore current PATH on a later rollback attempt"
            Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes($payloadMarker)) -ceq $oldPayloadBytes) "$rollbackFailurePoint changed old payload bytes"
            Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $currentPath "rollback-payload.bin"))) -ceq $oldPayloadBytes) "$rollbackFailurePoint did not restore current payload bytes"
            Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $atomicCurrentPath "rollback-payload.bin"))) -ceq $oldPayloadBytes) "$rollbackFailurePoint did not restore atomic-current payload bytes"
            Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $versionPath "atomic.exe"))) -ceq $oldAtomicBytes) "$rollbackFailurePoint changed old executable bytes"
            Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes($shimPath)) -ceq $oldShimBytes) "$rollbackFailurePoint did not restore old shim bytes"
            Assert-Fixture (((Get-Item -LiteralPath $currentPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "$rollbackFailurePoint did not restore the current junction"
            Assert-Fixture (((Get-Item -LiteralPath $atomicCurrentPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "$rollbackFailurePoint did not restore the atomic-current junction"
            $rollbackProbe = Invoke-FixtureShim $shimPath "--version"
            Assert-Fixture ($rollbackProbe.ExitCode -eq 0 -and $rollbackProbe.Output -eq "2.0.0") "$rollbackFailurePoint did not leave the old shim pair executable"
            Assert-NoTransactionResidue $installRoot $binDir
            Assert-Fixture (@(Get-ChildItem -LiteralPath $caseTemp -Filter "atomic-install-*" -Force).Count -eq 0) "$rollbackFailurePoint left a temporary download directory"

            $global:AtomicFixtureRollbackFailurePoint = $null
            $global:AtomicFixtureRollbackArmed = $false
            [Environment]::SetEnvironmentVariable("Path", $beforeCaseUserPath, "User")
            $env:Path = $beforeCaseProcessPath
            Remove-Item -LiteralPath $caseRoot -Recurse -Force
        }
    }
    elseif ($Scenario -eq "ctrl-c") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $ctrlChildPath = Join-Path $workspace "ctrl-c-child.ps1"
        $ctrlHelperSourcePath = Join-Path $workspace "ctrl-c-helper.cs"
        $ctrlHelperPath = Join-Path $workspace "ctrl-c-helper.exe"
        Add-Type -Path $ctrlHelperSourcePath -OutputAssembly $ctrlHelperPath -OutputType ConsoleApplication
        $powershellPath = Join-Path $PSHOME "powershell.exe"

        $caseSpecs = @(
            [pscustomobject]@{ State = "fresh"; Move = "version-install"; RollbackFailure = "version-remove" },
            [pscustomobject]@{ State = "fresh"; Move = "current-install"; RollbackFailure = "current-remove" },
            [pscustomobject]@{ State = "fresh"; Move = "atomic-current-install"; RollbackFailure = "atomic-current-remove" },
            [pscustomobject]@{ State = "fresh"; Move = "shim-install"; RollbackFailure = "shim-remove" },
            [pscustomobject]@{ State = "existing"; Move = "version-backup"; RollbackFailure = "version-restore" },
            [pscustomobject]@{ State = "existing"; Move = "version-install"; RollbackFailure = "version-remove" },
            [pscustomobject]@{ State = "existing"; Move = "current-backup"; RollbackFailure = "current-restore" },
            [pscustomobject]@{ State = "existing"; Move = "current-install"; RollbackFailure = "current-remove" },
            [pscustomobject]@{ State = "existing"; Move = "atomic-current-backup"; RollbackFailure = "atomic-current-restore" },
            [pscustomobject]@{ State = "existing"; Move = "atomic-current-install"; RollbackFailure = "atomic-current-remove" },
            [pscustomobject]@{ State = "existing"; Move = "shim-backup"; RollbackFailure = "shim-restore" },
            [pscustomobject]@{ State = "existing"; Move = "shim-install"; RollbackFailure = "shim-remove" }
        )

        $caseIndex = 0
        foreach ($case in $caseSpecs) {
            $caseName = $case.State + "-" + $case.Move + "-" + $case.RollbackFailure
            # Leave room for the extracted payload under .NET Framework's MAX_PATH.
            $caseRoot = Join-Path $workspace ("c" + $caseIndex)
            $caseIndex += 1
            $installContainer = Join-Path $caseRoot "created-install-parent"
            $binContainer = Join-Path $caseRoot "created-bin-parent"
            $installRoot = Join-Path $installContainer "install-root"
            $binDir = Join-Path $binContainer "bin-root"
            $caseTemp = Join-Path $caseRoot "temp"
            $longestRuntimePath = Join-Path $caseTemp ("atomic-install-" + ("0" * 32) + "\payload\nested\full-payload.txt")
            Assert-Fixture ($longestRuntimePath.Length -lt 260) "$caseName fixture exceeds legacy MAX_PATH: $longestRuntimePath"
            New-Item -ItemType Directory -Path $caseRoot -Force | Out-Null
            New-Item -ItemType Directory -Path $caseTemp -Force | Out-Null
            $parentMarker = Join-Path $caseRoot "pre-existing-parent.txt"
            Set-Content -LiteralPath $parentMarker -Value ("keep-" + $caseName) -Encoding ASCII -NoNewline
            $env:ATOMIC_INSTALL_DIR = $installRoot
            $env:ATOMIC_BIN_DIR = $binDir
            $env:TEMP = $caseTemp
            $env:TMP = $caseTemp
            $beforeCaseUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
            $beforeCaseProcessPath = $env:Path

            $oldPayloadBytes = $null
            $oldAtomicBytes = $null
            $oldShimBytes = $null
            if ($case.State -eq "existing") {
                & $InstallerPath -Ref "2.0.0" | Out-Null
                $versionPath = Join-Path $installRoot "versions\2.0.0"
                $payloadMarker = Join-Path $versionPath "preserve.bin"
                [IO.File]::WriteAllBytes($payloadMarker, [byte[]]@(0, 1, 2, 127, 128, 255))
                $oldPayloadBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($payloadMarker))
                $oldAtomicBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $versionPath "atomic.exe")))
                $shimPath = Join-Path $binDir "atomic.cmd"
                $oldShimContent = '@rem ctrl-c-' + $case.Move + '-' + $case.RollbackFailure + [Environment]::NewLine + '@echo off' + [Environment]::NewLine + '"%~dp0atomic-current\atomic.exe" %*' + [Environment]::NewLine + 'exit /b %ERRORLEVEL%' + [Environment]::NewLine
                Set-Content -LiteralPath $shimPath -Value $oldShimContent -Encoding ASCII -NoNewline
                $oldShimBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($shimPath))
            }

            $expectedUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
            $expectedProcessPath = $env:Path
            $readyPath = Join-Path $caseRoot "move-ready.txt"
            $moveLogPath = Join-Path $caseRoot "moves.log"
            $observedProcessPath = Join-Path $caseRoot "observed-process-path.txt"
            $childFinallyPath = Join-Path $caseRoot "child-finally.txt"
            $ctrlArguments = @(
                $powershellPath, $readyPath, $ctrlChildPath,
                "-InstallerPath", $InstallerPath,
                "-AssetRoot", $assetRoot,
                "-InstallRoot", $installRoot,
                "-BinDir", $binDir,
                "-TempRoot", $caseTemp,
                "-PauseMove", $case.Move,
                "-RollbackFailure", $case.RollbackFailure,
                "-ReadyPath", $readyPath,
                "-MoveLogPath", $moveLogPath,
                "-ObservedProcessPath", $observedProcessPath,
                "-FinallyPath", $childFinallyPath,
                "-IsolatedHkcuSubKey", $isolatedHkcuSubKey
            )
            $helperOutput = & $ctrlHelperPath $ctrlArguments 2>&1 | Out-String
            $helperExitCode = $LASTEXITCODE
            Assert-Fixture ($helperExitCode -eq 0) "$caseName console Ctrl+C helper failed: $helperOutput"
            Assert-Fixture ((Get-Content -LiteralPath $readyPath -Raw) -eq ("READY:" + $case.Move)) "$caseName did not pause after the requested move"
            Assert-Fixture ((Get-Content -LiteralPath $moveLogPath -Raw) -match ([regex]::Escape("MOVED:" + $case.Move))) "$caseName did not record the state-changing move"
            Assert-Fixture ((Get-Content -LiteralPath $moveLogPath -Raw) -match ([regex]::Escape("ROLLBACK_FAILURE:" + $case.RollbackFailure))) "$caseName did not deliver the one-shot rollback failure"
            Assert-Fixture ((Get-Content -LiteralPath $childFinallyPath -Raw) -eq "CHILD_FINALLY") "$caseName did not execute the child finally block"
            Assert-Fixture ((Get-Content -LiteralPath $observedProcessPath -Raw -Encoding Unicode) -ceq $expectedProcessPath) "$caseName did not restore the child process PATH"
            Assert-Fixture ([Environment]::GetEnvironmentVariable("Path", "User") -ceq $expectedUserPath) "$caseName changed the User PATH"
            Assert-NoTransactionResidue $installRoot $binDir
            Assert-Fixture ((Get-Content -LiteralPath $parentMarker -Raw) -eq ("keep-" + $caseName)) "$caseName removed the pre-existing parent marker"
            Assert-Fixture (@(Get-ChildItem -LiteralPath $caseTemp -Filter "atomic-install-*" -Force).Count -eq 0) "$caseName left a temporary download directory"

            if ($case.State -eq "fresh") {
                Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "$caseName left a fresh install root"
                Assert-Fixture (-not (Test-Path -LiteralPath $binDir)) "$caseName left a fresh bin directory"
                Assert-Fixture (-not (Test-Path -LiteralPath $installContainer)) "$caseName left a transaction-created install parent"
                Assert-Fixture (-not (Test-Path -LiteralPath $binContainer)) "$caseName left a transaction-created bin parent"
            }
            else {
                $versionPath = Join-Path $installRoot "versions\2.0.0"
                $currentPath = Join-Path $installRoot "current"
                $atomicCurrentPath = Join-Path $binDir "atomic-current"
                $shimPath = Join-Path $binDir "atomic.cmd"
                Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $versionPath "preserve.bin"))) -ceq $oldPayloadBytes) "$caseName changed old version bytes"
                Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $currentPath "preserve.bin"))) -ceq $oldPayloadBytes) "$caseName changed old current bytes"
                Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $atomicCurrentPath "preserve.bin"))) -ceq $oldPayloadBytes) "$caseName changed old atomic-current bytes"
                Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $versionPath "atomic.exe"))) -ceq $oldAtomicBytes) "$caseName changed old executable bytes"
                Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes($shimPath)) -ceq $oldShimBytes) "$caseName changed old shim bytes"
                Assert-Fixture (((Get-Item -LiteralPath $currentPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "$caseName did not restore the current junction"
                Assert-Fixture (((Get-Item -LiteralPath $atomicCurrentPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "$caseName did not restore the atomic-current junction"
                $rollbackProbe = Invoke-FixtureShim $shimPath "--version"
                Assert-Fixture ($rollbackProbe.ExitCode -eq 0 -and $rollbackProbe.Output -eq "2.0.0") "$caseName did not leave the old shim pair executable"
            }

            [Environment]::SetEnvironmentVariable("Path", $beforeCaseUserPath, "User")
            $env:Path = $beforeCaseProcessPath
            Remove-Item -LiteralPath $caseRoot -Recurse -Force
        }
    }
    elseif ($Scenario -eq "transaction-failures") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $failurePoints = @("payload-copy", "current-create", "current-move", "atomic-current-create", "atomic-current-move", "shim-stage")
        foreach ($state in @("fresh", "existing")) {
            $topologies = if ($state -eq "fresh") { @("separate", "bin-parent", "install-parent") } else { @("separate") }
            foreach ($topology in $topologies) {
                foreach ($failurePoint in $failurePoints) {
                    $caseRoot = Join-Path $workspace ("transaction-" + $state + "-" + $topology + "-" + $failurePoint)
                    New-Item -ItemType Directory -Path $caseRoot -Force | Out-Null
                    $parentMarker = Join-Path $caseRoot "pre-existing-parent.txt"
                    Set-Content -LiteralPath $parentMarker -Value "keep-parent" -Encoding ASCII -NoNewline
                    $preExistingJunctionTarget = Join-Path $caseRoot "pre-existing-junction-target"
                    $preExistingJunction = Join-Path $caseRoot "pre-existing-dangling-junction"
                    New-Item -ItemType Directory -Path $preExistingJunctionTarget -Force | Out-Null
                    New-Item -ItemType Junction -Path $preExistingJunction -Target $preExistingJunctionTarget | Out-Null
                    Remove-Item -LiteralPath $preExistingJunctionTarget -Recurse -Force
                    if ($topology -eq "bin-parent") {
                        $binDir = Join-Path $caseRoot "bin-parent"
                        $installRoot = Join-Path $binDir "install-root"
                    }
                    elseif ($topology -eq "install-parent") {
                        $installRoot = Join-Path $caseRoot "install-parent"
                        $binDir = Join-Path $installRoot "bin-root"
                    }
                    else {
                        $installRoot = Join-Path $caseRoot "install-root"
                        $binDir = Join-Path $caseRoot "bin-root"
                    }
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
                    Assert-Fixture ($null -ne $failure -and $failure.Exception.Message -match ("Injected transaction failure: " + $failurePoint)) "$state $topology $failurePoint failure was not injected"

                    Assert-Fixture ((Get-Content -LiteralPath $parentMarker -Raw) -eq "keep-parent") "$state $topology $failurePoint removed a pre-existing parent marker"
                    $preservedJunction = @(Get-ChildItem -LiteralPath $caseRoot -Force | Where-Object { $_.Name -eq "pre-existing-dangling-junction" })
                    Assert-Fixture ($preservedJunction.Count -eq 1 -and ($preservedJunction[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) "$state $topology $failurePoint removed a pre-existing dangling junction"
                    if ($state -eq "fresh") {
                        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "fresh $topology $failurePoint failure left the install root"
                        Assert-Fixture (-not (Test-Path -LiteralPath $binDir)) "fresh $topology $failurePoint failure left the bin directory"
                        Assert-Fixture (@(Get-ChildItem -LiteralPath $caseRoot -Force).Count -eq 2) "fresh $topology $failurePoint left transaction-created parent entries"
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
                    Assert-Fixture (@(Get-ChildItem -LiteralPath $fixtureTemp -Filter "atomic-install-*" -Force).Count -eq 0) "$state $topology $failurePoint failure left a temporary download directory"
                    [IO.Directory]::Delete($preExistingJunction)
                    Remove-Item -LiteralPath $caseRoot -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
    elseif ($Scenario -eq "hash-fallback") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/download/' }).Count -eq 2) "the .NET checksum fallback did not complete both release downloads"
        $versionProbe = Invoke-FixtureShim (Join-Path $binDir "atomic.cmd") "--version"
        Assert-Fixture ($versionProbe.ExitCode -eq 0 -and $versionProbe.Output -eq "1.0.0") ".NET checksum fallback did not leave a runnable install"
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "ref-identity") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $mismatch = $null
        try { & $InstallerPath -Ref "1.0.1" | Out-Null }
        catch { $mismatch = $_ }
        Assert-Fixture ($null -ne $mismatch) "a mismatched exact-tag response was accepted"
        Assert-Fixture ($mismatch.Exception.Message -match 'GitHub returned release 1\.0\.0 for requested tag 1\.0\.1') "mismatch failure did not name both release identities"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '/releases/download/' }).Count -eq 0) "a mismatched exact-tag response still downloaded a release"
        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "a mismatched exact-tag response created an installation"
        Assert-Fixture (-not (Test-Path -LiteralPath $binDir)) "a mismatched exact-tag response created a bin directory"

        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $installRoot "versions\1.0.0\atomic.exe")) "a matching exact ref did not install"
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "api-rate-limit") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $env:GITHUB_TOKEN = $null
        $env:GH_TOKEN = $null
        $global:AtomicFixtureWebPages = $true
        $global:AtomicFixtureApiRateLimited = $true

        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $installRoot "versions\1.0.0\atomic.exe")) "an exact tag did not install while the GitHub API was rate limited"
        Assert-Fixture (@($global:AtomicFixtureRequests | Where-Object { $_.Uri -match '^https://api\.github\.com/' }).Count -eq 0) "an exact tag confirmed on github.com still queried the API"
        Assert-Fixture (@($global:AtomicFixtureProbes | Where-Object { $_ -eq "https://github.com/bastani-inc/atomic/releases/download/1.0.0/SHA256SUMS" }).Count -eq 1) "the exact tag was not confirmed on github.com"

        $mark = $global:AtomicFixtureRequests.Count
        $missing = $null
        try { & $InstallerPath -Ref "9.9.9" | Out-Null }
        catch { $missing = $_ }
        Assert-Fixture ($null -ne $missing) "a missing exact tag did not fail"
        Assert-Fixture ($missing.Exception.Message -match 'release 9\.9\.9 not found') "a missing exact tag was not reported as not found: $($missing.Exception.Message)"
        Assert-Fixture (@($global:AtomicFixtureRequests | Select-Object -Skip $mark | Where-Object { $_.Uri -match '^https://api\.github\.com/|/releases/download/' }).Count -eq 0) "a missing exact tag queried the API or downloaded"
        Assert-Fixture (@($global:AtomicFixtureProbes | Where-Object { $_ -match '/releases/download/9\.9\.9/SHA256SUMS$' }).Count -eq 1) "a missing exact tag was not probed on github.com"

        $global:AtomicFixtureWebPages = $false
        $limited = $null
        try { & $InstallerPath -Ref "2.0.0" | Out-Null }
        catch { $limited = $_ }
        Assert-Fixture ($null -ne $limited) "a rate-limited API request did not fail"
        Assert-Fixture ($limited.Exception.Message -match "GitHub's API rate limit was reached for this network") "the rate limit was not explained: $($limited.Exception.Message)"
        Assert-Fixture ($limited.Exception.Message -match 'GITHUB_TOKEN') "the rate-limit error did not name GITHUB_TOKEN: $($limited.Exception.Message)"

        $env:GITHUB_TOKEN = "github-secret-token"
        $tokenLimited = $null
        try { & $InstallerPath -Ref "2.0.0" | Out-Null }
        catch { $tokenLimited = $_ }
        $env:GITHUB_TOKEN = $null
        Assert-Fixture ($null -ne $tokenLimited) "a rate-limited token request did not fail"
        Assert-Fixture ($tokenLimited.Exception.Message -match "GitHub's API rate limit was reached for this token") "the token rate limit was not explained: $($tokenLimited.Exception.Message)"
        Assert-Fixture ($tokenLimited.Exception.Message -notmatch 'github-secret-token') "the rate-limit error printed the token"

        $mark = $global:AtomicFixtureRequests.Count
        & $InstallerPath | Out-Null
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path (Join-Path $installRoot "current") "version.txt") -Raw) -eq "2.0.0") "the latest release did not install through the redirect"
        Assert-Fixture (@($global:AtomicFixtureRequests | Select-Object -Skip $mark | Where-Object { $_.Uri -match '^https://api\.github\.com/' }).Count -eq 0) "the latest path changed: it queried the API"
        # A launcher that no longer matches its recorded hash, or is empty, is reinstalled.
        $global:AtomicFixtureWebPages = $true
        $launcherTwo = Join-Path $installRoot "versions\2.0.0\atomic.exe"
        $recordTwo = Join-Path $installRoot "versions\2.0.0\.atomic-launcher.sha256"
        Assert-Fixture (([IO.File]::ReadAllText($recordTwo)).Trim() -ceq (Get-FixtureSha256 -Path $launcherTwo)) "the install did not record the launcher hash"
        $appended = [IO.File]::Open($launcherTwo, [IO.FileMode]::Append)
        try { $appended.WriteByte(0) } finally { $appended.Dispose() }
        $null = & $InstallerPath -Ref "2.0.0" | Out-String
        Assert-Fixture ((Get-FixtureSha256 -Path $launcherTwo) -ceq ([IO.File]::ReadAllText($recordTwo)).Trim()) "a changed launcher was not reinstalled"
        [IO.File]::WriteAllBytes($launcherTwo, [byte[]]@())
        $null = & $InstallerPath -Ref "2.0.0" | Out-String
        Assert-Fixture ((Get-Item -LiteralPath $launcherTwo).Length -gt 0) "the reinstall did not restore atomic.exe"
        $mark = $global:AtomicFixtureRequests.Count
        $probeMark = $global:AtomicFixtureProbes.Count
        $verifiedOutput = & $InstallerPath -Ref "2.0.0" | Out-String
        Assert-Fixture ($verifiedOutput -match ('(?m)^Installed to ' + [regex]::Escape((Join-Path $binDir "atomic.cmd")) + '\s*$')) "a verified pinned rerun did not finish: $verifiedOutput"
        Assert-Fixture ((@($global:AtomicFixtureRequests).Count -eq $mark) -and (@($global:AtomicFixtureProbes).Count -eq $probeMark)) "a verified pinned install made a request"

        $global:AtomicFixtureApiRateLimited = $false
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "semicolon-bin") {
        $semicolonBinDir = Join-Path $workspace "semi;bin"
        $env:ATOMIC_BIN_DIR = $semicolonBinDir
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $beforeUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $beforeProcessPath = $env:Path

        $installOutput = & $InstallerPath -Ref "1.0.0" | Out-String
        $shim = Join-Path $semicolonBinDir "atomic.cmd"
        Assert-Fixture (Test-Path -LiteralPath $shim) "semicolon bin directory did not receive the shim"
        Assert-Fixture ([Environment]::GetEnvironmentVariable("Path", "User") -eq $beforeUserPath) "a semicolon bin directory was appended to the User PATH"
        Assert-Fixture ($env:Path -eq $beforeProcessPath) "a semicolon bin directory was appended to the current PATH"
        Assert-Fixture ($installOutput -match ('(?m)^Installed to ' + [regex]::Escape($shim) + '\s*$')) "semicolon bin directory did not report the installed launcher path"
        Assert-Fixture ($installOutput -match "cannot be represented as one Windows PATH entry") "semicolon bin directory did not report the PATH limitation"
        Assert-Fixture ($installOutput -match 'Run Atomic directly') "semicolon bin directory did not print direct-run guidance"
        Assert-Fixture ($installOutput -notmatch 'to your User PATH') "semicolon bin directory claimed a PATH update"
        $versionProbe = Invoke-FixtureShim $shim "--version"
        Assert-Fixture ($versionProbe.ExitCode -eq 0 -and $versionProbe.Output -eq "1.0.0") "semicolon bin directory shim is not runnable"

        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-Fixture ([Environment]::GetEnvironmentVariable("Path", "User") -eq $beforeUserPath) "a semicolon bin directory rerun appended a duplicate PATH entry"
        Assert-NoTransactionResidue $installRoot $semicolonBinDir
    }
    elseif ($Scenario -eq "shadowed-shim") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $env:PATHEXT = $null
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        $stalePath = Join-Path $binDir "atomic.exe"
        Copy-Item -LiteralPath $fixtureExecutable -Destination $stalePath
        $staleBytes = [IO.File]::ReadAllBytes($stalePath)

        $shadowed = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $shadowed = $_ }
        Assert-Fixture ($null -ne $shadowed) "a stale same-stem atomic.exe was accepted"
        Assert-Fixture ($shadowed.Exception.Message -match 'atomic\.exe, which PATHEXT resolves before atomic\.cmd') "the stale launcher rejection did not name the shadowing entry"
        Assert-Fixture (@($global:AtomicFixtureRequests).Count -eq 0) "the stale launcher rejection performed a network request"
        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "the stale launcher rejection created an install root"
        Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd"))) "the stale launcher rejection created a shim"
        Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes($stalePath)) -ceq [Convert]::ToBase64String($staleBytes)) "the stale launcher was replaced instead of reported"
        Remove-Item -LiteralPath $stalePath -Force

        $env:PATHEXT = ".WSF;.CMD;.EXE"
        $wsfPath = Join-Path $binDir "atomic.wsf"
        Set-Content -LiteralPath $wsfPath -Value "stale script" -Encoding ASCII -NoNewline
        $customShadowed = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $customShadowed = $_ }
        Assert-Fixture ($null -ne $customShadowed) "a custom PATHEXT entry ahead of .CMD was accepted"
        Assert-Fixture ($customShadowed.Exception.Message -match 'atomic\.wsf, which PATHEXT resolves before atomic\.cmd') "the custom PATHEXT rejection did not name the shadowing entry"
        Assert-Fixture (@($global:AtomicFixtureRequests).Count -eq 0) "the custom PATHEXT rejection performed a network request"
        Remove-Item -LiteralPath $wsfPath -Force
        $env:PATHEXT = $null

        $staleDirectory = Join-Path $binDir "atomic.bat"
        New-Item -ItemType Directory -Path $staleDirectory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $staleDirectory "keep.txt") -Value "caller-data" -Encoding ASCII -NoNewline
        $shadowDirectory = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $shadowDirectory = $_ }
        Assert-Fixture ($null -ne $shadowDirectory) "a stale same-stem atomic.bat directory was accepted"
        Assert-Fixture ($shadowDirectory.Exception.Message -match 'atomic\.bat, which PATHEXT resolves before atomic\.cmd') "the stale directory rejection did not name the shadowing entry"
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $staleDirectory "keep.txt") -Raw) -eq "caller-data") "the stale same-stem directory was deleted instead of reported"
        Remove-Item -LiteralPath $staleDirectory -Recurse -Force

        Set-Content -LiteralPath (Join-Path $binDir "atomic.vbs") -Value "harmless" -Encoding ASCII -NoNewline
        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd")) "an extension after .CMD blocked a valid install"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $binDir "atomic.vbs")) "a harmless same-stem entry was removed"

        $previousProcessPath = $env:Path
        try {
            $env:Path = $binDir
            $cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe"
            $resolvedOutput = (& $cmdExe /d /c "atomic --version" | Out-String).Trim()
            $resolvedExit = $LASTEXITCODE
        }
        finally {
            $env:Path = $previousProcessPath
        }
        Assert-Fixture ($resolvedExit -eq 0 -and $resolvedOutput -eq "1.0.0") "PATHEXT resolution of atomic did not run the installed shim: $resolvedOutput"
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "custom-pathext") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $env:PATHEXT = ".CMD;.EXE"
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        $allowedStalePath = Join-Path $binDir "atomic.exe"
        Copy-Item -LiteralPath $fixtureExecutable -Destination $allowedStalePath
        $requestsBeforeInstall = @($global:AtomicFixtureRequests).Count

        & $InstallerPath -Ref "1.0.0" | Out-Null
        $shim = Join-Path $binDir "atomic.cmd"
        Assert-Fixture (Test-Path -LiteralPath $shim) "custom PATHEXT prevented the shim from being installed"
        Assert-Fixture (@($global:AtomicFixtureRequests).Count -gt $requestsBeforeInstall) "custom PATHEXT install did not reach the release request"

        $previousProcessPath = $env:Path
        try {
            $env:Path = $binDir
            $cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe"
            $resolvedOutput = (& $cmdExe /d /c "atomic --version" | Out-String).Trim()
            $resolvedExit = $LASTEXITCODE
        }
        finally {
            $env:Path = $previousProcessPath
        }
        Assert-Fixture ($resolvedExit -eq 0 -and $resolvedOutput -eq "1.0.0") "custom PATHEXT did not resolve atomic.cmd ahead of atomic.exe: $resolvedOutput"
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "skip-installed") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $current = Join-Path $installRoot "current"
        $atomicCurrent = Join-Path $binDir "atomic-current"
        $shim = Join-Path $binDir "atomic.cmd"
        $versionOne = Join-Path $installRoot "versions\1.0.0"
        $versionTwo = Join-Path $installRoot "versions\2.0.0"

        function Get-DownloadRequestCount {
            param([int]$Since)
            return @($global:AtomicFixtureRequests | Select-Object -Skip $Since | Where-Object { $_.Uri -match '/releases/download/' }).Count
        }

        function Assert-ShimRuns {
            param([string]$Version, [string]$Label)
            $probe = Invoke-FixtureShim $shim "--version"
            Assert-Fixture ($probe.ExitCode -eq 0 -and $probe.Output -eq $Version) "$Label left a shim that does not run $Version"
        }

        function Remove-FixtureJunction {
            param([string]$Path)
            [IO.Directory]::Delete($Path)
        }

        function Get-FixtureLinkTarget {
            param([string]$Path)
            $target = @((Get-Item -LiteralPath $Path -Force).Target)[0]
            return [string]$target
        }

        & $InstallerPath -Ref "1.0.0" | Out-Null
        Set-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Value "survives" -NoNewline
        $currentTarget = Get-FixtureLinkTarget $current
        $atomicCurrentTarget = Get-FixtureLinkTarget $atomicCurrent
        $shimBytes = [IO.File]::ReadAllBytes($shim)

        $mark = $global:AtomicFixtureRequests.Count
        $skipOutput = & $InstallerPath -Ref "1.0.0" | Out-String
        Assert-Fixture ($skipOutput -match ('(?m)^Installed to ' + [regex]::Escape($shim) + '\s*$')) "the skip did not keep the Installed to line"
        Assert-Fixture ($skipOutput -notmatch 'to your User PATH') "the skip claimed a User PATH update although the entry existed"
        Assert-Fixture ((Get-DownloadRequestCount $mark) -eq 0) "the skip requested release assets"
        Assert-Fixture (@($global:AtomicFixtureRequests | Select-Object -Skip $mark).Count -eq 0) "a healthy pinned rerun made a network request"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $versionOne "sentinel.txt")) "the skip replaced the installed version"
        Assert-Fixture ((Get-FixtureLinkTarget $current) -ceq $currentTarget) "the skip repointed current"
        Assert-Fixture ((Get-FixtureLinkTarget $atomicCurrent) -ceq $atomicCurrentTarget) "the skip repointed atomic-current"
        Assert-Fixture ([Convert]::ToBase64String([IO.File]::ReadAllBytes($shim)) -ceq [Convert]::ToBase64String($shimBytes)) "the skip rewrote the shim"
        Assert-NoTransactionResidue $installRoot $binDir

        [Environment]::SetEnvironmentVariable("Path", "C:\AtomicSkipUserPath", "User")
        $env:Path = "C:\AtomicSkipProcessPath"
        $mark = $global:AtomicFixtureRequests.Count
        $pathRepairOutput = & $InstallerPath -Ref "1.0.0" | Out-String
        Assert-Fixture ((Get-DownloadRequestCount $mark) -eq 0) "the PATH repair requested release assets"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $versionOne "sentinel.txt")) "the PATH repair replaced the installed version"
        Assert-Fixture ((Get-ExactPathEntryCount ([Environment]::GetEnvironmentVariable("Path", "User")) $binDir) -eq 1) "a skipped rerun did not restore the missing User PATH entry"
        Assert-Fixture ([Environment]::GetEnvironmentVariable("Path", "User") -like "C:\AtomicSkipUserPath;*") "the User PATH repair dropped existing entries"
        Assert-Fixture ((Get-ExactPathEntryCount $env:Path $binDir) -eq 1) "a skipped rerun did not restore the missing process PATH entry"
        Assert-Fixture ($pathRepairOutput -match ('(?m)^Added ' + [regex]::Escape($binDir) + ' to your User PATH; open a new terminal to use atomic\.\s*$')) "the User PATH repair was not reported"
        $mark = $global:AtomicFixtureRequests.Count
        $settledOutput = & $InstallerPath -Ref "1.0.0" | Out-String
        Assert-Fixture ($settledOutput -notmatch 'to your User PATH') "a second skipped rerun repeated the User PATH repair"
        Assert-Fixture ((Get-ExactPathEntryCount ([Environment]::GetEnvironmentVariable("Path", "User")) $binDir) -eq 1) "a second skipped rerun duplicated the User PATH entry"

        & $InstallerPath -Ref "2.0.0" | Out-Null
        $env:ATOMIC_VERSION = $null
        $mark = $global:AtomicFixtureRequests.Count
        $latestOutput = & $InstallerPath | Out-String
        Assert-Fixture ((Get-DownloadRequestCount $mark) -eq 0) "a healthy latest install requested release assets"
        Assert-Fixture (@($global:AtomicFixtureRequests | Select-Object -Skip $mark | Where-Object { $_.Uri -eq 'https://github.com/bastani-inc/atomic/releases/latest' }).Count -eq 1) "the latest skip did not resolve the latest release"
        Assert-Fixture ($latestOutput -match ('(?m)^Installed to ' + [regex]::Escape($shim) + '\s*$')) "the latest skip did not keep the Installed to line"

        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-Fixture ((Get-Content -LiteralPath (Join-Path $current "version.txt") -Raw) -eq "1.0.0") "switching back to 1.0.0 did not repoint current"

        $repairs = @(
            @{ Label = "a missing shim"; Break = { Remove-Item -LiteralPath $shim -Force } },
            @{ Label = "a shim with other content"; Break = { Set-Content -LiteralPath $shim -Value "@echo off" -Encoding ASCII } },
            @{ Label = "a missing atomic-current junction"; Break = { Remove-FixtureJunction $atomicCurrent } },
            @{ Label = "an atomic-current junction aimed at another version"; Break = {
                Remove-FixtureJunction $atomicCurrent
                New-Item -ItemType Junction -Path $atomicCurrent -Target $versionTwo | Out-Null } },
            @{ Label = "a missing current junction"; Break = { Remove-FixtureJunction $current } },
            @{ Label = "a missing payload executable"; Break = { Remove-Item -LiteralPath (Join-Path $versionOne "atomic.exe") -Force } },
            @{ Label = "a missing package.json"; Remove = "package.json" },
            @{ Label = "a missing app.js"; Remove = "app.js" },
            @{ Label = "a missing native-modifiers.js"; Remove = "native-modifiers.js" },
            @{ Label = "a missing native-module-path.js"; Remove = "native-module-path.js" },
            @{ Label = "a missing native-platform.js"; Remove = "native-platform.js" },
            @{ Label = "a missing builtin directory"; Remove = "builtin" },
            @{ Label = "a missing node_modules directory"; Remove = "node_modules" },
            @{ Label = "current and atomic-current aimed at a foreign versions directory"; Break = {
                $foreignVersion = Join-Path $workspace "foreign-install\versions\1.0.0"
                New-Item -ItemType Directory -Path (Split-Path -Parent $foreignVersion) -Force | Out-Null
                Copy-Item -LiteralPath $versionOne -Destination $foreignVersion -Recurse
                Set-Content -LiteralPath (Join-Path $foreignVersion "foreign-marker.txt") -Value "foreign" -NoNewline
                Remove-FixtureJunction $current
                Remove-FixtureJunction $atomicCurrent
                New-Item -ItemType Junction -Path $current -Target $foreignVersion | Out-Null
                New-Item -ItemType Junction -Path $atomicCurrent -Target $foreignVersion | Out-Null } }
        )
        foreach ($repair in $repairs) {
            if ($repair.ContainsKey("Remove")) {
                Remove-Item -LiteralPath (Join-Path $versionOne $repair.Remove) -Recurse -Force
            }
            else {
                & $repair.Break
            }
            $mark = $global:AtomicFixtureRequests.Count
            & $InstallerPath -Ref "1.0.0" | Out-Null
            Assert-Fixture ((Get-DownloadRequestCount $mark) -eq 2) ($repair.Label + " was skipped instead of repaired")
            Assert-Fixture ((Get-Content -LiteralPath (Join-Path $current "version.txt") -Raw) -eq "1.0.0") ($repair.Label + " left current unrepaired")
            Assert-Fixture ((Get-Content -LiteralPath (Join-Path $atomicCurrent "version.txt") -Raw) -eq "1.0.0") ($repair.Label + " left atomic-current unrepaired")
            Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $current "foreign-marker.txt"))) ($repair.Label + " left current inside a foreign directory")
            Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $atomicCurrent "foreign-marker.txt"))) ($repair.Label + " left atomic-current inside a foreign directory")
            foreach ($requiredPayloadFile in @("package.json", "app.js", "native-modifiers.js", "native-module-path.js", "native-platform.js")) {
                Assert-Fixture (Test-Path -LiteralPath (Join-Path $current $requiredPayloadFile) -PathType Leaf) ($repair.Label + " left $requiredPayloadFile missing")
            }
            foreach ($requiredPayloadDirectory in @("builtin", "node_modules")) {
                Assert-Fixture (Test-Path -LiteralPath (Join-Path $current $requiredPayloadDirectory) -PathType Container) ($repair.Label + " left $requiredPayloadDirectory missing")
            }
            Assert-ShimRuns "1.0.0" $repair.Label
            Assert-NoTransactionResidue $installRoot $binDir
        }
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $workspace "foreign-install\versions\1.0.0\foreign-marker.txt")) "repairing a foreign current junction deleted the foreign directory"

        Set-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Value "replaced by force" -NoNewline
        $mark = $global:AtomicFixtureRequests.Count
        & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        Assert-Fixture ((Get-DownloadRequestCount $mark) -eq 2) "-Force did not download the release"
        Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $versionOne "sentinel.txt"))) "-Force did not replace the installed version"

        Set-Content -LiteralPath (Join-Path $versionOne "sentinel.txt") -Value "replaced by environment force" -NoNewline
        $env:ATOMIC_FORCE_INSTALL = "1"
        $mark = $global:AtomicFixtureRequests.Count
        & $InstallerPath -Ref "1.0.0" | Out-Null
        $env:ATOMIC_FORCE_INSTALL = $null
        Assert-Fixture ((Get-DownloadRequestCount $mark) -eq 2) "ATOMIC_FORCE_INSTALL=1 did not download the release"
        Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $versionOne "sentinel.txt"))) "ATOMIC_FORCE_INSTALL=1 did not replace the installed version"
        Assert-ShimRuns "1.0.0" "the forced reinstall"
    }
    elseif ($Scenario -eq "path-broadcast") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"
        $wmListenerSourcePath = Join-Path $workspace "wm-listener.cs"
        $wmListenerPath = Join-Path $workspace "wm-listener.exe"
        Add-Type -Path $wmListenerSourcePath -OutputAssembly $wmListenerPath -OutputType ConsoleApplication

        function Invoke-WithSettingChangeListener {
            param([string]$Label, [int]$MinBroadcasts, [scriptblock]$Action)

            $wmReady = Join-Path $workspace ("wm-ready-" + $Label + ".txt")
            $wmStop = Join-Path $workspace ("wm-stop-" + $Label + ".txt")
            $wmLog = Join-Path $workspace ("wm-log-" + $Label + ".txt")
            Remove-Item -LiteralPath $wmReady, $wmStop, $wmLog -Force -ErrorAction SilentlyContinue
            $psi = New-Object Diagnostics.ProcessStartInfo
            $psi.FileName = $wmListenerPath
            $psi.Arguments = ('"' + $wmReady + '" "' + $wmStop + '" "' + $wmLog + '" 60000')
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $listener = [Diagnostics.Process]::Start($psi)
            try {
                $readyDeadline = (Get-Date).AddSeconds(15)
                while (-not (Test-Path -LiteralPath $wmReady) -and -not $listener.HasExited -and (Get-Date) -lt $readyDeadline) {
                    Start-Sleep -Milliseconds 20
                }
                Assert-Fixture (Test-Path -LiteralPath $wmReady) "$Label WM_SETTINGCHANGE listener did not become ready"
                & $Action
                [IO.File]::WriteAllText($wmStop, "STOP")
                $exited = $listener.WaitForExit(10000)
                Assert-Fixture ($exited -and $listener.ExitCode -eq 0) "$Label WM_SETTINGCHANGE listener did not exit cleanly (exited=$exited, rc=$($listener.ExitCode))"
                $broadcastLines = @()
                if (Test-Path -LiteralPath $wmLog) {
                    $broadcastLines = @(Get-Content -LiteralPath $wmLog | Where-Object { $_ -like "*WM_SETTINGCHANGE area=Environment*" })
                }
                Assert-Fixture ($broadcastLines.Count -ge $MinBroadcasts) "$Label did not broadcast WM_SETTINGCHANGE area=Environment (expected >= $MinBroadcasts, got $($broadcastLines.Count))"
            }
            finally {
                if (-not (Test-Path -LiteralPath $wmStop)) {
                    [IO.File]::WriteAllText($wmStop, "STOP")
                }
                if (-not $listener.HasExited) {
                    $listener.Kill()
                    [void]$listener.WaitForExit(5000)
                }
                $listener.Dispose()
            }
        }

        Invoke-WithSettingChangeListener "fresh-install" 1 {
            & $InstallerPath -Ref "1.0.0" | Out-Null
        }

        Reset-FixtureInstallState @($installRoot, $binDir)
        $resetEnvKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
        try {
            $resetEnvKey.SetValue("Path", $isolatedSeedUserPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        }
        finally {
            $resetEnvKey.Close()
        }
        $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = "2.0.0"
        try {
            Invoke-WithSettingChangeListener "rollback" 2 {
                $rollbackFailure = $null
                try { & $InstallerPath -Ref "2.0.0" | Out-Null }
                catch { $rollbackFailure = $_ }
                Assert-Fixture ($null -ne $rollbackFailure) "failing final smoke unexpectedly succeeded in path-broadcast"
            }
        }
        finally {
            $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null
        }
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "backup-cleanup") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"

        & $InstallerPath -Ref "1.0.0" | Out-Null
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd")) "the seed install did not complete"

        $global:AtomicFixtureWarnings.Clear()
        $global:AtomicFixtureBackupRemovalAttempts = 0
        $global:AtomicFixtureBackupLockMode = "one-shot"
        & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        $global:AtomicFixtureBackupLockMode = $null
        Assert-Fixture ($global:AtomicFixtureBackupRemovalAttempts -ge 2) "a real briefly locked version backup did not force a removal retry ($($global:AtomicFixtureBackupRemovalAttempts) removal calls)"
        Assert-Fixture ($null -eq $global:AtomicFixtureBackupLockStream) "the one-shot backup handle was never released"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd")) "the locked-backup reinstall did not complete"
        $recoveredWarnings = @($global:AtomicFixtureWarnings | Where-Object { $_ -match 'could not remove the previous' })
        Assert-Fixture ($recoveredWarnings.Count -eq 0) "a recovered backup removal still warned: $($recoveredWarnings -join '; ')"
        Assert-NoTransactionResidue $installRoot $binDir

        $global:AtomicFixtureWarnings.Clear()
        $global:AtomicFixtureBackupRemovalAttempts = 0
        $global:AtomicFixtureBackupLockMode = "sticky"
        & $InstallerPath -Ref "1.0.0" -Force | Out-Null
        $global:AtomicFixtureBackupLockMode = $null
        Assert-Fixture ($global:AtomicFixtureBackupRemovalAttempts -ge 2) "an exhausted backup removal did not retry ($($global:AtomicFixtureBackupRemovalAttempts) removal calls)"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd")) "an exhausted backup removal discarded a completed install"
        # Remove-AtomicTransactionBackups runs from the commit path and again from
        # the finally block, so a sticky lock warns once per committed call site.
        $stickyWarnings = @($global:AtomicFixtureWarnings | Where-Object { $_ -match 'could not remove the previous version backup' })
        Assert-Fixture ($stickyWarnings.Count -ge 1 -and $stickyWarnings.Count -le 2) "an exhausted backup removal did not warn once per cleanup call site ($($stickyWarnings.Count)): $($global:AtomicFixtureWarnings -join '; ')"
        $global:AtomicFixtureBackupLockStream.Dispose()
        $global:AtomicFixtureBackupLockStream = $null
        $lockedBackupDir = [IO.Path]::GetDirectoryName($global:AtomicFixtureBackupLockPath)
        Remove-Item -LiteralPath $lockedBackupDir -Recurse -Force
        Assert-NoTransactionResidue $installRoot $binDir
    }
    elseif ($Scenario -eq "temp-cleanup") {
        $env:PROCESSOR_ARCHITEW6432 = "AMD64"
        $env:PROCESSOR_ARCHITECTURE = "AMD64"

        $caseRoot = Join-Path $workspace "temp-cleanup"
        $installRoot = Join-Path $caseRoot "install-root"
        $binDir = Join-Path $caseRoot "bin-root"
        $caseTemp = Join-Path $caseRoot "temp"
        New-Item -ItemType Directory -Path $caseTemp -Force | Out-Null
        $env:ATOMIC_INSTALL_DIR = $installRoot
        $env:ATOMIC_BIN_DIR = $binDir
        $env:TEMP = $caseTemp
        $env:TMP = $caseTemp
        if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
            # GetTempPath2 ignores TEMP/TMP for SYSTEM. Its override must remain
            # inaccessible to unprivileged users, just like Windows\SystemTemp.
            $tempAcl = New-Object Security.AccessControl.DirectorySecurity
            $tempAcl.SetAccessRuleProtection($true, $false)
            foreach ($sid in @("S-1-5-18", "S-1-5-32-544")) {
                $identity = New-Object Security.Principal.SecurityIdentifier($sid)
                $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "ContainerInherit, ObjectInherit", "None", "Allow")
                $tempAcl.AddAccessRule($rule)
            }
            Import-Module (Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1") -ErrorAction Stop
            Set-Acl -LiteralPath $caseTemp -AclObject $tempAcl
            $env:SystemTemp = $caseTemp
        }
        $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        Assert-Fixture ($resolvedTempRoot -ieq [IO.Path]::GetFullPath($caseTemp).TrimEnd('\')) "GetTempPath() resolved to $resolvedTempRoot instead of the isolated case temp root"

        $global:AtomicFixtureTempLockPath = $null
        $global:AtomicFixtureTempLockStream = $null
        $global:AtomicFixtureTempRemovalAttempts = 0
        $global:AtomicFixtureTempLockMode = "one-shot"
        & $InstallerPath -Ref "1.0.0" | Out-Null
        $global:AtomicFixtureTempLockMode = $null
        Assert-Fixture ($global:AtomicFixtureTempRemovalAttempts -ge 2) "a real one-shot open handle did not force a verified cleanup retry ($($global:AtomicFixtureTempRemovalAttempts) removal calls)"
        Assert-Fixture ($null -eq $global:AtomicFixtureTempLockStream) "the one-shot fixture handle was never released"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd")) "the one-shot locked-handle install did not complete"
        $oneShotResidue = Get-TempResidueReport $caseTemp
        Assert-Fixture ($oneShotResidue.Count -eq 0) "a released one-shot handle still left temp residue: $($oneShotResidue.Paths)"
        Assert-NoTransactionResidue $installRoot $binDir

        Reset-FixtureInstallState @($installRoot, $binDir)
        $global:AtomicFixtureTempRemovalAttempts = 0
        $global:AtomicFixtureTempLockMode = "sticky"
        $stickyFailure = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $stickyFailure = $_ }
        $global:AtomicFixtureTempLockMode = $null
        Assert-Fixture ($null -ne $stickyFailure) "an exhausted temp cleanup reported success"
        $stickyMessage = [string]$stickyFailure.Exception.Message
        $stickyTempDir = [IO.Path]::GetDirectoryName($global:AtomicFixtureTempLockPath)
        Assert-Fixture ($stickyMessage -match 'Failed to remove the temporary download directory') "the exhausted cleanup used the wrong message: $stickyMessage"
        Assert-Fixture ($stickyMessage -match [regex]::Escape($stickyTempDir)) "the exhausted cleanup did not name the exact temporary path: $stickyMessage"
        Assert-Fixture ($stickyMessage -match 'after (\d+) attempts') "the exhausted cleanup did not report its attempt count: $stickyMessage"
        $reportedAttempts = [int]$Matches[1]
        Assert-Fixture ($reportedAttempts -ge 2) "the exhausted cleanup did not retry before giving up: $stickyMessage"
        Assert-Fixture ($global:AtomicFixtureTempRemovalAttempts -eq $reportedAttempts) "the exhausted cleanup reported $reportedAttempts attempts but performed $($global:AtomicFixtureTempRemovalAttempts)"
        Assert-Fixture ($stickyMessage -match 'last error: \S') "the exhausted cleanup did not report the last error: $stickyMessage"
        Assert-Fixture (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd")) "the exhausted cleanup discarded a completed install"
        $global:AtomicFixtureTempLockStream.Dispose()
        $global:AtomicFixtureTempLockStream = $null
        Remove-Item -LiteralPath $stickyTempDir -Recurse -Force
        Assert-NoTransactionResidue $installRoot $binDir

        Reset-FixtureInstallState @($installRoot, $binDir)
        $global:AtomicFixtureTempRemovalAttempts = 0
        $global:AtomicFixtureWarnings.Clear()
        $global:AtomicFixtureTempLockMode = "sticky"
        $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = "1.0.0"
        $previousWarningPreference = $WarningPreference
        $WarningPreference = "Stop"
        $primaryFailure = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $primaryFailure = $_ }
        finally {
            $WarningPreference = $previousWarningPreference
            $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null
        }
        $global:AtomicFixtureTempLockMode = $null
        Assert-Fixture ($null -ne $primaryFailure) "a failing installed smoke reported success"
        $primaryMessage = [string]$primaryFailure.Exception.Message
        Assert-Fixture ($primaryMessage -match 'Installed atomic\.cmd --version failed') "a failing temp cleanup replaced the primary installer error: $primaryMessage"
        Assert-Fixture ($primaryMessage -notmatch 'Failed to remove the temporary download directory') "the cleanup error was surfaced instead of the primary error: $primaryMessage"
        $lockedTempDir = [IO.Path]::GetDirectoryName($global:AtomicFixtureTempLockPath)
        $cleanupWarnings = @($global:AtomicFixtureWarnings | Where-Object { $_ -match 'Temporary download directory cleanup remains incomplete' })
        Assert-Fixture ($cleanupWarnings.Count -eq 1) "the deferred cleanup failure was not warned exactly once ($($cleanupWarnings.Count))"
        Assert-Fixture ($cleanupWarnings[0] -match [regex]::Escape($lockedTempDir)) "the cleanup warning did not name the exact temporary path: $($cleanupWarnings[0])"
        Assert-Fixture (-not (Test-Path -LiteralPath $installRoot)) "a failing temp cleanup blocked rollback of the fresh install root"
        Assert-Fixture (-not (Test-Path -LiteralPath $binDir)) "a failing temp cleanup blocked removal of the transaction-created bin directory"
        $global:AtomicFixtureTempLockStream.Dispose()
        $global:AtomicFixtureTempLockStream = $null
        Remove-Item -LiteralPath $lockedTempDir -Recurse -Force

        foreach ($stressTag in @("1.0.0", "2.0.0")) {
            & $InstallerPath -Ref $stressTag | Out-Null
            $stressResidue = Get-TempResidueReport $caseTemp
            Assert-Fixture ($stressResidue.Count -eq 0) "installing $stressTag left temp residue: $($stressResidue.Paths)"
            Assert-Fixture ((Get-Content -LiteralPath (Join-Path $binDir "atomic-current\version.txt") -Raw) -eq $stressTag) "installing $stressTag did not update the installed pointer"
            Assert-NoTransactionResidue $installRoot $binDir
        }

        $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = "1.0.0"
        $stressFailure = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $stressFailure = $_ }
        $env:ATOMIC_FIXTURE_FAIL_INSTALLED_VERSION = $null
        Assert-Fixture ($null -ne $stressFailure) "the rolled-back stress install reported success"
        $rolledBackResidue = Get-TempResidueReport $caseTemp
        Assert-Fixture ($rolledBackResidue.Count -eq 0) "a rolled-back install left temp residue: $($rolledBackResidue.Paths)"
        Assert-NoTransactionResidue $installRoot $binDir

        $env:TEMP = $fixtureTemp
        $env:TMP = $fixtureTemp
        $env:SystemTemp = $originalEnvironment["SystemTemp"]
    }
    else {
        throw "Unknown fixture scenario: $Scenario"
    }

    Assert-FixtureProcessesExited $workspace 10000
    $finalResidue = Get-TempResidueReport $fixtureTemp
    Assert-Fixture ($finalResidue.Count -eq 0) "temporary installer directory was not cleaned: $($finalResidue.Paths)"
    Write-Output "SCENARIO_OK:$Scenario"
}
finally {
    if ($null -ne $global:AtomicFixtureMoveLockStream) {
        $global:AtomicFixtureMoveLockStream.Dispose()
        $global:AtomicFixtureMoveLockStream = $null
    }
    if ($null -ne $global:AtomicFixtureRemoveLockStream) {
        $global:AtomicFixtureRemoveLockStream.Dispose()
        $global:AtomicFixtureRemoveLockStream = $null
    }
    foreach ($lockedStream in @($global:AtomicFixtureDualRollbackLockStreams)) {
        if ($null -ne $lockedStream) { $lockedStream.Dispose() }
    }
    $global:AtomicFixtureDualRollbackLockStreams.Clear()
    $hkcuRestored = $true
    if ($isolatedHkcuActive) {
        $restoreRc = [AtomicTestHkcuOverride]::RegOverridePredefKey(
            [AtomicTestHkcuOverride]::HKEY_CURRENT_USER,
            [IntPtr]::Zero
        )
        $isolatedHkcuActive = $false
        if ($restoreRc -ne 0) {
            $hkcuRestored = $false
        }
    }
    if ($null -ne $isolatedHkcuKey) {
        $isolatedHkcuKey.Close()
        $isolatedHkcuKey = $null
    }
    if ($hkcuRestored) {
        $parentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($isolatedHkcuParentPath, $true)
        if ($null -ne $parentKey) {
            try {
                $parentKey.DeleteSubKeyTree($isolatedHkcuRunId, $false)
            }
            finally {
                $parentKey.Close()
            }
        }
    }
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")
    }
    Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
}
`;

export const ctrlCChildHarness = String.raw`
param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][string]$AssetRoot,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$BinDir,
    [Parameter(Mandatory=$true)][string]$TempRoot,
    [Parameter(Mandatory=$true)][string]$PauseMove,
    [Parameter(Mandatory=$true)][string]$RollbackFailure,
    [Parameter(Mandatory=$true)][string]$ReadyPath,
    [Parameter(Mandatory=$true)][string]$MoveLogPath,
    [Parameter(Mandatory=$true)][string]$ObservedProcessPath,
    [Parameter(Mandatory=$true)][string]$FinallyPath,
    [Parameter(Mandatory=$true)][string]$IsolatedHkcuSubKey
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest
$env:ATOMIC_INSTALL_DIR = $InstallRoot
$env:ATOMIC_BIN_DIR = $BinDir
$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:PROCESSOR_ARCHITEW6432 = "AMD64"
$env:PROCESSOR_ARCHITECTURE = "AMD64"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AtomicTestCtrlCHkcuOverride
{
    public static readonly IntPtr HKEY_CURRENT_USER = new IntPtr(unchecked((int)0x80000001));

    [DllImport("advapi32.dll")]
    public static extern int RegOverridePredefKey(IntPtr hKey, IntPtr hNewHKey);
}
'@

function global:Invoke-WebRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Uri,
        [string]$OutFile,
        [hashtable]$Headers,
        [switch]$UseBasicParsing,
        [int]$MaximumRedirection
    )

    if ($Uri -match '/repos/bastani-inc/atomic/releases/tags/([^/]+)$') {
        return [pscustomobject]@{ Content = '{"tag_name":"2.0.0"}'; Headers = @{} }
    }
    if (-not [string]::IsNullOrWhiteSpace($OutFile) -and $Uri -match '/releases/download/([^/]+)/([^/]+)$') {
        $tag = [Uri]::UnescapeDataString($Matches[1])
        Copy-Item -LiteralPath (Join-Path (Join-Path $AssetRoot $tag) $Matches[2]) -Destination $OutFile
        return [pscustomobject]@{ StatusCode = 200; Headers = @{} }
    }
    throw "Unexpected Ctrl+C fixture request: $Uri"
}

# Mirror the main fixture: the archive download streams through
# System.Net.Http.HttpClient, which this harness cannot intercept. Refusing the
# assembly keeps the release request on Invoke-AtomicDownload and the mock above.
function global:Add-Type {
    [CmdletBinding()]
    param(
        [string]$AssemblyName,
        [string]$TypeDefinition,
        [string]$Path,
        [string]$OutputAssembly,
        [string]$OutputType
    )

    if ($AssemblyName -eq "System.Net.Http") {
        throw "System.Net.Http is unavailable in the Ctrl+C fixture."
    }
    Microsoft.PowerShell.Utility\Add-Type @PSBoundParameters
}

$global:AtomicCtrlCRollbackArmed = $false
$global:AtomicCtrlCRollbackFailureDelivered = $false
function global:Get-ChildItem {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [string]$Filter,
        [switch]$Force
    )

    if ($global:AtomicCtrlCRollbackArmed -and
        -not $global:AtomicCtrlCRollbackFailureDelivered -and
        $RollbackFailure -like "*-remove") {
        $requestedLeaf = $null
        try { $requestedLeaf = [string](Get-Variable -Name leafName -Scope 1 -ValueOnly -ErrorAction Stop) }
        catch { $requestedLeaf = $null }
        $failureLeaf = switch ($RollbackFailure) {
            "shim-remove" { "atomic.cmd" }
            "atomic-current-remove" { "atomic-current" }
            "current-remove" { "current" }
            "version-remove" { "2.0.0" }
            default { $null }
        }
        if (-not [string]::IsNullOrWhiteSpace($failureLeaf) -and $requestedLeaf -ieq $failureLeaf) {
            $global:AtomicCtrlCRollbackFailureDelivered = $true
            [IO.File]::AppendAllText($MoveLogPath, "ROLLBACK_FAILURE:$RollbackFailure" + [Environment]::NewLine)
            throw "Injected one-shot rollback removal failure: $RollbackFailure"
        }
    }

    if ([string]::IsNullOrWhiteSpace($Filter)) {
        return Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -Force:$Force
    }
    return Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -Filter $Filter -Force:$Force
}

$global:AtomicCtrlCPauseDelivered = $false
function global:Rename-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [Parameter(Mandatory=$true)][string]$NewName
    )

    $sourceLeaf = [IO.Path]::GetFileName($LiteralPath)
    $destinationLeaf = $NewName
    $moveName = $null
    if ($sourceLeaf -eq "2.0.0" -and $destinationLeaf -match '^\.backup-[0-9a-f]{32}$') { $moveName = "version-backup" }
    elseif ($sourceLeaf -match '^\.stage-[0-9a-f]{32}$' -and $destinationLeaf -eq "2.0.0") { $moveName = "version-install" }
    elseif ($sourceLeaf -eq "current" -and $destinationLeaf -match '^\.current-backup-[0-9a-f]{32}$') { $moveName = "current-backup" }
    elseif ($sourceLeaf -match '^\.current-[0-9a-f]{32}$' -and $destinationLeaf -eq "current") { $moveName = "current-install" }
    elseif ($sourceLeaf -eq "atomic-current" -and $destinationLeaf -match '^\.atomic-current-backup-[0-9a-f]{32}$') { $moveName = "atomic-current-backup" }
    elseif ($sourceLeaf -match '^\.atomic-current-[0-9a-f]{32}$' -and $destinationLeaf -eq "atomic-current") { $moveName = "atomic-current-install" }
    elseif ($sourceLeaf -eq "atomic.cmd" -and $destinationLeaf -match '^\.atomic-backup-[0-9a-f]{32}\.cmd$') { $moveName = "shim-backup" }
    elseif ($sourceLeaf -match '^\.atomic-[0-9a-f]{32}\.cmd$' -and $destinationLeaf -eq "atomic.cmd") { $moveName = "shim-install" }

    $restoreName = $null
    if ($sourceLeaf -match '^\.atomic-backup-[0-9a-f]{32}\.cmd$' -and $destinationLeaf -eq "atomic.cmd") { $restoreName = "shim-restore" }
    elseif ($sourceLeaf -match '^\.atomic-current-backup-[0-9a-f]{32}$' -and $destinationLeaf -eq "atomic-current") { $restoreName = "atomic-current-restore" }
    elseif ($sourceLeaf -match '^\.current-backup-[0-9a-f]{32}$' -and $destinationLeaf -eq "current") { $restoreName = "current-restore" }
    elseif ($sourceLeaf -match '^\.backup-[0-9a-f]{32}$' -and $destinationLeaf -eq "2.0.0") { $restoreName = "version-restore" }
    if ($global:AtomicCtrlCRollbackArmed -and
        -not $global:AtomicCtrlCRollbackFailureDelivered -and
        $RollbackFailure -eq $restoreName) {
        $global:AtomicCtrlCRollbackFailureDelivered = $true
        [IO.File]::AppendAllText($MoveLogPath, "ROLLBACK_FAILURE:$RollbackFailure" + [Environment]::NewLine)
        throw "Injected one-shot rollback restore failure: $RollbackFailure"
    }

    Microsoft.PowerShell.Management\Rename-Item -LiteralPath $LiteralPath -NewName $NewName -ErrorAction Stop
    if ($null -ne $moveName) {
        [IO.File]::AppendAllText($MoveLogPath, "MOVED:$moveName" + [Environment]::NewLine)
        if (-not $global:AtomicCtrlCPauseDelivered -and $moveName -eq $PauseMove) {
            $global:AtomicCtrlCPauseDelivered = $true
            $global:AtomicCtrlCRollbackArmed = $true
            [IO.File]::WriteAllText($ReadyPath, "READY:$moveName")
            while ($true) { Start-Sleep -Milliseconds 200 }
        }
    }
}

$isolatedChildHkcuKey = $null
$isolatedChildHkcuActive = $false
try {
    $isolatedChildHkcuKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($IsolatedHkcuSubKey, $true)
    if ($null -eq $isolatedChildHkcuKey) {
        throw "Ctrl+C child could not open isolated HKCU key: $IsolatedHkcuSubKey"
    }
    $childOverrideRc = [AtomicTestCtrlCHkcuOverride]::RegOverridePredefKey(
        [AtomicTestCtrlCHkcuOverride]::HKEY_CURRENT_USER,
        $isolatedChildHkcuKey.Handle.DangerousGetHandle()
    )
    if ($childOverrideRc -ne 0) {
        throw "Ctrl+C child RegOverridePredefKey failed with Win32 error $childOverrideRc"
    }
    $isolatedChildHkcuActive = $true

    & $InstallerPath -Ref "2.0.0" -Force | Out-Null
    throw "Installer unexpectedly completed before Ctrl+C"
}
finally {
    if ($isolatedChildHkcuActive) {
        [void][AtomicTestCtrlCHkcuOverride]::RegOverridePredefKey(
            [AtomicTestCtrlCHkcuOverride]::HKEY_CURRENT_USER,
            [IntPtr]::Zero
        )
        $isolatedChildHkcuActive = $false
    }
    if ($null -ne $isolatedChildHkcuKey) {
        $isolatedChildHkcuKey.Close()
        $isolatedChildHkcuKey = $null
    }
    [IO.File]::WriteAllText($ObservedProcessPath, [string]$env:Path, [Text.Encoding]::Unicode)
    [IO.File]::WriteAllText($FinallyPath, "CHILD_FINALLY", [Text.Encoding]::ASCII)
}
`;

const wmListenerSource = `
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class AtomicWmSettingChangeListener
{
    private const uint WM_SETTINGCHANGE = 0x001A;
    private const uint PM_REMOVE = 1;

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASS
    {
        public uint style;
        public WndProcDelegate lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string lpszMenuName;
        public string lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int pt_x;
        public int pt_y;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClass(ref WNDCLASS lpWndClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(
        uint exStyle, string className, string windowName, uint style,
        int x, int y, int width, int height,
        IntPtr parent, IntPtr menu, IntPtr hInstance, IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max, uint remove);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string name);

    private static string _logPath;
    private static WndProcDelegate _proc;

    private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_SETTINGCHANGE)
        {
            string area = lParam != IntPtr.Zero ? Marshal.PtrToStringUni(lParam) : "<null>";
            File.AppendAllText(_logPath, "WM_SETTINGCHANGE area=" + area + Environment.NewLine);
        }
        return DefWindowProc(hWnd, msg, wParam, lParam);
    }

    private static void PumpPending()
    {
        MSG msg;
        while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE))
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }

    public static int Main(string[] args)
    {
        if (args.Length < 4)
        {
            Console.Error.WriteLine("Usage: wm-listener.exe <readyPath> <stopPath> <logPath> <maxMs>");
            return 2;
        }
        string readyPath = args[0];
        string stopPath = args[1];
        _logPath = args[2];
        int maxMs = int.Parse(args[3]);

        _proc = new WndProcDelegate(WndProc);
        WNDCLASS wc = new WNDCLASS();
        wc.lpfnWndProc = _proc;
        wc.hInstance = GetModuleHandle(null);
        wc.lpszClassName = "AtomicWmSettingChangeListener_" + Guid.NewGuid().ToString("N");
        if (RegisterClass(ref wc) == 0)
        {
            Console.Error.WriteLine("RegisterClass failed");
            return 1;
        }
        IntPtr hwnd = CreateWindowEx(
            0, wc.lpszClassName, "atomic-wm-probe", 0,
            0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero)
        {
            Console.Error.WriteLine("CreateWindowEx failed");
            return 1;
        }
        try
        {
            File.WriteAllText(readyPath, "READY");
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(maxMs);
            while (DateTime.UtcNow < deadline)
            {
                PumpPending();
                if (File.Exists(stopPath))
                {
                    PumpPending();
                    return 0;
                }
                System.Threading.Thread.Sleep(10);
            }
            PumpPending();
            return 0;
        }
        finally
        {
            DestroyWindow(hwnd);
        }
    }
}
`;

// CREATE_NEW_CONSOLE isolates the child. The helper then attaches to that console, ignores
// Ctrl+C in only its own process, and broadcasts a kernel CTRL_C_EVENT to the attached
// console with GenerateConsoleCtrlEvent(..., 0). This is a real console event, not a
// PowerShell exception or a test-only production hook.
export const ctrlCHelperSource = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CtrlCConsoleDriver
{
    private const uint CREATE_NEW_CONSOLE = 0x00000010;
    private const uint CTRL_C_EVENT = 0;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    private delegate bool ConsoleCtrlDelegate(uint ctrlType);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate handler, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: ctrl-helper <powershell> <ready-file> <child-script> [child args]");
            return 64;
        }

        StringBuilder command = new StringBuilder();
        command.Append(Quote(args[0]));
        command.Append(" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ");
        command.Append(Quote(args[2]));
        for (int i = 3; i < args.Length; i++)
        {
            command.Append(" ");
            command.Append(Quote(args[i]));
        }

        // Do not let an inherited ignore-CTRL_C attribute flow into the child.
        SetConsoleCtrlHandler(null, false);
        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION process;
        if (!CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_NEW_CONSOLE,
            IntPtr.Zero, null, ref startup, out process))
        {
            Console.Error.WriteLine(new Win32Exception(Marshal.GetLastWin32Error()).Message);
            return 65;
        }

        try
        {
            DateTime markerDeadline = DateTime.UtcNow.AddSeconds(45);
            while (!File.Exists(args[1]))
            {
                if (WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0)
                {
                    Console.Error.WriteLine("child exited before the move marker");
                    return 66;
                }
                if (DateTime.UtcNow >= markerDeadline)
                {
                    TerminateProcess(process.hProcess, 67);
                    Console.Error.WriteLine("timed out waiting for the move marker");
                    return 67;
                }
                Thread.Sleep(25);
            }

            Thread.Sleep(100);
            FreeConsole();
            if (!AttachConsole(process.dwProcessId))
            {
                TerminateProcess(process.hProcess, 68);
                Console.Error.WriteLine("AttachConsole failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                return 68;
            }
            if (!SetConsoleCtrlHandler(null, true) || !GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0))
            {
                int error = Marshal.GetLastWin32Error();
                FreeConsole();
                TerminateProcess(process.hProcess, 69);
                Console.Error.WriteLine("GenerateConsoleCtrlEvent failed: " + new Win32Exception(error).Message);
                return 69;
            }
            Thread.Sleep(100);
            FreeConsole();

            uint wait = WaitForSingleObject(process.hProcess, 45000);
            if (wait == WAIT_TIMEOUT)
            {
                TerminateProcess(process.hProcess, 70);
                Console.Error.WriteLine("child did not exit after Ctrl+C");
                return 70;
            }
            uint childExitCode;
            GetExitCodeProcess(process.hProcess, out childExitCode);
            Console.WriteLine("CTRL_C_CHILD_EXIT:" + childExitCode);
            return 0;
        }
        finally
        {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
    }
}
`;

export type FixtureScenario =
	| "install"
	| "tag-grammar"
	| "missing-cmd-pathext"
	| "pointer-conflicts"
	| "preflight-errors"
	| "checksum"
	| "final-smoke"
	| "busy-stage-move"
	| "locked-version-backup"
	| "unicode"
	| "dangling-junction"
	| "rollback-retries"
	| "transaction-failures"
	| "ctrl-c"
	| "hash-fallback"
	| "ref-identity"
	| "api-rate-limit"
	| "semicolon-bin"
	| "shadowed-shim"
	| "custom-pathext"
	| "skip-installed"
	| "path-broadcast"
	| "backup-cleanup"
	| "temp-cleanup";

export function createIsolatedHkcuRunId(): string {
	return `run-${randomUUID().replaceAll("-", "")}`;
}

export function deleteIsolatedHkcuRunKeyBestEffort(runId: string, executable?: string): void {
	if (process.platform !== "win32" || !/^[A-Za-z0-9_-]+$/u.test(runId)) {
		return;
	}
	try {
		const regResult = spawnSyncCollect(
			["reg.exe", "delete", `HKCU\\Software\\AtomicTestIsolatedHkcu\\${runId}`, "/f"],
			{ timeout: 10_000 },
		);
		if (regResult.exitCode === 0) {
			return;
		}
		const regText = `${regResult.stdout.toString()}${regResult.stderr.toString()}`;
		if (/unable to find/iu.test(regText)) {
			return;
		}
	} catch {
		// Fall through to PowerShell registry cleanup below.
	}
	if (executable === undefined) {
		return;
	}
	const escapedRunId = runId.replaceAll("'", "''");
	const cleanupScript = [
		'$p = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\AtomicTestIsolatedHkcu", $true)',
		`if ($null -ne $p) { try { $p.DeleteSubKeyTree('${escapedRunId}', $false) } finally { $p.Close() } }`,
	].join("\n");
	try {
		spawnSyncCollect([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cleanupScript], {
			timeout: 15_000,
		});
	} catch {
		// Best-effort cleanup must never mask the primary fixture failure.
	}
}

function preparePowerShellFixtureWorkspace(scenario: FixtureScenario): { workspace: string; harnessPath: string } {
	const workspace = mkdtempSync(join(tmpdir(), `atomic-ps-fixture-${scenario}-`));
	const harnessPath = join(workspace, "fixture.ps1");
	if (scenario === "ctrl-c") {
		writeFileSync(join(workspace, "ctrl-c-child.ps1"), `\uFEFF${ctrlCChildHarness}`, "utf16le");
		writeFileSync(join(workspace, "ctrl-c-helper.cs"), ctrlCHelperSource, "utf8");
	}
	if (scenario === "path-broadcast") {
		writeFileSync(join(workspace, "wm-listener.cs"), wmListenerSource, "utf8");
	}
	writeFileSync(harnessPath, `\uFEFF${fixtureHarness}`, "utf16le");
	return { workspace, harnessPath };
}

function fixtureTimeoutMs(scenario: FixtureScenario): number {
	return scenario === "ctrl-c"
		? CTRL_C_FIXTURE_STRUCTURAL_TIMEOUT_MS
		: scenario === "rollback-retries"
			? ROLLBACK_RETRY_FIXTURE_STRUCTURAL_TIMEOUT_MS
			: scenario === "transaction-failures"
				? TRANSACTION_FAILURE_FIXTURE_STRUCTURAL_TIMEOUT_MS
				: scenario === "temp-cleanup"
					? TEMP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS
					: scenario === "backup-cleanup"
						? BACKUP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS
						: POWERSHELL_FIXTURE_TIMEOUT_MS;
}

export function readHostUserPathAndScratchPresence(
	executable: string,
	runIds: readonly string[],
): { exists: boolean; value: string | null; kind: string | null; leftoverRunIds: string[] } {
	const idsLiteral = runIds.map((id) => `'${id.replaceAll("'", "''")}'`).join(", ");
	const probe = [
		'$ErrorActionPreference = "Stop"',
		'$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)',
		"$exists = $null -ne $envKey",
		"$val = $null; $kind = $null",
		"if ($exists) {",
		"  try {",
		'    $val = $envKey.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
		'    if ($null -ne $val) { $kind = [string]$envKey.GetValueKind("Path") }',
		"  } finally { $envKey.Close() }",
		"}",
		"$leftovers = @()",
		`$parentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\AtomicTestIsolatedHkcu", $false)`,
		"if ($null -ne $parentKey) {",
		"  try {",
		`    foreach ($id in @(${idsLiteral})) {`,
		"      $child = $parentKey.OpenSubKey($id, $false)",
		"      if ($null -ne $child) { $child.Close(); $leftovers += $id }",
		"    }",
		"  } finally { $parentKey.Close() }",
		"}",
		"[pscustomobject]@{ exists = $exists; value = $val; kind = $kind; leftoverRunIds = @($leftovers) } | ConvertTo-Json -Compress",
	].join("\n");
	const result = spawnSyncCollect([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probe], {
		timeout: 30_000,
	});
	assert.equal(result.exitCode, 0, `${result.stdout.toString()}${result.stderr.toString()}`);
	const parsed = JSON.parse(result.stdout.toString().trim()) as {
		exists: boolean;
		value: string | null;
		kind: string | null;
		leftoverRunIds: string | string[] | null;
	};
	const leftoverRunIds =
		parsed.leftoverRunIds === null
			? []
			: Array.isArray(parsed.leftoverRunIds)
				? parsed.leftoverRunIds
				: [parsed.leftoverRunIds];
	return { exists: parsed.exists, value: parsed.value, kind: parsed.kind, leftoverRunIds };
}

export async function runPowerShellFixtureAsync(
	scenario: FixtureScenario,
	executable: string | undefined = powershellExecutable,
	isolatedHkcuRunId?: string,
): Promise<string> {
	assert.ok(executable);
	const { workspace, harnessPath } = preparePowerShellFixtureWorkspace(scenario);
	const runId = isolatedHkcuRunId ?? createIsolatedHkcuRunId();
	const args = [
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
		"-IsolatedHkcuRunId",
		runId,
		"-IsolatedHkcuOwnerPid",
		String(process.pid),
	];
	return runThenRemoveFixtureTreeAsync(workspace, async () => {
		let childSucceeded = false;
		try {
			const result = await spawnCollectAsync(
				executable,
				args,
				fixtureTimeoutMs(scenario),
				`PowerShell fixture ${scenario}`,
			);
			assert.equal(
				result.exitCode,
				0,
				`PowerShell fixture ${scenario} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			);
			assert.match(result.stdout, new RegExp(`SCENARIO_OK:${scenario}`, "u"));
			childSucceeded = true;
			return result.stdout;
		} finally {
			if (!childSucceeded) {
				deleteIsolatedHkcuRunKeyBestEffort(runId, executable);
			}
		}
	});
}

export function runPowerShellFixture(
	scenario: FixtureScenario,
	executable: string | undefined = powershellExecutable,
	isolatedHkcuRunId?: string,
): string {
	assert.ok(executable);
	const { workspace, harnessPath } = preparePowerShellFixtureWorkspace(scenario);
	const runId = isolatedHkcuRunId ?? createIsolatedHkcuRunId();
	return runThenRemoveFixtureTree(workspace, () => {
		let childSucceeded = false;
		try {
			const result = spawnSyncCollect(
				[
					executable,
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
					"-IsolatedHkcuRunId",
					runId,
					"-IsolatedHkcuOwnerPid",
					String(process.pid),
				],
				{ timeout: fixtureTimeoutMs(scenario) },
			);
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();
			assert.equal(
				result.exitCode,
				0,
				`PowerShell fixture ${scenario} failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
			assert.match(stdout, new RegExp(`SCENARIO_OK:${scenario}`, "u"));
			childSucceeded = true;
			return stdout;
		} finally {
			if (!childSucceeded) {
				deleteIsolatedHkcuRunKeyBestEffort(runId, executable);
			}
		}
	});
}
