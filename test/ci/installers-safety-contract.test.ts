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
		'if ! download_file "$RELEASE_BASE/$ASSET_NAME"',
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
	assert.match(powershell, /if \(\$extension -eq "\.CMD"\) \{\r?\n\s+break/u);
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
	assert.match(shell, /Atomic %s installed successfully[^\n]+"\$RELEASE_TAG"/u);
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
	assert.doesNotMatch(download, /TOKEN|API_AUTH|Authorization/u);
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
	const successOutput = powershell.indexOf('    Write-Output "Atomic $releaseTag installed successfully."');
	const transactionCatch = powershell.lastIndexOf("    catch {", successOutput);
	assert.ok(transactionCatch >= 0 && successOutput > transactionCatch);
	assert.match(powershell.slice(transactionCatch, successOutput), /Invoke-AtomicTransactionRollback \$transaction/u);
	const finallyBlock = powershell.slice(powershell.indexOf("finally {", successOutput));
	assert.match(finallyBlock, /-not \$transactionCommitted[\s\S]+Invoke-AtomicTransactionRollback \$transaction/u);
	assert.match(powershell, /\$rollbackRetryLimit\s*=\s*[2-9]/u);
	assert.match(finallyBlock, /while \(\$rollbackAttempt -lt \$rollbackRetryLimit/u);
	assert.match(finallyBlock, /Write-Warning[^\n]+rollback[^\n]+incomplete/iu);
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
