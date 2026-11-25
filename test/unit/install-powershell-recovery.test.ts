import assert from "node:assert/strict";
import { test } from "vitest";
import {
	CTRL_C_FIXTURE_STRUCTURAL_TIMEOUT_MS,
	ctrlCChildHarness,
	ctrlCHelperSource,
	fixtureHarness,
	installerSource,
	POWERSHELL_FIXTURE_TIMEOUT_MS,
	powershell7Executable,
	powershellExecutable,
	runPowerShellFixture,
} from "./install-powershell-helpers.js";

const powershellTest = powershellExecutable === undefined ? test.skip : test;
const powershell7Test = powershell7Executable === undefined ? test.skip : test;

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

test("Windows PowerShell 5.1 Ctrl+C fixture uses a real isolated console event after actual moves", () => {
	assert.match(ctrlCHelperSource, /CREATE_NEW_CONSOLE/u);
	assert.match(ctrlCHelperSource, /AttachConsole\(process\.dwProcessId\)/u);
	assert.match(ctrlCHelperSource, /SetConsoleCtrlHandler\(null, true\)/u);
	assert.match(ctrlCHelperSource, /GenerateConsoleCtrlEvent\(CTRL_C_EVENT, 0\)/u);
	assert.match(ctrlCChildHarness, /Microsoft\.PowerShell\.Management\\Rename-Item[\s\S]+WriteAllText\(\$ReadyPath/u);
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

powershell7Test(
	"PowerShell 7 fixture retries briefly locked version, shim, and rollback renames atomically without splitting directories",
	() => {
		runPowerShellFixture("locked-version-backup", powershell7Executable);
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture repairs and cleans up dangling junctions",
	() => {
		runPowerShellFixture("dangling-junction");
	},
	POWERSHELL_FIXTURE_TIMEOUT_MS,
);

powershellTest(
	"PowerShell 5.1 fixture retries one-shot rollback failures after every applicable real console Ctrl+C move",
	() => {
		runPowerShellFixture("ctrl-c");
	},
	CTRL_C_FIXTURE_STRUCTURAL_TIMEOUT_MS,
);
