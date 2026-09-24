import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { withoutSqliteExperimentalWarning } from "../fixtures/sdk-host-fixture-support.mjs";
import { type SyncSpawnResult, spawnSyncCollect } from "../helpers/runtime.js";

/** Spawn budget for one built-Node fixture process. Mirrors, but is not the
 *  source of, each suite file's vitest budget — the duration guard resolves
 *  timeout expressions only from numeric consts declared in the reporting file. */
const FIXTURE_PROCESS_TIMEOUT_MS = 60_000;

export function runBuiltNodeFixture(
	fixture: string,
	args: readonly string[] = [],
	execArgv: readonly string[] = [],
	env?: NodeJS.ProcessEnv,
): SyncSpawnResult {
	return spawnSyncCollect(
		[process.execPath, ...execArgv, fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url)), ...args],
		{ timeout: FIXTURE_PROCESS_TIMEOUT_MS, env },
	);
}

export function expectVerifiedFixture(
	fixture: string,
	args: readonly string[] = [],
	execArgv: readonly string[] = [],
): void {
	const result = runBuiltNodeFixture(fixture, args, execArgv);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.match(result.stdout.toString(), /"verified":true/);
}

export function expectDrainedFixture(fixture: string, args: readonly string[] = [], env?: NodeJS.ProcessEnv): void {
	const result = runBuiltNodeFixture(fixture, args, [], env);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.match(result.stdout.toString(), /"active":0/);
}

export function expectSilentVerifiedFixture(
	fixture: string,
	args: readonly string[] = [],
	{ allowSqliteWarning = false }: { allowSqliteWarning?: boolean } = {},
): void {
	const result = runBuiltNodeFixture(fixture, args);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const stderr = result.stderr.toString();
	assert.equal(allowSqliteWarning ? withoutSqliteExperimentalWarning(stderr) : stderr, "");
	assert.equal(result.stdout.toString().trim(), '{"verified":true}');
}
