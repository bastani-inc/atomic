import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import {
	providerCooldownMs,
	providerUnavailableMs,
	recordProviderRateLimit,
} from "../../packages/coding-agent/src/core/provider-rate-limits.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createAgentSessionAdapter } from "../../packages/workflows/src/extension/wiring.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { hostWorkerBindings } from "../../packages/workflows/src/workers/host-options.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	EARLY_PROVIDER,
	LIMITED_MODEL,
	LIMITED_PROVIDER,
	type LimitsSentStatus,
	limitedStageOptions,
	QUOTA_MODEL,
	SPARE_MODEL,
} from "../fixtures/pool-rate-limit-child.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;
/** The 429's cooldown. Only ordering depends on it, never how fast the machine is; short enough to wait out. */
const RETRY_AFTER_SECONDS = 6;
/** Outlasts any test budget, so the early cooldown is still active whenever the new worker reads it. */
const EARLY_COOLDOWN_MS = 3_600_000;
/** The worker and the root each read the clock once to turn the remaining cooldown into its end time. */
const CLOCK_READ_SLACK_MS = 1_000;

interface ProviderRequest {
	/** Order the fake provider received the request in. */
	readonly sequence: number;
	readonly label: string;
	readonly model: string;
	readonly at: number;
	readonly status: number;
}

/**
 * A stand-in for one HTTP provider: the first request to the limited model gets a 429, the quota model a 402.
 * With `dropLimited`, the limited model's connection closes without any response instead.
 */
function fakeProvider(options: { readonly dropLimited?: boolean } = {}) {
	const requests: ProviderRequest[] = [];
	let limitedSent = false;
	/** What the first worker reported once its stages were done. */
	let firstDone: string | undefined;
	const chunk = (model: string, body: object) =>
		`data: ${JSON.stringify({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 1, model, ...body })}\n\n`;
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		if (request.method === "GET" && request.url?.endsWith("/limits-sent")) {
			// The second worker's signal that both limits are out, so it never races the first worker's stages,
			// or that the first worker finished without them, so it stops waiting.
			const status: LimitsSentStatus = {
				sent429: requests.some((entry) => entry.status === 429),
				sent402: requests.some((entry) => entry.status === 402),
				...(firstDone === undefined ? {} : { firstDone }),
			};
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(status));
			return;
		}
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (data: string) => {
			raw += data;
		});
		request.on("end", () => {
			if (request.method === "POST" && request.url?.endsWith("/first-done")) {
				firstDone = raw;
				response.writeHead(204);
				response.end();
				return;
			}
			const body = JSON.parse(raw) as { model: string };
			const label = /label:(\w+)/.exec(raw)?.[1] ?? "unknown";
			const at = Date.now();
			const respond = (status: number, headers: Record<string, string>, text: string) => {
				requests.push({ sequence: requests.length, label, model: body.model, at, status });
				response.writeHead(status, headers);
				response.end(text);
			};
			if (body.model === QUOTA_MODEL)
				return respond(
					402,
					{ "content-type": "application/json", "retry-after": "3600" },
					JSON.stringify({ error: { message: `Quota exhausted for ${QUOTA_MODEL}` } }),
				);
			if (body.model === LIMITED_MODEL && options.dropLimited) {
				requests.push({ sequence: requests.length, label, model: body.model, at, status: 0 });
				request.socket.destroy();
				return;
			}
			if (body.model === LIMITED_MODEL && !limitedSent) {
				limitedSent = true;
				return respond(
					429,
					{ "content-type": "application/json", "retry-after": String(RETRY_AFTER_SECONDS) },
					JSON.stringify({ error: { message: `Rate limit reached for ${LIMITED_MODEL} in organization` } }),
				);
			}
			respond(
				200,
				{ "content-type": "text/event-stream" },
				chunk(body.model, { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }) +
					chunk(body.model, {
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}) +
					"data: [DONE]\n\n",
			);
		});
	});
	return { server, requests };
}

async function listen(server: ReturnType<typeof fakeProvider>["server"]): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

const provider = fakeProvider();
let baseUrl = "";

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
	baseUrl = await listen(provider.server);
});
afterAll(async () => {
	await new Promise<void>((resolve) => provider.server.close(() => resolve()));
});

async function withPool(
	name: string,
	workers: number,
	body: (child: Awaited<ReturnType<typeof loadWorkerDefinition>>) => Parameters<typeof workflow>[0]["run"],
): Promise<RunResult> {
	const directory = makeTempDirectory(`${name}-`);
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	const childPath = fileURLToPath(new URL("../fixtures/pool-rate-limit-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
	});
	try {
		const parent = workflow({ name, description: "", inputs: {}, outputs: {}, run: body(child) });
		const result = await run(
			parent,
			{},
			{
				runId: name,
				cwd: directory,
				store: createStore(),
				durableBackend: backend,
				// The root runs its own stage too, bound like the host binds it; its children run on the workers.
				adapters: { agentSession: createAgentSessionAdapter({ cwd: directory }) },
				[hostWorkerBindings]: true,
			},
		);
		return result;
	} finally {
		await pool.close();
		// Cleanup finished: the pool's workers are gone.
		assert.deepEqual(pool.workerPids, []);
		await backend.close();
		removeTempDirectory(directory);
	}
}

test(
	"a 429 or exhausted quota one local worker meets holds back the other workers and the root (#4023)",
	async () => {
		const result = await withPool("shared-limits-root", 2, (child) => async (ctx) => {
			const [first, second] = await Promise.all(
				["first", "second"].map((role) => ctx.workflow(child, { inputs: { role, baseUrl } })),
			);
			assert.equal(first!.status, "completed", JSON.stringify(first));
			assert.equal(second!.status, "completed", JSON.stringify(second));
			assert.equal(second!.outputs.sawLimits, true, "the second worker received the first worker's quota mark");
			// The root's own fallback walk skips the model a worker found exhausted.
			assert.ok(providerUnavailableMs(LIMITED_PROVIDER, QUOTA_MODEL) > 0);
			const rootOptions = await limitedStageOptions(ctx.cwd ?? process.cwd(), baseUrl, QUOTA_MODEL, [SPARE_MODEL]);
			await ctx.stage("root-walk", rootOptions as never).complete("label:root");
			return {};
		});
		assert.equal(result.status, "completed", JSON.stringify(result));
		const limited = provider.requests.find((request) => request.status === 429);
		assert.ok(limited, JSON.stringify(provider.requests));
		assert.equal(limited.label, "first");
		const of = (label: string, model: string) =>
			provider.requests.filter((request) => request.label === label && request.model === model);
		// Exhausted quota: the second worker's walk and the root's walk go straight to the fallback.
		assert.deepEqual(of("second", QUOTA_MODEL), []);
		assert.deepEqual(of("root", QUOTA_MODEL), []);
		assert.equal(of("root", SPARE_MODEL).length, 1);
		// The 429 named its model: the spare model on the same provider answered the second worker while its
		// request to the rate-limited model was held back.
		const held = of("second", LIMITED_MODEL);
		assert.equal(held.length, 1, JSON.stringify(provider.requests));
		const spare = of("second", SPARE_MODEL);
		assert.equal(spare.length, 2, JSON.stringify(provider.requests));
		assert.ok(spare.every((request) => request.sequence < held[0]!.sequence));
		// The rate-limited model saw nothing from the second worker until the 429's Retry-After had passed. Both
		// times are the provider's own clock: a worker's clock is its own process's, and on Windows one process's
		// Date.now() can differ from another's by seconds, so a worker's cooldown end is not comparable to them.
		const heldForMs = held[0]!.at - limited.at;
		assert.ok(
			heldForMs >= RETRY_AFTER_SECONDS * 1000,
			`held back ${heldForMs} ms after the 429; its Retry-After is ${RETRY_AFTER_SECONDS} s`,
		);
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test(
	"a newly started local worker receives the limits the pool already holds (#4023)",
	async () => {
		recordProviderRateLimit(EARLY_PROVIDER, { status: 429, retryAfterMs: EARLY_COOLDOWN_MS });
		const recordedEnd = Date.now() + providerCooldownMs(EARLY_PROVIDER);
		const result = await withPool("shared-limits-early", 1, (child) => async (ctx) => {
			const early = await ctx.workflow(child, { inputs: { role: "early", baseUrl } });
			assert.equal(early.status, "completed", JSON.stringify(early));
			const workerEnd = Number(early.outputs.earlyCooldownEnd);
			assert.ok(
				Math.abs(workerEnd - recordedEnd) <= CLOCK_READ_SLACK_MS,
				`worker cooldown end ${workerEnd} vs recorded ${recordedEnd}: ${JSON.stringify(early.outputs)}`,
			);
			return {};
		});
		assert.equal(result.status, "completed", JSON.stringify(result));
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test(
	"a worker waiting for another worker's limits stops when that worker ends without them (#4023)",
	async () => {
		const dropping = fakeProvider({ dropLimited: true });
		const droppingUrl = await listen(dropping.server);
		try {
			const result = await withPool("shared-limits-missing", 2, (child) => async (ctx) => {
				const [first, second] = await Promise.all(
					["first", "second"].map((role) => ctx.workflow(child, { inputs: { role, baseUrl: droppingUrl } })),
				);
				assert.equal(first!.status, "completed", JSON.stringify(first));
				return { second: second!.status };
			});
			// The run fails with the second worker's error, which names the reply that never came.
			assert.equal(result.status, "failed", JSON.stringify(result));
			assert.match(
				result.error ?? "",
				/The first worker finished before the fake server sent the limited model's scripted first reply/,
			);
			// The second worker sent no model request: it failed while still waiting for the limits.
			assert.deepEqual(
				dropping.requests.filter((request) => request.label === "second"),
				[],
			);
		} finally {
			await new Promise<void>((resolve) => dropping.server.close(() => resolve()));
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
