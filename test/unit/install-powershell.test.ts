import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";
import {
	createIsolatedHkcuRunId,
	type FixtureScenario,
	fixtureHarness,
	installerPath,
	installerSource,
	POWERSHELL_FIXTURE_TIMEOUT_MS,
	type PowerShellEngine,
	powershellEngines,
	powershellExecutable,
	readHostUserPathAndScratchPresence,
	runPowerShellFixture,
	runPowerShellFixtureAsync,
	spawnCollectAsync,
} from "./install-powershell-helpers.js";

const powershellTest = powershellExecutable === undefined ? test.skip : test;

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
	assert.match(source, /function Get-AtomicFileSha256/u);
	assert.match(source, /Get-FileHash\s+-LiteralPath\s+\$Path\s+-Algorithm\s+SHA256/u);
	assert.match(source, /Get-AtomicFileSha256\s+\$archivePath/u);
	assert.match(source, /Expand-AtomicReleaseArchive\s+\$archivePath\s+\$payloadPath/u);
	assert.match(
		source,
		/\[System\.IO\.Compression\.ZipFile\]::ExtractToDirectory\(\$ArchivePath, \$DestinationPath\)/u,
	);
	assert.doesNotMatch(source, /ConvertFrom-Json\s+-AsHashtable/u);
	assert.doesNotMatch(source, /\?\?|ForEach-Object\s+-Parallel|\?\s+[^:\r\n]+\s+:/u);
	assert.doesNotMatch(source, /\b(?:npm|pnpm|yarn|bun|node|git|jq)(?:\.exe)?\b/iu);
	assert.match(source, /\^\(\[A-Fa-f0-9\]\{64\}\) \(\[ \*\]\)\(\[\^\\\\\/\\r\\n\]\+\)\$/u);
	assert.ok(source.includes("$assetRowPattern = '(^|[ \\t*])'"));
	assert.match(source, /\$checksumAssetRows\.Count\s+-ne\s+1/u);

	const checksumComparison = source.indexOf("Checksum verification failed");
	const installMutation = source.indexOf("New-Item -ItemType Directory -Path $versionsDir");
	assert.ok(checksumComparison >= 0 && installMutation > checksumComparison);
	assert.match(source, /New-Item\s+-ItemType\s+Junction/u);
	// The User PATH is read unexpanded and written back with its registry type, so %VAR% entries survive.
	assert.match(source, /Set-AtomicUserPathValue \$newUserPath \$oldUserPathValue\.Kind/u);
	assert.match(source, /DoNotExpandEnvironmentNames/u);
	assert.match(source, /\$key\.SetValue\("Path", \$Value, \$Kind\)/u);
	// One installer at a time: an exclusive handle the system releases when the installer exits or is killed.
	assert.match(source, /\[IO\.FileShare\]::None, 1, \[IO\.FileOptions\]::DeleteOnClose/u);
	assert.ok(
		source.indexOf("$installLock = Enter-AtomicInstallLock") <
			source.indexOf("Get-AtomicInstalledVersion (Join-Path"),
	);
	// The installed version is read from where `current` points, never by running the installed atomic.exe.
	const installedVersionProbe = source.slice(
		source.indexOf("function Get-AtomicInstalledVersion"),
		source.indexOf("function Get-AtomicComparablePath"),
	);
	assert.doesNotMatch(installedVersionProbe, /--version/u);
	// Programs the installer starts never inherit the token.
	assert.ok(source.indexOf("$env:GITHUB_TOKEN = $null") < source.indexOf('$null = & $stagedAtomic "--version"'));
	assert.match(source, /\$null = &\s+\$stagedAtomic\s+"--version"[\s\S]*\$LASTEXITCODE/u);
	assert.match(source, /\$null = &\s+\$env:ComSpec\s+\/d\s+\/c\s+\$shimCommand[\s\S]*\$LASTEXITCODE/u);

	assert.match(source, /LOCALAPPDATA[\\/]atomic/u);
	assert.match(source, /Default bin directory:[^\r\n]*LOCALAPPDATA[\\/]atomic[\\/]bin/u);
	assert.match(source, /NO_COLOR\s+Disable colour and progress output \(plain mode\)\./u);
	assert.ok(source.includes('Write-Output "Installed to $shimPath"'));
	assert.ok(source.includes('Write-Output "Added $binDir to your User PATH; open a new terminal to use atomic."'));
	const unexpectedShim = source.indexOf("unexpected atomic.cmd directory");
	const unexpectedPointer = source.indexOf("unexpected atomic-current entry");
	const apiHeaders = source.indexOf('$apiHeaders = @{ Accept = "application/vnd.github+json" }');
	assert.ok(unexpectedShim >= 0 && unexpectedShim < apiHeaders);
	assert.ok(unexpectedPointer >= 0 && unexpectedPointer < apiHeaders);
});

test("Windows installer skips a healthy install before any download and keeps the force escape hatch documented", () => {
	const source = installerSource();

	assert.match(source, /param\([\s\S]*\[switch\]\$Force[\s\S]*\[switch\]\$Help[\s\S]*\)/u);
	assert.match(source, /install\.ps1 \[-Ref <tag>\] \[-Force\] \[-Help\]/u);
	assert.match(
		source,
		/^ {2}-Force +Reinstall even when the requested version is already installed and healthy\.\r?$/mu,
	);
	assert.match(source, /^ {2}ATOMIC_FORCE_INSTALL\r?\n +Set to 1 to behave like -Force\.\r?$/mu);
	assert.match(source, /\$forceInstall = \$Force\.IsPresent -or \$env:ATOMIC_FORCE_INSTALL -eq "1"/u);

	const skipCondition = source.indexOf("if (-not $forceInstall -and (Test-AtomicInstallIntact");
	const skipMessage = source.indexOf(
		'Write-AtomicMuted "atomic $releaseTag is already installed; skipping download (use -Force to reinstall)"',
	);
	const pathRepair = source.indexOf("Add-AtomicBinDirToPath $binDir", skipMessage);
	const skipSummary = source.indexOf("Write-AtomicInstallSummary $userPathAdded", pathRepair);
	const skipReturn = source.indexOf("return", skipSummary);
	const firstDownload = source.indexOf("$tempDir = Join-Path");
	assert.ok(
		skipCondition >= 0 &&
			skipMessage > skipCondition &&
			pathRepair > skipMessage &&
			skipSummary > pathRepair &&
			skipReturn > skipSummary &&
			firstDownload > skipReturn,
		"the healthy-install skip must repair PATH, print the summary, and return before any temp directory or download",
	);
	const releaseResolution = source.indexOf("$encodedReleaseTag = [Uri]::EscapeDataString($releaseTag)");
	assert.ok(
		releaseResolution >= 0 && releaseResolution < skipCondition,
		"the release tag is resolved before the skip decision",
	);

	const health = source.slice(
		source.indexOf("function Get-AtomicComparablePath"),
		source.indexOf("function Get-AtomicFileSha256"),
	);
	assert.match(health, /\$InstalledVersion -cne \$ReleaseTag/u);
	assert.match(health, /Get-AtomicReparseTarget \(Get-AtomicDirectoryEntry \(Join-Path \$InstallRoot "current"\)\)/u);
	assert.match(
		health,
		/Get-AtomicReparseTarget \(Get-AtomicDirectoryEntry \(Join-Path \$BinDir "atomic-current"\)\)/u,
	);
	assert.match(health, /\$currentTarget -ine \$atomicCurrentTarget/u);
	assert.match(health, /\[Uri\]::EscapeDataString\(\$ReleaseTag\)/u);
	assert.match(
		health,
		/\(Get-AtomicComparablePath \$currentTarget\) -ine \(Get-AtomicComparablePath \$expectedVersionPath\)/u,
		"current must resolve physically to the install root's versions directory for the release",
	);
	assert.match(health, /Test-AtomicInstalledPayloadComplete \(Join-Path \$InstallRoot "current"\)/u);
	for (const required of [
		"package.json",
		"app.js",
		"native-modifiers.js",
		"native-module-path.js",
		"native-platform.js",
	]) {
		assert.ok(health.includes(`"${required}"`), `the Windows health check must require ${required}`);
	}
	for (const required of ["builtin", "node_modules"]) {
		assert.ok(health.includes(`"${required}"`), `the Windows health check must require the ${required} directory`);
	}
	assert.match(health, /\$launcherItem\.Length -eq 0/u, "an empty atomic.exe must not count as healthy");
	assert.match(health, /Test-AtomicLauncherMatchesRecord \$currentRoot/u, "a recorded launcher hash must still match");
	assert.match(health, /function Test-AtomicInstallVerified/u);
	assert.match(health, /Join-Path \$BinDir "atomic\.cmd"/u);
	assert.match(health, /ReadAllText\(\$shimItem\.FullName\) -ceq \$ExpectedShimContent/u);
	assert.doesNotMatch(
		health,
		/&\s+\$|Invoke-WebRequest|Move-Item|Rename-Item|Move-AtomicItem|Remove-Item/u,
		"the health check must be read-only",
	);
});

test("Windows installer runs 'intercom upgrade' through the new shim after the commit and only warns on failure (#4538)", () => {
	const source = installerSource();
	const committed = source.indexOf("$transactionCommitted = $true");
	const backupCleanup = source.indexOf("Remove-AtomicTransactionBackups $transaction", committed);
	const upgrade = source.indexOf("    Invoke-AtomicIntercomUpgrade $shimPath", backupCleanup);
	const summary = source.indexOf("Write-AtomicInstallSummary $transaction.UserPathChangeIntended", upgrade);
	assert.ok(committed >= 0 && backupCleanup > committed, "the commit must be recorded before backups are removed");
	assert.ok(upgrade > backupCleanup, "'intercom upgrade' must run after the install is committed");
	assert.ok(summary > upgrade, "'intercom upgrade' must run before the install summary");

	const definition = source.indexOf("function Invoke-AtomicIntercomUpgrade {");
	const upgradeBlock = source.slice(definition, source.indexOf("\nfunction ", definition + 1));
	assert.ok(definition >= 0 && definition < committed);
	assert.match(upgradeBlock, /param\(\[string\]\$ShimPath, \[string\]\$ReleaseTag\)/u);
	assert.match(
		upgradeBlock,
		/try \{\s+if \(-not \(Test-AtomicReleaseHasIntercomCommand \$ReleaseTag\) -or -not \(Test-AtomicShimHasIntercomUpgrade \$ShimPath\)\) \{\s+return\s+\}[\s\S]*\$ShimPath \+ '" intercom upgrade <NUL'[\s\S]*\$env:ComSpec \/d \/c \$upgradeCommand/u,
	);
	assert.match(upgradeBlock, /\$LASTEXITCODE[\s\S]*Write-Warning/u);
	assert.match(upgradeBlock, /catch \{\s+Write-Warning /u);
	assert.ok(
		source.includes("    Invoke-AtomicIntercomUpgrade $shimPath $releaseTag\n") ||
			source.includes("    Invoke-AtomicIntercomUpgrade $shimPath $releaseTag\r\n"),
	);

	const floor = source.slice(source.indexOf("function Test-AtomicReleaseHasIntercomCommand {"));
	assert.match(
		floor,
		/^function Test-AtomicReleaseHasIntercomCommand \{\s+param\(\[string\]\$Tag\)\s+return \[version\]\(\$Tag -replace '-alpha\\\.\[0-9\]\+\$', ''\) -ge \[version\]'0\.9\.42'/u,
	);
	const probe = source.slice(source.indexOf("function Test-AtomicShimHasIntercomUpgrade {"), definition);
	assert.match(probe, /\$env:ComSpec \/d \/c \('"' \+ \$ShimPath \+ '" intercom --help <NUL 2>NUL'\)/u);
	assert.match(probe, /\.Trim\(\) -ceq 'atomic intercom upgrade'/u);
	assert.doesNotMatch(probe, /\) 2>/u, "the probe redirects inside cmd, never at the PowerShell level");
	assert.doesNotMatch(upgradeBlock, /\bthrow\b/u, "a failing 'intercom upgrade' must never fail the installer");
});

test("Windows installer streams the archive with a progress bar and keeps smoke-check output off the console", () => {
	const source = installerSource();
	const bytes = readFileSync(installerPath);

	// Windows PowerShell 5.1 reads a file without a byte-order mark as ANSI, so the script stays
	// pure ASCII and builds every glyph from code points instead of literal characters.
	assert.ok(
		bytes.every((byte) => byte < 0x80),
		"install.ps1 must stay ASCII-only",
	);
	assert.match(source, /\[char\]0x25A0/u);
	assert.match(source, /\[char\]0xFF65/u);
	for (const codePoint of ["0x2588", "0x2599", "0x259F", "0x259B", "0x259C"]) {
		assert.ok(source.includes(`[char]${codePoint}`), `banner glyph ${codePoint} is not built from its code point`);
	}

	assert.match(source, /\$null -eq \$Host\.UI -or \$null -eq \$Host\.UI\.RawUI/u);
	assert.match(source, /\$null -ne \$env:NO_COLOR -or \$null -ne \$env:CI/u);
	assert.match(source, /\[Console\]::IsOutputRedirected/u);
	assert.match(
		source,
		/\$useUnicodeGlyphs = -not \$plainOutput -and -not \[string\]::IsNullOrEmpty\(\$env:WT_SESSION\)/u,
	);

	const progress = source.slice(
		source.indexOf("function Invoke-AtomicDownloadWithProgress"),
		source.indexOf("function Test-AtomicPathContains"),
	);
	assert.match(progress, /Add-Type -AssemblyName System\.Net\.Http/u);
	assert.match(progress, /New-Object System\.Net\.Http\.HttpClient/u);
	assert.match(
		progress,
		/\[System\.Net\.Http\.HttpCompletionOption\]::ResponseHeadersRead, \$headerCancellation\.Token\)\.GetAwaiter\(\)\.GetResult\(\)/u,
		"the header wait must carry a cancellation token so a silent server cannot hang the installer",
	);
	assert.match(
		progress,
		/New-Object Threading\.CancellationTokenSource\(\[TimeSpan\]::FromMilliseconds\(\$downloadHeaderTimeoutMilliseconds\)\)/u,
	);
	assert.match(progress, /\$readTask = \$source\.ReadAsync\(\$buffer, 0, \$buffer\.Length\)/u);
	assert.match(
		progress,
		/if \(-not \$readTask\.Wait\(\$downloadStallTimeoutMilliseconds\)\) \{\r?\n\s+throw "download stalled: no data received for/u,
		"every body read must be bounded by the stall deadline",
	);
	assert.doesNotMatch(progress, /\$source\.Read\(\$buffer/u, "a synchronous unbounded body read must not return");
	assert.match(source, /^\$downloadHeaderTimeoutMilliseconds = 60000\r?$/mu);
	assert.match(source, /^\$downloadStallTimeoutMilliseconds = 60000\r?$/mu);
	assert.match(progress, /\$response\.Content\.Headers\.ContentLength/u);
	assert.match(progress, /New-Object byte\[\] 65536/u);
	assert.match(progress, /return \$false/u);
	assert.doesNotMatch(
		progress,
		/Authorization|-Headers|GITHUB_TOKEN|GH_TOKEN/u,
		"the archive stream must never carry a token",
	);
	assert.match(source, /\$width = 50/u);
	assert.match(source, /" \{0,3\}% {2}\{1\} \/ \{2\} MB" -f/u);

	const archiveDownload = source.indexOf(
		'Invoke-AtomicDownloadWithProgress "$releaseBase/$assetName" $archivePath $assetName',
	);
	const fallbackDownload = source.indexOf(
		'Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath',
		archiveDownload,
	);
	const checksumsDownload = source.indexOf(
		'Invoke-AtomicDownload "$releaseBase/SHA256SUMS" $checksumsPath',
		fallbackDownload,
	);
	assert.ok(archiveDownload >= 0, "the archive is not downloaded with progress");
	assert.ok(fallbackDownload > archiveDownload, "the archive download has no Invoke-WebRequest fallback");
	assert.ok(checksumsDownload > fallbackDownload, "SHA256SUMS must stay on the silent download path");
	assert.match(source.slice(archiveDownload, checksumsDownload), /"Downloading \$assetName \.\.\. "[\s\S]+"done"/u);

	// Assignment rather than `| Out-Null`: a pipeline makes Windows PowerShell
	// refuse to launch a native command that PATHEXT does not classify as an
	// application ("Cannot run a document in the middle of a pipeline"), and
	// the installer tolerates PATHEXT entries PowerShell itself does not parse.
	for (const smokeCheck of ['$null = & $stagedAtomic "--version"', "$null = & $env:ComSpec /d /c $shimCommand"]) {
		assert.ok(source.includes(smokeCheck), `smoke check output is not discarded: ${smokeCheck}`);
	}
	assert.match(source, /Write-AtomicMuted "Verified SHA256, extracted, and checked atomic --version"/u);

	const bannerGate = source.indexOf(
		"if ($useUnicodeGlyphs) {",
		source.indexOf('Write-Output "Installed to $shimPath"'),
	);
	assert.ok(bannerGate >= 0, "the banner is not gated on Windows Terminal");
	assert.match(
		source.slice(bannerGate, source.indexOf("if (-not $plainOutput) {", bannerGate)),
		/Get-AtomicBannerLines/u,
	);
	assert.match(source, /Write-AtomicMuted "For more information visit https:\/\/docs\.bastani\.ai\/quickstart"/u);

	const outputLines = [...source.matchAll(/^\s*Write-Output (.*)$/gmu)].map((match) => match[1]?.trim());
	assert.deepEqual(outputLines, [
		"$helpText",
		'"Installed to $shimPath"',
		"\"ATOMIC_BIN_DIR contains ';' and cannot be represented as one Windows PATH entry.\"",
		'"Run Atomic directly: `"$shimPath`""',
		'"Choose a semicolon-free ATOMIC_BIN_DIR to add Atomic to PATH."',
		'"Added $binDir to your User PATH; open a new terminal to use atomic."',
	]);
});

test("Windows installer rejects PATHEXT launchers that shadow atomic.cmd before any request", () => {
	const source = installerSource();

	assert.match(source, /function Get-AtomicShimShadowingExtensions/u);
	assert.ok(
		source.includes('".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"'),
		"the default PATHEXT order is not used as a fallback",
	);
	assert.match(source, /\$pathExtValue = \$env:PATHEXT/u);
	assert.match(source, /if \(\[string\]::IsNullOrWhiteSpace\(\$pathExtValue\)\) \{[\s\S]+\$pathExtValue = "\.COM;/u);
	assert.doesNotMatch(source, /foreach \(\$pathExtValue in @\(\$env:PATHEXT,/u);
	assert.match(source, /foreach \(\$pathExtEntry in \(\$pathExtValue -split ';'\)/u);
	assert.match(source, /\$cmdSeen = \$false/u);
	assert.match(source, /if \(\$extension -eq "\.CMD"\) \{\r?\n\s+\$cmdSeen = \$true\r?\n\s+break\r?\n\s+\}/u);
	assert.match(source, /\$extension = \$extension\.ToUpperInvariant\(\)/u);
	assert.match(source, /\$extension = \$pathExtEntry\.Trim\(\)\.Trim\('"'\)\.Trim\(\)/u);
	const missingCmdThrow = source.indexOf("PATHEXT does not include .CMD");
	assert.ok(missingCmdThrow >= 0, "the installer does not reject a PATHEXT without .CMD");
	assert.match(source, /if \(-not \$cmdSeen\) \{[\s\S]{0,200}PATHEXT does not include \.CMD/u);
	assert.match(source, /PATHEXT does not include \.CMD; bare atomic cannot resolve the installed atomic\.cmd shim\./u);
	for (const boundary of [
		'$apiHeaders = @{ Accept = "application/vnd.github+json" }',
		"New-Item -ItemType Directory -Path $tempDir",
		'Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath',
	]) {
		assert.ok(missingCmdThrow < source.indexOf(boundary), `the missing-.CMD rejection runs after: ${boundary}`);
	}

	const shadowLoop = source.indexOf("foreach ($shadowingExtension in @(Get-AtomicShimShadowingExtensions))");
	assert.ok(shadowLoop >= 0, "the shadowing preflight loop is missing");
	assert.match(
		source.slice(shadowLoop),
		/Get-AtomicDirectoryEntry \(Join-Path \$binDir \("atomic" \+ \$shadowingExtension\)\)/u,
	);
	assert.match(source, /which PATHEXT resolves before atomic\.cmd; remove it and rerun the installer\./u);
	assert.doesNotMatch(
		source.slice(shadowLoop, source.indexOf("$apiHeaders = @{")),
		/PSIsContainer|Remove-Item|Move-Item|Rename-Item|Move-AtomicItem/u,
		"the shadowing preflight must report rather than delete or narrow to files",
	);

	for (const boundary of [
		'$apiHeaders = @{ Accept = "application/vnd.github+json" }',
		'$redirectTag = Get-AtomicRedirectTag "https://github.com',
		"$releaseBase = ",
		'Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath',
		"New-Item -ItemType Directory -Path $tempDir",
	]) {
		const boundaryIndex = source.indexOf(boundary);
		assert.ok(boundaryIndex >= 0, boundary);
		assert.ok(shadowLoop < boundaryIndex, `the shadowing preflight runs after: ${boundary}`);
	}
});

test("Windows installer rejects bin directories inside transaction-owned install paths before any request or mutation", () => {
	const source = installerSource();
	const guard = source.indexOf(
		"ATOMIC_BIN_DIR cannot be inside ATOMIC_INSTALL_DIR\\current or ATOMIC_INSTALL_DIR\\versions",
	);
	assert.ok(guard >= 0, "the transaction-owned bin-directory guard is missing");
	const tlsCapture = source.indexOf("$previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol");
	const tlsEnable = source.indexOf(
		"[Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
	);
	assert.ok(tlsCapture >= 0 && tlsEnable > tlsCapture, "the TLS assignment is missing or malformed");
	assert.ok(guard < tlsCapture, "the transaction-owned bin-directory guard runs after TLS state is captured");
	assert.ok(guard < tlsEnable, "the transaction-owned bin-directory guard runs after TLS is assigned");
	assert.match(
		source,
		/\$ownedInstallPaths = @\([\s\S]+Join-Path \$installRoot "current"[\s\S]+Join-Path \$installRoot "versions"/u,
	);
	assert.match(source, /\$binCandidate -ieq \$ownedInstallPath/u);
	assert.match(source, /\$binCandidate\.StartsWith\(\$ownedInstallPrefix, \[StringComparison\]::OrdinalIgnoreCase\)/u);
	assert.match(source, /function Get-AtomicPhysicalPath/u);
	assert.match(source, /function Get-AtomicReparseTarget/u);
	assert.match(source, /\$physicalInstallRoot = Get-AtomicPhysicalPath \$installRoot/u);
	assert.match(source, /\$physicalBinDir = Get-AtomicPhysicalPath \$binDir/u);
	assert.match(source, /\$binCandidates = @\(\$binDir, \$physicalBinDir\)/u);
	assert.match(source, /Join-Path \$physicalInstallRoot "current"/u);
	assert.match(source, /Join-Path \$physicalInstallRoot "versions"/u);
	assert.match(source, /\[IO\.FileAttributes\]::ReparsePoint/u);
	assert.match(source, /\$Item\.Target/u);
	for (const boundary of [
		'$apiHeaders = @{ Accept = "application/vnd.github+json" }',
		'$redirectTag = Get-AtomicRedirectTag "https://github.com',
		"New-Item -ItemType Directory -Path $tempDir",
		'Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath',
	]) {
		const boundaryIndex = source.indexOf(boundary);
		assert.ok(boundaryIndex >= 0, boundary);
		assert.ok(guard < boundaryIndex, `the transaction-owned bin-directory guard runs after: ${boundary}`);
	}
	assert.doesNotMatch(
		source.slice(
			source.indexOf("$ownedInstallPaths = @("),
			source.indexOf('$apiHeaders = @{ Accept = "application/vnd.github+json" }'),
		),
		/Move-Item|Rename-Item|Move-AtomicItem|Remove-Item|New-Item/u,
		"the transaction-owned path preflight must not mutate caller paths",
	);
});

test("Windows installer initializes cleanup state before preflight and API resolution", () => {
	const source = installerSource();
	const outerTry = source.indexOf("$previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol");
	assert.ok(outerTry >= 0, "the TLS guard was not found");

	for (const declaration of [
		"$tempDir = $null",
		"$versionStagePath = $null",
		"$currentNextPath = $null",
		"$atomicCurrentNextPath = $null",
		"$shimNextPath = $null",
		"$transaction = $null",
		"$transactionCommitted = $false",
		"$transactionMissingDirectories = New-Object System.Collections.ArrayList",
		"$rollbackRetryLimit = 3",
		"$tempCleanupRetryLimit = 9",
		"$tempCleanupRetryDelayMilliseconds = 250",
		"$primaryError = $null",
		"$tempCleanupError = $null",
	]) {
		const declarationIndex = source.indexOf(declaration);
		assert.ok(declarationIndex >= 0, `${declaration} is missing`);
		assert.ok(declarationIndex < outerTry, `${declaration} is initialized after the outer try`);
		assert.equal(
			(source.match(new RegExp(declaration.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")) ?? []).length,
			1,
			`${declaration} is initialized more than once`,
		);
	}

	assert.match(source, /if \(\$null -ne \$tempDir -and \(Test-Path -LiteralPath \$tempDir\)\)/u);
	const preflightThrow = source.indexOf("ATOMIC_BIN_DIR contains an unexpected atomic.cmd directory");
	assert.ok(outerTry < preflightThrow, "a preflight throw precedes the cleanup-state initialization");
});

test("Windows installer enforces Atomic release grammar before archive downloads", () => {
	const source = installerSource();
	assert.match(source, /function Test-AtomicReleaseTag/u);
	assert.ok(
		// \z, not $: .NET's $ also matches before a final newline, which install.sh rejects.
		source.includes("'^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-alpha\\.(?:[1-9][0-9]*))?\\z'"),
		"the PowerShell grammar does not match install.sh",
	);
	assert.match(source, /-cmatch/u);
	assert.equal(
		(
			source.match(
				/throw "unsupported release tag: expected MAJOR\.MINOR\.PATCH or MAJOR\.MINOR\.PATCH-alpha\.REVISION"/gu,
			) ?? []
		).length,
		2,
		"the requested ref and the resolved tag are not both validated",
	);

	const requestedCheck = source.indexOf(
		"if (-not [string]::IsNullOrWhiteSpace($requestedRef) -and -not (Test-AtomicReleaseTag $requestedRef))",
	);
	const resolvedCheck = source.indexOf("if (-not (Test-AtomicReleaseTag $releaseTag))");
	assert.ok(requestedCheck >= 0 && resolvedCheck > requestedCheck);
	assert.ok(requestedCheck < source.indexOf("Invoke-AtomicApiRequest $latestApi"));
	assert.ok(requestedCheck < source.indexOf('$apiHeaders = @{ Accept = "application/vnd.github+json" }'));
	assert.ok(resolvedCheck < source.indexOf("$releaseBase = "));
	assert.ok(resolvedCheck < source.indexOf("New-Item -ItemType Directory -Path $tempDir"));
});

test("Windows installer protects transaction pointer types before I/O", () => {
	const source = installerSource();
	const currentPath = source.indexOf('$currentPath = Join-Path $installRoot "current"');
	const currentItem = source.indexOf("$existingCurrentItem = Get-AtomicDirectoryEntry $currentPath");
	const currentThrow = source.indexOf(
		"ATOMIC_INSTALL_DIR contains an unexpected current entry; refusing to replace it.",
	);
	const apiHeaders = source.indexOf('$apiHeaders = @{ Accept = "application/vnd.github+json" }');
	assert.ok(currentPath >= 0 && currentItem > currentPath && currentThrow > currentItem);
	assert.ok(currentThrow < apiHeaders, "the current-pointer guard runs after the API headers");
	assert.ok(currentThrow < source.indexOf("New-Item -ItemType Directory -Path $tempDir"));
	assert.match(
		source.slice(currentItem, currentThrow),
		/\(\$existingCurrentItem\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint\) -eq 0/u,
	);
	assert.match(source, /ATOMIC_BIN_DIR contains an unexpected atomic-current entry; refusing to replace it\./u);
	assert.doesNotMatch(
		source.slice(source.indexOf("$existingShimItem = Get-AtomicDirectoryEntry $shimPath"), apiHeaders),
		/Move-Item|Rename-Item|Move-AtomicItem|Remove-Item|New-Item/u,
		"the pointer preflight must not mutate caller entries",
	);
});

test("Windows installer isolates IEX state and scopes TLS 1.2 to controlled requests", () => {
	const source = installerSource();
	assert.match(source, /& \{\r?\nparam\(/u);
	assert.ok(source.trimEnd().endsWith("} @args"));
	assert.match(
		source,
		/\$previousSecurityProtocol = \[Net\.ServicePointManager\]::SecurityProtocol[\s\S]+-bor \[Net\.SecurityProtocolType\]::Tls12/u,
	);
	const requestStart = source.indexOf('$redirectTag = Get-AtomicRedirectTag "https://github.com');
	const tlsEnable = source.indexOf("[Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor");
	const tlsRestore = source.lastIndexOf("[Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol");
	assert.ok(tlsEnable >= 0 && tlsEnable < requestStart && tlsRestore > requestStart);
});

test("Windows installer pins the requested ref and refuses an unusable PATH entry", () => {
	const source = installerSource();

	const identityCheck = source.indexOf("$releaseTag -cne $requestedRef");
	assert.ok(identityCheck >= 0, "the resolved tag is not compared with the requested ref");
	assert.ok(identityCheck < source.indexOf("$releaseBase ="), "the identity check runs after the download base");
	assert.match(source, /throw "GitHub returned release \$releaseTag for requested tag \$requestedRef\."/u);

	assert.match(source, /\$binDirHasPathSeparator = \$binDir\.Contains\(";"\)/u);
	assert.equal(
		(source.match(/if \(-not \$binDirHasPathSeparator -and -not \(Test-AtomicPathContains/gu) ?? []).length,
		4,
		"every PATH mutation, in the skip repair and in the transaction, must be guarded by the separator check",
	);
	assert.match(source, /cannot be represented as one Windows PATH entry/u);
	assert.match(source, /Choose a semicolon-free ATOMIC_BIN_DIR to add Atomic to PATH\./u);
	const successOutput = source.indexOf('Write-Output "Installed to $shimPath"');
	assert.ok(successOutput >= 0, "success output does not start with the installed launcher path");
	const separatorBranch = source.indexOf("if ($binDirHasPathSeparator) {", successOutput);
	assert.ok(separatorBranch >= 0, "success output does not branch on the separator case");
	const pathUpdateBranch = source.indexOf("elseif ($UserPathAdded) {", separatorBranch);
	assert.ok(pathUpdateBranch > separatorBranch, "the User PATH line is not gated on an actual PATH change");
	assert.match(
		source.slice(pathUpdateBranch, source.indexOf("}", pathUpdateBranch)),
		/Write-Output "Added \$binDir to your User PATH; open a new terminal to use atomic\."/u,
	);
	assert.doesNotMatch(source, /Restart your terminal|installed successfully|Write-Output "Shim:/u);
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

test("Windows installer extracts PS7 and PS5.1 redirect response shapes in compatibility order", () => {
	const source = installerSource();
	const redirect = source.slice(
		source.indexOf("function Get-AtomicRedirectTag"),
		source.indexOf("function Invoke-AtomicApiRequest"),
	);
	const exceptionResponse = redirect.indexOf("$response = $_.Exception.Response");
	const typedLocation = redirect.indexOf("$response.Headers.Location");
	const tryGetValues = redirect.indexOf("TryGetValues", typedLocation);
	const getValues = redirect.indexOf("GetValues", tryGetValues + "TryGetValues".length);
	const stringIndexer = redirect.indexOf('$response.Headers["Location"]', getValues);
	const baseResponse = redirect.indexOf("$response.BaseResponse.ResponseUri.AbsoluteUri", stringIndexer);

	assert.ok(exceptionResponse >= 0, "redirect failures do not inspect Exception.Response");
	assert.ok(
		typedLocation >= 0 &&
			tryGetValues > typedLocation &&
			getValues > tryGetValues &&
			stringIndexer > getValues &&
			baseResponse > stringIndexer,
		"redirect locations are not extracted as typed, TryGetValues/GetValues, PS5 indexer, then BaseResponse",
	);
	assert.match(redirect, /\[Uri\]::UnescapeDataString\(\$Matches\[1\]\)/u);
	assert.equal(
		(redirect.match(/\[Uri\]::UnescapeDataString\(\$Matches\[1\]\)/gu) ?? []).length,
		1,
		"redirect tags are not decoded exactly once",
	);
	const laterEncode = source.indexOf("$encodedReleaseTag = [Uri]::EscapeDataString($releaseTag)");
	assert.ok(laterEncode > source.indexOf("$redirectTag = Get-AtomicRedirectTag"));
	assert.doesNotMatch(redirect, /-SkipHttpErrorCheck/u);
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

if (powershellEngines.length === 0) {
	test.skip("available PowerShell engines isolate literal IEX failure state", () => {});
}
for (const engine of powershellEngines) {
	test(`${engine.label} isolates literal IEX failure state`, () => {
		const workspace = mkdtempSync(join(tmpdir(), "atomic-ps-scope-"));
		const probePath = join(workspace, "scope-probe.ps1");
		const quotedInstallerPath = installerPath.replaceAll("'", "''");
		writeFileSync(
			probePath,
			[
				'$ErrorActionPreference = "Continue"',
				'$ProgressPreference = "Continue"',
				"Set-StrictMode -Off",
				'$Ref = "caller-ref"',
				'$Help = "caller-help"',
				'$helpText = "caller-help-text"',
				"$beforeTls = [Net.ServicePointManager]::SecurityProtocol",
				"$oldWow = $env:PROCESSOR_ARCHITEW6432",
				"$oldArch = $env:PROCESSOR_ARCHITECTURE",
				'$env:PROCESSOR_ARCHITEW6432 = "unsupported"',
				'$env:PROCESSOR_ARCHITECTURE = "unsupported"',
				`$source = [IO.File]::ReadAllText('${quotedInstallerPath}')`,
				'try { Invoke-Expression $source } catch { if ($_ -notmatch "Unsupported Windows processor architecture") { throw } }',
				"$env:PROCESSOR_ARCHITEW6432 = $oldWow",
				"$env:PROCESSOR_ARCHITECTURE = $oldArch",
				"$missingReadWorked = $true; try { $null = $AtomicInstallerMissingScopeProbe } catch { $missingReadWorked = $false }",
				'if ($ErrorActionPreference -ne "Continue" -or $ProgressPreference -ne "Continue" -or $Ref -ne "caller-ref" -or $Help -ne "caller-help" -or $helpText -ne "caller-help-text" -or -not $missingReadWorked -or [Net.ServicePointManager]::SecurityProtocol -ne $beforeTls) { throw "caller scope changed" }',
				'Write-Output "IEX_SCOPE_OK"',
			].join("\n"),
		);
		try {
			const result = spawnSyncCollect(
				[engine.executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", probePath],
				{ timeout: 30_000 },
			);
			assert.equal(result.exitCode, 0, `${result.stdout.toString()}${result.stderr.toString()}`);
			assert.match(result.stdout.toString(), /IEX_SCOPE_OK/u);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
}

const shimShadowProbeHarness = String.raw`
param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][string]$Workspace
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$binDir = Join-Path $Workspace "bin root"
$installRoot = Join-Path $Workspace "install root"
$originalPathExt = $env:PATHEXT
$env:ATOMIC_INSTALL_DIR = $installRoot
$env:ATOMIC_BIN_DIR = $binDir
$env:PROCESSOR_ARCHITEW6432 = "AMD64"
$env:PROCESSOR_ARCHITECTURE = "AMD64"
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $binDir "keep.txt") -Value "caller-data" -Encoding ASCII -NoNewline

try {
    foreach ($case in @(
        @{ PathExt = $null; Stale = "atomic.exe"; Kind = "File" },
        @{ PathExt = $null; Stale = "atomic.com"; Kind = "File" },
        @{ PathExt = $null; Stale = "atomic.bat"; Kind = "File" },
        @{ PathExt = $null; Stale = "ATOMIC.EXE"; Kind = "File" },
        @{ PathExt = $null; Stale = "atomic.exe"; Kind = "Directory" },
        @{ PathExt = ".WSF;.CMD;.EXE"; Stale = "atomic.wsf"; Kind = "File" }
    )) {
        $env:PATHEXT = $case.PathExt
        $stalePath = Join-Path $binDir $case.Stale
        if ($case.Kind -eq "Directory") {
            New-Item -ItemType Directory -Path $stalePath -Force | Out-Null
        }
        else {
            Set-Content -LiteralPath $stalePath -Value "stale launcher" -Encoding ASCII -NoNewline
        }
        $failure = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $failure = $_ }
        if ($null -eq $failure) { throw "$($case.Stale) ($($case.Kind)) was accepted" }
        if ($failure.Exception.Message -notmatch 'PATHEXT resolves before atomic\.cmd') {
            throw "$($case.Stale) failed for the wrong reason: $($failure.Exception.Message)"
        }
        if ($failure.Exception.Message -notmatch [regex]::Escape($case.Stale)) {
            throw "$($case.Stale) rejection did not name the shadowing launcher"
        }
        if (Test-Path -LiteralPath $installRoot) { throw "$($case.Stale) rejection created an install root" }
        if (Test-Path -LiteralPath (Join-Path $binDir "atomic.cmd")) { throw "$($case.Stale) rejection created a shim" }
        if ((Get-Content -LiteralPath (Join-Path $binDir "keep.txt") -Raw) -ne "caller-data") {
            throw "$($case.Stale) rejection mutated the bin directory"
        }
        if ($case.Kind -eq "File" -and (Get-Content -LiteralPath $stalePath -Raw) -ne "stale launcher") {
            throw "$($case.Stale) rejection replaced the pre-existing launcher"
        }
        Remove-Item -LiteralPath $stalePath -Recurse -Force
    }
    Write-Output "SHIM_SHADOW_OK"
}
finally {
    $env:PATHEXT = $originalPathExt
}
`;

if (powershellEngines.length === 0) {
	test.skip("available PowerShell engines refuse PATHEXT launchers that shadow the shim", () => {});
}
for (const engine of powershellEngines) {
	test(`${engine.label} refuses PATHEXT launchers that shadow the shim before any request`, () => {
		const workspace = mkdtempSync(join(tmpdir(), "atomic-ps-shadow-"));
		const probePath = join(workspace, "shim-shadow-probe.ps1");
		writeFileSync(probePath, shimShadowProbeHarness);
		try {
			const result = spawnSyncCollect(
				[
					engine.executable,
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					probePath,
					"-InstallerPath",
					installerPath,
					"-Workspace",
					workspace,
				],
				{ timeout: 60_000 },
			);
			assert.equal(result.exitCode, 0, `${result.stdout.toString()}${result.stderr.toString()}`);
			assert.match(result.stdout.toString(), /SHIM_SHADOW_OK/u);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
}

const preflightGuardProbeHarness = String.raw`
param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][string]$Workspace
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$originalPathExt = $env:PATHEXT
$env:PROCESSOR_ARCHITEW6432 = "AMD64"
$env:PROCESSOR_ARCHITECTURE = "AMD64"
$caseIndex = 0
$requestCount = 0

function Invoke-WebRequest {
    $script:requestCount++
    throw "unexpected network request"
}

function New-ProbeSpace {
    $script:caseIndex++
    $root = Join-Path $Workspace ("case-" + $script:caseIndex)
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $env:ATOMIC_INSTALL_DIR = Join-Path $root "install root"
    $env:ATOMIC_BIN_DIR = Join-Path $root "bin root"
    return $root
}

function Assert-Rejected {
    param([string]$Label, [string]$Pattern)
    $failure = $null
    try { & $InstallerPath @args | Out-Null }
    catch { $failure = $_ }
    if ($null -eq $failure) { throw "$Label was accepted" }
    if ($failure.Exception.Message -notmatch $Pattern) {
        throw "$Label failed for the wrong reason: $($failure.Exception.Message)"
    }
    if ($failure.Exception.Message -match 'variable') {
        throw "$Label surfaced an uninitialized-variable error: $($failure.Exception.Message)"
    }
    if (Test-Path -LiteralPath $env:ATOMIC_INSTALL_DIR) { throw "$Label created an install root" }
    return $failure
}

try {
    # Missing .CMD in an effective PATHEXT must fail before any request or mutation.
    $null = New-ProbeSpace
    $env:PATHEXT = ".EXE;.BAT"
    $missingCmd = Assert-Rejected "PATHEXT without .CMD" 'PATHEXT does not include \.CMD' -Ref "1.0.0"
    if ($missingCmd.Exception.Message -notmatch 'bare atomic') { throw "the missing-.CMD rejection did not name bare atomic" }
    if (Test-Path -LiteralPath $env:ATOMIC_BIN_DIR) { throw "the missing-.CMD rejection created a bin directory" }
    $env:PATHEXT = $null

    # Unsupported release tag grammar must fail before the tags API request.
    foreach ($invalidTag in @("v1.0.0", "1.0", "1.0.0.0", "1.0.0-alpha.0", "1.0.0-beta.1", "1.0.0-alpha", "01.0.0", "release/1.0", "hash#tag", "percent%tag", ("1.0.0" + [char]10), ("1.0.0-alpha.1" + [char]10))) {
        $null = New-ProbeSpace
        $null = Assert-Rejected "explicit ref $invalidTag" 'unsupported release tag: expected MAJOR\.MINOR\.PATCH or MAJOR\.MINOR\.PATCH-alpha\.REVISION' -Ref $invalidTag
    }
    $null = New-ProbeSpace
    $env:ATOMIC_VERSION = "not-a-tag"
    $null = Assert-Rejected "ATOMIC_VERSION not-a-tag" 'unsupported release tag'
    $env:ATOMIC_VERSION = $null


    # Junction aliases of current/versions must fail before requests or mutation.
    # Windows-only: Linux pwsh cannot create NTFS junctions, so the overlap
    # guard would miss and the fixture would hit the GitHub API stub.
    if ($env:OS -eq "Windows_NT") {
        $null = New-ProbeSpace
        New-Item -ItemType Directory -Path $env:ATOMIC_INSTALL_DIR -Force | Out-Null
        $aliasRoot = Join-Path (Split-Path $env:ATOMIC_INSTALL_DIR -Parent) "install-alias"
        New-Item -ItemType Junction -Path $aliasRoot -Target $env:ATOMIC_INSTALL_DIR | Out-Null
        $env:ATOMIC_BIN_DIR = Join-Path $aliasRoot "current"
        $requestStart = $script:requestCount
        $failure = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $failure = $_ }
        if ($null -eq $failure) { throw "junction alias current was accepted" }
        if ($failure.Exception.Message -notmatch 'ATOMIC_BIN_DIR cannot be inside ATOMIC_INSTALL_DIR\\current or ATOMIC_INSTALL_DIR\\versions') {
            throw "junction alias current failed for the wrong reason: $($failure.Exception.Message)"
        }
        if ($script:requestCount -ne $requestStart) { throw "junction alias current performed a request" }
        if (Test-Path -LiteralPath (Join-Path $env:ATOMIC_INSTALL_DIR "versions")) { throw "junction alias current created versions" }

        $null = New-ProbeSpace
        New-Item -ItemType Directory -Path $env:ATOMIC_INSTALL_DIR -Force | Out-Null
        $aliasRoot = Join-Path (Split-Path $env:ATOMIC_INSTALL_DIR -Parent) "install-alias"
        New-Item -ItemType Junction -Path $aliasRoot -Target $env:ATOMIC_INSTALL_DIR | Out-Null
        $physicalBin = Join-Path $env:ATOMIC_INSTALL_DIR "versions"
        $env:ATOMIC_INSTALL_DIR = $aliasRoot
        $env:ATOMIC_BIN_DIR = $physicalBin
        $requestStart = $script:requestCount
        $failure = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $failure = $_ }
        if ($null -eq $failure) { throw "physical versions under aliased install root was accepted" }
        if ($failure.Exception.Message -notmatch 'ATOMIC_BIN_DIR cannot be inside ATOMIC_INSTALL_DIR\\current or ATOMIC_INSTALL_DIR\\versions') {
            throw "physical versions under aliased install root failed for the wrong reason: $($failure.Exception.Message)"
        }
        if ($script:requestCount -ne $requestStart) { throw "physical versions under aliased install root performed a request" }
    }
    # Bin paths under installer-owned transaction paths must fail before requests or mutation.
    foreach ($binSuffix in @("current", "current\nested", "versions", "versions\1.0.0", "versions\1.2.3\bin")) {
        $null = New-ProbeSpace
        $env:ATOMIC_BIN_DIR = Join-Path $env:ATOMIC_INSTALL_DIR $binSuffix
        $requestStart = $script:requestCount
        $null = Assert-Rejected "bin path $binSuffix" 'ATOMIC_BIN_DIR cannot be inside ATOMIC_INSTALL_DIR\\current or ATOMIC_INSTALL_DIR\\versions' -Ref "1.0.0"
        if ($script:requestCount -ne $requestStart) { throw "bin path $binSuffix performed a request" }
        if (Test-Path -LiteralPath $env:ATOMIC_BIN_DIR) { throw "bin path $binSuffix was created" }
    }

    # A regular installRoot\current entry must be reported, never moved or deleted.
    foreach ($kind in @("Directory", "File")) {
        $null = New-ProbeSpace
        New-Item -ItemType Directory -Path $env:ATOMIC_INSTALL_DIR -Force | Out-Null
        $conflictPath = Join-Path $env:ATOMIC_INSTALL_DIR "current"
        if ($kind -eq "Directory") {
            New-Item -ItemType Directory -Path $conflictPath -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $conflictPath "marker.txt") -Value "caller-data" -NoNewline
        }
        else {
            Set-Content -LiteralPath $conflictPath -Value "caller-data" -NoNewline
        }
        $failure = $null
        try { & $InstallerPath -Ref "1.0.0" | Out-Null }
        catch { $failure = $_ }
        if ($null -eq $failure) { throw "a regular current $kind was accepted" }
        if ($failure.Exception.Message -notmatch 'ATOMIC_INSTALL_DIR contains an unexpected current entry') {
            throw "the regular current $kind failed for the wrong reason: $($failure.Exception.Message)"
        }
        $preserved = if ($kind -eq "Directory") { Get-Content -LiteralPath (Join-Path $conflictPath "marker.txt") -Raw } else { Get-Content -LiteralPath $conflictPath -Raw }
        if ($preserved -ne "caller-data") { throw "the regular current $kind lost caller data" }
        if (Test-Path -LiteralPath (Join-Path $env:ATOMIC_INSTALL_DIR "versions")) { throw "the regular current $kind rejection created versions" }
        if (Test-Path -LiteralPath $env:ATOMIC_BIN_DIR) { throw "the regular current $kind rejection created a bin directory" }
    }

    # A preflight blocker must surface its own message rather than a cleanup error.
    $null = New-ProbeSpace
    New-Item -ItemType Directory -Path $env:ATOMIC_BIN_DIR -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $env:ATOMIC_BIN_DIR "atomic.exe") -Value "stale launcher" -NoNewline
    $preflight = Assert-Rejected "stale same-stem launcher" 'PATHEXT resolves before atomic\.cmd' -Ref "1.0.0"
    if ($preflight.Exception.Message -cne "ATOMIC_BIN_DIR contains atomic.exe, which PATHEXT resolves before atomic.cmd; remove it and rerun the installer.") {
        throw "the preflight error text changed: $($preflight.Exception.Message)"
    }

    Write-Output "PREFLIGHT_GUARDS_OK"
}
finally {
    $env:PATHEXT = $originalPathExt
    $env:ATOMIC_VERSION = $null
}
`;

if (powershellEngines.length === 0) {
	test.skip("available PowerShell engines enforce every preflight guard before I/O", () => {});
}
// One real PowerShell child runs the full installer for 20 preflight cases
// (22 on Windows), including filesystem guards. Keep its existing 90s kill
// bound inside a named test budget rather than the shared 30s default.
const REAL_POWERSHELL_PREFLIGHT_TIMEOUT_MS = 120_000;
for (const engine of powershellEngines) {
	test(
		`${engine.label} enforces PATHEXT, tag grammar, and pointer guards before any request`,
		() => {
			const workspace = mkdtempSync(join(tmpdir(), "atomic-ps-preflight-"));
			const probePath = join(workspace, "preflight-guard-probe.ps1");
			writeFileSync(probePath, preflightGuardProbeHarness);
			try {
				const result = spawnSyncCollect(
					[
						engine.executable,
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						probePath,
						"-InstallerPath",
						installerPath,
						"-Workspace",
						workspace,
					],
					{ timeout: 90_000 },
				);
				assert.equal(result.exitCode, 0, `${result.stdout.toString()}${result.stderr.toString()}`);
				assert.match(result.stdout.toString(), /PREFLIGHT_GUARDS_OK/u);
			} finally {
				rmSync(workspace, { recursive: true, force: true });
			}
		},
		REAL_POWERSHELL_PREFLIGHT_TIMEOUT_MS,
	);
}

// One real PowerShell child runs the full installer through a dozen skip, repair and force cases against
// symbolic-link stand-ins for the junctions, so it only runs where the installer's native-path layout can
// be faked; Windows PowerShell 5.1 covers the real junction fixture scenarios below.
const REAL_POWERSHELL_SKIP_PROBE_TIMEOUT_MS = 120_000;
const skipProbeHarness = String.raw`
param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][string]$Workspace
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$env:PROCESSOR_ARCHITEW6432 = "AMD64"
$env:PROCESSOR_ARCHITECTURE = "AMD64"
$env:NO_COLOR = "1"
$env:ATOMIC_VERSION = $null
$env:ATOMIC_FORCE_INSTALL = $null
$env:GITHUB_TOKEN = $null
$env:GH_TOKEN = $null
$expectedShim = "@echo off" + [char]13 + [char]10 + '"%~dp0atomic-current\atomic.exe" %*' + [char]13 + [char]10 + "exit /b %ERRORLEVEL%" + [char]13 + [char]10

$global:caseIndex = 0
$global:latestTag = "2.0.0"
$global:requests = New-Object System.Collections.ArrayList
$global:installRoot = $null
$global:binDir = $null

function Invoke-WebRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Uri,
        [string]$OutFile,
        [hashtable]$Headers,
        [switch]$UseBasicParsing,
        [int]$MaximumRedirection
    )
    [void]$global:requests.Add($Uri)
    if ($Uri -eq "https://github.com/bastani-inc/atomic/releases/latest") {
        return [pscustomobject]@{
            Headers = @{ Location = "/bastani-inc/atomic/releases/tag/" + $global:latestTag }
            BaseResponse = [pscustomobject]@{ ResponseUri = [Uri]"https://github.com/bastani-inc/atomic/releases/latest" }
        }
    }
    if ($Uri -match '/repos/bastani-inc/atomic/releases/tags/([^/]+)$') {
        return [pscustomobject]@{ Content = ('{"tag_name":"' + [Uri]::UnescapeDataString($Matches[1]) + '"}'); Headers = @{} }
    }
    if ($Uri -match '/releases/download/') {
        throw "DOWNLOAD_ATTEMPTED:$Uri"
    }
    throw "Unexpected probe request: $Uri"
}

function Add-Type {
    [CmdletBinding()]
    param([string]$AssemblyName)
    throw "System.Net.Http is unavailable in this probe."
}

function New-Space {
    $global:caseIndex++
    $root = Join-Path $Workspace ("case-" + $global:caseIndex)
    $global:installRoot = Join-Path $root "install root"
    $global:binDir = Join-Path $root "bin root"
    $env:ATOMIC_INSTALL_DIR = $global:installRoot
    $env:ATOMIC_BIN_DIR = $global:binDir
    $env:ATOMIC_FORCE_INSTALL = $null
    $env:Path = $null
    $global:latestTag = "2.0.0"
}

function New-HealthyInstall {
    param([string]$Tag, [string]$BinDirectory = $global:binDir)
    $versionPath = Join-Path (Join-Path $global:installRoot "versions") $Tag
    New-Item -ItemType Directory -Path $versionPath, $BinDirectory -Force | Out-Null
    $executable = Join-Path $versionPath "atomic.exe"
    [IO.File]::WriteAllText($executable, "#!/bin/sh" + [char]10 + "echo $Tag" + [char]10)
    & chmod +x $executable
    foreach ($companionFile in @("package.json", "app.js", "native-modifiers.js", "native-module-path.js", "native-platform.js")) {
        [IO.File]::WriteAllText((Join-Path $versionPath $companionFile), "fixture " + $companionFile)
    }
    New-Item -ItemType Directory -Path (Join-Path $versionPath "builtin"), (Join-Path $versionPath "node_modules") -Force | Out-Null
    New-Item -ItemType SymbolicLink -Path (Join-Path $global:installRoot "current") -Target $versionPath | Out-Null
    New-Item -ItemType SymbolicLink -Path (Join-Path $BinDirectory "atomic-current") -Target $versionPath | Out-Null
    [IO.File]::WriteAllText((Join-Path $BinDirectory "atomic.cmd"), $expectedShim)
    return $versionPath
}

function Invoke-Installer {
    param([hashtable]$Parameters = @{})
    $global:requests.Clear()
    $failure = $null
    $text = ""
    try { $text = (& $InstallerPath @Parameters *>&1 | Out-String) }
    catch { $failure = $_ }
    $downloaded = $null -ne $failure -and $failure.Exception.Message -match 'DOWNLOAD_ATTEMPTED'
    if ($null -ne $failure -and -not $downloaded) { throw "installer failed unexpectedly: $($failure.Exception.Message)" }
    return [pscustomobject]@{ Text = $text; Downloaded = $downloaded }
}

function Assert-Probe {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Probe assertion failed: $Message" }
}

function Assert-Skipped {
    param($Result, [string]$Tag, [string]$Label)
    Assert-Probe (-not $Result.Downloaded) "$Label downloaded instead of skipping"
    Assert-Probe ($Result.Text -match ("atomic " + [regex]::Escape($Tag) + " is already installed; skipping download \(use -Force to reinstall\)")) "$Label did not print the skip message: $($Result.Text)"
    Assert-Probe ($Result.Text -match ('(?m)^Installed to ' + [regex]::Escape((Join-Path $global:binDir "atomic.cmd")) + '\s*$')) "$Label did not keep the Installed to line: $($Result.Text)"
    Assert-Probe ($Result.Text -match 'For more information visit') "$Label dropped the closing line"
    Assert-Probe ($Result.Text -notmatch 'Downloading|Verified SHA256') "$Label printed install progress"
    $artifactRequests = @($global:requests | Where-Object { $_ -match '/releases/download/|SHA256SUMS|\.zip$' })
    Assert-Probe ($artifactRequests.Count -eq 0) "$Label requested release artifacts: $($artifactRequests -join ', ')"
}

function Get-InstallSnapshot {
    $entries = @(Get-ChildItem -LiteralPath $global:installRoot -Recurse -Force | ForEach-Object { $_.FullName + "|" + $_.LastWriteTimeUtc.Ticks })
    $entries += @(Get-ChildItem -LiteralPath $global:binDir -Force | ForEach-Object { $_.FullName + "|" + $_.LastWriteTimeUtc.Ticks })
    return ($entries | Sort-Object) -join "|"
}

# Same requested version, healthy: skipped, state untouched, only the tag lookup is requested.
New-Space
$versionPath = New-HealthyInstall "1.0.0"
Set-Content -LiteralPath (Join-Path $versionPath "sentinel.txt") -Value "survives" -NoNewline
$before = Get-InstallSnapshot
$result = Invoke-Installer @{ Ref = "1.0.0" }
Assert-Skipped $result "1.0.0" "requested version"
Assert-Probe ($global:requests.Count -eq 0) "a healthy pinned rerun made a network request: $($global:requests -join ', ')"
Assert-Probe ((Get-InstallSnapshot) -ceq $before) "a skipped rerun changed the install"
Assert-Probe (Test-Path -LiteralPath (Join-Path $versionPath "sentinel.txt")) "a skipped rerun removed the version payload"
Assert-Probe ($env:Path -split [IO.Path]::PathSeparator -contains $global:binDir) "a skipped rerun did not repair the current session PATH"

# ATOMIC_VERSION behaves like -Ref.
$env:ATOMIC_VERSION = "1.0.0"
Assert-Skipped (Invoke-Installer) "1.0.0" "ATOMIC_VERSION"
$env:ATOMIC_VERSION = $null

# No version requested: the resolved latest release is compared, through the redirect and without the API.
New-Space
$null = New-HealthyInstall "2.0.0"
$result = Invoke-Installer
Assert-Skipped $result "2.0.0" "latest release"
Assert-Probe (@($global:requests | Where-Object { $_ -eq "https://github.com/bastani-inc/atomic/releases/latest" }).Count -eq 1) "the latest redirect was not resolved"
Assert-Probe (@($global:requests | Where-Object { $_ -match '^https://api\.github\.com/' }).Count -eq 0) "the latest skip queried the API"

# A newer latest than the installed version installs.
$global:latestTag = "2.1.0"
Assert-Probe ((Invoke-Installer).Downloaded) "a newer latest release did not download"
$global:latestTag = "2.0.0"

# A different requested version installs.
Assert-Probe ((Invoke-Installer @{ Ref = "1.0.0" }).Downloaded) "a different requested version did not download"

# -Force and ATOMIC_FORCE_INSTALL=1 reinstall a healthy install; other values do not force.
Assert-Probe ((Invoke-Installer @{ Ref = "2.0.0"; Force = $true }).Downloaded) "-Force did not reinstall"
$env:ATOMIC_FORCE_INSTALL = "1"
Assert-Probe ((Invoke-Installer @{ Ref = "2.0.0" }).Downloaded) "ATOMIC_FORCE_INSTALL=1 did not reinstall"
$env:ATOMIC_FORCE_INSTALL = "0"
Assert-Skipped (Invoke-Installer @{ Ref = "2.0.0" }) "2.0.0" "ATOMIC_FORCE_INSTALL=0"
$env:ATOMIC_FORCE_INSTALL = $null

# Every unhealthy shape of the same version is repaired by a download instead of skipped.
$brokenInstalls = @(
    @{ Label = "missing shim"; Break = { Remove-Item -LiteralPath (Join-Path $global:binDir "atomic.cmd") } },
    @{ Label = "shim with other content"; Break = { [IO.File]::WriteAllText((Join-Path $global:binDir "atomic.cmd"), "@echo off" + [char]13 + [char]10) } },
    @{ Label = "missing atomic-current"; Break = { Remove-Item -LiteralPath (Join-Path $global:binDir "atomic-current") } },
    @{ Label = "atomic-current aimed at another directory"; Break = {
        $pointer = Join-Path $global:binDir "atomic-current"
        $elsewhere = Join-Path $global:binDir "elsewhere"
        New-Item -ItemType Directory -Path $elsewhere | Out-Null
        Remove-Item -LiteralPath $pointer
        New-Item -ItemType SymbolicLink -Path $pointer -Target $elsewhere | Out-Null } },
    @{ Label = "missing current"; Break = { Remove-Item -LiteralPath (Join-Path $global:installRoot "current") } },
    @{ Label = "missing payload executable"; Break = { Remove-Item -LiteralPath (Join-Path (Join-Path $global:installRoot "current") "atomic.exe") } },
    @{ Label = "payload executable that fails"; Break = {
        $executable = Join-Path (Join-Path $global:installRoot "current") "atomic.exe"
        [IO.File]::WriteAllText($executable, "#!/bin/sh" + [char]10 + "exit 9" + [char]10) } },
    @{ Label = "missing package.json"; Break = { Remove-Item -LiteralPath (Join-Path (Join-Path $global:installRoot "current") "package.json") } },
    @{ Label = "missing app.js"; Break = { Remove-Item -LiteralPath (Join-Path (Join-Path $global:installRoot "current") "app.js") } },
    @{ Label = "missing native-modifiers.js"; Break = { Remove-Item -LiteralPath (Join-Path (Join-Path $global:installRoot "current") "native-modifiers.js") } },
    @{ Label = "missing native-module-path.js"; Break = { Remove-Item -LiteralPath (Join-Path (Join-Path $global:installRoot "current") "native-module-path.js") } },
    @{ Label = "missing native-platform.js"; Break = { Remove-Item -LiteralPath (Join-Path (Join-Path $global:installRoot "current") "native-platform.js") } },
    @{ Label = "missing builtin directory"; Break = { Remove-Item -LiteralPath (Join-Path (Join-Path $global:installRoot "current") "builtin") -Recurse } },
    @{ Label = "missing node_modules directory"; Break = { Remove-Item -LiteralPath (Join-Path (Join-Path $global:installRoot "current") "node_modules") -Recurse } },
    @{ Label = "current and atomic-current aimed at a foreign versions directory"; Break = {
        $foreignRoot = Join-Path (Join-Path $Workspace ("foreign-" + $global:caseIndex)) "versions"
        $foreignVersion = Join-Path $foreignRoot "1.0.0"
        New-Item -ItemType Directory -Path $foreignRoot -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path (Join-Path $global:installRoot "versions") "1.0.0") -Destination $foreignVersion -Recurse
        & chmod +x (Join-Path $foreignVersion "atomic.exe")
        foreach ($pointer in @((Join-Path $global:installRoot "current"), (Join-Path $global:binDir "atomic-current"))) {
            Remove-Item -LiteralPath $pointer
            New-Item -ItemType SymbolicLink -Path $pointer -Target $foreignVersion | Out-Null
        } } }
)
foreach ($broken in $brokenInstalls) {
    New-Space
    $null = New-HealthyInstall "1.0.0"
    & $broken.Break
    Assert-Probe ((Invoke-Installer @{ Ref = "1.0.0" }).Downloaded) ("an install with a " + $broken.Label + " was skipped")
}

# An install root reached through a link is the same physical directory, so a healthy install still skips.
New-Space
$linkedInstallRoot = $global:installRoot
$realInstallRoot = Join-Path (Split-Path $linkedInstallRoot -Parent) "real install root"
New-Item -ItemType Directory -Path $realInstallRoot -Force | Out-Null
New-Item -ItemType SymbolicLink -Path $linkedInstallRoot -Target $realInstallRoot | Out-Null
$null = New-HealthyInstall "1.0.0"
Assert-Skipped (Invoke-Installer @{ Ref = "1.0.0" }) "1.0.0" "install root reached through a link"

# A bin directory that cannot be one PATH entry still skips, prints direct-run guidance, and leaves PATH alone.
New-Space
$semicolonBin = Join-Path (Split-Path $global:binDir -Parent) "semi;bin"
$env:ATOMIC_BIN_DIR = $semicolonBin
$global:binDir = $semicolonBin
$null = New-HealthyInstall "1.0.0" $semicolonBin
$result = Invoke-Installer @{ Ref = "1.0.0" }
Assert-Skipped $result "1.0.0" "semicolon bin directory"
Assert-Probe ($result.Text -match 'cannot be represented as one Windows PATH entry') "the semicolon limitation was not reported"
Assert-Probe ($result.Text -match 'Run Atomic directly') "direct-run guidance was not printed"
Assert-Probe ($result.Text -notmatch 'to your User PATH') "a semicolon bin directory claimed a PATH update"
Assert-Probe ([string]::IsNullOrEmpty($env:Path)) "a semicolon bin directory changed the session PATH"

# -Help documents the escape hatch and never reaches the network.
$global:requests.Clear()
$help = (& $InstallerPath -Help *>&1 | Out-String)
Assert-Probe ($help -match 'install\.ps1 \[-Ref <tag>\] \[-Force\] \[-Help\]') "-Help usage omits -Force"
Assert-Probe ($help -match '-Force\s+Reinstall even when .*already installed') "-Help does not describe -Force"
Assert-Probe ($help -match 'ATOMIC_FORCE_INSTALL\s+Set to 1 to behave like -Force') "-Help does not describe ATOMIC_FORCE_INSTALL"
Assert-Probe ($global:requests.Count -eq 0) "-Help performed a request"

Write-Output "SKIP_PROBE_OK"
`;

const skipProbeTest = process.platform === "win32" ? test.skip : test;
if (powershellEngines.length === 0) {
	skipProbeTest.skip("available PowerShell engines skip the download for a healthy install", () => {});
}
for (const engine of powershellEngines) {
	skipProbeTest(
		`${engine.label} skips the download for a healthy install and repairs every unhealthy one`,
		() => {
			const workspace = mkdtempSync(join(tmpdir(), "atomic-ps-skip-"));
			const probePath = join(workspace, "skip-probe.ps1");
			writeFileSync(probePath, skipProbeHarness);
			try {
				const result = spawnSyncCollect(
					[
						engine.executable,
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						probePath,
						"-InstallerPath",
						installerPath,
						"-Workspace",
						workspace,
					],
					{ timeout: REAL_POWERSHELL_SKIP_PROBE_TIMEOUT_MS },
				);
				assert.equal(result.exitCode, 0, `${result.stdout.toString()}${result.stderr.toString()}`);
				assert.match(result.stdout.toString(), /SKIP_PROBE_OK/u);
			} finally {
				rmSync(workspace, { recursive: true, force: true });
			}
		},
		REAL_POWERSHELL_SKIP_PROBE_TIMEOUT_MS,
	);
}

function redirectFunctionSource(): string {
	const source = installerSource();
	return source.slice(
		source.indexOf("function Get-AtomicRedirectTag"),
		source.indexOf("function Invoke-AtomicApiRequest"),
	);
}

async function runRealRedirectFixture(engine: PowerShellEngine): Promise<void> {
	let apiRequests = 0;
	const server = createServer((request, response) => {
		response.setHeader("Connection", "close");
		if (request.url === "/latest") {
			response.writeHead(302, {
				Location: "/bastani-inc/atomic/releases/tag/release%2F1.0",
			});
			response.end();
			return;
		}
		if (request.url === "/api") {
			apiRequests += 1;
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end('{"tag_name":"fallback"}');
			return;
		}
		response.writeHead(200, { "Content-Type": "text/plain" });
		response.end("not a redirect");
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUri = `http://127.0.0.1:${address.port}`;
	const workspace = mkdtempSync(join(tmpdir(), "atomic-ps-redirect-"));
	const harnessPath = join(workspace, "redirect-fixture.ps1");
	const harness = String.raw`
param(
    [Parameter(Mandatory=$true)][string]$BaseUri,
    [Parameter(Mandatory=$true)][string]$Mode
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest
${redirectFunctionSource()}

function Invoke-WebRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Uri,
        [switch]$UseBasicParsing,
        [int]$MaximumRedirection
    )
    return [pscustomobject]@{
        StatusCode = 302
        Headers = [pscustomobject]@{ Location = [Uri]"/bastani-inc/atomic/releases/tag/returned%2Ftag" }
    }
}
$returnedTag = Get-AtomicRedirectTag "mock://returned-response"
Remove-Item -LiteralPath "Function:\Invoke-WebRequest" -Force
if ($returnedTag -cne "returned/tag") {
    throw "Returned 302 response did not yield its redirect tag: $returnedTag"
}
Write-Output ("RETURNED_REDIRECT_TAG:" + $returnedTag)


$redirectUri = if ($Mode -eq "success") { "$BaseUri/latest" } else { "$BaseUri/not-a-redirect" }
$tag = Get-AtomicRedirectTag $redirectUri
if ([string]::IsNullOrWhiteSpace($tag)) {
    Invoke-WebRequest -Uri "$BaseUri/api" -UseBasicParsing -ErrorAction Stop | Out-Null
    Write-Output "API_FALLBACK"
}
else {
    Write-Output ("REDIRECT_TAG:" + $tag)
}
`;
	writeFileSync(harnessPath, `\uFEFF${harness}`, "utf8");

	try {
		const commonArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath, "-BaseUri", baseUri];
		const success = await spawnCollectAsync(engine.executable, [...commonArgs, "-Mode", "success"], 20_000);
		assert.equal(
			success.exitCode,
			0,
			`${engine.label} real 302 fixture failed.\nstdout:\n${success.stdout}\nstderr:\n${success.stderr}`,
		);
		assert.match(success.stdout, /REDIRECT_TAG:release\/1\.0/u);
		assert.match(success.stdout, /RETURNED_REDIRECT_TAG:returned\/tag/u);
		assert.equal(apiRequests, 0, `${engine.label} queried the API after a successful real 302`);

		const fallback = await spawnCollectAsync(engine.executable, [...commonArgs, "-Mode", "fallback"], 20_000);
		assert.equal(
			fallback.exitCode,
			0,
			`${engine.label} redirect fallback fixture failed.\nstdout:\n${fallback.stdout}\nstderr:\n${fallback.stderr}`,
		);
		assert.match(fallback.stdout, /API_FALLBACK/u);
		assert.equal(apiRequests, 1, `${engine.label} did not make exactly one API fallback request`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(workspace, { recursive: true, force: true });
	}
}

if (powershellEngines.length === 0) {
	test.skip("available PowerShell engines extract tags from a real local HTTP 302 and fall back only on failure", () => {});
}
for (const engine of powershellEngines) {
	test(
		`${engine.label} extracts a tag from a real local HTTP 302 and falls back only on failure`,
		async () => runRealRedirectFixture(engine),
		45_000,
	);
}

test("Windows PowerShell 5.1 tag-grammar fixture rejects unsupported refs before any request", () => {
	for (const invalidTag of [
		"v1.0.0",
		"1.0",
		"1.0.0.0",
		"1.0.0-alpha.0",
		"1.0.0-beta.1",
		"1.0.0-alpha",
		"01.0.0",
		"release/1.0",
		"hash#tag",
		"percent%tag",
	]) {
		assert.ok(fixtureHarness.includes(`"${invalidTag}"`), `tag-grammar fixture is missing ${invalidTag}`);
	}
	assert.match(fixtureHarness, /explicit ref \$invalidTag performed a request/u);
	assert.match(fixtureHarness, /explicit ref \$invalidTag created an install root/u);
	assert.match(fixtureHarness, /ATOMIC_VERSION rejection performed a request/u);
	assert.match(fixtureHarness, /foreach \(\$validTag in @\("1\.0\.0", "1\.0\.0-alpha\.1"\)\)/u);
	assert.match(fixtureHarness, /an unsupported latest redirect tag still downloaded a release/u);
	assert.match(fixtureHarness, /an unsupported latest API tag_name still downloaded a release/u);
	assert.doesNotMatch(fixtureHarness, /Atomic \$tag installed successfully\./u);
});

test("Windows PowerShell 5.1 fixtures keep the archive download on the recorded Invoke-WebRequest fallback", () => {
	assert.match(fixtureHarness, /function global:Add-Type \{/u);
	assert.match(
		fixtureHarness,
		/if \(\$AssemblyName -eq "System\.Net\.Http"\) \{[\s\S]+throw "System\.Net\.Http is unavailable in this fixture scenario\."/u,
	);
	assert.match(fixtureHarness, /Microsoft\.PowerShell\.Utility\\Add-Type @PSBoundParameters/u);
	assert.ok(
		fixtureHarness.indexOf("function global:Add-Type {") > fixtureHarness.indexOf("-OutputType ConsoleApplication"),
		"the fixture executable must be compiled before Add-Type is shadowed",
	);
	assert.match(fixtureHarness, /the archive download did not attempt the HttpClient stream before falling back/u);
	assert.match(fixtureHarness, /first install did not report the installed launcher path/u);
	assert.match(fixtureHarness, /first install did not report the User PATH update/u);
	assert.match(fixtureHarness, /same-version rerun claimed a User PATH update although the entry already existed/u);
	assert.match(fixtureHarness, /a healthy same-version rerun still downloaded release assets/u);
	assert.match(fixtureHarness, /forced same-version reinstall was not clean/u);
	assert.match(fixtureHarness, /semicolon bin directory did not report the installed launcher path/u);
	assert.match(fixtureHarness, /\$installOutput -notmatch 'to your User PATH'/u);
});

test("Windows PowerShell 5.1 fixtures cover missing .CMD, pointer conflicts, and preserved preflight errors", () => {
	assert.match(fixtureHarness, /\$env:PATHEXT = "\.EXE;\.BAT"/u);
	assert.match(fixtureHarness, /the missing-\.CMD rejection performed a request/u);
	assert.match(fixtureHarness, /the missing-\.CMD rejection did not name bare atomic/u);
	for (const acceptedPathExt of ['".cmd;.EXE"', '".EXE;.CMD;.BAT"']) {
		assert.ok(fixtureHarness.includes(acceptedPathExt), `missing-cmd-pathext lacks the control ${acceptedPathExt}`);
	}
	assert.ok(
		fixtureHarness.includes(`'  " .CMD " ; ".EXE"  '`),
		"missing-cmd-pathext lacks the quoted-whitespace control",
	);

	for (const label of ["current directory", "current file", "atomic-current directory", "atomic-current file"]) {
		assert.ok(fixtureHarness.includes(`Label = "${label}"`), `pointer-conflicts lacks ${label}`);
	}
	assert.match(fixtureHarness, /marker data was not preserved/u);
	assert.match(fixtureHarness, /an installer-owned current junction was not replaced/u);

	assert.match(fixtureHarness, /the preflight error was replaced/u);
	assert.match(fixtureHarness, /the API error was replaced/u);
	assert.equal((fixtureHarness.match(/mentions an uninitialized variable/gu) ?? []).length, 2);
	assert.match(fixtureHarness, /\$env:PATHEXT = "\.COM;\.EXE;\.BAT;\.CMD;\.VBS;\.VBE;\.JS;\.JSE;\.WSF;\.WSH;\.MSC"/u);
});

powershellTest(
	"PowerShell 5.1 fixtures run concurrent PATH-mutating scenarios without racing or mutating host User PATH",
	async () => {
		assert.ok(powershellExecutable);
		const scenarios: readonly FixtureScenario[] = ["install", "final-smoke", "semicolon-bin", "skip-installed"];
		const runIds = scenarios.map(() => createIsolatedHkcuRunId());
		const before = readHostUserPathAndScratchPresence(powershellExecutable, runIds);
		await Promise.all(
			scenarios.map((scenario, index) => runPowerShellFixtureAsync(scenario, powershellExecutable, runIds[index])),
		);
		const after = readHostUserPathAndScratchPresence(powershellExecutable, runIds);
		assert.deepEqual(
			{ exists: after.exists, value: after.value, kind: after.kind },
			{ exists: before.exists, value: before.value, kind: before.kind },
			"concurrent PowerShell fixtures must not mutate the host user's real HKCU\\Environment\\Path",
		);
		assert.deepEqual(after.leftoverRunIds, [], "isolated HKCU scratch subkeys must be removed after exit");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture broadcasts WM_SETTINGCHANGE Environment when updating User PATH",
	() => {
		runPowerShellFixture("path-broadcast");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture installs exact refs for both architectures and is idempotent",
	() => {
		runPowerShellFixture("install");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture rejects unsupported release tags before archive download",
	() => {
		runPowerShellFixture("tag-grammar");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture rejects PATHEXT without .CMD before any request or mutation",
	() => {
		runPowerShellFixture("missing-cmd-pathext");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture refuses unexpected regular transaction pointers before any request",
	() => {
		runPowerShellFixture("pointer-conflicts");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture preserves preflight and API errors before transaction setup",
	() => {
		runPowerShellFixture("preflight-errors");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture rejects a checksum mismatch without mutating the old install",
	() => {
		runPowerShellFixture("checksum");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture preserves Unicode install paths and rolls back final smoke failure",
	() => {
		runPowerShellFixture("unicode");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture installs when Get-FileHash is unavailable",
	() => {
		runPowerShellFixture("hash-fallback");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture fails closed when an exact-tag response names a different release",
	() => {
		runPowerShellFixture("ref-identity");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture installs an exact tag while the GitHub API is rate limited and explains API failures",
	() => {
		runPowerShellFixture("api-rate-limit");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture never appends a semicolon-containing bin directory to PATH",
	() => {
		runPowerShellFixture("semicolon-bin");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture refuses same-stem launchers that PATHEXT resolves before the shim",
	() => {
		runPowerShellFixture("shadowed-shim");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture honors custom PATHEXT order when .CMD precedes .EXE",
	() => {
		runPowerShellFixture("custom-pathext");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture skips a healthy install, repairs the User PATH, and reinstalls unhealthy or forced ones",
	() => {
		runPowerShellFixture("skip-installed");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);
