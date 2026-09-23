import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

async function installers(): Promise<{ shell: string; powershell: string }> {
	const [shell, powershell] = await Promise.all([readText(`${root}/install.sh`), readText(`${root}/install.ps1`)]);
	return { shell, powershell };
}

test("POSIX path conflicts and unexpected launcher directories fail before I/O", async () => {
	const { shell } = await installers();
	assert.equal(shell.match(/pwd -P/gu)?.length, 1);
	assert.match(shell, /INSTALL_ROOT=\$\(normalize_absolute_path "\$INSTALL_ROOT" && printf '_'\)/u);
	assert.match(shell, /BIN_DIR=\$\(normalize_absolute_path "\$BIN_DIR" && printf '_'\)/u);
	assert.match(shell, /BIN_PATH=\$BIN_DIR\/atomic/u);
	assert.match(shell, /reject_dangling_symlink_path\(\) \{/u);
	assert.match(shell, /\[ -L "\$dangling_probe" \] && \[ ! -d "\$dangling_probe" \]/u);
	assert.match(shell, /reject_dangling_symlink_path "\$INSTALL_ROOT" ATOMIC_INSTALL_DIR/u);
	assert.match(shell, /reject_dangling_symlink_path "\$BIN_DIR" ATOMIC_BIN_DIR/u);
	assert.match(shell, /canonical_physical=\$\(CDPATH= cd -P "\$canonical_probe"[^\n]+&& pwd && printf '_'\)/u);
	assert.match(shell, /PHYSICAL_INSTALL_ROOT=\$\(canonicalize_existing_prefix "\$INSTALL_ROOT" && printf '_'\)/u);
	assert.match(shell, /PHYSICAL_BIN_PATH=\$\(canonicalize_existing_prefix "\$BIN_PATH" && printf '_'\)/u);
	assert.match(shell, /case \$PHYSICAL_INSTALL_ROOT\/ in[\s\S]+"\$PHYSICAL_BIN_PATH\/"\*/u);
	assert.match(shell, /\[ -d "\$BIN_PATH" \] && \[ ! -L "\$BIN_PATH" \]/u);
	for (const message of [
		"ATOMIC_INSTALL_DIR cannot equal ATOMIC_BIN_DIR/atomic",
		"ATOMIC_BIN_DIR/atomic is an unexpected directory",
		"ATOMIC_BIN_DIR cannot be inside ATOMIC_INSTALL_DIR/$owned_child",
	]) {
		const failure = shell.indexOf(message);
		assert.ok(failure >= 0);
		assert.ok(failure < shell.indexOf("for required_command"));
		assert.ok(failure < shell.indexOf("TEMP_BASE="));
		assert.ok(failure < shell.indexOf("if ! RELEASE_JSON=$(http_get"));
	}
});

test("POSIX bin paths under transaction-owned install paths fail before any request or mutation", async () => {
	const { shell } = await installers();
	assert.match(shell, /for owned_child in current versions; do/u);
	assert.match(shell, /for owned_root in "\$INSTALL_ROOT" "\$PHYSICAL_INSTALL_ROOT"; do/u);
	assert.match(shell, /for owned_candidate in "\$BIN_PATH" "\$PHYSICAL_BIN_PATH"; do/u);
	assert.match(shell, /\/\) owned_path=\/\$owned_child ;;/u);
	assert.match(shell, /"\$owned_path"\|"\$owned_path"\/\*\)/u);
	assert.match(shell, /the installer replaces that path: \$BIN_DIR/u);
	const danglingInstallPreflight = shell.indexOf('reject_dangling_symlink_path "$INSTALL_ROOT" ATOMIC_INSTALL_DIR');
	const danglingBinPreflight = shell.indexOf('reject_dangling_symlink_path "$BIN_DIR" ATOMIC_BIN_DIR');
	assert.ok(danglingInstallPreflight >= 0 && danglingBinPreflight > danglingInstallPreflight);

	const preflight = shell.indexOf("for owned_child in current versions; do");
	assert.ok(preflight >= 0);
	for (const boundary of [
		"for required_command",
		"TEMP_BASE=",
		"if ! RELEASE_JSON=$(http_get",
		"resolve_redirect_tag",
		'if ! download_archive "$RELEASE_BASE/$ASSET_NAME"',
		'mkdir -p "$INSTALL_ROOT"',
	]) {
		const boundaryIndex = shell.indexOf(boundary);
		assert.ok(boundaryIndex >= 0, boundary);
		assert.ok(
			danglingInstallPreflight < boundaryIndex,
			`the install-root dangling-symlink preflight runs after: ${boundary}`,
		);
		assert.ok(
			danglingBinPreflight < boundaryIndex,
			`the bin-root dangling-symlink preflight runs after: ${boundary}`,
		);
		assert.ok(preflight < boundaryIndex, `the transaction-owned preflight runs after: ${boundary}`);
	}
});

test("POSIX owner-only modes cover temporary state only and both checksum row formats are accepted", async () => {
	const { shell } = await installers();
	assert.match(shell, /ORIGINAL_UMASK=\$\(umask\)\numask 077\n/u);
	assert.match(shell, /umask "\$ORIGINAL_UMASK"\nmkdir "\$EXTRACT_ROOT"/u);
	const tighten = shell.indexOf("umask 077");
	const restore = shell.indexOf('umask "$ORIGINAL_UMASK"');
	assert.ok(tighten >= 0 && tighten < shell.indexOf("TEMP_BASE="), "the temp directory is created before umask 077");
	assert.ok(restore > tighten);
	assert.ok(
		restore > shell.indexOf('chmod 600 "$API_AUTH_PATH"'),
		"the API token file is protected before the umask is restored",
	);
	assert.ok(
		restore < shell.indexOf('tar -xzf "$ARCHIVE_PATH"'),
		"the payload is extracted before the umask is restored",
	);
	assert.ok(
		restore < shell.indexOf('mkdir -p "$INSTALL_ROOT"'),
		"the install root is created before the umask is restored",
	);
	assert.ok(
		restore < shell.indexOf('mkdir -p "$BIN_DIR"'),
		"the bin directory is created before the umask is restored",
	);
	assert.match(shell, /\\\*\*\) checksum_name=\$\{checksum_name#\\\*\} ;;/u);
});

test("POSIX container installer keeps bind-mounted fixture trees host-owned", async () => {
	const smoke = await readText(`${root}/scripts/test-installers-containers.sh`);
	assert.match(smoke, /docker run --rm \\\n\s+--user "\$\(id -u\):\$\(id -g\)" \\\n/u);
	assert.match(smoke, /printf '%s \*%s\\n' "\$archive_hash" "\$asset"/u);
});

test("Windows bin paths under transaction-owned install paths fail before any request or mutation", async () => {
	const { powershell } = await installers();
	assert.match(
		powershell,
		/\$ownedInstallPaths = @\([\s\S]+Join-Path \$installRoot "current"[\s\S]+Join-Path \$installRoot "versions"/u,
	);
	assert.match(powershell, /\$binCandidate -ieq \$ownedInstallPath/u);
	assert.match(
		powershell,
		/\$binCandidate\.StartsWith\(\$ownedInstallPrefix, \[StringComparison\]::OrdinalIgnoreCase\)/u,
	);
	assert.match(powershell, /function Get-AtomicPhysicalPath/u);
	assert.match(powershell, /function Get-AtomicReparseTarget/u);
	assert.match(powershell, /\$physicalInstallRoot = Get-AtomicPhysicalPath \$installRoot/u);
	assert.match(powershell, /\$physicalBinDir = Get-AtomicPhysicalPath \$binDir/u);
	assert.match(powershell, /\$binCandidates = @\(\$binDir, \$physicalBinDir\)/u);
	assert.match(powershell, /Join-Path \$physicalInstallRoot "current"/u);
	assert.match(powershell, /Join-Path \$physicalInstallRoot "versions"/u);
	assert.match(powershell, /\[IO\.FileAttributes\]::ReparsePoint/u);
	const preflight = powershell.indexOf(
		"ATOMIC_BIN_DIR cannot be inside ATOMIC_INSTALL_DIR\\current or ATOMIC_INSTALL_DIR\\versions",
	);
	assert.ok(preflight >= 0);
	const tlsCapture = powershell.indexOf("$previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol");
	const tlsEnable = powershell.indexOf(
		"[Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
	);
	assert.ok(tlsCapture >= 0 && tlsEnable > tlsCapture, "the Windows TLS assignment is missing or malformed");
	assert.ok(preflight < tlsCapture, "the Windows transaction-owned preflight runs after TLS state is captured");
	assert.ok(preflight < tlsEnable, "the Windows transaction-owned preflight runs after TLS is assigned");
	for (const boundary of [
		'$apiHeaders = @{ Accept = "application/vnd.github+json" }',
		'$redirectTag = Get-AtomicRedirectTag "https://github.com',
		"New-Item -ItemType Directory -Path $tempDir",
		'Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath',
	]) {
		const boundaryIndex = powershell.indexOf(boundary);
		assert.ok(boundaryIndex >= 0, boundary);
		assert.ok(preflight < boundaryIndex, `the Windows transaction-owned preflight runs after: ${boundary}`);
	}
	assert.doesNotMatch(
		powershell.slice(powershell.indexOf("$ownedInstallPaths = @("), powershell.indexOf("$apiHeaders = @{")),
		/Move-Item|Remove-Item|New-Item/u,
		"the Windows transaction-owned preflight must not mutate caller paths",
	);
});

test("Windows same-stem PATHEXT launchers are rejected before any request", async () => {
	const { powershell } = await installers();
	assert.match(powershell, /function Get-AtomicShimShadowingExtensions/u);
	assert.match(powershell, /\$pathExtValue = \$env:PATHEXT/u);
	assert.match(
		powershell,
		/if \(\[string\]::IsNullOrWhiteSpace\(\$pathExtValue\)\) \{[\s\S]+\$pathExtValue = "\.COM;/u,
	);
	assert.doesNotMatch(powershell, /foreach \(\$pathExtValue in @\(\$env:PATHEXT,/u);
	assert.match(powershell, /foreach \(\$pathExtEntry in \(\$pathExtValue -split ';'\)/u);
	assert.match(powershell, /if \(\$extension -eq "\.CMD"\) \{\r?\n\s+\$cmdSeen = \$true\r?\n\s+break/u);
	assert.match(powershell, /which PATHEXT resolves before atomic\.cmd; remove it and rerun the installer\./u);

	const preflight = powershell.indexOf("foreach ($shadowingExtension in @(Get-AtomicShimShadowingExtensions))");
	assert.ok(preflight >= 0);
	for (const boundary of [
		'$apiHeaders = @{ Accept = "application/vnd.github+json" }',
		'$redirectTag = Get-AtomicRedirectTag "https://github.com',
		"New-Item -ItemType Directory -Path $tempDir",
		'Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath',
	]) {
		const boundaryIndex = powershell.indexOf(boundary);
		assert.ok(boundaryIndex >= 0, boundary);
		assert.ok(preflight < boundaryIndex, `the Windows shadowing preflight runs after: ${boundary}`);
	}
});

test("Windows safety and version checks all precede temp creation and archive downloads", async () => {
	const { shell, powershell } = await installers();

	const outerTry = powershell.indexOf("$previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol");
	assert.ok(outerTry >= 0);
	for (const declaration of ["$transaction = $null", "$transactionCommitted = $false", "$tempDir = $null"]) {
		const declarationIndex = powershell.indexOf(declaration);
		assert.ok(declarationIndex >= 0, declaration);
		assert.ok(declarationIndex < outerTry, `cleanup state ${declaration} is initialized after the outer try`);
	}
	assert.match(powershell, /if \(\$null -ne \$tempDir -and \(Test-Path -LiteralPath \$tempDir\)\)/u);

	const currentGuard = powershell.indexOf("ATOMIC_INSTALL_DIR contains an unexpected current entry");
	const atomicCurrentGuard = powershell.indexOf("ATOMIC_BIN_DIR contains an unexpected atomic-current entry");
	const missingCmdGuard = powershell.indexOf("PATHEXT does not include .CMD");
	const requestedTagGuard = powershell.indexOf("(Test-AtomicReleaseTag $requestedRef)");
	const resolvedTagGuard = powershell.indexOf("if (-not (Test-AtomicReleaseTag $releaseTag))");
	for (const [name, index] of [
		["current-pointer guard", currentGuard],
		["atomic-current guard", atomicCurrentGuard],
		["missing-.CMD guard", missingCmdGuard],
		["requested-tag grammar", requestedTagGuard],
		["resolved-tag grammar", resolvedTagGuard],
	] as const) {
		assert.ok(index >= 0, `${name} is missing`);
	}

	const apiHeaders = powershell.indexOf('$apiHeaders = @{ Accept = "application/vnd.github+json" }');
	const apiRequest = powershell.indexOf("Invoke-AtomicApiRequest $latestApi");
	const releaseBase = powershell.indexOf("$releaseBase = ");
	const tempCreation = powershell.indexOf("New-Item -ItemType Directory -Path $tempDir");
	const archiveDownload = powershell.indexOf('Invoke-AtomicDownload "$releaseBase/$assetName" $archivePath');
	assert.ok(currentGuard < apiHeaders, "the current-pointer guard runs after the API headers");
	assert.ok(atomicCurrentGuard < apiHeaders, "the atomic-current guard runs after the API headers");
	assert.ok(missingCmdGuard < apiHeaders, "the missing-.CMD guard runs after the API headers");
	assert.ok(requestedTagGuard < apiRequest, "the requested-tag grammar check runs after the API request");
	assert.ok(requestedTagGuard < apiHeaders, "the requested-tag grammar check runs after the API headers");
	assert.ok(resolvedTagGuard < releaseBase, "the resolved-tag grammar check runs after the download base");
	for (const guard of [currentGuard, atomicCurrentGuard, missingCmdGuard, requestedTagGuard, resolvedTagGuard]) {
		assert.ok(guard < tempCreation, "a preflight guard runs after the temp directory is created");
		assert.ok(guard < archiveDownload, "a preflight guard runs after the archive download");
	}

	assert.doesNotMatch(
		powershell.slice(powershell.indexOf("$existingShimItem = Get-AtomicDirectoryEntry $shimPath"), apiHeaders),
		/Move-Item|Remove-Item|New-Item/u,
		"the Windows pointer preflight must not move or delete caller entries",
	);

	assert.ok(
		powershell.includes("'^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-alpha\\.(?:[1-9][0-9]*))?$'"),
		"the Windows tag grammar does not mirror install.sh",
	);
	assert.match(shell, /MAJOR\.MINOR\.PATCH or MAJOR\.MINOR\.PATCH-alpha\.REVISION/u);
	assert.match(
		powershell,
		/unsupported release tag: expected MAJOR\.MINOR\.PATCH or MAJOR\.MINOR\.PATCH-alpha\.REVISION/u,
	);
});

test("POSIX release identities stay within Atomic's supported tag grammar", async () => {
	const { shell } = await installers();
	assert.match(shell, /is_atomic_release_tag/u);
	assert.match(shell, /MAJOR\.MINOR\.PATCH or MAJOR\.MINOR\.PATCH-alpha\.REVISION/u);
	assert.doesNotMatch(shell, /\bawk\b/u);
	assert.match(shell, /REQUESTED_REF_ENCODED=\$\(percent_encode "\$REQUESTED_REF"\)/u);
	assert.match(shell, /API_URL=\$TAGS_API\/\$REQUESTED_REF_ENCODED/u);
	assert.match(shell, /RELEASE_TAG_ENCODED=\$\(percent_encode "\$RELEASE_TAG"\)/u);
	assert.match(shell, /releases\/download\/\$RELEASE_TAG_ENCODED/u);
	assert.match(shell, /VERSION_PATH=\$VERSIONS_DIR\/\$RELEASE_TAG_ENCODED/u);
	assert.match(shell, /ln -s "versions\/\$RELEASE_TAG_ENCODED"/u);
	assert.match(shell, /Installing atomic version:[^\n]+"\$RELEASE_TAG"/u);
	assert.doesNotMatch(shell, /installed successfully|Binary: %s|Add Atomic to PATH/u);
	// The installed-version line is informational and must never execute the existing
	// binary before repair: a hung `current/atomic` would block the download and promotion.
	assert.doesNotMatch(shell, /"\$INSTALL_ROOT\/current\/atomic" --version/u);
	assert.match(shell, /CDPATH= cd -P "\$INSTALL_ROOT\/current" 2>\/dev\/null && pwd/u);
	assert.match(
		shell,
		/INSTALLED_VERSION=\$\(percent_decode "\$installed_encoded"\) &&\n\s+is_atomic_release_tag "\$INSTALLED_VERSION"/u,
	);
});

test("installers pin the requested exact ref and fail closed on a mismatched release identity", async () => {
	const { shell, powershell } = await installers();
	const shellCheck = shell.indexOf('[ "$RELEASE_TAG" != "$REQUESTED_REF" ]');
	assert.ok(shellCheck >= 0, "POSIX installer does not compare the resolved tag with the requested ref");
	assert.ok(shellCheck < shell.indexOf("RELEASE_BASE="), "POSIX identity check runs after the download base");
	assert.match(shell, /GitHub returned release \$RELEASE_TAG for requested tag \$REQUESTED_REF/u);

	const powershellCheck = powershell.indexOf("$releaseTag -cne $requestedRef");
	assert.ok(powershellCheck >= 0, "PowerShell installer does not compare the resolved tag with the requested ref");
	assert.ok(
		powershellCheck < powershell.indexOf("$releaseBase ="),
		"PowerShell identity check runs after the download base",
	);
	assert.match(powershell, /GitHub returned release \$releaseTag for requested tag \$requestedRef/u);
});

test("POSIX path normalization preserves caller-controlled trailing newlines", async () => {
	const { shell } = await installers();
	assert.match(shell, /NEWLINE=\$\(printf '\\n_'\)/u);
	assert.match(shell, /START_WORKING_DIR=\$\(pwd -P && printf '_'\)/u);
	assert.match(shell, /START_WORKING_DIR=\$\{START_WORKING_DIR%"\$NEWLINE"\}/u);
	for (const name of ["INSTALL_ROOT", "BIN_DIR", "PHYSICAL_INSTALL_ROOT", "PHYSICAL_BIN_PATH"]) {
		assert.match(shell, new RegExp(`${name}=\\$\\{${name}%_\\}`, "u"));
	}
	assert.match(shell, /printf '\/%s' "\$normalize_result"/u);
	assert.match(shell, /printf '%s' "\$existing_candidate"/u);
});

test("Windows PATH updates refuse a bin directory that cannot be one PATH entry", async () => {
	const { powershell } = await installers();
	assert.match(powershell, /\$binDirHasPathSeparator = \$binDir\.Contains\(";"\)/u);
	const userPathUpdate = powershell.indexOf('[Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")');
	const processPathUpdate = powershell.indexOf("$env:Path = if ([string]::IsNullOrWhiteSpace($env:Path))");
	assert.ok(userPathUpdate >= 0 && processPathUpdate >= 0);
	for (const guard of [userPathUpdate, processPathUpdate]) {
		const enclosing = powershell.lastIndexOf("if (-not $binDirHasPathSeparator -and", guard);
		assert.ok(enclosing >= 0 && guard - enclosing < 400, "a PATH mutation is not guarded by the separator check");
	}
	assert.match(powershell, /cannot be represented as one Windows PATH entry/u);
	assert.match(powershell, /Choose a semicolon-free ATOMIC_BIN_DIR/u);
});

test("POSIX API authentication uses protected files and never authenticates release downloads", async () => {
	const { shell } = await installers();
	assert.match(shell, /printf 'Authorization: Bearer %s\\n' "\$TOKEN" > "\$API_AUTH_PATH"/u);
	assert.match(shell, /printf 'header = Authorization: Bearer %s\\n' "\$TOKEN" > "\$API_AUTH_PATH"/u);
	assert.match(shell, /chmod 600 "\$API_AUTH_PATH"/u);
	assert.match(shell, /curl[^\n]+-H "@\$API_AUTH_PATH" "\$http_url"/u);
	assert.match(shell, /WGETRC="\$API_AUTH_PATH" wget[^\n]+"\$http_url"/u);
	assert.doesNotMatch(shell, /--location-trusted/u);
	assert.doesNotMatch(shell, /(?:-H|--header=)"Authorization: Bearer \$TOKEN"/u);
	const clearAuth = shell.indexOf("clear_api_auth");
	const releaseBase = shell.indexOf("RELEASE_BASE=");
	assert.ok(clearAuth >= 0 && clearAuth < releaseBase);
	const download = shell.slice(shell.indexOf("download_file()"), shell.indexOf("tag_from_release_url()"));
	assert.ok(download.includes("content_length_of()") && download.includes("download_archive()"));
	assert.doesNotMatch(download, /TOKEN|API_AUTH|Authorization|WGETRC/u);
	assert.match(download, /curl -fsIL -o "\$length_headers" "\$length_url"/u);
	assert.match(download, /wget -S --spider "\$length_url"/u);
	assert.ok(shell.indexOf("clear_api_auth\n") < shell.indexOf('download_archive "$RELEASE_BASE'));
});

test("POSIX rollback retries failed restores and removes created empty parent chains", async () => {
	const { shell } = await installers();
	assert.match(shell, /ROLLBACK_RETRY_LIMIT=3/u);
	assert.match(shell, /while \[ "\$rollback_attempt" -lt "\$ROLLBACK_RETRY_LIMIT" \][^\n]+"\$rollback_incomplete"/u);
	assert.match(shell, /failed to restore the previous atomic launcher/u);
	assert.match(shell, /rollback remains incomplete[^\n]+backups were retained for recovery/u);
	assert.match(shell, /nearest_existing_directory/u);
	assert.match(shell, /remove_created_empty_path "\$BIN_DIR" "\$BIN_DIRECTORY_STOP"/u);
	assert.match(shell, /remove_created_empty_path "\$INSTALL_ROOT" "\$INSTALL_DIRECTORY_STOP"/u);
});

test("PowerShell rolls back uncommitted move intents from finally and cleans created parents to a fixed point", async () => {
	const { powershell } = await installers();
	assert.match(powershell, /function Invoke-AtomicTransactionRollback/u);
	assert.match(powershell, /\$null -eq \$Transaction -or \$Transaction\.RollbackCompleted/u);
	assert.doesNotMatch(powershell, /\$Transaction\.RollbackCompleted\s*=\s*\$true/u);
	assert.match(powershell, /\$Transaction\.RollbackCompleted\s*=\s*-not\s+\$rollbackIncomplete/u);
	assert.match(powershell, /RollbackCompleted = \$false/u);
	assert.match(powershell, /\$transactionCommitted = \$false/u);
	assert.match(powershell, /\$transactionCommitted = \$true[\s\S]+Remove-AtomicTransactionBackups/u);
	for (const name of [
		"VersionBackup",
		"VersionInstall",
		"CurrentBackup",
		"CurrentInstall",
		"AtomicCurrentBackup",
		"AtomicCurrentInstall",
		"ShimBackup",
		"ShimInstall",
	]) {
		const intent = powershell.indexOf(`$transaction.${name}Intended = $true`);
		const move = powershell.indexOf("Move-Item", intent);
		assert.ok(intent >= 0 && move > intent, `${name} intent must precede its move`);
	}
	const successOutput = powershell.indexOf('    Write-Output "Installed to $shimPath"');
	const transactionCatch = powershell.lastIndexOf("    catch {", successOutput);
	assert.ok(transactionCatch >= 0 && successOutput > transactionCatch);
	assert.match(powershell.slice(transactionCatch, successOutput), /Invoke-AtomicTransactionRollback \$transaction/u);
	const finallyBlock = powershell.slice(powershell.indexOf("finally {", successOutput));
	assert.match(finallyBlock, /-not \$transactionCommitted[\s\S]+Invoke-AtomicTransactionRollback \$transaction/u);
	assert.match(powershell, /\$rollbackRetryLimit\s*=\s*[2-9]/u);
	assert.match(finallyBlock, /while \(\$rollbackAttempt -lt \$rollbackRetryLimit/u);
	assert.match(finallyBlock, /Write-Warning.*rollback.*incomplete.*-WarningAction Continue/iu);
	assert.match(powershell, /function Add-AtomicMissingDirectoryPaths/u);
	assert.match(powershell, /Sort-Object -Property Length -Descending/u);
	assert.match(powershell, /do \{[\s\S]+\} while \(\$removedDirectory\)/u);
	assert.doesNotMatch(
		powershell.slice(
			powershell.indexOf("function Remove-AtomicCreatedEmptyDirectories"),
			powershell.indexOf("function Invoke-AtomicTransactionRollback"),
		),
		/Remove-Item|-Recurse/u,
	);
});

test("Windows temporary download directories are removed with bounded verified retries", async () => {
	const { powershell } = await installers();

	const retryStart = powershell.indexOf("function Remove-AtomicTreeWithRetry");
	assert.ok(retryStart >= 0, "the bounded shared removal helper is missing");
	const helper = powershell.slice(retryStart, powershell.indexOf("function Remove-AtomicTemporaryDirectory"));
	assert.ok(helper.length > 0, "the shared removal helper is not declared before Remove-AtomicTemporaryDirectory");
	assert.match(helper, /while \(\$result\.Attempts -lt \$RetryLimit\)/u);
	assert.doesNotMatch(helper, /while \(\$true\)|do \{/u);
	assert.match(helper, /Remove-Item -LiteralPath \$Path -Recurse:\$isDirectory -Force -ErrorAction Stop/u);
	assert.doesNotMatch(helper, /SilentlyContinue/u);
	assert.match(helper, /\[IO\.Directory\]::Delete\(\$Path, \$true\)/u);
	assert.match(helper, /if \(-not \(Test-AtomicRemovalTargetExists \$Path\)\)/u);
	assert.match(helper, /\[IO\.FileAttributes\]::ReadOnly/u);
	assert.doesNotMatch(helper, /Remove-Item -LiteralPath (?!\$Path\b)/u);
	assert.doesNotMatch(helper, /\[IO\.Directory\]::Delete\((?!\$Path,)/u);

	const wrapperStart = powershell.indexOf("function Remove-AtomicTemporaryDirectory");
	assert.ok(wrapperStart >= 0, "the bounded temp-directory removal helper is missing");
	const wrapper = powershell.slice(wrapperStart, powershell.indexOf("function Remove-AtomicEmptyDirectory"));
	assert.ok(wrapper.length > 0, "the removal helper is not declared before Remove-AtomicEmptyDirectory");
	assert.match(wrapper, /Remove-AtomicTreeWithRetry \$Path \$RetryLimit \$RetryDelayMilliseconds/u);
	assert.match(wrapper, /after \$\(\$removal\.Attempts\) attempts; last error: \$lastCleanupDetail/u);

	const backupCleanupStart = powershell.indexOf("function Remove-AtomicTransactionBackups");
	assert.ok(backupCleanupStart >= 0, "the committed backup cleanup helper is missing");
	const backupCleanup = powershell.slice(
		backupCleanupStart,
		powershell.indexOf("$tempDir = $null", backupCleanupStart),
	);
	assert.match(
		backupCleanup,
		/Remove-AtomicTreeWithRetry \$shimBackupItem\.FullName \$RetryLimit \$RetryDelayMilliseconds/u,
	);
	assert.match(
		backupCleanup,
		/Remove-AtomicTreeWithRetry \$backupItem\.FullName \$RetryLimit \$RetryDelayMilliseconds/u,
	);
	assert.doesNotMatch(backupCleanup, /Remove-AtomicDirectoryLinkOrTree/u);
	assert.match(
		powershell,
		/Remove-AtomicTransactionBackups \$transaction \$tempCleanupRetryLimit \$tempCleanupRetryDelayMilliseconds/u,
	);

	assert.match(powershell, /\$tempCleanupRetryLimit = [2-9]/u);
	assert.doesNotMatch(powershell, /Remove-Item -LiteralPath \$tempDir/u);
	assert.match(
		powershell,
		/Remove-AtomicTemporaryDirectory \$tempDir \$tempCleanupRetryLimit \$tempCleanupRetryDelayMilliseconds/u,
	);
	assert.doesNotMatch(
		powershell,
		/Remove-AtomicTemporaryDirectory \$(?:binDir|installRoot|versionsDir|currentPath|shimPath)\b/u,
		"the bounded removal helper must only be used for the installer-owned temp directory",
	);

	const successOutput = powershell.indexOf('    Write-Output "Installed to $shimPath"');
	const finallyBlock = powershell.slice(powershell.indexOf("finally {", successOutput));
	const rollback = finallyBlock.indexOf("Invoke-AtomicTransactionRollback");
	const tempCleanup = finallyBlock.indexOf("Remove-AtomicTemporaryDirectory $tempDir", rollback);
	const parentCleanup = finallyBlock.indexOf(
		"Remove-AtomicCreatedEmptyDirectories $transactionMissingDirectories",
		tempCleanup,
	);
	const deferredReport = finallyBlock.indexOf("if ($null -ne $tempCleanupError)", parentCleanup);
	assert.ok(
		rollback >= 0 && tempCleanup > rollback && parentCleanup > tempCleanup && deferredReport > parentCleanup,
		"a temp cleanup failure is surfaced before rollback and created-parent cleanup complete",
	);
	assert.match(finallyBlock.slice(tempCleanup), /catch \{\r?\n\s+\$tempCleanupError = \$_/u);
	assert.match(
		finallyBlock.slice(deferredReport),
		/if \(\$null -ne \$primaryError\) \{[\s\S]{0,200}Write-Warning[^\r\n]+cleanup remains incomplete[^\r\n]+-WarningAction Continue[\s\S]{0,80}else \{\r?\n\s+throw \$tempCleanupError/u,
	);
	for (const warning of powershell.matchAll(/^\s*Write-Warning[^\r\n]*$/gmu)) {
		assert.match(
			warning[0],
			/-WarningAction Continue/u,
			`warning can inherit a terminating preference: ${warning[0]}`,
		);
	}
	assert.match(powershell, /catch \{\r?\n\s+\$primaryError = \$_\r?\n\s+throw \$primaryError\r?\n\}/u);
});

test("POSIX installer output modes never weaken the download, cleanup, or error contract", async () => {
	const { shell } = await installers();
	// The caller's locale is read before the script pins LC_ALL=C for its own parsing.
	const localeCapture = shell.search(/CALLER_LOCALE=\$\{LC_ALL:-\$\{LC_CTYPE:-\$\{LANG:-\}\}\}/u);
	const localePin = shell.indexOf("\nLC_ALL=C\nexport LC_ALL\n");
	assert.ok(
		localeCapture >= 0 && localePin > localeCapture,
		"LC_ALL=C is assigned before the caller's locale is captured",
	);
	assert.match(
		shell,
		/if \[ ! -t 1 \] \|\| \[ -n "\$\{NO_COLOR\+x\}" \] \|\| \[ -n "\$\{CI\+x\}" \] \|\| \[ "\$\{TERM:-dumb\}" = dumb \]; then\n\s+OUTPUT_MODE='plain'/u,
	);
	assert.match(shell, /printf '%serror:%s %s\\n' "\$ERROR_COLOR" "\$ERROR_RESET" "\$\*" >&2/u);
	assert.doesNotMatch(shell, /\bawk\b/u);

	// The background downloader is killed and the cursor restored before any rollback work.
	const cleanupStart = shell.indexOf("cleanup() {");
	const cleanup = shell.slice(cleanupStart, shell.indexOf("\n}\n", cleanupStart));
	const kill = cleanup.indexOf('kill "$DOWNLOAD_PID"');
	const reap = cleanup.indexOf('wait "$DOWNLOAD_PID"');
	const cursor = cleanup.indexOf("\\033[?25h");
	const rollback = cleanup.indexOf("rollback_once");
	assert.ok(kill >= 0 && reap > kill && cursor > reap && rollback > cursor, cleanup);
	assert.match(shell, /trap cleanup 0\ntrap 'exit 1' HUP INT TERM\n/u);
	// The downloader is exec'd in the background subshell so $! is curl/wget itself,
	// not a wrapper whose death would orphan the real download.
	const execHelperStart = shell.indexOf("exec_download_file() {");
	assert.ok(execHelperStart >= 0, "exec_download_file helper is missing");
	const execHelper = shell.slice(execHelperStart, shell.indexOf("\n}\n", execHelperStart));
	assert.match(execHelper, /exec curl -fsSL -o "\$download_destination" "\$download_url"/u);
	assert.match(execHelper, /exec wget -q -O "\$download_destination" "\$download_url"/u);
	assert.match(shell, /\n\s+exec_download_file "\$archive_url" "\$archive_destination" &\n\s+DOWNLOAD_PID=\$!/u);
	assert.doesNotMatch(shell, /(^|[^_])download_file "\$archive_url" "\$archive_destination" &/mu);
	assert.match(shell, /wait "\$DOWNLOAD_PID" \|\| archive_status=\$\?\n\s+DOWNLOAD_PID=\n/u);

	// Only the asset and SHA256SUMS base can be overridden, and verification is untouched.
	assert.match(
		shell,
		/RELEASE_BASE=\$\{ATOMIC_RELEASE_BASE_URL:-\$GITHUB_WEB\/\$REPOSITORY\/releases\/download\/\$RELEASE_TAG_ENCODED\}/u,
	);
	const overrideUses = shell
		.split("\n")
		.filter((line) => line.includes("ATOMIC_RELEASE_BASE_URL") && !line.trimStart().startsWith("#"));
	assert.equal(overrideUses.length, 2, "the override must stay a download-base knob");
	assert.equal(overrideUses[0], "  ATOMIC_RELEASE_BASE_URL");
	assert.match(
		overrideUses[1] ?? "",
		/^RELEASE_BASE=\$\{ATOMIC_RELEASE_BASE_URL:-\$GITHUB_WEB\/\$REPOSITORY\/releases\/download\/\$RELEASE_TAG_ENCODED\}$/u,
	);
	assert.match(shell, /if ! download_file "\$RELEASE_BASE\/\$CHECKSUM_FILE" "\$CHECKSUM_PATH"; then/u);
	assert.match(shell, /\[ "\$ACTUAL_CHECKSUM" = "\$EXPECTED_CHECKSUM" \] \|\| fail "checksum verification failed/u);
	assert.match(shell, /NO_COLOR\s+Disable colour and progress output/u);
	assert.match(shell, /ATOMIC_RELEASE_BASE_URL\n\s+Testing only/u);

	// Decorations are terminal-only; PATH guidance keeps today's shell-quoted export.
	const toStart = shell.indexOf("printf 'To start:");
	const ttyGate = shell.lastIndexOf('if [ "$OUTPUT_MODE" = tty ]; then', toStart);
	assert.ok(toStart >= 0 && ttyGate >= 0 && toStart - ttyGate < 200, "the start block is not gated on a terminal");
	assert.ok(shell.indexOf("print_banner\n") > shell.indexOf('if [ "$CALLER_UTF8" -eq 1 ]; then', ttyGate));
	assert.match(shell, /printf ' {2}export PATH='\n\s+shell_quote "\$BIN_DIR"\n\s+printf ':"\$PATH"\\n'/u);
	assert.match(shell, /printf ' {2}fish_add_path '\n\s+shell_quote "\$BIN_DIR"/u);
	assert.match(shell, /case :\$\{PATH:-\}: in\n\s+\*:"\$BIN_DIR":\*\) ;;/u);
	assert.match(shell, /ATOMIC_BIN_DIR contains ':' and cannot be represented as one POSIX PATH entry/u);
});

test("Windows smoke checks stay silent without a pipeline and the summary lines use the new wording", async () => {
	const { powershell } = await installers();
	// `$null = & ...` rather than `| Out-Null`: Windows PowerShell refuses to run
	// a native command inside a pipeline when PATHEXT does not classify it as an
	// application ("Cannot run a document in the middle of a pipeline"), and the
	// installer accepts PATHEXT spellings PowerShell itself does not parse.
	for (const [command, status] of [
		['$null = & $stagedAtomic "--version"', "$stagedExitCode = $LASTEXITCODE"],
		['$null = & $stagedAtomic "--internal-validate-postgres-runtime" $postgresRuntime', "if ($LASTEXITCODE -ne 0)"],
		['$null = & $postgresExecutable "--version"', "if ($LASTEXITCODE -ne 0)"],
		["$null = & $env:ComSpec /d /c $shimCommand", "$finalExitCode = $LASTEXITCODE"],
	] as const) {
		const invocation = powershell.indexOf(command);
		assert.ok(invocation >= 0, `smoke check output is not discarded by assignment: ${command}`);
		const check = powershell.indexOf(status, invocation);
		assert.ok(check > invocation && check - invocation < 200, `exit status is not checked after: ${command}`);
	}
	assert.doesNotMatch(powershell, /^\s*& \$stagedAtomic "--version"\r?\n/mu);
	assert.doesNotMatch(powershell, /^\s*& \$postgresExecutable "--version"\r?\n/mu);
	assert.doesNotMatch(powershell, /^\s*& \$env:ComSpec \/d \/c \$shimCommand\r?\n/mu);
	assert.doesNotMatch(powershell, /& \$(?:stagedAtomic|postgresExecutable|env:ComSpec)\b[^\r\n]*\| Out-Null/u);
	assert.match(powershell, /Write-Output "Installed to \$shimPath"/u);
	assert.match(powershell, /Write-Output "Added \$binDir to your User PATH; open a new terminal to use atomic\."/u);
	assert.match(powershell, /Write-Output "Run Atomic directly: `"\$shimPath`""/u);
	assert.doesNotMatch(powershell, /installed successfully|Restart your terminal|Write-Output "Shim: /u);
});
