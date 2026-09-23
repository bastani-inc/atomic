import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import { moduleDir } from "../helpers/runtime.js";

/**
 * The classifier and image examples in the workflow authoring guide are the
 * only documented way to call a non-chat model from workflow TypeScript. They
 * are loaded here exactly as a user project would load them: through workflow
 * discovery, with `@bastani/pi-ai` installed in the project that owns the
 * workflow file, and then executed against a stubbed provider response so the
 * result fields the snippets read (`stopReason`, `answers.intent`,
 * `output[].type === "image"`) are the real ones.
 */
const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");
const authoringDoc = join(repositoryRoot, "packages/coding-agent/docs/workflows/authoring.md");
const SECTION_HEADING = "### Classifier and image models in `ctx.tool`";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function documentedExamples(): { triage: string; previewAsset: string } {
	const text = readFileSync(authoringDoc, "utf8").replaceAll("\r\n", "\n");
	const start = text.indexOf(SECTION_HEADING);
	assert.notEqual(start, -1, `${SECTION_HEADING} is missing from the authoring guide`);
	const end = text.indexOf("\n### ", start + SECTION_HEADING.length);
	const section = text.slice(start, end === -1 ? undefined : end);
	const fences = [...section.matchAll(/^```ts\n([\s\S]*?)^```/gmu)].map((match) => match[1] ?? "");
	assert.equal(fences.length, 2, "the section documents exactly one classifier and one image example");
	const [triage, previewAsset] = fences as [string, string];
	assert.match(triage, /\.atomic\/workflows\/triage\.ts|name: "triage"/u);
	assert.match(previewAsset, /name: "preview-asset"/u);
	return { triage, previewAsset };
}

/** A user project with the guide's install step applied: `@bastani/pi-ai` in its own node_modules. */
function userProject(): string {
	const project = mkdtempSync(join(tmpdir(), "atomic-docs-model-ops-"));
	tempDirs.push(project);
	const piAi = join(repositoryRoot, "packages/ai");
	assert.ok(existsSync(join(piAi, "dist/providers/all.js")), "build @bastani/pi-ai before running this suite");
	mkdirSync(join(project, "node_modules/@bastani"), { recursive: true });
	symlinkSync(piAi, join(project, "node_modules/@bastani/pi-ai"), process.platform === "win32" ? "junction" : "dir");
	mkdirSync(join(project, ".atomic/workflows"), { recursive: true });
	const { triage, previewAsset } = documentedExamples();
	writeFileSync(join(project, ".atomic/workflows/triage.ts"), triage);
	writeFileSync(join(project, ".atomic/workflows/preview-asset.ts"), previewAsset);
	return project;
}

type ToolCallback = (toolCtx: { readonly signal: AbortSignal }) => Promise<unknown>;

function fakeContext(project: string, inputs: Record<string, string>) {
	const toolCalls: string[] = [];
	const taskCalls: Array<{ name: string; prompt?: string }> = [];
	const ctx = {
		inputs,
		cwd: project,
		runId: "run-1",
		tool: async (name: string, _args: object, callback: ToolCallback) => {
			toolCalls.push(name);
			return await callback({ signal: new AbortController().signal });
		},
		task: async (name: string, options: { prompt?: string }) => {
			taskCalls.push({ name, prompt: options.prompt });
			return { text: "reviewed" };
		},
	};
	return { ctx, toolCalls, taskCalls };
}

async function withFetch<T>(handler: (url: string, init: RequestInit) => Response, body: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	const requests: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		requests.push(url);
		return handler(url, init ?? {});
	}) as typeof fetch;
	try {
		return await body();
	} finally {
		globalThis.fetch = original;
	}
}

const jsonResponse = (value: unknown): Response =>
	new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

describe("workflow authoring guide: classifier and image examples", () => {
	test("both documented workflows register through discovery from a project that installed @bastani/pi-ai", async () => {
		const project = userProject();
		const { registry, errors } = await discoverWorkflows({
			cwd: project,
			homeDir: mkdtempSync(join(tmpdir(), "atomic-docs-model-ops-home-")),
			includeBundled: false,
		});
		assert.deepEqual(errors, []);
		assert.deepEqual(registry.names().sort(), ["preview-asset", "triage"]);
	});

	test("triage routes a confident classifier answer to a chat stage and leaves the classifier out of execution", async () => {
		const project = userProject();
		const { registry } = await discoverWorkflows({ cwd: project, homeDir: project, includeBundled: false });
		const triage = registry.get("triage");
		assert.ok(triage);
		const { ctx, toolCalls, taskCalls } = fakeContext(project, { request: "Why was my account charged twice?" });
		const seen: Array<{ url: string; authorization: string | undefined; payload: Record<string, unknown> }> = [];
		process.env.TYPESAFE_API_KEY = "test-typesafe-key";
		try {
			const result = await withFetch(
				(url, init) => {
					const headers = new Headers(init.headers);
					seen.push({
						url,
						authorization: headers.get("authorization") ?? undefined,
						payload: JSON.parse(String(init.body)) as Record<string, unknown>,
					});
					return jsonResponse({
						answers: {
							intent: {
								type: "choice",
								choice: "account",
								probabilities: { account: 0.9, product: 0.07, other: 0.03 },
								confidence: 0.88,
							},
						},
					});
				},
				async () => await triage.run(ctx as never),
			);
			assert.deepEqual(result, { handler: "account" });
		} finally {
			delete process.env.TYPESAFE_API_KEY;
		}
		assert.equal(seen.length, 1);
		assert.match(seen[0]!.url, /\/systemone$/u);
		assert.equal(seen[0]!.authorization, "Bearer test-typesafe-key");
		assert.equal(seen[0]!.payload.model, "jev-latest");
		assert.deepEqual(seen[0]!.payload.state, { request: "Why was my account charged twice?" });
		assert.deepEqual(toolCalls, ["classify-intent"]);
		assert.equal(taskCalls.length, 1);
		assert.equal(taskCalls[0]!.name, "account-review");
		assert.match(taskCalls[0]!.prompt ?? "", /charged twice/u);
	});

	test("triage sends an uncertain answer to human review without starting a stage", async () => {
		const project = userProject();
		const { registry } = await discoverWorkflows({ cwd: project, homeDir: project, includeBundled: false });
		const triage = registry.get("triage");
		assert.ok(triage);
		const { ctx, taskCalls } = fakeContext(project, { request: "hello?" });
		process.env.TYPESAFE_API_KEY = "test-typesafe-key";
		try {
			const result = await withFetch(
				() =>
					jsonResponse({
						answers: {
							intent: { type: "choice", choice: "product", probabilities: { product: 0.4 }, confidence: 0.41 },
						},
					}),
				async () => await triage.run(ctx as never),
			);
			assert.deepEqual(result, { handler: "human review required" });
		} finally {
			delete process.env.TYPESAFE_API_KEY;
		}
		assert.deepEqual(taskCalls, []);
	});

	test("triage surfaces a missing TypeSafe key as the tool error instead of a silent route", async () => {
		const project = userProject();
		const { registry } = await discoverWorkflows({ cwd: project, homeDir: project, includeBundled: false });
		const triage = registry.get("triage");
		assert.ok(triage);
		const { ctx, taskCalls } = fakeContext(project, { request: "anything" });
		delete process.env.TYPESAFE_API_KEY;
		await assert.rejects(
			withFetch(
				() => {
					throw new Error("no request expected without a key");
				},
				async () => await triage.run(ctx as never),
			),
			/Provider is not configured: typesafe/u,
		);
		assert.deepEqual(taskCalls, []);
	});

	test("preview-asset writes the generated image under the run's asset directory", async () => {
		const project = userProject();
		const { registry } = await discoverWorkflows({ cwd: project, homeDir: project, includeBundled: false });
		const previewAsset = registry.get("preview-asset");
		assert.ok(previewAsset);
		const { ctx, toolCalls } = fakeContext(project, { brief: "a teal onboarding illustration" });
		const png = Buffer.from("fake-png-bytes").toString("base64");
		const seen: Array<{ url: string; authorization: string | undefined; payload: Record<string, unknown> }> = [];
		process.env.OPENROUTER_API_KEY = "test-openrouter-key";
		try {
			const result = await withFetch(
				(url, init) => {
					const headers = new Headers(init.headers);
					seen.push({
						url,
						authorization: headers.get("authorization") ?? undefined,
						payload: JSON.parse(String(init.body)) as Record<string, unknown>,
					});
					return jsonResponse({
						id: "gen-1",
						choices: [
							{
								message: {
									content: "",
									images: [{ image_url: { url: `data:image/png;base64,${png}` } }],
								},
							},
						],
					});
				},
				async () => await previewAsset.run(ctx as never),
			);
			const imagePath = (result as { imagePath: string }).imagePath;
			assert.equal(imagePath, join(project, ".atomic", "workflow-assets", "run-1", "preview.png"));
			assert.equal(readFileSync(imagePath, "utf8"), "fake-png-bytes");
		} finally {
			delete process.env.OPENROUTER_API_KEY;
		}
		assert.equal(seen.length, 1);
		assert.match(seen[0]!.url, /openrouter\.ai\/api\/v1\/chat\/completions$/u);
		assert.equal(seen[0]!.authorization, "Bearer test-openrouter-key");
		assert.equal(seen[0]!.payload.model, "google/gemini-2.5-flash-image");
		assert.deepEqual(seen[0]!.payload.modalities, ["image", "text"]);
		assert.deepEqual(toolCalls, ["generate-preview"]);
	});
});
