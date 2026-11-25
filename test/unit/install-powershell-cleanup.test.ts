import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";
import {
	type AsyncProcessResult,
	BACKUP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS,
	createIsolatedHkcuRunId,
	ctrlCChildHarness,
	deleteIsolatedHkcuRunKeyBestEffort,
	fixtureHarness,
	installerSource,
	powershell7Executable,
	powershellExecutable,
	ROLLBACK_RETRY_FIXTURE_STRUCTURAL_TIMEOUT_MS,
	readHostUserPathAndScratchPresence,
	runPowerShellFixture,
	runPowerShellFixtureAsync,
	spawnCollectAsync,
	TEMP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS,
} from "./install-powershell-helpers.js";

const powershellTest = powershellExecutable === undefined ? test.skip : test;

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
	const retryStart = source.indexOf("function Remove-AtomicTreeWithRetry");
	assert.ok(retryStart >= 0, "the shared verified removal helper is missing");
	const helper = source.slice(retryStart, source.indexOf("function Remove-AtomicTemporaryDirectory"));
	assert.ok(helper.length > 0, "the shared removal helper is not declared before Remove-AtomicTemporaryDirectory");

	assert.match(helper, /\[string\]\$Path,\r?\n\s+\[int\]\$RetryLimit,\r?\n\s+\[int\]\$RetryDelayMilliseconds/u);
	assert.match(
		helper,
		/if \(\[string\]::IsNullOrWhiteSpace\(\$Path\) -or -not \(Test-AtomicRemovalTargetExists \$Path\)\)/u,
	);
	assert.match(helper, /while \(\$result\.Attempts -lt \$RetryLimit\)/u);
	assert.doesNotMatch(helper, /while \(\$true\)|do \{/u, "the removal helper must not loop without a bound");
	assert.match(helper, /\[IO\.FileAttributes\]::ReadOnly/u);
	assert.match(helper, /\[IO\.File\]::SetAttributes\(/u);
	assert.match(helper, /Remove-Item -LiteralPath \$Path -Recurse:\$isDirectory -Force -ErrorAction Stop/u);
	assert.doesNotMatch(helper, /SilentlyContinue/u, "the removal helper must not suppress deletion failures");
	assert.match(helper, /\[IO\.Directory\]::Delete\(\$Path, \$true\)/u);
	assert.match(helper, /\[IO\.File\]::Delete\(\$Path\)/u);
	assert.equal(
		(
			helper.match(/if \(-not \(Test-AtomicRemovalTargetExists \$Path\)\) \{\r?\n\s+return \$result\r?\n\s+\}/gu) ??
			[]
		).length,
		2,
		"the removal helper does not verify absence after both removal strategies",
	);
	assert.match(helper, /Test-AtomicTransientFileSystemError \$result\.LastError/u);
	assert.match(helper, /Start-Sleep -Milliseconds \(\$RetryDelayMilliseconds \* \$result\.Attempts\)/u);
	assert.doesNotMatch(helper, /Remove-Item -LiteralPath (?!\$Path\b)/u, "the helper removes a path it was not given");
	assert.doesNotMatch(helper, /\[IO\.Directory\]::Delete\((?!\$Path,)/u, "the helper deletes a path it was not given");

	const wrapperStart = source.indexOf("function Remove-AtomicTemporaryDirectory");
	assert.ok(wrapperStart >= 0, "the verified temporary-directory removal helper is missing");
	const wrapper = source.slice(wrapperStart, source.indexOf("function Remove-AtomicEmptyDirectory"));
	assert.ok(wrapper.length > 0, "the removal helper is not declared before Remove-AtomicEmptyDirectory");
	assert.match(
		wrapper,
		/if \(\[string\]::IsNullOrWhiteSpace\(\$Path\) -or -not \[IO\.Directory\]::Exists\(\$Path\)\)/u,
	);
	assert.match(wrapper, /Remove-AtomicTreeWithRetry \$Path \$RetryLimit \$RetryDelayMilliseconds/u);
	assert.match(
		wrapper,
		/throw "Failed to remove the temporary download directory \$\{Path\} after \$\(\$removal\.Attempts\) attempts; last error: \$lastCleanupDetail"/u,
	);

	assert.match(source, /\$tempCleanupRetryLimit = [2-9]\r?\n/u);
	assert.match(source, /\$tempCleanupRetryDelayMilliseconds = [1-9][0-9]*\r?\n/u);
	assert.match(source, /catch \{\r?\n\s+\$primaryError = \$_\r?\n\s+throw \$primaryError\r?\n\}/u);
	assert.doesNotMatch(source, /Remove-Item -LiteralPath \$tempDir/u, "the suppressed temp deletion is still present");

	const cleanup = source.slice(
		source.indexOf("finally {", source.indexOf("Write-AtomicInstallSummary $transaction.UserPathChangeIntended")),
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

test("Windows installer waits out a transient lock on its just-executed payload before failing temp cleanup (#4483)", () => {
	const source = installerSource();
	const retryLimit = Number(/^\$tempCleanupRetryLimit = (\d+)\r?$/mu.exec(source)?.[1]);
	const retryDelayMilliseconds = Number(/^\$tempCleanupRetryDelayMilliseconds = (\d+)\r?$/mu.exec(source)?.[1]);
	const pausesBeforeGivingUp = Array.from(
		{ length: retryLimit - 1 },
		(_, index) => retryDelayMilliseconds * (index + 1),
	);
	const totalBackoffMilliseconds = pausesBeforeGivingUp.reduce((total, pause) => total + pause, 0);
	assert.ok(
		totalBackoffMilliseconds >= 9_000,
		`temp cleanup gives up after ${totalBackoffMilliseconds} ms of backoff; 1.25 s did not outlast a just-executed payload's lock`,
	);
});

test("Windows PowerShell 5.1 fixtures await and fail on any process from the workspace before they report success (#4483)", () => {
	const checkStart = fixtureHarness.indexOf("function Assert-FixtureProcessesExited");
	assert.ok(checkStart >= 0, "the fixture lacks a check for processes started from its workspace");
	const check = fixtureHarness.slice(checkStart, fixtureHarness.indexOf("\nfunction ", checkStart + 1));
	assert.match(check, /\[Diagnostics\.Process\]::GetProcesses\(\)/u);
	assert.match(check, /\$process\.MainModule\.FileName/u);
	assert.match(check, /\$prefix = \$Root\.TrimEnd\('\\'\) \+ '\\'/u, "a sibling workspace sharing the prefix matched");
	assert.match(check, /\$imagePath\.StartsWith\(\$prefix, \[StringComparison\]::OrdinalIgnoreCase\)/u);
	assert.match(check, /\$process\.WaitForExit\(\$WaitMilliseconds\)/u, "a running process must be awaited");
	assert.match(check, /Assert-Fixture \(\$outlived\.Count -eq 0\)/u, "an awaited straggler must still fail");

	const call = fixtureHarness.indexOf("Assert-FixtureProcessesExited $workspace 10000");
	const unknownScenario = fixtureHarness.indexOf('throw "Unknown fixture scenario: $Scenario"');
	const finalResidue = fixtureHarness.indexOf("$finalResidue = Get-TempResidueReport $fixtureTemp");
	assert.ok(
		unknownScenario >= 0 && call > unknownScenario && finalResidue > call,
		"every scenario must await its processes before the final residue check and SCENARIO_OK",
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

test("Windows installer retries transaction backup removal after commit with the bounded shared helper", () => {
	const source = installerSource();
	const cleanupStart = source.indexOf("function Remove-AtomicTransactionBackups");
	assert.ok(cleanupStart >= 0, "the committed backup cleanup helper is missing");
	const cleanup = source.slice(cleanupStart, source.indexOf("$tempDir = $null", cleanupStart));
	assert.ok(cleanup.length > 0, "the committed backup cleanup helper is not declared before the state block");

	assert.match(
		cleanup,
		/\[hashtable\]\$Transaction,\r?\n\s+\[int\]\$RetryLimit,\r?\n\s+\[int\]\$RetryDelayMilliseconds/u,
	);
	assert.match(
		cleanup,
		/Remove-AtomicTreeWithRetry \$shimBackupItem\.FullName \$RetryLimit \$RetryDelayMilliseconds/u,
		"the shim backup file is not removed with the bounded retry helper",
	);
	assert.match(
		cleanup,
		/Remove-AtomicTreeWithRetry \$backupItem\.FullName \$RetryLimit \$RetryDelayMilliseconds/u,
		"directory backups are not removed with the bounded retry helper",
	);
	assert.match(
		cleanup,
		/\(\$backupItem\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint\) -ne 0/u,
		"reparse-point backups are not detected before recursive removal",
	);
	assert.match(
		cleanup,
		/\[IO\.Directory\]::Delete\(\$backupItem\.FullName\)/u,
		"reparse-point backups must be deleted with a single non-recursive link delete",
	);
	assert.doesNotMatch(
		cleanup,
		/Remove-AtomicDirectoryLinkOrTree/u,
		"the single-attempt removal path is still present",
	);
	for (const warning of cleanup.matchAll(/^\s*Write-Warning[^\r\n]*$/gmu)) {
		assert.match(warning[0], /-WarningAction Continue/u);
	}
	assert.match(
		cleanup,
		/if \(-not \$removal\.Removed\) \{\r?\n\s+Write-Warning -Message "Installed successfully, but could not remove the previous shim backup/u,
		"the shim backup warning does not wait for exhausted retries",
	);
	assert.equal(
		(
			source.match(
				/Remove-AtomicTransactionBackups \$transaction \$tempCleanupRetryLimit \$tempCleanupRetryDelayMilliseconds/gu,
			) ?? []
		).length,
		2,
		"both committed cleanup call sites must pass the bounded retry budget",
	);
});

test("Windows PowerShell 5.1 backup-cleanup fixture proves committed backups survive brief real locks", () => {
	assert.match(
		fixtureHarness,
		/\[IO\.File\]::Open\(\$backupLockPath, \[IO\.FileMode\]::Open, \[IO\.FileAccess\]::Read, \[IO\.FileShare\]::None\)/u,
	);
	assert.match(
		fixtureHarness,
		/\$global:AtomicFixtureBackupLockMode -eq "one-shot" -and\r?\n\s+\$global:AtomicFixtureBackupRemovalAttempts -ge 2/u,
	);
	const scenario = fixtureHarness.slice(
		fixtureHarness.indexOf('elseif ($Scenario -eq "backup-cleanup")'),
		fixtureHarness.indexOf('elseif ($Scenario -eq "temp-cleanup")'),
	);
	assert.ok(scenario.length > 0, "the backup-cleanup fixture scenario is missing");
	assert.doesNotMatch(scenario, /Start-Sleep/u, "the deterministic probe must not wait on wall-clock time");
	assert.match(scenario, /a real briefly locked version backup did not force a removal retry/u);
	assert.match(scenario, /the one-shot backup handle was never released/u);
	assert.match(scenario, /the locked-backup reinstall did not complete/u);
	assert.match(scenario, /a recovered backup removal still warned/u);
	assert.match(scenario, /an exhausted backup removal did not retry/u);
	assert.match(scenario, /an exhausted backup removal discarded a completed install/u);
	assert.match(scenario, /an exhausted backup removal did not warn once per cleanup call site/u);
});

test("Windows PowerShell fixtures isolate HKCU User PATH per process and never rewrite the host User PATH", () => {
	assert.match(fixtureHarness, /RegOverridePredefKey/u);
	assert.match(fixtureHarness, /0x80000001/u);
	assert.match(fixtureHarness, /Software\\AtomicTestIsolatedHkcu/u);
	assert.match(fixtureHarness, /RegistryOptions\]::Volatile/u);
	assert.equal(
		(fixtureHarness.match(/RegistryOptions\]::Volatile/gu) ?? []).length,
		2,
		"both the per-run scratch key and its Environment subkey must be created volatile",
	);
	assert.match(fixtureHarness, /"Environment",[\s\S]{0,160}RegistryOptions\]::Volatile/u);
	assert.match(fixtureHarness, /RegistryValueKind\]::ExpandString/u);
	assert.match(fixtureHarness, /"FixturePid"/u);
	assert.match(fixtureHarness, /"FixtureStartTicks"/u);
	assert.match(fixtureHarness, /"OwnerPid"/u);
	assert.match(fixtureHarness, /"OwnerStartTicks"/u);
	assert.match(fixtureHarness, /"MetadataReady"/u);
	assert.match(fixtureHarness, /function Clear-DeadIsolatedHkcuKeys/u);
	assert.match(fixtureHarness, /function Test-IsolatedOwnerProcessAlive/u);
	assert.doesNotMatch(
		fixtureHarness,
		/\$originalUserPath\b/u,
		"the fixture must not snapshot or write back the host user's real HKCU\\Environment\\Path",
	);

	const finallyStart = fixtureHarness.lastIndexOf("\nfinally {");
	assert.ok(finallyStart >= 0);
	const finallyBlock = fixtureHarness.slice(finallyStart);
	const unoverrideIdx = finallyBlock.indexOf("RegOverridePredefKey(");
	const deleteIdx = finallyBlock.indexOf("DeleteSubKeyTree(");
	assert.ok(unoverrideIdx >= 0, "finally must restore HKEY_CURRENT_USER before cleanup");
	assert.ok(deleteIdx > unoverrideIdx, "finally must restore HKEY_CURRENT_USER before deleting its scratch subkey");
	assert.doesNotMatch(
		finallyBlock,
		/DeleteSubKeyTree\("Software\\AtomicTestIsolatedHkcu"/u,
		"finally must never delete the shared container key while sibling runs may be active",
	);
	assert.doesNotMatch(
		finallyBlock,
		/SetEnvironmentVariable\("Path",/u,
		"finally must never write back to the host user's real User PATH",
	);

	assert.match(fixtureHarness, /"-IsolatedHkcuSubKey",\s*\$isolatedHkcuSubKey/u);
	assert.match(ctrlCChildHarness, /\[Parameter\(Mandatory=\$true\)\]\[string\]\$IsolatedHkcuSubKey/u);
	const childOverride = ctrlCChildHarness.indexOf("RegOverridePredefKey(");
	const childInstall = ctrlCChildHarness.indexOf("& $InstallerPath");
	assert.ok(
		childOverride >= 0 && childInstall > childOverride,
		"ctrl-c child must activate RegOverridePredefKey before running install.ps1",
	);
	const childFinally = ctrlCChildHarness.slice(ctrlCChildHarness.lastIndexOf("\nfinally {"));
	assert.match(childFinally, /RegOverridePredefKey\([\s\S]*\[IntPtr\]::Zero/u);
	assert.doesNotMatch(
		ctrlCChildHarness,
		/DeleteSubKeyTree/u,
		"ctrl-c child must not delete the parent-owned scratch key",
	);
	assert.match(fixtureHarness, /elseif \(\$Scenario -eq "path-broadcast"\)/u);
	assert.match(fixtureHarness, /WM_SETTINGCHANGE area=Environment/u);
});

function spawnVerifiedFixtureKiller(executable: string, targetRunId: string): Promise<AsyncProcessResult> {
	const escapedRunId = targetRunId.replaceAll("'", "''");
	const killerScript = [
		'$ErrorActionPreference = "Stop"',
		`$subKey = "Software\\AtomicTestIsolatedHkcu\\${escapedRunId}"`,
		"$deadline = (Get-Date).AddSeconds(60)",
		"$killed = $false",
		"while ((Get-Date) -lt $deadline) {",
		"  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey, $false)",
		"  if ($null -ne $k) {",
		"    try {",
		'      $ready = $k.GetValue("MetadataReady", $null)',
		'      $rawPid = $k.GetValue("FixturePid", $null)',
		'      $rawTicks = $k.GetValue("FixtureStartTicks", $null)',
		'      $envSub = $k.OpenSubKey("Environment", $false)',
		"      $hasEnv = $null -ne $envSub",
		"      if ($hasEnv) { $envSub.Close() }",
		"    } finally { $k.Close() }",
		'    if ($ready -ceq "1" -and $hasEnv -and $null -ne $rawPid -and $null -ne $rawTicks) {',
		"      Start-Sleep -Milliseconds 300",
		"      $targetPid = [int]$rawPid",
		"      $expectedTicks = [long]$rawTicks",
		"      $proc = [Diagnostics.Process]::GetProcessById($targetPid)",
		"      try {",
		"        if (-not $proc.HasExited -and $proc.StartTime.ToUniversalTime().Ticks -eq $expectedTicks) {",
		"          $proc.Kill()",
		"          [void]$proc.WaitForExit(10000)",
		"          $killed = $true",
		"        }",
		"      } finally { $proc.Dispose() }",
		"      break",
		"    }",
		"  }",
		"  Start-Sleep -Milliseconds 30",
		"}",
		'if (-not $killed) { throw "Did not observe and kill fixture for $subKey before timeout" }',
		'Write-Output "KILLED_OK"',
	].join("\n");
	return spawnCollectAsync(
		executable,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", killerScript],
		90_000,
		`Verified fixture killer for ${targetRunId}`,
	);
}

powershellTest(
	"PowerShell 5.1 and 7 fixtures clean up volatile HKCU scratch keys when killed mid-run and sweep dead-owner orphans",
	async () => {
		assert.ok(powershellExecutable);
		const engines = [powershellExecutable, ...(powershell7Executable !== undefined ? [powershell7Executable] : [])];
		const beforeHost = readHostUserPathAndScratchPresence(powershellExecutable, []);

		for (const engine of engines) {
			const asyncRunId = createIsolatedHkcuRunId();
			const asyncFixture = runPowerShellFixtureAsync("rollback-retries", engine, asyncRunId).then(
				() => null,
				(error: unknown) => error,
			);
			const asyncKill = await spawnVerifiedFixtureKiller(powershellExecutable, asyncRunId);
			assert.equal(asyncKill.exitCode, 0, `${asyncKill.stdout}${asyncKill.stderr}`);
			const asyncError = await asyncFixture;
			assert.ok(asyncError instanceof Error, "mid-run killed async fixture unexpectedly succeeded");
			const afterAsync = readHostUserPathAndScratchPresence(powershellExecutable, [asyncRunId]);
			assert.deepEqual(afterAsync.leftoverRunIds, [], `killed async fixture leaked ${asyncRunId}`);

			const syncRunId = createIsolatedHkcuRunId();
			const syncKillPromise = spawnVerifiedFixtureKiller(powershellExecutable, syncRunId);
			assert.throws(() => runPowerShellFixture("rollback-retries", engine, syncRunId));
			const syncKill = await syncKillPromise;
			assert.equal(syncKill.exitCode, 0, `${syncKill.stdout}${syncKill.stderr}`);
			const afterSync = readHostUserPathAndScratchPresence(powershellExecutable, [syncRunId]);
			assert.deepEqual(afterSync.leftoverRunIds, [], `killed sync fixture leaked ${syncRunId}`);
		}

		// Dead-owner sweep: seed a volatile dead-owner orphan, an unready sibling key, and a live-owner key.
		const orphanDeadId = createIsolatedHkcuRunId();
		const unreadySiblingId = createIsolatedHkcuRunId();
		const liveOwnerId = createIsolatedHkcuRunId();
		const seedSweepKeys = [
			'$ErrorActionPreference = "Stop"',
			`$selfExe = Join-Path $PSHOME "powershell.exe"`,
			'$deadProc = Start-Process -FilePath $selfExe -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0") -PassThru -NoNewWindow',
			"$deadTicks = $deadProc.StartTime.ToUniversalTime().Ticks",
			"$deadPid = $deadProc.Id",
			"[void]$deadProc.WaitForExit(10000)",
			"$deadProc.Dispose()",
			`$liveProc = [Diagnostics.Process]::GetProcessById(${process.pid})`,
			"$liveTicks = $liveProc.StartTime.ToUniversalTime().Ticks",
			"$liveProc.Dispose()",
			'$parent = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\\AtomicTestIsolatedHkcu")',
			"try {",
			`  $orphan = $parent.CreateSubKey('${orphanDeadId}', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Microsoft.Win32.RegistryOptions]::Volatile)`,
			"  try {",
			'    $orphan.SetValue("FixturePid", [string]$deadPid, [Microsoft.Win32.RegistryValueKind]::String)',
			'    $orphan.SetValue("FixtureStartTicks", [string]$deadTicks, [Microsoft.Win32.RegistryValueKind]::String)',
			'    $orphan.SetValue("OwnerPid", [string]$deadPid, [Microsoft.Win32.RegistryValueKind]::String)',
			'    $orphan.SetValue("OwnerStartTicks", [string]$deadTicks, [Microsoft.Win32.RegistryValueKind]::String)',
			'    $orphan.SetValue("MetadataReady", "1", [Microsoft.Win32.RegistryValueKind]::String)',
			"  } finally { $orphan.Close() }",
			`  $unready = $parent.CreateSubKey('${unreadySiblingId}', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Microsoft.Win32.RegistryOptions]::Volatile)`,
			"  $unready.Close()",
			`  $live = $parent.CreateSubKey('${liveOwnerId}', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Microsoft.Win32.RegistryOptions]::Volatile)`,
			"  try {",
			'    $live.SetValue("FixturePid", [string]$deadPid, [Microsoft.Win32.RegistryValueKind]::String)',
			'    $live.SetValue("FixtureStartTicks", [string]$deadTicks, [Microsoft.Win32.RegistryValueKind]::String)',
			`    $live.SetValue("OwnerPid", '${process.pid}', [Microsoft.Win32.RegistryValueKind]::String)`,
			'    $live.SetValue("OwnerStartTicks", [string]$liveTicks, [Microsoft.Win32.RegistryValueKind]::String)',
			'    $live.SetValue("MetadataReady", "1", [Microsoft.Win32.RegistryValueKind]::String)',
			"  } finally { $live.Close() }",
			"} finally { $parent.Close() }",
		].join("\n");
		try {
			const seeded = spawnSyncCollect(
				[powershellExecutable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", seedSweepKeys],
				{ timeout: 30_000 },
			);
			assert.equal(seeded.exitCode, 0, `${seeded.stdout.toString()}${seeded.stderr.toString()}`);

			runPowerShellFixture("semicolon-bin", powershellExecutable);
			const afterSweep = readHostUserPathAndScratchPresence(powershellExecutable, [
				orphanDeadId,
				unreadySiblingId,
				liveOwnerId,
			]);
			assert.ok(!afterSweep.leftoverRunIds.includes(orphanDeadId), "dead-owner orphan key was not swept");
			assert.ok(
				afterSweep.leftoverRunIds.includes(unreadySiblingId),
				"unready sibling key without MetadataReady was swept prematurely",
			);
			assert.ok(afterSweep.leftoverRunIds.includes(liveOwnerId), "key with live OwnerPid was swept prematurely");
			assert.deepEqual(
				{ exists: afterSweep.exists, value: afterSweep.value, kind: afterSweep.kind },
				{ exists: beforeHost.exists, value: beforeHost.value, kind: beforeHost.kind },
				"killed fixtures and dead-owner sweep must not mutate host HKCU\\Environment\\Path",
			);
		} finally {
			deleteIsolatedHkcuRunKeyBestEffort(orphanDeadId, powershellExecutable);
			deleteIsolatedHkcuRunKeyBestEffort(unreadySiblingId, powershellExecutable);
			deleteIsolatedHkcuRunKeyBestEffort(liveOwnerId, powershellExecutable);
		}
	},
	ROLLBACK_RETRY_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture retries a briefly locked version backup and leaves no residue",
	() => {
		runPowerShellFixture("backup-cleanup");
	},
	BACKUP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture removes every temporary download directory against real open handles",
	() => {
		runPowerShellFixture("temp-cleanup");
	},
	TEMP_CLEANUP_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);
