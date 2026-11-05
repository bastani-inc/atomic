import assert from "node:assert/strict";
import { test } from "vitest";
import {
	DecisionConfigError,
	DecisionError,
	DecisionModelUnavailableError,
	DecisionOutputError,
	DecisionProviderError,
	DecisionRequestError,
	DecisionTimeoutError,
	findDecisionError,
	isDecisionConfigError,
	isDecisionError,
	isDecisionModelUnavailableError,
	isDecisionOutputError,
	isDecisionProviderError,
	isDecisionRequestError,
	isDecisionTimeoutError,
	isRetryableDecisionError,
	rehydrateDecisionError,
	serializeDecisionError,
} from "../../packages/coding-agent/src/core/decision/errors.js";

const ERRORS = {
	config: new DecisionConfigError({ code: "invalid-setting", source: "sdk", field: "decisionModel" }),
	request: new DecisionRequestError({ field: "state", reason: "invalid-state" }),
	unavailable: new DecisionModelUnavailableError({ reason: "no-chat-model" }),
	timeout: new DecisionTimeoutError({ timeoutMs: 5, elapsedMs: 6, phase: "resolve" }),
	output: new DecisionOutputError({ model: "a/b" }),
	provider: new DecisionProviderError({}),
} as const;

const GUARDS = {
	config: isDecisionConfigError,
	request: isDecisionRequestError,
	unavailable: isDecisionModelUnavailableError,
	timeout: isDecisionTimeoutError,
	output: isDecisionOutputError,
	provider: isDecisionProviderError,
} as const;

test("each class renders its message and hint once, as a UX contract (#4358)", () => {
	const rendered = (error: DecisionError) => ({ message: error.message, hint: error.hint });
	assert.deepEqual(rendered(ERRORS.config), {
		message:
			'Invalid decision model setting: "decisionModel" in the SDK settings (invalid-setting). Set "decisionModel" in the settings you pass to an exact provider/model ID, "auto", or an empty string.',
		hint: 'Set "decisionModel" in the settings you pass to an exact provider/model ID, "auto", or an empty string.',
	});
	assert.deepEqual(
		rendered(new DecisionConfigError({ code: "renamed-setting", source: "settings", field: "routerModel" })),
		{
			message:
				'Renamed setting: "routerModel" in settings.json (renamed-setting). Rename "routerModel" to "decisionModel" in settings.json.',
			hint: 'Rename "routerModel" to "decisionModel" in settings.json.',
		},
	);
	assert.deepEqual(rendered(ERRORS.request), {
		message:
			"Invalid decision request: state is invalid-state (invalid-request). Pass state as a nonempty object of finite, acyclic JSON values.",
		hint: "Pass state as a nonempty object of finite, acyclic JSON values.",
	});
	assert.equal(
		new DecisionModelUnavailableError({ reason: "not-in-catalog", model: "x/y" }).message,
		'Decision model unavailable: x/y is not-in-catalog (model-unavailable). Set "decisionModel" to a registered chat or classifier model in /settings, or leave it empty.',
	);
	assert.equal(
		ERRORS.unavailable.message,
		'Decision model unavailable: no-chat-model (model-unavailable). Select a chat model with /model, or set "decisionModel" in /settings.',
	);
	assert.equal(
		new DecisionModelUnavailableError({ reason: "no-probabilities" }).hint,
		'Set "decisionModel" to a classifier, such as typesafe/jev-latest, in /settings; a chat model\'s answers carry no probabilities.',
	);
	assert.equal(
		ERRORS.timeout.message,
		"Decision timed out: no answer within its 5ms deadline while waiting for the decision model (timeout). Retry, or allow a longer deadline (httpIdleTimeoutMs).",
	);
	assert.equal(
		new DecisionTimeoutError({ timeoutMs: 5, elapsedMs: 6, phase: "classifier", attempts: "Attempts: 1) x." })
			.message,
		"Decision timed out: no answer within its 5ms deadline while waiting for the classifier model (timeout). Retry, or allow a longer deadline (httpIdleTimeoutMs). Attempts: 1) x.",
	);
	assert.deepEqual(rendered(new DecisionOutputError({ model: "a/b", detail: "bad shape" })), {
		message:
			"Decision output invalid: a/b gave no valid answer: bad shape (invalid-output). Make the questions and their options unambiguous, or choose another decision model.",
		hint: "Make the questions and their options unambiguous, or choose another decision model.",
	});
	assert.equal(
		ERRORS.output.message,
		"Decision output invalid: a/b gave no valid answer (invalid-output). Make the questions and their options unambiguous, or choose another decision model.",
	);
	assert.deepEqual(rendered(ERRORS.provider), {
		message:
			"Decision model request failed: the decision model (provider-failure). Check the decision model's provider configuration and connectivity.",
		hint: "Check the decision model's provider configuration and connectivity.",
	});
	assert.deepEqual(
		rendered(
			new DecisionProviderError({
				model: "a/b",
				providerStatus: 429,
				providerCode: "rate_limit_exceeded",
				retryAfterMs: 250,
				detail: "rate limited",
			}),
		),
		{
			message:
				"Decision model request failed: a/b returned HTTP 429: rate limited (provider-failure). Retry after 250ms; the provider reported rate_limit_exceeded.",
			hint: "Retry after 250ms; the provider reported rate_limit_exceeded.",
		},
	);
	assert.equal(
		new DecisionProviderError({ providerCode: "insufficient_quota" }).hint,
		"Retry after a moment; the provider reported insufficient_quota.",
	);
});

test("each class carries its code, retry semantics and only the fields that are set", () => {
	assert.deepEqual(
		Object.entries(ERRORS).map(([key, error]) => [key, error.code, error.retryable, error.fields()]),
		[
			["config", "invalid-setting", false, { source: "sdk", field: "decisionModel" }],
			["request", "invalid-request", false, { field: "state", reason: "invalid-state" }],
			["unavailable", "model-unavailable", false, { reason: "no-chat-model" }],
			["timeout", "timeout", true, { timeoutMs: 5, elapsedMs: 6, phase: "resolve" }],
			["output", "invalid-output", false, { model: "a/b" }],
			["provider", "provider-failure", false, {}],
		],
	);
	assert.equal(new DecisionProviderError({ providerCode: "insufficient_quota" }).retryable, true);
	assert.deepEqual(new DecisionError("timeout", "m", "h").fields(), {});
	assert.equal(new DecisionError("timeout", "m", "h").retryable, false);
	assert.equal(new DecisionError("timeout", "m", "h").name, "DecisionError");
	assert.equal(
		new DecisionConfigError({ code: "renamed-setting", source: "settings", field: "routerModel" }).scope,
		undefined,
	);
	assert.equal(new DecisionOutputError({ model: "a/b", detail: "" }).detail, undefined);
	assert.equal(
		new DecisionTimeoutError({ timeoutMs: 1, elapsedMs: 1, phase: "chat", attempts: "" }).attempts,
		undefined,
	);
	assert.equal(new DecisionProviderError({ detail: "" }).detail, undefined);
});

test("each guard accepts only its own class, live or structural", () => {
	for (const [key, guard] of Object.entries(GUARDS)) {
		for (const [other, error] of Object.entries(ERRORS)) {
			const plain = JSON.parse(JSON.stringify({ name: error.name, code: error.code }));
			assert.equal(guard(error), key === other, `${key} guard on ${other}`);
			assert.equal(guard(plain), key === other, `${key} guard on structural ${other}`);
			assert.equal(guard({ ...plain, code: "unknown-code" }), false);
		}
		assert.equal(guard(new Error("plain")), false);
		assert.equal(guard({ name: "DecisionError", code: "timeout" }), false);
		assert.equal(guard(undefined), false);
	}
	for (const error of Object.values(ERRORS)) assert.equal(isDecisionError(error), true);
	assert.equal(isDecisionError({ name: "DecisionError", code: "timeout" }), true);
	assert.equal(isDecisionError({ name: "DecisionError", code: "nope" }), false);
	assert.equal(isDecisionError({ name: "toString", code: "timeout" }), false);
	assert.equal(isDecisionError({ name: 7, code: "timeout" }), false);
	assert.equal(isDecisionError({ name: "DecisionTimeoutError", code: 7 }), false);
	assert.equal(isDecisionError(null), false);
	assert.equal(isDecisionError("DecisionError"), false);
});

test("a serialized chain keeps at most eight errors, and a non-error cause is dropped", () => {
	let chain: DecisionError = new DecisionOutputError({ model: "root" });
	for (let depth = 1; depth < 12; depth++) chain = new DecisionOutputError({ model: `m${depth}` }, { cause: chain });
	let serialized = serializeDecisionError(chain);
	let levels = 0;
	for (
		let node: typeof serialized.cause = serialized;
		node !== undefined;
		node = "code" in node ? node.cause : undefined
	)
		levels++;
	assert.equal(levels, 8);
	serialized = serializeDecisionError(new DecisionOutputError({ model: "a" }, { cause: "text cause" }));
	assert.equal(serialized.cause, undefined);
	const plainCause = serializeDecisionError(
		new DecisionOutputError({ model: "a" }, { cause: new RangeError("inner") }),
	);
	assert.deepEqual(plainCause.cause, { name: "RangeError", message: "inner" });
	const restored = rehydrateDecisionError(plainCause);
	assert.ok(restored.cause instanceof Error);
	assert.equal((restored.cause as Error).name, "RangeError");
	assert.equal(
		rehydrateDecisionError(serializeDecisionError(new DecisionOutputError({ model: "a" }))).cause,
		undefined,
	);
	const base = rehydrateDecisionError(serializeDecisionError(new DecisionError("timeout", "m", "h")));
	assert.equal(base.constructor, DecisionError);
	assert.equal(base.name, "DecisionError");
	assert.equal(base.message, "m");
});

test("finding a decision error walks causes, stops at eight, and reports retryability", () => {
	const timeout = ERRORS.timeout;
	assert.equal(findDecisionError(timeout), timeout);
	assert.equal(findDecisionError(new Error("a", { cause: { cause: timeout } })), timeout);
	assert.equal(findDecisionError(new Error("a", { cause: "x" })), undefined);
	let wrapped: unknown = timeout;
	for (let depth = 0; depth < 7; depth++) wrapped = new Error(`w${depth}`, { cause: wrapped });
	assert.equal(findDecisionError(wrapped), timeout);
	assert.equal(findDecisionError(new Error("w", { cause: wrapped })), undefined);
	assert.equal(isRetryableDecisionError(new Error("w", { cause: timeout })), true);
	assert.equal(isRetryableDecisionError(ERRORS.output), false);
	assert.equal(isRetryableDecisionError(undefined), false);
});
