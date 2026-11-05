import assert from "node:assert/strict";
import { test } from "vitest";
import { StorageConfigError, StorageError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	isRetryableTeamProfileError,
	isTeamProfileConfigError,
	isTeamProfileError,
	TEAM_PROFILE_CONFIG_ERROR_CODES,
	TEAM_PROFILE_ERROR_CODES,
	TeamProfileConfigError,
	TeamProfileError,
} from "../../packages/coding-agent/src/core/storage/team-errors.js";

test("team errors carry an explicit name, a stable code, safe fields and a hint (#4320)", () => {
	const cause = new Error("EACCES: permission denied");
	const error = new TeamProfileError("token-write-failed", {
		subject: "/home/me/.atomic/agent/storage-token.1",
		detail: "EACCES: permission denied",
		hint: "Check that the agent directory is writable.",
		cause,
	});
	assert.ok(error instanceof StorageError);
	assert.equal(error.name, "TeamProfileError");
	assert.equal(error.code, "token-write-failed");
	assert.equal(error.subject, "/home/me/.atomic/agent/storage-token.1");
	assert.equal(error.detail, "EACCES: permission denied");
	assert.equal(error.hint, "Check that the agent directory is writable.");
	assert.equal(error.retryable, false);
	assert.equal(error.cause, cause);
	assert.equal(
		error.message,
		"Could not store the database token: /home/me/.atomic/agent/storage-token.1 (token-write-failed): EACCES: permission denied. Check that the agent directory is writable.",
	);
	const withoutDetail = new TeamProfileError("adapter-not-installed", { subject: "x", hint: "Install it." });
	assert.equal(withoutDetail.detail, undefined);
	assert.equal(withoutDetail.cause, undefined);
	assert.equal(
		withoutDetail.message,
		"The libSQL storage adapter is not installed: x (adapter-not-installed). Install it.",
	);
	assert.deepEqual(
		[...TEAM_PROFILE_ERROR_CODES].filter((code) => new TeamProfileError(code, { subject: "s", hint: "h" }).retryable),
		["connection-failed", "settings-locked", "broker-restart-failed"],
	);
});

test("a team config error is a StorageConfigError whose reason is its code (#4320)", () => {
	const cause = new Error("ENOENT");
	const error = new TeamProfileConfigError("unreadable-token-file", {
		source: "env",
		field: "ATOMIC_TEAM_TOKEN_FILE",
		hint: "Check that /run/token exists and is readable.",
		path: "/run/token",
		cause,
	});
	assert.ok(error instanceof StorageConfigError);
	assert.equal(error.name, "TeamProfileConfigError");
	assert.deepEqual(
		[error.source, error.field, error.reason, error.code, error.path, error.retryable, error.cause],
		["env", "ATOMIC_TEAM_TOKEN_FILE", "unreadable-token-file", "unreadable-token-file", "/run/token", false, cause],
	);
	assert.equal(
		error.message,
		"Invalid storage configuration: ATOMIC_TEAM_TOKEN_FILE (unreadable-token-file). Check that /run/token exists and is readable.",
	);
	const usage = new TeamProfileConfigError("unknown-option", { source: "cli", field: "--x", hint: "See help." });
	assert.equal(usage.message, "Invalid team command: --x (unknown-option). See help.");
	assert.equal(usage.path, undefined);
	assert.equal(usage.cause, undefined);
});

test("guards match the class or, across realms and processes, its name and a known code (#4320)", () => {
	const operation = new TeamProfileError("connection-failed", { subject: "libsql://db", hint: "h" });
	const config = new TeamProfileConfigError("missing-url", { source: "sdk", field: "url", hint: "h" });
	assert.equal(isTeamProfileError(operation), true);
	assert.equal(isTeamProfileError(config), false);
	assert.equal(isTeamProfileConfigError(config), true);
	assert.equal(isTeamProfileConfigError(operation), false);
	for (const code of TEAM_PROFILE_ERROR_CODES)
		assert.equal(isTeamProfileError({ name: "TeamProfileError", code }), true);
	for (const code of TEAM_PROFILE_CONFIG_ERROR_CODES) {
		assert.equal(isTeamProfileConfigError({ name: "TeamProfileConfigError", code }), true);
	}
	for (const value of [
		{ name: "TeamProfileError", code: "unknown-code" },
		{ name: "TeamProfileError", code: 7 },
		{ name: "TeamProfileError" },
		{ name: "OtherError", code: "connection-failed" },
		null,
		undefined,
		"TeamProfileError",
	]) {
		assert.equal(isTeamProfileError(value), false, JSON.stringify(value));
		assert.equal(isTeamProfileConfigError(value), false, JSON.stringify(value));
	}
});

test("retryability walks the cause chain up to eight levels (#4320)", () => {
	const retryable = new TeamProfileError("connection-failed", { subject: "s", hint: "h" });
	const permanent = new TeamProfileError("adapter-not-installed", { subject: "s", hint: "h" });
	const wrap = (error: Error, levels: number): Error => {
		let current = error;
		for (let level = 0; level < levels; level++) current = new Error(`level ${level}`, { cause: current });
		return current;
	};
	assert.equal(isRetryableTeamProfileError(retryable), true);
	assert.equal(isRetryableTeamProfileError(wrap(retryable, 7)), true);
	assert.equal(isRetryableTeamProfileError(wrap(retryable, 8)), false);
	assert.equal(isRetryableTeamProfileError(permanent), false);
	assert.equal(isRetryableTeamProfileError(wrap(permanent, 2)), false);
	assert.equal(
		isRetryableTeamProfileError({ name: "TeamProfileError", code: "connection-failed", retryable: true }),
		true,
	);
	assert.equal(
		isRetryableTeamProfileError(new TeamProfileConfigError("missing-url", { source: "env", field: "f", hint: "h" })),
		false,
	);
	assert.equal(isRetryableTeamProfileError(undefined), false);
});
