/**
 * Unavailable credentials are ladder control flow, not an early throw.
 *
 * A borrowed candidate carries its own credentials, so the session model having
 * none must not end the compaction, and a load-bearing caller must still reach
 * the credential-free fresh rung.
 */

import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import { runVerbatimCompaction } from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import type { PlannerAuth } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { RangePlanError } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import { preparation, registryOf, runRequest, scriptedStream, testModel } from "./compaction-rung-support.js";

const primary = testModel();
const fallback = testModel({ provider: "backup", id: "planner-b", baseUrl: "https://backup.example" });

function fallbackContext() {
	return {
		fallbackModels: ["backup/planner-b"],
		registry: registryOf([primary, fallback]),
		preferredProvider: "primary",
		sessionThinkingLevel: "high" as const,
	};
}

/** Credentials for every model except the named ones. */
function authExcept(...withoutAuth: string[]) {
	const seen: string[] = [];
	const resolveAuth = async (model: Model<Api>): Promise<PlannerAuth | undefined> => {
		seen.push(`${model.provider}/${model.id}`);
		return withoutAuth.includes(model.id) ? undefined : { apiKey: `${model.provider}-key` };
	};
	return { resolveAuth, seen };
}

test("missing primary auth advances to a healthy fallback and still plans", async () => {
	const stream = scriptedStream({ "planner-b": [{ text: "1,10\n" }] });
	const { resolveAuth, seen } = authExcept("planner-a");
	const result = await runVerbatimCompaction(
		preparation(),
		primary,
		runRequest({ streamFn: stream.streamFn, resolveAuth, fallback: fallbackContext() }),
	);

	assert.equal(result.rung, "planned");
	assert.deepEqual(result.plannerModel, { provider: "backup", id: "planner-b", thinkingLevel: "high" });
	// The unusable primary was never sent a request, and the fallback ran once.
	assert.equal(stream.calls.length, 1);
	assert.equal(stream.calls[0].model.id, "planner-b");
	assert.deepEqual(seen, ["primary/planner-a", "backup/planner-b"]);
});

test("a rejected primary auth resolver is normalized, not propagated", async () => {
	const stream = scriptedStream({ "planner-b": [{ text: "1,10\n" }] });
	const result = await runVerbatimCompaction(
		preparation(),
		primary,
		runRequest({
			streamFn: stream.streamFn,
			resolveAuth: async (model) => {
				if (model.id === "planner-a") throw new Error('No API key found for provider "primary"');
				return { apiKey: "backup-key" };
			},
			fallback: fallbackContext(),
		}),
	);
	assert.equal(result.rung, "planned");
	assert.equal(stream.calls.length, 1);
});

test("no model has auth under load_bearing: zero requests and a fresh boundary", async () => {
	const stream = scriptedStream({ default: [{ text: "1,10\n" }] });
	const { resolveAuth } = authExcept("planner-a", "planner-b");
	const result = await runVerbatimCompaction(
		preparation(),
		primary,
		runRequest({
			streamFn: stream.streamFn,
			resolveAuth,
			urgency: "load_bearing",
			fallback: fallbackContext(),
		}),
	);

	assert.equal(result.rung, "fresh");
	assert.equal(stream.calls.length, 0);
	assert.equal(result.plannerModel, undefined);
});

test("no model has auth under recoverable: the honest auth error, no fresh boundary", async () => {
	const stream = scriptedStream({ default: [{ text: "1,10\n" }] });
	const { resolveAuth } = authExcept("planner-a", "planner-b");
	await assert.rejects(
		() =>
			runVerbatimCompaction(
				preparation(),
				primary,
				runRequest({ streamFn: stream.streamFn, resolveAuth, fallback: fallbackContext() }),
			),
		(error: unknown) => {
			assert.ok(error instanceof RangePlanError);
			assert.equal(error.message, "Compaction provider authentication is unavailable");
			// A runner-local cause: no provider request was made, so nothing is
			// classified as a provider attempt and no sidecar path is claimed.
			assert.equal(error.diagnosticPath, undefined);
			return true;
		},
	);
	assert.equal(stream.calls.length, 0);
});

test("a rejected primary auth message survives recoverable exhaustion", async () => {
	const stream = scriptedStream({ default: [{ text: "1,10\n" }] });
	await assert.rejects(
		() =>
			runVerbatimCompaction(
				preparation(),
				primary,
				runRequest({
					streamFn: stream.streamFn,
					resolveAuth: async () => {
						throw new Error('Authentication failed for "primary"');
					},
					fallback: fallbackContext(),
				}),
			),
		/Authentication failed for "primary"/,
	);
	assert.equal(stream.calls.length, 0);
});

test("the credential-less primary is not retried as a fallback candidate", async () => {
	// The configured list names the session model itself; it must not be tried a
	// second time just because its auth failed the first time.
	const stream = scriptedStream({ default: [{ text: "1,10\n" }] });
	const { resolveAuth, seen } = authExcept("planner-a");
	await assert.rejects(
		() =>
			runVerbatimCompaction(
				preparation(),
				primary,
				runRequest({
					streamFn: stream.streamFn,
					resolveAuth,
					fallback: { ...fallbackContext(), fallbackModels: ["primary/planner-a"] },
				}),
			),
		/Compaction provider authentication is unavailable/,
	);
	assert.deepEqual(seen, ["primary/planner-a"]);
	assert.equal(stream.calls.length, 0);
});
