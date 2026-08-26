import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
	assert.match(source, /function Get-AtomicFileSha256/u);
	assert.match(source, /Get-FileHash\s+-LiteralPath\s+\$Path\s+-Algorithm\s+SHA256/u);
	assert.match(source, /Get-AtomicFileSha256\s+\$archivePath/u);
	assert.match(source, /Expand-Archive\s+-LiteralPath\s+\$archivePath/u);
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
	assert.match(source, /\[Environment\]::SetEnvironmentVariable\("Path",\s*\$newUserPath,\s*"User"\)/u);
	assert.match(source, /&\s+\$stagedAtomic\s+"--version"[\s\S]*\$LASTEXITCODE/u);
	assert.match(source, /&\s+\$env:ComSpec\s+\/d\s+\/c\s+\$shimCommand[\s\S]*\$LASTEXITCODE/u);

	assert.match(source, /LOCALAPPDATA[\\/]atomic/u);
	assert.match(source, /Default bin directory:[^\r\n]*LOCALAPPDATA[\\/]atomic[\\/]bin/u);
	assert.match(source, /Restart your terminal/u);
	const unexpectedShim = source.indexOf("unexpected atomic.cmd directory");
	const unexpectedPointer = source.indexOf("unexpected atomic-current entry");
	const apiHeaders = source.indexOf('$apiHeaders = @{ Accept = "application/vnd.github+json" }');
	assert.ok(unexpectedShim >= 0 && unexpectedShim < apiHeaders);
	assert.ok(unexpectedPointer >= 0 && unexpectedPointer < apiHeaders);
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
		/PSIsContainer|Remove-Item|Move-Item/u,
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
		/Move-Item|Remove-Item|New-Item/u,
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
		"$tempCleanupRetryLimit = 5",
		"$tempCleanupRetryDelayMilliseconds = 125",
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
		source.includes("'^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-alpha\\.(?:[1-9][0-9]*))?$'"),
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
		/Move-Item|Remove-Item|New-Item/u,
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
		2,
		"both PATH mutations are not guarded by the separator check",
	);
	assert.match(source, /cannot be represented as one Windows PATH entry/u);
	assert.match(source, /Choose a semicolon-free ATOMIC_BIN_DIR to add Atomic to PATH\./u);
	const separatorBranch = source.indexOf("if ($binDirHasPathSeparator) {", source.indexOf('Write-Output "Shim:'));
	assert.ok(separatorBranch >= 0, "success output does not branch on the separator case");
	assert.ok(source.indexOf("Restart your terminal", separatorBranch) > separatorBranch);
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
	assert.match(source, /Get-AtomicDirectoryEntry\s+\$Transaction\.CurrentBackupPath/u);
	assert.doesNotMatch(source, /Test-Path\s+-LiteralPath\s+\$(?:currentPath|currentNextPath|currentBackupPath)\b/u);
});

test("Windows installer records move intent and idempotently rolls back from catch and finally before commit", () => {
	const source = installerSource();
	const rollbackStart = source.indexOf("function Invoke-AtomicTransactionRollback");
	const rollbackEnd = source.indexOf("function Remove-AtomicTransactionBackups", rollbackStart);
	assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart, "transaction rollback routine was not found");
	const rollback = source.slice(rollbackStart, rollbackEnd);
	const shimRollback = rollback.indexOf("ShimInstallIntended");
	const atomicCurrentRollback = rollback.indexOf("AtomicCurrentInstallIntended", shimRollback);
	const currentRollback = rollback.indexOf("CurrentInstallIntended", atomicCurrentRollback);
	const versionRollback = rollback.indexOf("VersionInstallIntended", currentRollback);
	assert.ok(
		shimRollback >= 0 &&
			atomicCurrentRollback > shimRollback &&
			currentRollback > atomicCurrentRollback &&
			versionRollback > currentRollback,
		"rollback is not ordered shim, atomic-current, current, then version",
	);
	assert.match(
		rollback,
		/Get-AtomicDirectoryEntry\s+\$Transaction\.(?:Shim|AtomicCurrent|Current|Version)BackupPath/u,
	);
	assert.doesNotMatch(rollback, /throw\s+\$_/u);
	assert.doesNotMatch(rollback, /\$Transaction\.RollbackCompleted\s*=\s*\$true/u);
	assert.match(rollback, /\$Transaction\.RollbackCompleted\s*=\s*-not\s+\$rollbackIncomplete/u);
	for (const intent of [
		"VersionBackupIntended",
		"VersionInstallIntended",
		"CurrentBackupIntended",
		"CurrentInstallIntended",
		"AtomicCurrentBackupIntended",
		"AtomicCurrentInstallIntended",
		"ShimBackupIntended",
		"ShimInstallIntended",
		"UserPathChangeIntended",
		"CurrentPathChangeIntended",
	]) {
		assert.match(rollback, new RegExp(`\\$Transaction\\.${intent}\\s*=\\s*\\$false`, "u"));
	}

	for (const intent of [
		"VersionBackupIntended",
		"VersionInstallIntended",
		"CurrentBackupIntended",
		"CurrentInstallIntended",
		"AtomicCurrentBackupIntended",
		"AtomicCurrentInstallIntended",
		"ShimBackupIntended",
		"ShimInstallIntended",
	]) {
		const intentAssignment = source.indexOf(`$transaction.${intent} = $true`);
		const move = source.indexOf("Move-Item", intentAssignment);
		assert.ok(intentAssignment >= 0 && move > intentAssignment, `${intent} is not recorded before its move`);
	}

	const finalSmoke = source.indexOf("Installed atomic.cmd --version failed");
	const commit = source.indexOf("$transactionCommitted = $true", finalSmoke);
	const committedCleanup = source.indexOf("Remove-AtomicTransactionBackups", commit);
	assert.ok(
		finalSmoke >= 0 && commit > finalSmoke && committedCleanup > commit,
		"transaction commits before final smoke succeeds",
	);
	const catchBlock = source.slice(
		source.indexOf("    catch {", finalSmoke),
		source.indexOf("    Write-Output", finalSmoke),
	);
	assert.match(catchBlock, /if \(-not \$transactionCommitted\)[\s\S]+Invoke-AtomicTransactionRollback/u);
	assert.equal((catchBlock.match(/Invoke-AtomicTransactionRollback/gu) ?? []).length, 1);
	const finalBlock = source.slice(source.indexOf("finally {"));
	assert.match(
		finalBlock,
		/if \(\$null -ne \$transaction -and -not \$transactionCommitted\)[\s\S]+Invoke-AtomicTransactionRollback/u,
	);
	assert.match(source, /\$rollbackRetryLimit\s*=\s*[2-9]/u);
	assert.match(
		finalBlock,
		/while \(\$rollbackAttempt -lt \$rollbackRetryLimit -and -not \$transaction\.RollbackCompleted\)/u,
	);
	assert.match(finalBlock, /Write-Warning.*rollback.*incomplete.*-WarningAction Continue/iu);
	const committedFinally = finalBlock.slice(
		finalBlock.indexOf("if ($null -ne $transaction -and $transactionCommitted)"),
		finalBlock.indexOf("if ($null -ne $shimNextPath"),
	);
	assert.match(committedFinally, /Remove-AtomicTransactionBackups/u);
	assert.doesNotMatch(committedFinally, /Invoke-AtomicTransactionRollback/u);
});

test("Windows installer cleans staged children before only snapshotted empty transaction-created parents", () => {
	const source = installerSource();
	const emptyDirectoryRemoval = source.slice(
		source.indexOf("function Remove-AtomicEmptyDirectory"),
		source.indexOf("function Add-AtomicMissingDirectoryPaths"),
	);
	assert.match(emptyDirectoryRemoval, /\[IO\.Directory\]::Delete\(\$item\.FullName,\s*\$false\)/u);
	assert.doesNotMatch(emptyDirectoryRemoval, /Remove-Item|-Recurse/u);

	const missingSnapshot = source.slice(
		source.indexOf("function Add-AtomicMissingDirectoryPaths"),
		source.indexOf("function Remove-AtomicCreatedEmptyDirectories"),
	);
	assert.match(missingSnapshot, /Get-AtomicDirectoryEntry\s+\$candidate/u);
	assert.match(missingSnapshot, /\$MissingPaths\.Add\(\$candidate\)/u);
	assert.match(source, /Add-AtomicMissingDirectoryPaths\s+\$transactionMissingDirectories\s+\$versionsDir/u);
	assert.match(source, /Add-AtomicMissingDirectoryPaths\s+\$transactionMissingDirectories\s+\$binDir/u);

	const createdCleanup = source.slice(
		source.indexOf("function Remove-AtomicCreatedEmptyDirectories"),
		source.indexOf("function Invoke-AtomicTransactionRollback"),
	);
	assert.match(createdCleanup, /Sort-Object[\s\S]+Descending/u);
	assert.match(createdCleanup, /Remove-AtomicEmptyDirectory/u);
	assert.doesNotMatch(createdCleanup, /Remove-Item|-Recurse/u);

	const cleanup = source.slice(source.indexOf("finally {"));
	const rollback = cleanup.indexOf("Invoke-AtomicTransactionRollback");
	const shimStageCleanup = cleanup.indexOf("$shimNextPath", rollback);
	const atomicJunctionStageCleanup = cleanup.indexOf("$atomicCurrentNextPath", shimStageCleanup);
	const currentJunctionStageCleanup = cleanup.indexOf("$currentNextPath", atomicJunctionStageCleanup);
	const versionStageCleanup = cleanup.indexOf("$versionStagePath", currentJunctionStageCleanup);
	const downloadCleanup = cleanup.indexOf("$tempDir", versionStageCleanup);
	const parentCleanup = cleanup.indexOf(
		"Remove-AtomicCreatedEmptyDirectories $transactionMissingDirectories",
		downloadCleanup,
	);
	assert.ok(
		rollback >= 0 &&
			shimStageCleanup > rollback &&
			atomicJunctionStageCleanup > shimStageCleanup &&
			currentJunctionStageCleanup > atomicJunctionStageCleanup &&
			versionStageCleanup > currentJunctionStageCleanup &&
			parentCleanup > downloadCleanup,
		"cleanup does not roll back and remove staged children/downloads before empty parent directories",
	);
	assert.doesNotMatch(source, /Remove-Item\s+-LiteralPath\s+\$(?:binDir|versionsDir|installRoot)\b/u);
});

test("Windows installer removes its temporary download directory with bounded verified retries", () => {
	const source = installerSource();
	const helperStart = source.indexOf("function Remove-AtomicTemporaryDirectory");
	assert.ok(helperStart >= 0, "the verified temporary-directory removal helper is missing");
	const helper = source.slice(helperStart, source.indexOf("function Remove-AtomicEmptyDirectory"));
	assert.ok(helper.length > 0, "the removal helper is not declared before Remove-AtomicEmptyDirectory");

	assert.match(helper, /\[string\]\$Path,\r?\n\s+\[int\]\$RetryLimit,\r?\n\s+\[int\]\$RetryDelayMilliseconds/u);
	assert.match(
		helper,
		/if \(\[string\]::IsNullOrWhiteSpace\(\$Path\) -or -not \[IO\.Directory\]::Exists\(\$Path\)\)/u,
	);
	assert.match(helper, /while \(\$attempt -lt \$RetryLimit\)/u);
	assert.doesNotMatch(helper, /while \(\$true\)|do \{/u, "the removal helper must not loop without a bound");
	assert.match(helper, /\[IO\.FileAttributes\]::ReadOnly/u);
	assert.match(helper, /\[IO\.File\]::SetAttributes\(/u);
	assert.match(helper, /Remove-Item -LiteralPath \$Path -Recurse -Force -ErrorAction Stop/u);
	assert.doesNotMatch(helper, /SilentlyContinue/u, "the removal helper must not suppress deletion failures");
	assert.match(helper, /\[IO\.Directory\]::Delete\(\$Path, \$true\)/u);
	assert.equal(
		(helper.match(/if \(-not \[IO\.Directory\]::Exists\(\$Path\)\) \{\r?\n\s+return\r?\n\s+\}/gu) ?? []).length,
		2,
		"the removal helper does not verify absence after both removal strategies",
	);
	assert.match(helper, /Start-Sleep -Milliseconds \(\$RetryDelayMilliseconds \* \$attempt\)/u);
	assert.match(
		helper,
		/throw "Failed to remove the temporary download directory \$\{Path\} after \$attempt attempts; last error: \$lastCleanupDetail"/u,
	);
	assert.doesNotMatch(helper, /Remove-Item -LiteralPath (?!\$Path\b)/u, "the helper removes a path it was not given");
	assert.doesNotMatch(helper, /\[IO\.Directory\]::Delete\((?!\$Path,)/u, "the helper deletes a path it was not given");

	assert.match(source, /\$tempCleanupRetryLimit = [2-9]\r?\n/u);
	assert.match(source, /\$tempCleanupRetryDelayMilliseconds = [1-9][0-9]*\r?\n/u);
	assert.match(source, /catch \{\r?\n\s+\$primaryError = \$_\r?\n\s+throw \$primaryError\r?\n\}/u);
	assert.doesNotMatch(source, /Remove-Item -LiteralPath \$tempDir/u, "the suppressed temp deletion is still present");

	const cleanup = source.slice(
		source.indexOf("finally {", source.indexOf('Write-Output "Atomic $releaseTag installed successfully."')),
	);
	assert.match(
		cleanup,
		/if \(\$null -ne \$tempDir -and \(Test-Path -LiteralPath \$tempDir\)\) \{\r?\n\s+try \{\r?\n\s+Remove-AtomicTemporaryDirectory \$tempDir \$tempCleanupRetryLimit \$tempCleanupRetryDelayMilliseconds\r?\n\s+\}\r?\n\s+catch \{\r?\n\s+\$tempCleanupError = \$_/u,
	);
	const tempCleanupCall = cleanup.indexOf("Remove-AtomicTemporaryDirectory $tempDir");
	const parentCleanup = cleanup.indexOf(
		"Remove-AtomicCreatedEmptyDirectories $transactionMissingDirectories",
		tempCleanupCall,
	);
	const deferredReport = cleanup.indexOf("if ($null -ne $tempCleanupError)", tempCleanupCall);
	assert.ok(
		tempCleanupCall >= 0 && parentCleanup > tempCleanupCall && deferredReport > parentCleanup,
		"the cleanup failure is surfaced before every later cleanup step completes",
	);
	assert.match(
		cleanup.slice(deferredReport),
		/if \(\$null -ne \$primaryError\) \{\r?\n\s+Write-Warning -Message "Temporary download directory cleanup remains incomplete: \$tempCleanupError" -WarningAction Continue\r?\n\s+\}\r?\n\s+else \{\r?\n\s+throw \$tempCleanupError/u,
	);
	for (const warning of source.matchAll(/^\s*Write-Warning[^\r\n]*$/gmu)) {
		assert.match(
			warning[0],
			/-WarningAction Continue/u,
			`warning can inherit a terminating preference: ${warning[0]}`,
		);
	}
});

interface PowerShellEngine {
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

const powershellEngines = findPowerShellEngines();
const powershellExecutable = powershellEngines.find(
	(engine) => process.platform === "win32" && engine.major === 5,
)?.executable;
const powershellTest = powershellExecutable === undefined ? test.skip : test;
const POWERSHELL_FIXTURE_TIMEOUT_MS = 120_000;
const TRANSACTION_FAILURE_FIXTURE_STRUCTURAL_TIMEOUT_MS = 240_000;
const ROLLBACK_RETRY_FIXTURE_STRUCTURAL_TIMEOUT_MS = 300_000;
const CTRL_C_FIXTURE_STRUCTURAL_TIMEOUT_MS = 360_000;
const TEMP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS = 180_000;

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
    foreach ($invalidTag in @("v1.0.0", "1.0", "1.0.0.0", "1.0.0-alpha.0", "1.0.0-beta.1", "1.0.0-alpha", "01.0.0", "release/1.0", "hash#tag", "percent%tag")) {
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
for (const engine of powershellEngines) {
	test(`${engine.label} enforces PATHEXT, tag grammar, and pointer guards before any request`, () => {
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
	});
}

interface AsyncProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

function spawnCollectAsync(command: string, args: string[], timeout: number): Promise<AsyncProcessResult> {
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
				reject(
					new Error(
						`PowerShell redirect fixture timed out.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
					),
				);
				return;
			}
			resolve(result);
		});
	});
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

function Get-TempResidueReport {
    param([string]$Root)
    $entries = @(Get-ChildItem -LiteralPath $Root -Filter "atomic-install-*" -Force)
    return [pscustomobject]@{
        Count = $entries.Count
        Paths = (($entries | ForEach-Object { $_.FullName }) -join '; ')
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

$global:AtomicFixtureAssetRoot = $assetRoot
$global:AtomicFixtureRequests = New-Object System.Collections.ArrayList
$global:AtomicFixtureBadChecksumTag = $null
$global:AtomicFixtureLastAssetName = $null
$global:AtomicFixtureFailApi = $false
$global:AtomicFixtureRedirectFails = $false
$global:AtomicFixtureRedirectTag = "2.0.0"
$global:AtomicFixtureLatestApiTag = "2.0.0"

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
            Headers = @{ Location = "/bastani-inc/atomic/releases/tag/" + $global:AtomicFixtureRedirectTag }
            BaseResponse = [pscustomobject]@{ ResponseUri = [Uri]"https://github.com/bastani-inc/atomic/releases/latest" }
        }
    }

    if ($Uri -match '^https://api\.github\.com/') {
        if ($global:AtomicFixtureFailApi) { throw "GitHub API is unavailable in this fixture scenario: $Uri" }
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

$global:AtomicFixturePayloadCopyCount = 0
$global:AtomicFixtureFailurePoint = $null
$global:AtomicFixtureRollbackFailurePoint = $null
$global:AtomicFixtureRollbackFailureDelivered = $false
$global:AtomicFixtureRollbackArmed = $false
$global:AtomicFixtureTempLockMode = $null
$global:AtomicFixtureTempLockPath = $null
$global:AtomicFixtureTempLockStream = $null
$global:AtomicFixtureTempRemovalAttempts = 0
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

function global:Move-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [Parameter(Mandatory=$true)][string]$Destination
    )

    $leafName = [IO.Path]::GetFileName($LiteralPath)
    $destinationLeaf = [IO.Path]::GetFileName($Destination)
    if ($global:AtomicFixtureFailurePoint -eq "current-move" -and
        $leafName -match '^\.current-[0-9a-f]{32}$') {
        throw "Injected transaction failure: current-move"
    }
    if ($global:AtomicFixtureFailurePoint -eq "atomic-current-move" -and
        $leafName -match '^\.atomic-current-[0-9a-f]{32}$') {
        throw "Injected transaction failure: atomic-current-move"
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

    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
    if (-not [string]::IsNullOrWhiteSpace($global:AtomicFixtureRollbackFailurePoint) -and
        $leafName -match '^\.atomic-[0-9a-f]{32}\.cmd$' -and $destinationLeaf -eq "atomic.cmd") {
        $global:AtomicFixtureRollbackArmed = $true
    }
}

$environmentNames = @(
    "ATOMIC_INSTALL_DIR", "ATOMIC_BIN_DIR", "ATOMIC_VERSION", "GITHUB_TOKEN", "GH_TOKEN",
    "PROCESSOR_ARCHITEW6432", "PROCESSOR_ARCHITECTURE", "TEMP", "TMP", "PATHEXT",
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
        & $InstallerPath -Ref "1.0.0" | Out-Null

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
        Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue

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
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
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
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
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

        Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
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

        foreach ($case in $caseSpecs) {
            $caseName = $case.State + "-" + $case.Move + "-" + $case.RollbackFailure
            $caseRoot = Join-Path $workspace ("ctrl-c-" + $caseName)
            $installContainer = Join-Path $caseRoot "created-install-parent"
            $binContainer = Join-Path $caseRoot "created-bin-parent"
            $installRoot = Join-Path $installContainer "install-root"
            $binDir = Join-Path $binContainer "bin-root"
            $caseTemp = Join-Path $caseRoot "temp"
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
                "-FinallyPath", $childFinallyPath
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
        Assert-Fixture ($installOutput -match "cannot be represented as one Windows PATH entry") "semicolon bin directory did not report the PATH limitation"
        Assert-Fixture ($installOutput -match 'Run Atomic directly') "semicolon bin directory did not print direct-run guidance"
        Assert-Fixture ($installOutput -notmatch 'Restart your terminal') "semicolon bin directory claimed a PATH update"
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

        Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
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

        Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue
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
    }
    else {
        throw "Unknown fixture scenario: $Scenario"
    }

    $finalResidue = Get-TempResidueReport $fixtureTemp
    Assert-Fixture ($finalResidue.Count -eq 0) "temporary installer directory was not cleaned: $($finalResidue.Paths)"
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

const ctrlCChildHarness = String.raw`
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
    [Parameter(Mandatory=$true)][string]$FinallyPath
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
function global:Move-Item {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [Parameter(Mandatory=$true)][string]$Destination
    )

    $sourceLeaf = [IO.Path]::GetFileName($LiteralPath)
    $destinationLeaf = [IO.Path]::GetFileName($Destination)
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

    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
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

try {
    & $InstallerPath -Ref "2.0.0" | Out-Null
    throw "Installer unexpectedly completed before Ctrl+C"
}
finally {
    [IO.File]::WriteAllText($ObservedProcessPath, [string]$env:Path, [Text.Encoding]::Unicode)
    [IO.File]::WriteAllText($FinallyPath, "CHILD_FINALLY", [Text.Encoding]::ASCII)
}
`;

// CREATE_NEW_CONSOLE isolates the child. The helper then attaches to that console, ignores
// Ctrl+C in only its own process, and broadcasts a kernel CTRL_C_EVENT to the attached
// console with GenerateConsoleCtrlEvent(..., 0). This is a real console event, not a
// PowerShell exception or a test-only production hook.
const ctrlCHelperSource = String.raw`
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

test("Windows PowerShell 5.1 fixtures enforce shim bytes, cmd execution, rollback, and failure cleanup", () => {
	assert.match(fixtureHarness, /安装-Δοκιμή/u);
	assert.match(fixtureHarness, /自訂-bin-Δ/u);
	assert.match(fixtureHarness, /\[Alias\("Type"\)\]/u);
	assert.match(fixtureHarness, /SupportsShouldProcess=\$true/u);
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
	assert.match(fixtureHarness, /fresh \$topology \$failurePoint failure left the install root/u);
	assert.match(fixtureHarness, /existing \$failurePoint failure recursed into the bin directory/u);
	assert.match(fixtureHarness, /existing \$failurePoint failure did not preserve the old version/u);
	assert.match(fixtureHarness, /existing \$failurePoint failure did not leave the old pair executable/u);
	assert.match(fixtureHarness, /Assert-NoTransactionResidue \$installRoot \$binDir/u);
	assert.match(
		fixtureHarness,
		/AtomicFixtureFailApi\s*=\s*\$true[\s\S]+successful stable redirect queried the GitHub API/u,
	);
	assert.match(fixtureHarness, /@\("separate", "bin-parent", "install-parent"\)/u);
	assert.match(fixtureHarness, /pre-existing-dangling-junction/u);
	assert.match(
		fixtureHarness,
		/"shim-remove", "shim-restore",[\s\S]+"atomic-current-remove", "atomic-current-restore",[\s\S]+"current-remove", "current-restore",[\s\S]+"version-remove", "version-restore"/u,
	);
	assert.match(fixtureHarness, /one-shot rollback failure was not delivered/u);
	assert.match(
		fixtureHarness,
		/did not restore User PATH on a later rollback attempt[\s\S]+did not restore current PATH on a later rollback attempt/u,
	);
	assert.match(
		fixtureHarness,
		/changed old payload bytes[\s\S]+restore current payload bytes[\s\S]+restore atomic-current payload bytes[\s\S]+restore old shim bytes/u,
	);
});

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

test("Windows PowerShell 5.1 Ctrl+C fixture uses a real isolated console event after actual moves", () => {
	assert.match(ctrlCHelperSource, /CREATE_NEW_CONSOLE/u);
	assert.match(ctrlCHelperSource, /AttachConsole\(process\.dwProcessId\)/u);
	assert.match(ctrlCHelperSource, /SetConsoleCtrlHandler\(null, true\)/u);
	assert.match(ctrlCHelperSource, /GenerateConsoleCtrlEvent\(CTRL_C_EVENT, 0\)/u);
	assert.match(ctrlCChildHarness, /Microsoft\.PowerShell\.Management\\Move-Item[\s\S]+WriteAllText\(\$ReadyPath/u);
	assert.match(ctrlCChildHarness, /while \(\$true\) \{ Start-Sleep -Milliseconds 200 \}/u);
	assert.match(ctrlCChildHarness, /finally[\s\S]+CHILD_FINALLY/u);
	assert.doesNotMatch(ctrlCChildHarness, /Injected transaction failure|throw "Ctrl\+C"/u);
	assert.match(ctrlCChildHarness, /Injected one-shot rollback removal failure/u);
	assert.match(ctrlCChildHarness, /Injected one-shot rollback restore failure/u);
	for (const [state, move, failure] of [
		["fresh", "version-install", "version-remove"],
		["fresh", "current-install", "current-remove"],
		["fresh", "atomic-current-install", "atomic-current-remove"],
		["fresh", "shim-install", "shim-remove"],
		["existing", "version-backup", "version-restore"],
		["existing", "version-install", "version-remove"],
		["existing", "current-backup", "current-restore"],
		["existing", "current-install", "current-remove"],
		["existing", "atomic-current-backup", "atomic-current-restore"],
		["existing", "atomic-current-install", "atomic-current-remove"],
		["existing", "shim-backup", "shim-restore"],
		["existing", "shim-install", "shim-remove"],
	] as const) {
		assert.ok(
			fixtureHarness.includes(`State = "${state}"; Move = "${move}"; RollbackFailure = "${failure}"`),
			`${state} ${move} does not pair real Ctrl+C with ${failure}`,
		);
	}
	assert.match(fixtureHarness, /"ROLLBACK_FAILURE:" \+ \$case\.RollbackFailure/u);
	assert.match(
		fixtureHarness,
		/changed old version bytes[\s\S]+changed old current bytes[\s\S]+changed old atomic-current bytes[\s\S]+changed old shim bytes/u,
	);
});

test("Windows PowerShell 5.1 temp-cleanup fixture proves bounded removal against real open handles", () => {
	assert.match(fixtureHarness, /function global:Remove-Item/u);
	assert.match(
		fixtureHarness,
		/\[IO\.File\]::Open\(\$lockPath, \[IO\.FileMode\]::Open, \[IO\.FileAccess\]::Read, \[IO\.FileShare\]::None\)/u,
	);
	assert.match(fixtureHarness, /Microsoft\.PowerShell\.Management\\Remove-Item -LiteralPath \$LiteralPath/u);
	assert.match(
		fixtureHarness,
		/\$global:AtomicFixtureTempLockMode -eq "one-shot" -and\r?\n\s+\$global:AtomicFixtureTempRemovalAttempts -ge 2/u,
	);
	assert.match(fixtureHarness, /function Get-TempResidueReport/u);

	const scenario = fixtureHarness.slice(
		fixtureHarness.indexOf('elseif ($Scenario -eq "temp-cleanup")'),
		fixtureHarness.indexOf('throw "Unknown fixture scenario'),
	);
	assert.ok(scenario.length > 0, "the temp-cleanup fixture scenario is missing");
	assert.doesNotMatch(scenario, /Start-Sleep/u, "the deterministic probe must not wait on wall-clock time");
	assert.match(scenario, /GetTempPath\(\) resolved to \$resolvedTempRoot instead of the isolated case temp root/u);
	assert.match(scenario, /a real one-shot open handle did not force a verified cleanup retry/u);
	assert.match(scenario, /an exhausted temp cleanup reported success/u);
	assert.match(scenario, /the exhausted cleanup did not name the exact temporary path/u);
	assert.match(scenario, /the exhausted cleanup did not report its attempt count/u);
	assert.match(scenario, /the exhausted cleanup did not report the last error/u);
	assert.match(scenario, /the exhausted cleanup discarded a completed install/u);
	assert.match(scenario, /a failing temp cleanup replaced the primary installer error/u);
	assert.match(scenario, /the deferred cleanup failure was not warned exactly once/u);
	assert.match(scenario, /a failing temp cleanup blocked rollback of the fresh install root/u);
	assert.match(scenario, /a failing temp cleanup blocked removal of the transaction-created bin directory/u);
	assert.match(scenario, /installing \$stressTag left temp residue/u);
	assert.match(scenario, /a rolled-back install left temp residue/u);
	assert.match(fixtureHarness, /temporary installer directory was not cleaned: \$\(\$finalResidue\.Paths\)/u);
	assert.match(
		fixtureHarness,
		/the missing-\.CMD rejection created transaction temp state: \$\(\$rejectionResidue\.Paths\)/u,
	);
});

function runPowerShellFixture(
	scenario:
		| "install"
		| "tag-grammar"
		| "missing-cmd-pathext"
		| "pointer-conflicts"
		| "preflight-errors"
		| "checksum"
		| "final-smoke"
		| "unicode"
		| "dangling-junction"
		| "rollback-retries"
		| "transaction-failures"
		| "ctrl-c"
		| "hash-fallback"
		| "ref-identity"
		| "semicolon-bin"
		| "shadowed-shim"
		| "custom-pathext"
		| "temp-cleanup",
): string {
	assert.ok(powershellExecutable);
	const workspace = mkdtempSync(join(tmpdir(), `atomic-ps-fixture-${scenario}-`));
	const harnessPath = join(workspace, "fixture.ps1");
	if (scenario === "ctrl-c") {
		writeFileSync(join(workspace, "ctrl-c-child.ps1"), `\uFEFF${ctrlCChildHarness}`, "utf16le");
		writeFileSync(join(workspace, "ctrl-c-helper.cs"), ctrlCHelperSource, "utf8");
	}
	writeFileSync(harnessPath, `\uFEFF${fixtureHarness}`, "utf16le");
	try {
		const fixtureTimeout =
			scenario === "ctrl-c"
				? CTRL_C_FIXTURE_STRUCTURAL_TIMEOUT_MS
				: scenario === "rollback-retries"
					? ROLLBACK_RETRY_FIXTURE_STRUCTURAL_TIMEOUT_MS
					: scenario === "transaction-failures"
						? TRANSACTION_FAILURE_FIXTURE_STRUCTURAL_TIMEOUT_MS
						: scenario === "temp-cleanup"
							? TEMP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS
							: POWERSHELL_FIXTURE_TIMEOUT_MS;
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
			{ timeout: fixtureTimeout },
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

powershellTest("PowerShell 5.1 fixture rejects unsupported release tags before archive download", () => {
	runPowerShellFixture("tag-grammar");
});

powershellTest("PowerShell 5.1 fixture rejects PATHEXT without .CMD before any request or mutation", () => {
	runPowerShellFixture("missing-cmd-pathext");
});

powershellTest("PowerShell 5.1 fixture refuses unexpected regular transaction pointers before any request", () => {
	runPowerShellFixture("pointer-conflicts");
});

powershellTest("PowerShell 5.1 fixture preserves preflight and API errors before transaction setup", () => {
	runPowerShellFixture("preflight-errors");
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
	"PowerShell 5.1 fixture retries one-shot rollback removal and restore failures for every installed resource",
	() => {
		runPowerShellFixture("rollback-retries");
	},
	ROLLBACK_RETRY_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture retries one-shot rollback failures after every applicable real console Ctrl+C move",
	() => {
		runPowerShellFixture("ctrl-c");
	},
	CTRL_C_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture rolls back fresh and existing installs at every staged transaction failure",
	() => {
		runPowerShellFixture("transaction-failures");
	},
	TRANSACTION_FAILURE_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);

powershellTest("PowerShell 5.1 fixture installs when Get-FileHash is unavailable", () => {
	runPowerShellFixture("hash-fallback");
});
powershellTest("PowerShell 5.1 fixture fails closed when an exact-tag response names a different release", () => {
	runPowerShellFixture("ref-identity");
});

powershellTest("PowerShell 5.1 fixture never appends a semicolon-containing bin directory to PATH", () => {
	runPowerShellFixture("semicolon-bin");
});

powershellTest("PowerShell 5.1 fixture refuses same-stem launchers that PATHEXT resolves before the shim", () => {
	runPowerShellFixture("shadowed-shim");
});

powershellTest("PowerShell 5.1 fixture honors custom PATHEXT order when .CMD precedes .EXE", () => {
	runPowerShellFixture("custom-pathext");
});

powershellTest(
	"PowerShell 5.1 fixture removes every temporary download directory against real open handles",
	() => {
		runPowerShellFixture("temp-cleanup");
	},
	TEMP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);
