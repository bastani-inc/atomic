import assert from "node:assert/strict";
import { test } from "vitest";
import {
	fixtureHarness,
	installerSource,
	POWERSHELL_FIXTURE_TIMEOUT_MS,
	powershellExecutable,
	ROLLBACK_RETRY_FIXTURE_STRUCTURAL_TIMEOUT_MS,
	runPowerShellFixture,
	TRANSACTION_FAILURE_FIXTURE_STRUCTURAL_TIMEOUT_MS,
} from "./install-powershell-helpers.js";

const powershellTest = powershellExecutable === undefined ? test.skip : test;

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
		assert.match(
			source,
			new RegExp(`\\$transaction\\.${intent} = \\$true\\r?\\n\\s+Move-AtomicItem\\b`, "u"),
			`${intent} is not recorded immediately before its atomic rename`,
		);
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
		source.indexOf("    Write-AtomicInstallSummary", finalSmoke),
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

test("Windows installer performs every transaction, rollback, and recovery move as a bounded atomic rename", () => {
	const source = installerSource();
	const moveHelperStart = source.indexOf("function Move-AtomicItem");
	assert.ok(moveHelperStart >= 0, "Move-AtomicItem helper is missing");
	const moveHelperEnd = source.indexOf("\nfunction ", moveHelperStart + 1);
	const moveHelper = source.slice(moveHelperStart, moveHelperEnd);

	assert.match(
		moveHelper,
		/Rename-Item -LiteralPath \$normalizedSource -NewName \$destinationLeaf -ErrorAction Stop/u,
		"Move-AtomicItem must use atomic same-directory Rename-Item rather than Move-Item",
	);
	assert.doesNotMatch(
		source,
		/^(?!\s*#)[^\r\n]*\bMove-Item\b/mu,
		"install.ps1 must not call Move-Item (non-atomic on PowerShell 7 when a directory contains a locked file)",
	);
	assert.match(
		moveHelper,
		/catch \[System\.IO\.IOException\], \[System\.UnauthorizedAccessException\]/u,
		"Move-AtomicItem must retry only transient IO/access violations so Ctrl+C and non-IO errors propagate immediately",
	);
	assert.doesNotMatch(
		moveHelper,
		/\bcatch\s*\{/u,
		"Move-AtomicItem must not have a bare catch-all that swallows Ctrl+C or non-IO errors",
	);
	assert.match(
		moveHelper,
		/\$attemptLimit = 1[5-9]/u,
		"Move-AtomicItem retry limit must cover Windows antivirus scans",
	);
	assert.match(moveHelper, /\[Math\]::Min\(100 \* \$attempt, 1000\)/u);
	assert.match(moveHelper, /Start-Sleep -Milliseconds \$delayMilliseconds/u);
	assert.match(moveHelper, /Refusing non-local rename/u);
	assert.match(moveHelper, /Source and destination path must be different/u);
	assert.match(moveHelper, /Test-AtomicTransientFileSystemError \$_/u);
	assert.match(moveHelper, /\[hashtable\]\$RetryBudget = \$null/u);

	const transientHelperStart = source.indexOf("function Test-AtomicTransientFileSystemError");
	assert.ok(transientHelperStart >= 0, "Test-AtomicTransientFileSystemError helper is missing");
	const transientHelperEnd = source.indexOf("\nfunction ", transientHelperStart + 1);
	const transientHelper = source.slice(transientHelperStart, transientHelperEnd);
	for (const subclass of [
		"FileNotFoundException",
		"DirectoryNotFoundException",
		"PathTooLongException",
		"DriveNotFoundException",
	]) {
		assert.match(transientHelper, new RegExp(`\\[System\\.IO\\.${subclass}\\]`, "u"));
	}
	assert.match(transientHelper, /@\(39,\s*80,\s*112,\s*183\)/u);

	const rollbackStart = source.indexOf("function Invoke-AtomicTransactionRollback");
	const rollbackEnd = source.indexOf("function Remove-AtomicTransactionBackups", rollbackStart);
	const rollback = source.slice(rollbackStart, rollbackEnd);
	assert.equal(
		(rollback.match(/\bMove-AtomicItem\b[^\r\n]*-RetryBudget \$Transaction\.RollbackRetryBudget/gu) ?? []).length,
		4,
		"all four rollback backup restores must pass the shared RollbackRetryBudget to Move-AtomicItem",
	);
	assert.match(
		source,
		/RollbackRetryBudget = @\{ RemainingMilliseconds = 9500 \}/u,
		"transaction must initialize one shared rollback retry sleep budget",
	);

	const leftoversStart = source.indexOf("function Clear-AtomicInstallLeftovers");
	const leftoversEnd = source.indexOf("\nfunction ", leftoversStart + 1);
	const leftovers = source.slice(leftoversStart, leftoversEnd);
	assert.match(
		leftovers,
		/Move-AtomicItem -LiteralPath \$backup\.FullName -Destination \$currentPath/u,
		"leftover current-backup recovery must use Move-AtomicItem",
	);

	const linkRemovalStart = source.indexOf("function Remove-AtomicDirectoryLinkOrTree");
	const linkRemovalEnd = source.indexOf("\nfunction ", linkRemovalStart + 1);
	const linkRemoval = source.slice(linkRemovalStart, linkRemovalEnd);
	assert.match(
		linkRemoval,
		/Remove-AtomicTreeWithRetry \$item\.FullName \$RetryLimit \$RetryDelayMilliseconds \$RetryBudget/u,
		"Remove-AtomicDirectoryLinkOrTree must retry real directory tree removals with Remove-AtomicTreeWithRetry and forward RetryBudget",
	);
	assert.doesNotMatch(
		linkRemoval,
		/Remove-Item -LiteralPath/u,
		"Remove-AtomicDirectoryLinkOrTree must not use bare single-attempt Remove-Item",
	);
	assert.match(
		rollback,
		/Remove-AtomicDirectoryLinkOrTree \$versionItem\.FullName \$tempCleanupRetryLimit \$tempCleanupRetryDelayMilliseconds \$Transaction\.RollbackRetryBudget/u,
		"rollback version removal must pass the shared RollbackRetryBudget",
	);
	assert.match(
		rollback,
		/Remove-AtomicTreeWithRetry \$shimItem\.FullName \$tempCleanupRetryLimit \$tempCleanupRetryDelayMilliseconds \$Transaction\.RollbackRetryBudget/u,
		"rollback shim removal must pass the shared RollbackRetryBudget",
	);
	assert.doesNotMatch(rollback, /Remove-Item -LiteralPath/u, "rollback must not use bare single-attempt Remove-Item");

	const finalBlock = source.slice(source.indexOf("finally {"));
	assert.match(
		finalBlock,
		/\$null = Remove-AtomicTreeWithRetry \$versionStagePath \$tempCleanupRetryLimit \$tempCleanupRetryDelayMilliseconds/u,
		"finally stage directory cleanup must use bounded Remove-AtomicTreeWithRetry while preserving best-effort semantics",
	);
	assert.match(
		finalBlock,
		/\$null = Remove-AtomicTreeWithRetry \$shimNextPath \$tempCleanupRetryLimit \$tempCleanupRetryDelayMilliseconds/u,
		"finally staged shim cleanup must use bounded Remove-AtomicTreeWithRetry while preserving best-effort semantics",
	);
	assert.doesNotMatch(
		finalBlock,
		/Remove-Item -LiteralPath \$(?:versionStagePath|shimNextPath)/u,
		"finally must not use bare single-attempt Remove-Item for staged version or shim paths",
	);
});

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

test("Windows PowerShell 5.1 fixtures verify install-state removal before reinstalling into the same roots", () => {
	// Windows can leave a just-executed atomic.exe delete-pending (for example while
	// Defender scans it), so a silenced Remove-Item can leave versions\1.0.0 behind
	// and turn the next fresh install into a backup move that fails with access denied.
	const resetStart = fixtureHarness.indexOf("function Reset-FixtureInstallState");
	assert.ok(resetStart >= 0, "the fixture lacks a verified install-state reset");
	const resetEnd = fixtureHarness.indexOf("\nfunction ", resetStart + 1);
	const reset = fixtureHarness.slice(resetStart, resetEnd);
	assert.doesNotMatch(reset, /SilentlyContinue/u, "the reset must not hide removal failures");
	assert.match(reset, /Start-Sleep/u, "the reset must retry transient Windows deletion failures");
	assert.match(reset, /Assert-Fixture/u, "the reset must fail loudly when residue remains");

	const silencedResets = fixtureHarness.match(
		/Remove-Item -LiteralPath \$(?:installRoot|binDir) -Recurse -Force -ErrorAction SilentlyContinue/gu,
	);
	assert.equal(
		silencedResets?.length,
		2,
		"only the final best-effort cleanup may silence install-root and bin-dir removal",
	);
	assert.ok(
		fixtureHarness.indexOf("Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue") >
			fixtureHarness.lastIndexOf("finally {"),
		"a silenced install-root removal still precedes a reinstall",
	);
});

powershellTest(
	"PowerShell 5.1 fixture rolls back a failing final shim smoke and PATH changes",
	() => {
		runPowerShellFixture("final-smoke");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture installs when Windows refuses the staged version move twice",
	() => {
		runPowerShellFixture("busy-stage-move");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture retries briefly locked version, shim, and rollback renames and rolls back permanent locks cleanly",
	() => {
		runPowerShellFixture("locked-version-backup");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture retries one-shot rollback removal and restore failures for every installed resource",
	() => {
		runPowerShellFixture("rollback-retries");
	},
	ROLLBACK_RETRY_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture rolls back fresh and existing installs at every staged transaction failure",
	() => {
		runPowerShellFixture("transaction-failures");
	},
	TRANSACTION_FAILURE_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);
