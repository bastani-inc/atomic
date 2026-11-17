/**
 * A workflow stage's model chain skips candidates whose provider has no usable credentials before it creates any
 * session for them, fails at once naming each model and its provider when none has credentials, and drops the rest of
 * a provider's candidates once that provider rejects its credentials. Fake sessions record every model the stage
 * creates a session for, which is what would otherwise send a request.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type {
	StageRunnerOpts,
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { makeMockSession } from "./stage-runner-helpers.js";

const REVOKED_401 = Object.assign(
	new Error(
		'401 {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}',
	),
	{ status: 401 },
);

function stageOpts(
	chain: readonly string[],
	withCredentials: ReadonlySet<string>,
	created: string[],
	failing: ReadonlyMap<string, Error> = new Map(),
): StageRunnerOpts {
	const [model, ...fallbackModels] = chain;
	return {
		stageId: "stage-credentials",
		stageName: "Reviewer",
		runId: "run-credentials",
		stageOptions: { model, fallbackModels },
		models: {
			async listModels() {
				return chain.map((fullId) => {
					const [provider, id] = fullId.split("/") as [string, string];
					return { provider, id, fullId };
				});
			},
			hasCredentials: (provider) => withCredentials.has(provider),
		},
		adapters: {
			agentSession: {
				async create(options: StageSessionCreateOptions): Promise<StageSessionRuntime> {
					const id = String(options?.model);
					created.push(id);
					const { session } = makeMockSession({
						async prompt() {
							const failure = failing.get(id);
							if (failure) throw failure;
							return "ok";
						},
					});
					return session;
				},
			},
		},
	};
}

describe("a workflow stage's model chain and credentials", () => {
	test("a chain whose first models have no credentials starts on its first model that has them, with no session for the others", async () => {
		const created: string[] = [];
		const ctx = createStageContext(stageOpts(["nokey/a", "nokey/b", "working/a"], new Set(["working"]), created));

		assert.equal(await ctx.prompt("run"), "ok");
		await ctx.__dispose();

		assert.deepEqual(created, ["working/a"]);
		const attempts = ctx.__modelFallbackMeta().modelAttempts ?? [];
		assert.deepEqual(
			attempts.filter((attempt) => !attempt.success).map((attempt) => [attempt.model, attempt.error]),
			[
				["nokey/a", "Skipped nokey/a: provider 'nokey' has no credentials."],
				["nokey/b", "Skipped nokey/b: provider 'nokey' has no credentials."],
			],
		);
	});

	test("a chain with no model that has credentials fails at once, naming each model and its provider", async () => {
		const created: string[] = [];
		const ctx = createStageContext(stageOpts(["nokey/a", "other/b"], new Set(["working"]), created));

		await assert.rejects(ctx.prompt("run"), (error: Error) => {
			assert.equal(error.name, "NoUsableModelError");
			assert.match(error.message, /nokey\/a \(no credentials for nokey\)/);
			assert.match(error.message, /other\/b \(no credentials for other\)/);
			return true;
		});
		await ctx.__dispose();
		assert.deepEqual(created, []);
	});

	test("a resumed stage skips its rejected provider when restarting the fallback chain", async () => {
		const created: string[] = [];
		const failures = new Map<string, Error>();
		const ctx = createStageContext(
			stageOpts(
				["resumed-revoked/a", "resumed-revoked/b", "working/a"],
				new Set(["resumed-revoked", "working"]),
				created,
				failures,
			),
		);
		try {
			assert.equal(await ctx.prompt("first"), "ok");
			failures.set("resumed-revoked/a", REVOKED_401);
			assert.equal(await ctx.prompt("second"), "ok");
			assert.deepEqual(created, ["resumed-revoked/a", "working/a"]);
			assert.deepEqual(
				ctx.__modelFallbackMeta().modelAttempts?.map((attempt) => [attempt.model, attempt.success]),
				[
					["resumed-revoked/a", true],
					["resumed-revoked/a", false],
					["resumed-revoked/b", false],
					["working/a", true],
				],
			);
		} finally {
			await ctx.__dispose();
		}
	});

	test("a provider that rejects its credentials is not asked again for its other models", async () => {
		const created: string[] = [];
		const ctx = createStageContext(
			stageOpts(
				["revoked/a", "revoked/b", "working/a"],
				new Set(["revoked", "working"]),
				created,
				new Map([["revoked/a", REVOKED_401]]),
			),
		);

		assert.equal(await ctx.prompt("run"), "ok");
		await ctx.__dispose();

		assert.deepEqual(created, ["revoked/a", "working/a"]);
		const attempts = ctx.__modelFallbackMeta().modelAttempts ?? [];
		assert.deepEqual(
			attempts.map((attempt) => [attempt.model, attempt.success]),
			[
				["revoked/a", false],
				["revoked/b", false],
				["working/a", true],
			],
		);
		assert.equal(attempts[1]?.error, "Skipped revoked/b: provider 'revoked' rejected its credentials.");
	});
});
