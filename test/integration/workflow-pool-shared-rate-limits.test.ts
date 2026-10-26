import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test, vi } from "vitest";
import {
	providerUnavailableMs,
	recordProviderRateLimit,
} from "../../packages/coding-agent/src/core/provider-rate-limits.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createAgentSessionAdapter } from "../../packages/workflows/src/extension/wiring.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { hostWorkerBindings } from "../../packages/workflows/src/workers/host-options.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	EARLY_PROVIDER,
	LIMITED_MODEL,
	LIMITED_PROVIDER,
	limitedStageOptions,
	QUOTA_MODEL,
	SPARE_MODEL,
} from "../fixtures/pool-rate-limit-child.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;
/** Long enough that the second worker's other requests land inside it, short enough to wait out. */
const RETRY_AFTER_SECONDS = 6;

// Keep the real coordinator, fork and IPC, but run the shipped worker rather than
// cold-transpiling its entire source graph through jiti.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { fileURLToPath } = await import("node:url");
	const sourceEntry = fileURLToPath(
		new URL("../../packages/workflows/src/workers/local-worker-entry.mjs", import.meta.url),
	);
	const packagedEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	return {
		...actual,
		fork: (modulePath: string | URL, args: readonly string[], options: ForkOptions) =>
			actual.fork(modulePath === sourceEntry ? packagedEntry : modulePath, args, options),
	};
});

interface ProviderRequest {
	readonly label: string;
	readonly model: string;
	readonly at: number;
	readonly status: number;
}

/** A stand-in for one HTTP provider: the first request to the limited model gets a 429, the quota model a 402. */
function fakeProvider() {
	const requests: ProviderRequest[] = [];
	let limitedSent = false;
	const chunk = (model: string, body: object) =>
		`data: ${JSON.stringify({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 1, model, ...body })}\n\n`;
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (data: string) => {
			raw += data;
		});
		request.on("end", () => {
			const body = JSON.parse(raw) as { model: string };
			const label = /label:(\w+)/.exec(raw)?.[1] ?? "unknown";
			const at = Date.now();
			const respond = (status: number, headers: Record<string, string>, text: string) => {
				requests.push({ label, model: body.model, at, status });
				response.writeHead(status, headers);
				response.end(text);
			};
			if (body.model === QUOTA_MODEL)
				return respond(
					402,
					{ "content-type": "application/json", "retry-after": "3600" },
					JSON.stringify({ error: { message: `Quota exhausted for ${QUOTA_MODEL}` } }),
				);
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

const provider = fakeProvider();
let baseUrl = "";

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
	await new Promise<void>((resolve) => provider.server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(provider.server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
	await new Promise<void>((resolve) => provider.server.close(() => resolve()));
});

async function withPool(
	name: string,
	workers: number,
	body: (child: Awaited<ReturnType<typeof loadWorkerDefinition>>) => Parameters<typeof workflow>[0]["run"],
): Promise<void> {
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
		assert.equal(result.status, "completed", JSON.stringify(result));
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
}

test(
	"a 429 or exhausted quota one local worker meets holds back the other workers and the root (#4023)",
	async () => {
		await withPool("shared-limits-root", 2, (child) => async (ctx) => {
			const [first, second] = await Promise.all(
				["first", "second"].map((role) => ctx.workflow(child, { inputs: { role, baseUrl } })),
			);
			assert.equal(first!.status, "completed", JSON.stringify(first));
			assert.equal(second!.status, "completed", JSON.stringify(second));
			assert.equal(second!.outputs.sawLimits, true, "the second worker received the first worker's limits");
			// The root's own fallback walk skips the model a worker found exhausted.
			assert.ok(providerUnavailableMs(LIMITED_PROVIDER, QUOTA_MODEL) > 0);
			const rootOptions = await limitedStageOptions(ctx.cwd ?? process.cwd(), baseUrl, QUOTA_MODEL, [SPARE_MODEL]);
			await ctx.stage("root-walk", rootOptions as never).complete("label:root");
			return {};
		});
		const limited = provider.requests.find((request) => request.status === 429);
		assert.ok(limited, JSON.stringify(provider.requests));
		assert.equal(limited.label, "first");
		const cooldownEnd = limited.at + RETRY_AFTER_SECONDS * 1000;
		const of = (label: string, model: string) =>
			provider.requests.filter((request) => request.label === label && request.model === model);
		// Exhausted quota: the second worker's walk and the root's walk go straight to the fallback.
		assert.deepEqual(of("second", QUOTA_MODEL), []);
		assert.deepEqual(of("root", QUOTA_MODEL), []);
		assert.equal(of("root", SPARE_MODEL).length, 1);
		// The 429 named its model: the spare model on the same provider answered the second worker during it.
		const spare = of("second", SPARE_MODEL);
		assert.equal(spare.length, 2, JSON.stringify(provider.requests));
		assert.ok(spare.every((request) => request.at < cooldownEnd));
		// The rate-limited model saw nothing from the second worker until the first worker's cooldown ended.
		const held = of("second", LIMITED_MODEL);
		assert.equal(held.length, 1, JSON.stringify(provider.requests));
		assert.ok(held[0]!.at >= cooldownEnd, `${held[0]!.at - limited.at} ms after the 429`);
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test(
	"a newly started local worker receives the limits the pool already holds (#4023)",
	async () => {
		recordProviderRateLimit(EARLY_PROVIDER, { status: 429, retryAfterMs: 60_000 });
		await withPool("shared-limits-early", 1, (child) => async (ctx) => {
			const early = await ctx.workflow(child, { inputs: { role: "early", baseUrl } });
			assert.equal(early.status, "completed", JSON.stringify(early));
			assert.ok(Number(early.outputs.earlyCooldownMs) > 50_000, JSON.stringify(early.outputs));
			return {};
		});
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
