import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "vitest";
import {
	isRetryableTeamProfileError,
	isTeamProfileConfigError,
	isTeamProfileError,
	isTeamProfileTimeoutError,
	rehydrateTeamError,
	type SerializedTeamError,
	StorageConfigError,
	StorageError,
	serializeTeamError,
	TEAM_PROFILE_CONFIG_ERROR_CODES,
	TEAM_PROFILE_ERROR_CODES,
	TeamProfileConfigError,
	TeamProfileError,
	TeamProfileTimeoutError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { getTeamProfile, leaveTeam } from "../../packages/coding-agent/src/core/storage/index.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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
		["connection-failed", "connection-timeout", "settings-locked", "broker-restart-failed"],
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

test("a timeout is a retryable team error carrying its deadline, elapsed time and phase (#4320)", () => {
	const timeout = new TeamProfileTimeoutError({
		subject: "libsql://db",
		hint: "Retry.",
		timeoutMs: 15000,
		elapsedMs: 15003,
		phase: "connect",
	});
	assert.ok(timeout instanceof TeamProfileError);
	assert.deepEqual(
		[
			timeout.name,
			timeout.code,
			timeout.retryable,
			timeout.timeoutMs,
			timeout.elapsedMs,
			timeout.phase,
			timeout.detail,
		],
		[
			"TeamProfileTimeoutError",
			"connection-timeout",
			true,
			15000,
			15003,
			"connect",
			"no answer within 15000 ms (connect)",
		],
	);
	assert.equal(isTeamProfileTimeoutError(timeout), true);
	assert.equal(isTeamProfileError(timeout), true);
	assert.equal(isRetryableTeamProfileError(new Error("wrapped", { cause: timeout })), true);
	assert.equal(isTeamProfileTimeoutError({ name: "TeamProfileTimeoutError", code: "connection-timeout" }), true);
	assert.equal(isTeamProfileTimeoutError({ name: "TeamProfileTimeoutError", code: "connection-failed" }), false);
	assert.equal(
		isTeamProfileTimeoutError(new TeamProfileError("connection-failed", { subject: "s", hint: "h" })),
		false,
	);
	assert.equal(isTeamProfileError({ name: "TeamProfileTimeoutError", code: "connection-timeout" }), true);
});

test("the code lists, summaries and usage prefixes are the documented ones (#4320)", () => {
	assert.deepEqual(
		[...TEAM_PROFILE_ERROR_CODES],
		[
			"settings-unreadable",
			"adapter-not-installed",
			"connection-failed",
			"connection-timeout",
			"token-write-failed",
			"settings-write-failed",
			"settings-locked",
			"broker-restart-failed",
			"token-delete-failed",
		],
	);
	assert.deepEqual(
		[...TEAM_PROFILE_CONFIG_ERROR_CODES],
		[
			"unknown-profile",
			"incomplete-profile",
			"missing-url",
			"unsupported-url",
			"relative-file-url",
			"credential-in-url",
			"missing-token",
			"conflicting-token",
			"unreadable-token-file",
			"relative-token-file",
			"empty-token",
			"invalid-prefix",
			"unknown-command",
			"unknown-option",
			"missing-value",
			"unexpected-argument",
		],
	);
	const summaries = Object.fromEntries(
		[...TEAM_PROFILE_ERROR_CODES].map((code) => [
			code,
			new TeamProfileError(code, { subject: "s", hint: "h" }).message.replace(": s (", " (").split(" (")[0],
		]),
	);
	assert.deepEqual(summaries, {
		"settings-unreadable": "Cannot update the global settings",
		"adapter-not-installed": "The libSQL storage adapter is not installed",
		"connection-failed": "Could not connect to the team database",
		"connection-timeout": "The team database did not answer in time",
		"token-write-failed": "Could not store the database token",
		"settings-write-failed": "Could not write the global settings",
		"settings-locked": "Another process is writing the settings",
		"broker-restart-failed": "Could not restart the Intercom broker",
		"token-delete-failed": "Could not delete the token file",
	});
	const usage = [...TEAM_PROFILE_CONFIG_ERROR_CODES].filter((code) =>
		new TeamProfileConfigError(code, { source: "cli", field: "f", hint: "h" }).message.startsWith(
			"Invalid team command:",
		),
	);
	assert.deepEqual(usage, ["unknown-command", "unknown-option", "missing-value", "unexpected-argument"]);
});

/** Serialize, send as JSON text, and rehydrate, as a worker, coordinator or broker boundary would. */
function acrossProcesses(error: TeamProfileError | TeamProfileConfigError) {
	const sent: SerializedTeamError = JSON.parse(JSON.stringify(serializeTeamError(error)));
	return { sent, received: rehydrateTeamError(sent) };
}

test("a team error crosses a process boundary as the same class with its code, fields, hint and causes (#4320)", () => {
	const socket = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:8443\n    at internal"), {
		code: "ECONNREFUSED",
		cause: "socket closed",
	});
	const failed = new TeamProfileError("connection-failed", {
		subject: "libsql://team.example.turso.io",
		detail: "connect ECONNREFUSED 10.0.0.5:8443",
		hint: "Check the URL.",
		cause: socket,
	});
	const { sent, received } = acrossProcesses(failed);
	assert.deepEqual(sent, {
		name: "TeamProfileError",
		code: "connection-failed",
		message: failed.message,
		hint: "Check the URL.",
		fields: {
			retryable: true,
			subject: "libsql://team.example.turso.io",
			detail: "connect ECONNREFUSED 10.0.0.5:8443",
		},
		cause: {
			name: "Error",
			message: "ECONNREFUSED",
			code: "ECONNREFUSED",
			cause: { name: "Error", message: "Error" },
		},
	});
	assert.ok(received instanceof TeamProfileError);
	assert.ok(isTeamProfileError(received));
	assert.deepEqual(
		[
			received.name,
			received.code,
			received.subject,
			received.detail,
			received.hint,
			received.retryable,
			received.message,
		],
		["TeamProfileError", "connection-failed", failed.subject, failed.detail, failed.hint, true, failed.message],
	);
	assert.ok(isRetryableTeamProfileError(new Error("worker failed", { cause: received })));
	const cause = received.cause as Error & { code?: string };
	assert.deepEqual([cause.name, cause.message, cause.code], ["Error", "ECONNREFUSED", "ECONNREFUSED"]);
	assert.equal((cause.cause as Error).name, "Error");

	const timeout = new TeamProfileTimeoutError({
		subject: "libsql://team.example.turso.io",
		hint: "Retry.",
		timeoutMs: 15_000,
		elapsedMs: 15_004,
		phase: "connect",
	});
	const timedOut = acrossProcesses(timeout).received;
	assert.ok(timedOut instanceof TeamProfileTimeoutError);
	assert.ok(isTeamProfileTimeoutError(timedOut));
	assert.deepEqual(
		[timedOut.code, timedOut.timeoutMs, timedOut.elapsedMs, timedOut.phase, timedOut.retryable, timedOut.message],
		["connection-timeout", 15_000, 15_004, "connect", true, timeout.message],
	);
	assert.equal(Object.hasOwn(timedOut, "cause"), false);

	const config = new TeamProfileConfigError("incomplete-profile", {
		source: "env",
		field: "ATOMIC_PROFILE",
		hint: "Set it.",
		missing: ["ATOMIC_PROFILE", "ATOMIC_TEAM_TOKEN"],
	});
	const invalid = acrossProcesses(config).received;
	assert.ok(invalid instanceof TeamProfileConfigError);
	assert.ok(invalid instanceof StorageConfigError);
	assert.ok(isTeamProfileConfigError(invalid));
	assert.deepEqual(
		[invalid.code, invalid.reason, invalid.source, invalid.field, invalid.missing, invalid.path, invalid.message],
		["incomplete-profile", "incomplete-profile", "env", "ATOMIC_PROFILE", config.missing, undefined, config.message],
	);
	const unreadable = acrossProcesses(
		new TeamProfileConfigError("unreadable-token-file", {
			source: "cli",
			field: "--token-file",
			hint: "Fix it.",
			path: "/tmp/token",
			cause: new Error("ENOENT"),
		}),
	).received as TeamProfileConfigError;
	assert.deepEqual([unreadable.path, (unreadable.cause as Error).name], ["/tmp/token", "Error"]);
});

test("an unknown team error name keeps its name, code and retryable, and causes stay bounded (#4320)", () => {
	const future = rehydrateTeamError({
		name: "TeamProfileQuotaError",
		code: "quota-exceeded",
		message: "The team database is full (quota-exceeded). Free space.",
		hint: "Free space.",
		fields: { retryable: true, subject: "libsql://team.example.turso.io" },
	});
	assert.ok(future instanceof TeamProfileError);
	assert.deepEqual(
		[future.name, future.code, future.retryable, future.message, future.subject],
		[
			"TeamProfileQuotaError",
			"quota-exceeded",
			true,
			"The team database is full (quota-exceeded). Free space.",
			"libsql://team.example.turso.io",
		],
	);
	let deep: Error = new Error("level 12");
	for (let level = 11; level >= 1; level--) deep = new Error(`level ${level}`, { cause: deep });
	const { sent } = acrossProcesses(
		new TeamProfileError("settings-write-failed", { subject: "/s.json", hint: "Fix it.", cause: deep }),
	);
	let levels = 0;
	for (let cause = sent.cause; cause !== undefined; cause = cause.cause) levels++;
	assert.equal(levels, 8);
});

test("serialized team errors carry only the fields that are set, and causes keep only their own facts (#4320)", () => {
	assert.deepEqual(
		serializeTeamError(new TeamProfileError("settings-locked", { subject: "/s.json", hint: "Retry." })),
		{
			name: "TeamProfileError",
			code: "settings-locked",
			message: "Another process is writing the settings: /s.json (settings-locked). Retry.",
			hint: "Retry.",
			fields: { retryable: true, subject: "/s.json" },
		},
	);
	assert.deepEqual(
		serializeTeamError(
			new TeamProfileConfigError("missing-url", { source: "sdk", field: "url", hint: "Pass the URL." }),
		).fields,
		{ retryable: false, source: "sdk", field: "url" },
	);
	const chained = serializeTeamError(
		new TeamProfileError("token-delete-failed", {
			subject: "/t",
			hint: "Delete it.",
			cause: new Error("outer", { cause: null }),
		}),
	);
	assert.deepEqual(chained.cause, { name: "Error", message: "Error" });

	const received = rehydrateTeamError({
		name: "TeamProfileError",
		code: "connection-failed",
		message: "m",
		hint: "h",
		fields: { retryable: true, subject: "s" },
		cause: { name: "TypeError", message: "outer", cause: { name: "Error", message: "inner", code: "EPIPE" } },
	});
	const outer = received.cause as Error;
	const inner = outer.cause as Error & { code?: string };
	assert.deepEqual([outer.name, outer.message, Object.hasOwn(outer, "code")], ["TypeError", "outer", false]);
	assert.deepEqual([inner.message, inner.code, Object.hasOwn(inner, "cause")], ["inner", "EPIPE", false]);
	assert.deepEqual(Object.getOwnPropertyDescriptor(received, "message"), {
		value: "m",
		writable: true,
		enumerable: false,
		configurable: true,
	});
});

test("a serialized cause keeps its name and code but never its own message, which can quote a settings file (#4320)", () => {
	let parserError: unknown;
	try {
		JSON.parse('{"token": sk-synthetic-value}');
	} catch (error) {
		parserError = error;
	}
	assert.ok(parserError instanceof SyntaxError);
	assert.match(parserError.message, /sk-synthet/);
	const denied = Object.assign(new Error("EACCES: permission denied, open '/x/sk-synthetic-value'"), {
		code: "EACCES",
		cause: "sk-synthetic-value",
	});
	const wrapped = new TeamProfileError("settings-write-failed", {
		subject: "/settings.json",
		hint: "Fix it.",
		cause: denied,
	});
	const unreadable = new TeamProfileError("settings-unreadable", {
		subject: "/settings.json",
		detail: "not valid JSON",
		hint: "Fix it.",
		cause: new Error("outer", { cause: parserError }),
	});
	const { sent, received } = acrossProcesses(unreadable);
	assert.doesNotMatch(JSON.stringify(sent), /sk-synthet|outer/);
	assert.deepEqual(sent.cause, {
		name: "Error",
		message: "Error",
		cause: { name: "SyntaxError", message: "SyntaxError" },
	});
	assert.equal(((received.cause as Error).cause as Error).name, "SyntaxError");

	const chained = acrossProcesses(
		new TeamProfileError("broker-restart-failed", { subject: "/agent", hint: "Restart.", cause: wrapped }),
	);
	assert.doesNotMatch(JSON.stringify(chained.sent), /sk-synthet/);
	assert.deepEqual(chained.sent.cause, {
		name: "TeamProfileError",
		code: "settings-write-failed",
		message: wrapped.message,
		hint: "Fix it.",
		fields: { retryable: false, subject: "/settings.json" },
		cause: { name: "Error", message: "EACCES", code: "EACCES", cause: { name: "Error", message: "Error" } },
	});
	assert.ok(isTeamProfileError(chained.received.cause));

	const disguised = Object.assign(new Error("m"), { name: "token sk-synthetic-value", code: "bad code sk-synthetic" });
	const quoted = serializeTeamError(
		new TeamProfileError("token-delete-failed", { subject: "/t", hint: "h", cause: disguised }),
	);
	assert.deepEqual(quoted.cause, { name: "Error", message: "Error" });

	const untyped = Object.assign(new Error("raw sk-synthetic-value"), { name: true, code: true });
	const coerced = serializeTeamError(
		new TeamProfileError("token-delete-failed", { subject: "/t", hint: "h", cause: untyped }),
	);
	assert.deepEqual(coerced.cause, { name: "Error", message: "Error" });
});

test("a cause from another realm or a callable cause serializes from its name and code alone (#4320)", () => {
	const foreign = runInNewContext(
		'Object.assign(new Error("raw sk-synthetic-value"), { name: "TeamProfileError", code: "settings-locked" })',
	) as unknown;
	assert.equal(foreign instanceof Error, false);
	assert.ok(isTeamProfileError(foreign));
	const fromRealm = serializeTeamError(
		new TeamProfileError("token-delete-failed", {
			subject: "/t",
			hint: "h",
			cause: new Error("wrapper", { cause: foreign }),
		}),
	);
	assert.doesNotMatch(JSON.stringify(fromRealm), /sk-syn/);
	assert.deepEqual(fromRealm.cause, {
		name: "Error",
		message: "Error",
		cause: { name: "Error", message: "settings-locked", code: "settings-locked" },
	});

	const callable = Object.defineProperty(() => undefined, "code", {
		get: () => assert.fail("the serializer inspected a callable cause"),
	});
	const fromCallable = serializeTeamError(
		new TeamProfileError("token-delete-failed", {
			subject: "/t",
			hint: "h",
			cause: new Error("wrapper", { cause: callable }),
		}),
	);
	assert.deepEqual(fromCallable.cause, {
		name: "Error",
		message: "Error",
		cause: { name: "Error", message: "Error" },
	});
});

test("a nested team error crosses a process boundary as its own class, so retry decisions do not change (#4320)", () => {
	const failed = new TeamProfileError("connection-failed", {
		subject: "libsql://team.example.invalid",
		detail: "ECONNREFUSED",
		hint: "Check the URL.",
		cause: Object.assign(new Error("raw sk-synthetic-value"), { code: "ECONNREFUSED" }),
	});
	const outer = new TeamProfileError("settings-write-failed", { subject: "/s.json", hint: "Fix it.", cause: failed });
	assert.equal(outer.retryable, false);
	assert.ok(isRetryableTeamProfileError(outer));
	const { sent, received } = acrossProcesses(outer);
	assert.doesNotMatch(JSON.stringify(sent), /sk-syn/);
	assert.ok(isRetryableTeamProfileError(received));
	const nested = received.cause;
	assert.ok(nested instanceof TeamProfileError);
	assert.deepEqual(
		[nested.name, nested.code, nested.subject, nested.detail, nested.hint, nested.retryable, nested.message],
		["TeamProfileError", "connection-failed", failed.subject, "ECONNREFUSED", "Check the URL.", true, failed.message],
	);
	const driver = nested.cause as Error & { code?: string };
	assert.deepEqual([driver.name, driver.message, driver.code], ["Error", "ECONNREFUSED", "ECONNREFUSED"]);

	const timeout = new TeamProfileTimeoutError({
		subject: "libsql://team.example.invalid",
		hint: "Retry.",
		timeoutMs: 300,
		elapsedMs: 301,
		phase: "connect",
	});
	const future = rehydrateTeamError({
		name: "TeamProfileQuotaError",
		code: "quota-exceeded",
		message: "The team database is full (quota-exceeded). Free space.",
		hint: "Free space.",
		fields: { retryable: true, subject: "libsql://team.example.invalid" },
	});
	for (const inner of [timeout, future]) {
		const wrapped = new TeamProfileError("token-delete-failed", {
			subject: "/t",
			hint: "Delete it.",
			cause: new Error("worker failed", { cause: inner }),
		});
		const delivered = acrossProcesses(wrapped).received;
		assert.equal(delivered.retryable, false);
		assert.ok(isRetryableTeamProfileError(delivered));
		const restored = (delivered.cause as Error).cause;
		assert.ok(restored instanceof TeamProfileError);
		assert.deepEqual(
			[restored.name, restored.code, restored.retryable, restored.message],
			[inner.name, inner.code, true, inner.message],
		);
	}
	const restoredTimeout = acrossProcesses(
		new TeamProfileError("token-delete-failed", { subject: "/t", hint: "Delete it.", cause: timeout }),
	).received.cause;
	assert.ok(restoredTimeout instanceof TeamProfileTimeoutError);
	assert.deepEqual(
		[restoredTimeout.timeoutMs, restoredTimeout.elapsedMs, restoredTimeout.phase],
		[300, 301, "connect"],
	);

	let chain: Error = new Error("level 12");
	for (let level = 11; level >= 1; level--) {
		chain = new TeamProfileError("token-delete-failed", { subject: `/t${level}`, hint: "h", cause: chain });
	}
	const deep = acrossProcesses(
		new TeamProfileError("settings-write-failed", { subject: "/s", hint: "h", cause: chain }),
	);
	let sentLevels = 0;
	for (let cause = deep.sent.cause; cause !== undefined; cause = cause.cause) sentLevels++;
	let receivedLevels = 0;
	for (let cause = deep.received.cause; cause instanceof Error; cause = cause.cause) receivedLevels++;
	assert.deepEqual([sentLevels, receivedLevels], [8, 8]);

	let crafted: SerializedTeamError["cause"];
	for (let level = 12; level >= 1; level--) {
		crafted = {
			name: "TeamProfileError",
			code: "connection-failed",
			message: `level ${level}`,
			hint: "h",
			fields: { retryable: true, subject: "s" },
			...(crafted === undefined ? {} : { cause: crafted }),
		};
	}
	const bounded = rehydrateTeamError({ ...deep.sent, cause: crafted });
	let boundedLevels = 0;
	for (let cause = bounded.cause; cause instanceof Error; cause = cause.cause) boundedLevels++;
	assert.equal(boundedLevels, 8);

	const malformed = rehydrateTeamError({
		...deep.sent,
		cause: { name: "TeamProfileError", code: "connection-failed", message: "m", hint: "h", fields: null as never },
	}).cause;
	assert.ok(malformed instanceof Error);
	assert.equal(malformed instanceof TeamProfileError, false);
	assert.equal(malformed.message, "m");
});

function foreignTeamError(message: string, props: Readonly<Record<string, unknown>>): unknown {
	return runInNewContext(
		'Object.assign(new Error(message), props, { cause: Object.assign(new Error("raw sk-synthetic-value"), { code: "ECONNREFUSED" }) })',
		{ message, props },
	);
}

function serializedNestedCause(cause: unknown): SerializedTeamError["cause"] {
	return serializeTeamError(
		new TeamProfileError("token-delete-failed", { subject: "/t", hint: "h", cause: new Error("w", { cause }) }),
	).cause?.cause;
}

test("a team error from another realm with complete fields crosses a process boundary as its own class (#4320)", () => {
	const local = new TeamProfileError("connection-failed", {
		subject: "libsql://team.example.invalid",
		detail: "ECONNREFUSED",
		hint: "Check the URL.",
	});
	const foreign = foreignTeamError(local.message, {
		name: "TeamProfileError",
		code: "connection-failed",
		subject: local.subject,
		detail: local.detail,
		hint: local.hint,
		retryable: true,
	});
	assert.equal(foreign instanceof Error, false);
	const outer = new TeamProfileError("settings-write-failed", {
		subject: "/s.json",
		hint: "Fix it.",
		cause: new Error("worker failed", { cause: foreign }),
	});
	assert.equal(outer.retryable, false);
	assert.ok(isRetryableTeamProfileError(outer));
	const { sent, received } = acrossProcesses(outer);
	assert.doesNotMatch(JSON.stringify(sent), /sk-syn/);
	assert.ok(isRetryableTeamProfileError(received));
	const restored = (received.cause as Error).cause;
	assert.ok(restored instanceof TeamProfileError);
	assert.deepEqual(
		[restored.name, restored.code, restored.subject, restored.detail, restored.hint, restored.retryable],
		["TeamProfileError", "connection-failed", local.subject, "ECONNREFUSED", "Check the URL.", true],
	);
	assert.equal(restored.message, local.message);
	const driver = restored.cause as Error & { code?: string };
	assert.deepEqual([driver.name, driver.message, driver.code], ["Error", "ECONNREFUSED", "ECONNREFUSED"]);

	const timeoutProps = {
		name: "TeamProfileTimeoutError",
		code: "connection-timeout",
		subject: local.subject,
		hint: "Retry.",
		retryable: true,
		timeoutMs: 300,
		elapsedMs: 301,
		phase: "connect",
	};
	const timeout = acrossProcesses(
		new TeamProfileError("token-delete-failed", {
			subject: "/t",
			hint: "h",
			cause: new Error("worker failed", { cause: foreignTeamError("timed out", timeoutProps) }),
		}),
	).received;
	assert.ok(isRetryableTeamProfileError(timeout));
	const restoredTimeout = (timeout.cause as Error).cause;
	assert.ok(restoredTimeout instanceof TeamProfileTimeoutError);
	assert.deepEqual(
		[restoredTimeout.timeoutMs, restoredTimeout.elapsedMs, restoredTimeout.phase],
		[300, 301, "connect"],
	);

	const configProps = {
		name: "TeamProfileConfigError",
		code: "incomplete-profile",
		source: "env",
		field: "ATOMIC_PROFILE",
		hint: "Set them.",
		retryable: false,
		missing: ["ATOMIC_TEAM_URL"],
	};
	const config = acrossProcesses(
		new TeamProfileError("token-delete-failed", {
			subject: "/t",
			hint: "h",
			cause: new Error("worker failed", { cause: foreignTeamError("incomplete", configProps) }),
		}),
	).received;
	const restoredConfig = (config.cause as Error).cause;
	assert.ok(restoredConfig instanceof TeamProfileConfigError);
	assert.deepEqual(
		[restoredConfig.code, restoredConfig.source, restoredConfig.field, restoredConfig.missing],
		["incomplete-profile", "env", "ATOMIC_PROFILE", ["ATOMIC_TEAM_URL"]],
	);

	const incomplete: readonly Readonly<Record<string, unknown>>[] = [
		{ name: "TeamProfileError", code: "connection-failed", subject: "s", hint: "h", retryable: "true" },
		{ name: "TeamProfileError", code: "connection-failed", subject: 7, hint: "h", retryable: true },
		{ name: "TeamProfileError", code: "connection-failed", subject: "s", detail: 7, hint: "h", retryable: true },
		{ name: "TeamProfileError", code: "connection-failed", subject: "s", hint: 7, retryable: true },
		{ ...timeoutProps, timeoutMs: "300" },
		{ ...timeoutProps, elapsedMs: "301" },
		{ ...timeoutProps, phase: 1 },
		{ ...configProps, source: 1 },
		{ ...configProps, field: 1 },
		{ ...configProps, path: 1 },
		{ ...configProps, missing: [1] },
		{ ...configProps, missing: "ATOMIC_TEAM_URL" },
	];
	for (const props of incomplete) {
		assert.deepEqual(
			serializedNestedCause(foreignTeamError("raw sk-synthetic-value", props)),
			{ name: "Error", message: props.code, code: props.code },
			JSON.stringify(props),
		);
	}
	const untypedMessage = runInNewContext(
		'Object.assign(new Error(), { name: "TeamProfileError", code: "connection-failed", subject: "s", hint: "h", retryable: true, message: 7 })',
	);
	assert.deepEqual(serializedNestedCause(untypedMessage), {
		name: "Error",
		message: "connection-failed",
		code: "connection-failed",
	});
});

test("only a cause in the team error family with complete fields is serialized as a team error (#4320)", () => {
	const lookalike = Object.assign(new Error("raw sk-synthetic-value"), {
		code: "ECONNREFUSED",
		subject: "libsql://team.example.invalid",
		hint: "Check the URL.",
		retryable: true,
	});
	assert.deepEqual(serializedNestedCause(lookalike), { name: "Error", message: "ECONNREFUSED", code: "ECONNREFUSED" });

	const withoutMissing = new TeamProfileConfigError("missing-url", { source: "sdk", field: "url", hint: "Pass it." });
	const restored = acrossProcesses(
		new TeamProfileError("token-delete-failed", { subject: "/t", hint: "h", cause: withoutMissing }),
	).received.cause;
	assert.ok(restored instanceof TeamProfileConfigError);
	assert.deepEqual([restored.code, restored.field, restored.missing], ["missing-url", "url", undefined]);

	const mixedMissing = foreignTeamError("raw sk-synthetic-value", {
		name: "TeamProfileConfigError",
		code: "incomplete-profile",
		source: "env",
		field: "ATOMIC_PROFILE",
		hint: "Set them.",
		retryable: false,
		missing: ["ATOMIC_TEAM_URL", 1],
	});
	assert.deepEqual(serializedNestedCause(mixedMissing), {
		name: "Error",
		message: "incomplete-profile",
		code: "incomplete-profile",
	});
});

test("a serialized cause rehydrates as a team error only with a string code and hint and object fields (#4320)", () => {
	const outer = serializeTeamError(new TeamProfileError("token-delete-failed", { subject: "/t", hint: "h" }));
	const complete = {
		name: "TeamProfileError",
		code: "connection-failed",
		message: "m",
		hint: "h",
		fields: { retryable: true, subject: "s" },
	};
	const rehydrated = (cause: Readonly<Record<string, unknown>>) =>
		rehydrateTeamError({ ...outer, cause: cause as unknown as SerializedTeamError["cause"] }).cause;
	assert.ok(rehydrated(complete) instanceof TeamProfileError);
	const { code: _code, ...withoutCode } = complete;
	const { hint: _hint, ...withoutHint } = complete;
	const { fields: _fields, ...withoutFields } = complete;
	const malformed = [
		withoutCode,
		withoutHint,
		withoutFields,
		{ ...complete, code: 7 },
		{ ...complete, hint: 7 },
		{ ...complete, fields: "retryable" },
	];
	for (const cause of malformed) {
		const restored = rehydrated(cause);
		assert.ok(restored instanceof Error, JSON.stringify(cause));
		assert.equal(restored instanceof TeamProfileError, false, JSON.stringify(cause));
		assert.equal(restored.message, "m");
	}

	let deep: SerializedTeamError["cause"];
	for (let level = 50; level >= 1; level--) {
		deep = { name: "Error", message: `level ${level}`, ...(deep === undefined ? {} : { cause: deep }) };
	}
	let levels = 0;
	for (
		let cause = rehydrated(deep as unknown as Readonly<Record<string, unknown>>);
		cause instanceof Error;
		cause = cause.cause
	)
		levels++;
	assert.equal(levels, 8);
});

test("a malformed settings file reaches getTeamProfile and leaveTeam callers, serialized, without its content (#4320)", async () => {
	const credential = "sk-synthetic-team-credential";
	const root = makeTempDirectory("team-errors-");
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const settingsPath = join(agentDir, "settings.json");
		const malformed = `{"storage": {"adapter": "libsql", "token": ${credential}}}`;
		writeFileSync(settingsPath, malformed);

		const thrown = [
			await getTeamProfile({ agentDir, cwd }).then(
				() => assert.fail("read malformed settings"),
				(error: unknown) => error,
			),
			await leaveTeam({ agentDir, cwd }).then(
				() => assert.fail("left with malformed settings"),
				(error: unknown) => error,
			),
		];
		assert.equal(readFileSync(settingsPath, "utf8"), malformed);
		for (const error of thrown) {
			assert.ok(error instanceof TeamProfileError);
			assert.equal(error.code, "settings-unreadable");
			assert.ok(error.cause instanceof Error, "the parser failure stays attached as the cause");
			const { sent, received } = acrossProcesses(error);
			assert.doesNotMatch(JSON.stringify(sent), /sk-syn/);
			assert.ok(sent.cause !== undefined, "the cause chain is serialized");
			let deepest: SerializedTeamError["cause"] = sent.cause;
			while (deepest?.cause !== undefined) deepest = deepest.cause;
			assert.equal(deepest?.name, "SyntaxError");
			assert.ok(isTeamProfileError(received));
			assert.equal(received.code, "settings-unreadable");
		}
	} finally {
		removeTempDirectory(root);
	}
});

test("a rehydrated timeout keeps its subject and cause, and malformed fields fall back to safe defaults (#4320)", () => {
	const timedOut = rehydrateTeamError({
		name: "TeamProfileTimeoutError",
		code: "connection-timeout",
		message: "m",
		hint: "h",
		fields: { retryable: true, subject: "libsql://team", timeoutMs: 300, elapsedMs: 301, phase: "connect" },
		cause: { name: "Error", message: "late" },
	}) as TeamProfileTimeoutError;
	assert.equal(timedOut.subject, "libsql://team");
	const cause = Object.getOwnPropertyDescriptor(timedOut, "cause");
	assert.deepEqual([cause?.writable, cause?.enumerable, cause?.configurable], [true, false, true]);
	assert.ok(cause);
	assert.equal((cause.value as Error).message, "late");

	const malformedTimeout = rehydrateTeamError({
		name: "TeamProfileTimeoutError",
		code: "connection-timeout",
		message: "m",
		hint: "h",
		fields: { timeoutMs: "300", elapsedMs: "301" },
	}) as TeamProfileTimeoutError;
	assert.deepEqual(
		[malformedTimeout.subject, malformedTimeout.timeoutMs, malformedTimeout.elapsedMs, malformedTimeout.phase],
		["", 0, 0, "connect"],
	);
	assert.equal(malformedTimeout.retryable, true);
	const malformedConfig = rehydrateTeamError({
		name: "TeamProfileConfigError",
		code: "missing-url",
		message: "m",
		hint: "h",
		fields: { source: "sdk", retryable: "no" },
	}) as TeamProfileConfigError;
	assert.deepEqual([malformedConfig.field, malformedConfig.retryable], ["", false]);
	const malformed = rehydrateTeamError({
		name: "TeamProfileError",
		code: "connection-failed",
		message: "m",
		hint: "h",
		fields: { subject: 7, detail: false },
	});
	assert.ok(malformed instanceof TeamProfileError);
	assert.deepEqual([malformed.subject, Object.hasOwn(malformed, "detail"), malformed.retryable], ["", false, true]);
});
