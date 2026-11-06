import assert from "node:assert/strict";
import {
	deserializeSubscriptionError,
	EventSourceError,
	findSubscriptionError,
	isEventSourceError,
	isRetryableSubscriptionError,
	isSubscriptionChildUnavailableError,
	isSubscriptionClosedError,
	isSubscriptionConfigError,
	isSubscriptionError,
	isSubscriptionEventError,
	isSubscriptionHandlerError,
	isSubscriptionSetupError,
	isSubscriptionSubscriberUnavailableError,
	type SerializedSubscriptionError,
	SubscriptionChildUnavailableError,
	SubscriptionClosedError,
	SubscriptionConfigError,
	SubscriptionError,
	SubscriptionEventError,
	SubscriptionHandlerError,
	SubscriptionSetupError,
	SubscriptionSubscriberUnavailableError,
	serializeSubscriptionError,
} from "@bastani/atomic";
import { test } from "vitest";

const guards = {
	SubscriptionClosedError: isSubscriptionClosedError,
	SubscriptionConfigError: isSubscriptionConfigError,
	SubscriptionEventError: isSubscriptionEventError,
	EventSourceError: isEventSourceError,
	SubscriptionHandlerError: isSubscriptionHandlerError,
	SubscriptionChildUnavailableError: isSubscriptionChildUnavailableError,
	SubscriptionSetupError: isSubscriptionSetupError,
	SubscriptionSubscriberUnavailableError: isSubscriptionSubscriberUnavailableError,
} as const;

const examples = (): readonly SubscriptionError[] => [
	new SubscriptionClosedError("run-1/ci#1", "publish"),
	new SubscriptionConfigError("options.maxConcurrent", "not-positive-integer"),
	new SubscriptionEventError("run-1/ci#1", "missing-id"),
	new EventSourceError("github-checks:o/r#1", "poll", {
		detail: "gh exited with code 1",
		retryable: true,
		cause: new Error("gh failed"),
	}),
	new SubscriptionHandlerError("run-1/ci#1", "evt-3", new TypeError("bad payload")),
	new SubscriptionChildUnavailableError("sess-1/list#1", "sess-1"),
	new SubscriptionSetupError("gh-cli", { cause: new Error("spawn gh ENOENT") }),
	new SubscriptionSubscriberUnavailableError("run-1/ci#1", "watcher", "invalid_session"),
];

test("each subscription error has its family, literal name, stable code, fields and hint", () => {
	const shapes = examples().map((error) => ({
		family: error instanceof SubscriptionError && error instanceof Error,
		name: error.name,
		code: error.code,
		retryable: error.retryable,
		fields: error.fields(),
		hasHint: typeof error.hint === "string" && error.hint.length > 0 && error.message.endsWith(error.hint),
	}));
	assert.deepEqual(shapes, [
		{
			family: true,
			name: "SubscriptionClosedError",
			code: "subscription-closed",
			retryable: false,
			fields: { subscriptionId: "run-1/ci#1", operation: "publish" },
			hasHint: true,
		},
		{
			family: true,
			name: "SubscriptionConfigError",
			code: "invalid-option",
			retryable: false,
			fields: {
				source: "sdk",
				field: "options.maxConcurrent",
				reason: "not-positive-integer",
				expected: "a positive integer",
			},
			hasHint: true,
		},
		{
			family: true,
			name: "SubscriptionEventError",
			code: "invalid-event",
			retryable: false,
			fields: { subscriptionId: "run-1/ci#1", reason: "missing-id" },
			hasHint: true,
		},
		{
			family: true,
			name: "EventSourceError",
			code: "source-failed",
			retryable: true,
			fields: { sourceId: "github-checks:o/r#1", phase: "poll", detail: "gh exited with code 1" },
			hasHint: true,
		},
		{
			family: true,
			name: "SubscriptionHandlerError",
			code: "handler-failed",
			retryable: false,
			fields: { subscriptionId: "run-1/ci#1", eventId: "evt-3" },
			hasHint: true,
		},
		{
			family: true,
			name: "SubscriptionChildUnavailableError",
			code: "child-unavailable",
			retryable: false,
			fields: { subscriptionId: "sess-1/list#1", sessionId: "sess-1" },
			hasHint: true,
		},
		{
			family: true,
			name: "SubscriptionSetupError",
			code: "setup-missing",
			retryable: false,
			fields: { missing: "gh-cli" },
			hasHint: true,
		},
		{
			family: true,
			name: "SubscriptionSubscriberUnavailableError",
			code: "subscriber-unavailable",
			retryable: false,
			fields: { subscriptionId: "run-1/ci#1", subscriber: "watcher", reason: "invalid_session" },
			hasHint: true,
		},
	]);
	assert.deepEqual(new SubscriptionError("invalid-event", "x").fields(), {});
	assert.equal(new SubscriptionError("invalid-event", "x").name, "SubscriptionError");
	assert.equal(new SubscriptionError("invalid-event", "x").hint, undefined);
	assert.deepEqual(new EventSourceError("s", "start").fields(), { sourceId: "s", phase: "start", detail: null });
	assert.equal(new EventSourceError("s", "start").retryable, false);
});

test("rendered messages state what failed, the subject, the code and what to do", () => {
	assert.deepEqual(
		examples().map((error) => error.message),
		[
			"Subscription is closed: run-1/ci#1 (subscription-closed). Use the id of an open subscription; a closed subscription accepts no events or reports.",
			"Invalid subscription option: options.maxConcurrent (invalid-option). Pass a positive integer for options.maxConcurrent.",
			"Invalid subscription event: run-1/ci#1 (invalid-event). Emit objects shaped { id: string, type?: string, payload?: JSON value }; the id drives deduplication.",
			"Event source failed during poll (gh exited with code 1): github-checks:o/r#1 (source-failed). Check the source's configuration and access, then subscribe again.",
			"Event handler failed for event evt-3: run-1/ci#1 (handler-failed). Inspect the cause, fix the handler, then subscribe again; events already handled are not repeated.",
			"Event child session unavailable: sess-1/list#1 (child-unavailable). Create the session with createAgentSession() so it can start child sessions, or report directly.",
			"Subscription setup is missing: the GitHub CLI (gh) that githubChecks and githubReviews run (setup-missing). Install the GitHub CLI from https://cli.github.com (for example `brew install gh` or `winget install GitHub.cli`), then run `gh auth login`.",
			'Subscriber stage "watcher" cannot take reports (invalid_session): run-1/ci#1 (subscriber-unavailable). The subscriber stage was replayed after a resume and its retained session could not be reopened; subscribe from a stage that runs in this run, or start the run again instead of resuming it.',
		],
	);
	assert.equal(
		new EventSourceError("webhook:/hooks", "listen").message,
		"Event source failed during listen: webhook:/hooks (source-failed). Choose a free port or hostname for the webhook source, then subscribe again.",
	);
	const reasons = [
		"duplicate-id",
		"duplicate-path",
		"not-absolute-path",
		"not-event-source",
		"not-function",
		"not-owner-repo",
		"not-positive-integer",
		"not-stage",
		"not-string",
		"out-of-range",
	] as const;
	assert.deepEqual(
		reasons.map((reason) => new SubscriptionConfigError("f", reason).hint),
		[
			"Pass a value that no other open subscription in this process uses for f.",
			"Pass a path that no other open webhook source on this host and port uses for f.",
			"Pass a path that starts with /, for example /hooks/ci for f.",
			"Pass an EventSource with a string id and a start(signal, emit) function for f.",
			"Pass a function for f.",
			"Pass a repository as owner/name, for example acme/widgets for f.",
			"Pass a positive integer for f.",
			"Pass a stage returned by ctx.stage() for f.",
			"Pass a non-empty string for f.",
			"Pass a value inside the allowed range for f.",
		],
	);
	const ranged = new SubscriptionConfigError("webhook.port", "out-of-range", "an integer from 0 to 65535");
	assert.equal(ranged.expected, "an integer from 0 to 65535");
	assert.equal(ranged.hint, "Pass an integer from 0 to 65535 for webhook.port.");
	assert.equal(
		new SubscriptionClosedError("sess-1/ci", "subscribe").hint,
		"Subscribe while the session is open; a closed session accepts no subscriptions.",
	);
	assert.equal(
		new SubscriptionClosedError("run-1/ci#1", "emit").hint,
		"Use the id of an open subscription; a closed subscription accepts no events or reports.",
	);
	const sourceHints = (["start", "listen", "poll", "read", "request"] as const).map(
		(phase) => new EventSourceError("s", phase).hint,
	);
	assert.deepEqual(sourceHints, [
		"Check the source's configuration and access, then subscribe again.",
		"Choose a free port or hostname for the webhook source, then subscribe again.",
		"Check the source's configuration and access, then subscribe again.",
		"Check the source's configuration and access, then subscribe again.",
		"Inspect the cause; the sender can send the delivery again.",
	]);
	assert.equal(new EventSourceError("s", "poll", { hint: "Run the fix." }).hint, "Run the fix.");
	assert.equal(
		new SubscriptionSetupError("gh-auth").message,
		"Subscription setup is missing: a GitHub login for gh (setup-missing). Run `gh auth login`, then subscribe again.",
	);
});

test("guards match their own class only, structurally across realms, and through a bounded cause chain", () => {
	for (const error of examples()) {
		for (const [name, guard] of Object.entries(guards)) {
			assert.equal(guard(error), name === error.name, `${name} vs ${error.name}`);
		}
		assert.equal(isSubscriptionError(error), true);
		const structural = { name: error.name, code: error.code, message: error.message };
		assert.equal(guards[error.name as keyof typeof guards](structural), true);
		assert.equal(isSubscriptionError(structural), true);
		const wrapped = new Error("outer", { cause: new Error("middle", { cause: error }) });
		assert.equal(guards[error.name as keyof typeof guards](wrapped), true);
		assert.equal(findSubscriptionError(wrapped), error);
	}
	assert.equal(isSubscriptionClosedError({ name: "SubscriptionClosedError", code: "invalid-option" }), false);
	assert.equal(isSubscriptionError({ name: "SubscriptionError", code: "not-a-code" }), false);
	assert.equal(isSubscriptionError({ name: "OtherError", code: "invalid-option" }), false);
	assert.equal(isSubscriptionError({ name: "SubscriptionError", code: "invalid-option" }), true);
	assert.equal(isSubscriptionError(null), false);
	assert.equal(isSubscriptionError("SubscriptionClosedError"), false);
	assert.equal(isSubscriptionError(new Error("plain")), false);
	let deep: unknown = new SubscriptionClosedError("deep", "emit");
	for (let depth = 0; depth < 8; depth++) deep = new Error(`level ${depth}`, { cause: deep });
	assert.equal(isSubscriptionClosedError(deep), false);
	assert.equal(findSubscriptionError(deep), undefined);
	let shallow: unknown = new SubscriptionClosedError("shallow", "emit");
	for (let depth = 0; depth < 7; depth++) shallow = new Error(`level ${depth}`, { cause: shallow });
	assert.equal(isSubscriptionClosedError(shallow), true);
});

test("retryability is explicit and read from the first subscription error in the chain", () => {
	const retryable = new EventSourceError("gh", "poll", { retryable: true });
	assert.equal(isRetryableSubscriptionError(retryable), true);
	assert.equal(isRetryableSubscriptionError(new Error("outer", { cause: retryable })), true);
	assert.equal(isRetryableSubscriptionError(new SubscriptionHandlerError("s", "e", retryable)), false);
	assert.equal(isRetryableSubscriptionError(new Error("plain")), false);
	assert.equal(isRetryableSubscriptionError(undefined), false);
});

test("serialized errors survive a process boundary and rehydrate as the same class with fields and causes", () => {
	for (const error of examples()) {
		const wire = JSON.parse(JSON.stringify(serializeSubscriptionError(error))) as SerializedSubscriptionError;
		const rebuilt = deserializeSubscriptionError(wire);
		assert.equal(rebuilt.constructor, error.constructor, error.name);
		assert.equal(guards[error.name as keyof typeof guards](rebuilt), true);
		assert.deepEqual(
			{
				name: rebuilt.name,
				code: rebuilt.code,
				message: rebuilt.message,
				hint: rebuilt.hint,
				retryable: rebuilt.retryable,
				fields: rebuilt.fields(),
			},
			{
				name: error.name,
				code: error.code,
				message: error.message,
				hint: error.hint,
				retryable: error.retryable,
				fields: error.fields(),
			},
		);
		const cause = error.cause as Error | undefined;
		assert.equal((rebuilt.cause as Error | undefined)?.message, cause?.message);
		assert.equal((rebuilt.cause as Error | undefined)?.name, cause?.name);
		if (cause !== undefined) {
			assert.deepEqual(Object.getOwnPropertyDescriptor(rebuilt, "cause"), {
				value: rebuilt.cause,
				writable: true,
				enumerable: false,
				configurable: true,
			});
		}
	}
	const chained = new SubscriptionHandlerError(
		"s",
		"e",
		new EventSourceError("gh", "poll", { cause: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }),
	);
	const rebuilt = deserializeSubscriptionError(serializeSubscriptionError(chained));
	assert.equal(((rebuilt.cause as Error).cause as { code?: string }).code, "ENOENT");
	assert.equal((rebuilt.cause as { code?: string }).code, "source-failed");
	assert.equal(isEventSourceError(rebuilt), true);
	const unknown = deserializeSubscriptionError({
		name: "SubscriptionQuotaError",
		code: "invalid-option",
		message: "future error",
		hint: "upgrade",
		retryable: true,
		fields: {},
	});
	assert.equal(unknown instanceof SubscriptionError, true);
	assert.deepEqual(
		[unknown.name, unknown.code, unknown.hint, unknown.retryable],
		["SubscriptionQuotaError", "invalid-option", "upgrade", true],
	);
	assert.equal(serializeSubscriptionError(new SubscriptionError("invalid-event", "x")).cause, undefined);
	const primitiveCause = serializeSubscriptionError(new SubscriptionHandlerError("s", "e", "text failure"));
	assert.deepEqual(primitiveCause.cause, { name: "string", message: "text failure" });
});

test("the wire form keeps optional parts only when present, and bounds the cause chain at eight levels", () => {
	const bare = serializeSubscriptionError(new SubscriptionError("invalid-event", "bare"));
	assert.deepEqual(Object.keys(bare).sort(), ["code", "fields", "message", "name", "retryable"]);
	const hinted = serializeSubscriptionError(new SubscriptionClosedError("s", "report"));
	assert.equal(hinted.hint, new SubscriptionClosedError("s", "report").hint);
	let deep: Error = new Error("level 0");
	for (let level = 1; level <= 12; level++) deep = new Error(`level ${level}`, { cause: deep });
	let serialized = serializeSubscriptionError(new SubscriptionHandlerError("s", "e", deep)).cause;
	let depth = 0;
	while (serialized !== undefined) {
		depth += 1;
		serialized = serialized.cause;
	}
	assert.equal(depth, 8);
	const withCode = deserializeSubscriptionError(
		serializeSubscriptionError(new SubscriptionHandlerError("s", "e", Object.assign(new Error("x"), { code: "E1" }))),
	);
	assert.deepEqual(Object.keys(withCode.cause as object), ["code"]);
	const withoutCode = deserializeSubscriptionError(
		serializeSubscriptionError(new SubscriptionHandlerError("s", "e", new Error("y"))),
	);
	assert.equal("code" in (withoutCode.cause as object), false);
});

test("rehydration tolerates malformed fields and keeps causes on every class", () => {
	const cause = { name: "Error", message: "underlying" };
	const closed = deserializeSubscriptionError({
		name: "SubscriptionClosedError",
		code: "subscription-closed",
		message: "m",
		retryable: false,
		fields: { subscriptionId: 7, operation: "publish" },
		cause,
	});
	assert.equal((closed as SubscriptionClosedError).subscriptionId, "");
	assert.equal((closed.cause as Error).message, "underlying");
	const config = deserializeSubscriptionError({
		name: "SubscriptionConfigError",
		code: "invalid-option",
		message: "m",
		retryable: false,
		fields: { field: "options.name", reason: "not-string" },
		cause,
	});
	assert.equal((config.cause as Error).message, "underlying");
	const source = deserializeSubscriptionError({
		name: "EventSourceError",
		code: "source-failed",
		message: "m",
		retryable: false,
		fields: { sourceId: "s", phase: "read", detail: null },
	});
	assert.equal((source as EventSourceError).detail, undefined);
	assert.equal(source.cause, undefined);
	const unknown = deserializeSubscriptionError({
		name: "SubscriptionFutureError",
		code: "invalid-event",
		message: "m",
		retryable: false,
		fields: {},
	});
	assert.equal(isSubscriptionError(unknown), true);
	assert.equal(unknown.hint, undefined);
	assert.equal(new SubscriptionClosedError("s", "emit", { cause: "why" }).cause, "why");
	assert.equal("cause" in new SubscriptionClosedError("s", "emit"), false);
});

test("guards require both the name and the code, and serialization skips null causes and non-string codes", () => {
	assert.equal(isSubscriptionClosedError({ name: "OtherError", code: "subscription-closed" }), false);
	assert.equal("cause" in serializeSubscriptionError(new SubscriptionHandlerError("s", "e", null)), false);
	const numeric = serializeSubscriptionError(
		new SubscriptionHandlerError("s", "e", Object.assign(new Error("n"), { code: 5 })),
	);
	assert.equal(numeric.cause !== undefined && "code" in numeric.cause, false);
	const plain = deserializeSubscriptionError(serializeSubscriptionError(new SubscriptionClosedError("s", "emit")));
	assert.equal("cause" in plain, false);
});

test("a custom source hint and a custom expected value survive the wire (#4311)", () => {
	const source = new EventSourceError("log:/var/log/app.log", "read", {
		hint: "Check the log file.",
		detail: "EACCES",
	});
	const rebuiltSource = deserializeSubscriptionError(
		JSON.parse(JSON.stringify(serializeSubscriptionError(source))),
	) as EventSourceError;
	assert.equal(rebuiltSource.hint, "Check the log file.");
	assert.equal(rebuiltSource.message, source.message);
	const config = new SubscriptionConfigError("webhook.port", "out-of-range", "an integer from 0 to 65535");
	const rebuiltConfig = deserializeSubscriptionError(
		JSON.parse(JSON.stringify(serializeSubscriptionError(config))),
	) as SubscriptionConfigError;
	assert.equal(rebuiltConfig.expected, "an integer from 0 to 65535");
	assert.equal(rebuiltConfig.message, config.message);
	const withoutExpected = deserializeSubscriptionError({
		name: "SubscriptionConfigError",
		code: "invalid-option",
		message: "m",
		retryable: false,
		fields: { field: "f", reason: "not-function" },
	}) as SubscriptionConfigError;
	assert.equal(withoutExpected.expected, "a function");
});

test("setup and subscriber errors are found through a wrapping source failure (#4311)", () => {
	const spawnFailure = new Error("spawn gh ENOENT");
	assert.equal(new SubscriptionSetupError("gh-cli", { cause: spawnFailure }).cause, spawnFailure);
	assert.equal(Object.hasOwn(new SubscriptionSetupError("gh-cli"), "cause"), false);
	const setup = new SubscriptionSetupError("gh-auth");
	const wrapped = new EventSourceError("github-checks:o/r#1", "poll", { cause: setup, hint: setup.hint });
	assert.equal(isSubscriptionSetupError(wrapped), true);
	assert.equal(isEventSourceError(wrapped), true);
	assert.equal(isRetryableSubscriptionError(wrapped), false);
	const unavailable = new SubscriptionSubscriberUnavailableError("run-1/ci#1", "watcher", "no_session");
	assert.equal(isSubscriptionSubscriberUnavailableError(new SubscriptionHandlerError("s", "e", unavailable)), true);
	assert.equal(isSubscriptionSetupError({ name: "SubscriptionSetupError", code: "setup-missing" }), true);
	assert.equal(isSubscriptionSetupError({ name: "SubscriptionSetupError", code: "invalid-option" }), false);
	assert.equal(
		isSubscriptionSubscriberUnavailableError({
			name: "SubscriptionSubscriberUnavailableError",
			code: "subscriber-unavailable",
		}),
		true,
	);
	const rebuilt = deserializeSubscriptionError(serializeSubscriptionError(unavailable));
	assert.equal(rebuilt instanceof SubscriptionSubscriberUnavailableError, true);
	assert.equal((rebuilt as SubscriptionSubscriberUnavailableError).reason, "no_session");
	const rebuiltSetup = deserializeSubscriptionError(serializeSubscriptionError(setup)) as SubscriptionSetupError;
	assert.equal(rebuiltSetup.missing, "gh-auth");
});
