import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import { getWorkflowHostModules } from "../../packages/coding-agent/src/core/extensions/loader-host-modules.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import { moduleDir } from "../helpers/runtime.js";

/**
 * The classifier and image examples in the workflow authoring guide are the
 * only documented way to call a non-chat model from workflow TypeScript. They
 * are loaded through workflow discovery with the host's module instances and
 * no project node_modules, then executed against a stubbed provider response.
 * The result fields the snippets read (`stopReason`, `answers.intent`,
 * `output[].type === "image"`) are the real ones.
 */
const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");
const authoringDoc = join(repositoryRoot, "packages/coding-agent/docs/workflows/authoring.md");
const SECTION_HEADING = "### Classifier and image models in `ctx.tool`";

const tempDirs: string[] = [];
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
});

function documentedExamples(): { triage: string; previewAsset: string; svgAndGif: string } {
	const text = readFileSync(authoringDoc, "utf8").replaceAll("\r\n", "\n");
	const start = text.indexOf(SECTION_HEADING);
	assert.notEqual(start, -1, `${SECTION_HEADING} is missing from the authoring guide`);
	const end = text.indexOf("\n### ", start + SECTION_HEADING.length);
	const section = text.slice(start, end === -1 ? undefined : end);
	const fences = [...section.matchAll(/^```ts\n([\s\S]*?)^```/gmu)].map((match) => match[1] ?? "");
	assert.equal(fences.length, 3, "the section documents a classifier workflow, an image workflow and an SVG/GIF step");
	const [triage, previewAsset, svgAndGif] = fences as [string, string, string];
	assert.match(triage, /\.atomic\/workflows\/triage\.ts|name: "triage"/u);
	assert.match(previewAsset, /name: "preview-asset"/u);
	assert.match(svgAndGif, /ctx\.tool\("generate-svg-and-gif"/u);
	return { triage, previewAsset, svgAndGif };
}

function userProject(): string {
	const project = mkdtempSync(join(tmpdir(), "atomic-docs-model-ops-"));
	tempDirs.push(project);
	process.env.ATOMIC_CODING_AGENT_DIR = join(project, "agent-config");
	mkdirSync(join(project, ".atomic/workflows"), { recursive: true });
	const { triage, previewAsset, svgAndGif } = documentedExamples();
	writeFileSync(join(project, ".atomic/workflows/triage.ts"), triage);
	writeFileSync(join(project, ".atomic/workflows/preview-asset.ts"), previewAsset);
	writeFileSync(
		join(project, ".atomic/workflows/svg-and-gif.ts"),
		`${previewAsset.slice(0, previewAsset.indexOf("export default"))}
export default workflow({
  name: "svg-and-gif",
  description: "Exercise the documented SVG and GIF tool step.",
  inputs: { brief: Type.String() },
  outputs: { paths: Type.Record(Type.String(), Type.String()), svgModel: Type.Optional(Type.String()) },
  run: async (ctx) => {
    const brief = ctx.inputs.brief;
    const outputDir = join(ctx.cwd, ".atomic", "workflow-assets", ctx.runId);
    ${svgAndGif}
    return assets;
  },
});`,
	);
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
	test("all documented model examples register without project node_modules (#3454, #4615)", async () => {
		const project = userProject();
		const { registry, errors } = await discoverWorkflows({
			cwd: project,
			homeDir: project,
			includeBundled: false,
			getWorkflowHostModules,
		});
		assert.deepEqual(errors, []);
		assert.deepEqual(registry.names().sort(), ["preview-asset", "svg-and-gif", "triage"]);
	});

	test("triage routes a confident classifier answer to a chat stage and leaves the classifier out of execution", async () => {
		const project = userProject();
		const { registry } = await discoverWorkflows({
			cwd: project,
			homeDir: project,
			includeBundled: false,
			getWorkflowHostModules,
		});
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
		const { registry } = await discoverWorkflows({
			cwd: project,
			homeDir: project,
			includeBundled: false,
			getWorkflowHostModules,
		});
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
		const { registry } = await discoverWorkflows({
			cwd: project,
			homeDir: project,
			includeBundled: false,
			getWorkflowHostModules,
		});
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

	test("the documented SVG/GIF step negotiates SVG and saves both formats (#4615)", async () => {
		const project = userProject();
		const { registry, errors } = await discoverWorkflows({
			cwd: project,
			homeDir: project,
			includeBundled: false,
			getWorkflowHostModules,
		});
		assert.deepEqual(errors, []);
		const svgAndGif = registry.get("svg-and-gif");
		assert.ok(svgAndGif);
		const { ctx, toolCalls } = fakeContext(project, { brief: "a teal loading animation" });
		const seen: Array<Record<string, unknown>> = [];
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
		const gif = "GIF89a-test-frames";
		process.env.OPENAI_API_KEY = "test-openai-key";
		try {
			const result = await withFetch(
				(url, init) => {
					assert.match(url, /\/images\/generations$/u);
					assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-openai-key");
					const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
					seen.push(payload);
					if (seen.length === 1) {
						return new Response(
							JSON.stringify({ error: { code: "missing_required_parameter", param: "svg.model" } }),
							{ status: 400, headers: { "content-type": "application/json" } },
						);
					}
					return jsonResponse({
						data: [{ b64_json: Buffer.from(payload.output_format === "svg" ? svg : gif).toString("base64") }],
						...(payload.output_format === "svg" ? { svg_usage: { model: "test-svg-author" } } : {}),
					});
				},
				async () => await svgAndGif.run(ctx as never),
			);
			const assets = result as { svgModel: string; paths: Record<string, string> };
			assert.equal(assets.svgModel, "test-svg-author");
			assert.deepEqual(assets.paths, {
				"image.svg": join(project, ".atomic", "workflow-assets", "run-1", "image.svg"),
				"image.gif": join(project, ".atomic", "workflow-assets", "run-1", "image.gif"),
			});
			assert.equal(readFileSync(assets.paths["image.svg"]!, "utf8"), svg);
			assert.equal(readFileSync(assets.paths["image.gif"]!, "utf8"), gif);
		} finally {
			delete process.env.OPENAI_API_KEY;
		}
		assert.deepEqual(toolCalls, ["generate-svg-and-gif"]);
		assert.equal(seen.length, 3);
		assert.deepEqual(
			seen.map((payload) => payload.output_format),
			["svg", "svg", "gif"],
		);
		assert.equal(seen[0]!.svg, undefined);
		assert.deepEqual(seen[1]!.svg, { model: "gpt-6.1-sol" });
		assert.equal(seen[2]!.svg, undefined);
		assert.equal(seen[2]!.frame_count, 4);
		assert.equal(seen[2]!.frame_duration_ms, 200);
		assert.equal(seen[2]!.size, "512x512");
		for (const payload of seen) {
			assert.equal(payload.model, "gpt-image-2.6-flare");
			assert.equal(payload.prompt, "a teal loading animation");
		}
	});

	test("preview-asset writes the generated image under the run's asset directory", async () => {
		const project = userProject();
		const { registry } = await discoverWorkflows({
			cwd: project,
			homeDir: project,
			includeBundled: false,
			getWorkflowHostModules,
		});
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
