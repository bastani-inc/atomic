import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { fileExists, moduleDir, readText } from "../helpers/runtime.js";
import {
	type CreateAgentSessionOptions,
	createStore,
	mockSession,
	run,
	type StageSessionRuntime,
	structuredOutputMockSession,
	type WorkflowDefinition,
} from "./executor-shared.js";

const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");
const documentationPath = resolve(repositoryRoot, "packages/coding-agent/docs/workflows.md");

async function readDocumentation(): Promise<string> {
	return (await readText(documentationPath)).replaceAll("\r\n", "\n");
}

function extractExample(documentation: string, filename: string): string {
	const marker = `// .atomic/workflows/${filename}`;
	const opening = `\`\`\`ts\n${marker}\n`;
	const tail = documentation.split(opening)[1];
	if (tail === undefined) throw new Error(`missing ${filename} example`);
	const body = tail.split("\n```", 1)[0];
	if (body === undefined) throw new Error(`unterminated ${filename} example`);
	return `${marker}\n${body}\n`;
}

async function loadExample(
	documentation: string,
	filename: string,
	directory: string,
): Promise<{ readonly definition: WorkflowDefinition; readonly source: string }> {
	const source = extractExample(documentation, filename);
	const examplePath = resolve(directory, filename);
	await writeFile(examplePath, source);
	const loaded = (await import(`${pathToFileURL(examplePath).href}?test=${filename}-${Date.now()}`)) as {
		readonly default: WorkflowDefinition;
	};
	return { definition: loaded.default, source };
}

function textSession(stageName: string, prompts: Map<string, string[]>): StageSessionRuntime {
	return {
		...mockSession(),
		sessionFile: undefined,
		async prompt(text: string) {
			const stagePrompts = prompts.get(stageName) ?? [];
			stagePrompts.push(text);
			prompts.set(stageName, stagePrompts);
		},
		getLastAssistantText() {
			return `output from ${stageName}`;
		},
	};
}

function testUi(onEditor: () => void = () => {}): {
	input: (prompt: string) => Promise<string>;
	confirm: (message: string) => Promise<boolean>;
	select: <T extends string>(message: string, options: readonly T[]) => Promise<T>;
	editor: (initial?: string) => Promise<string>;
} {
	return {
		input: async () => "input",
		confirm: async () => true,
		select: async <T extends string>(_message: string, options: readonly T[]) => options[0]!,
		editor: async () => {
			onEditor();
			return "No unclear decisions remain.";
		},
	};
}

describe("workflow scope-guard guidance", () => {
	test("locks the scope contract, decision actions, fallback, and lifecycle rules", async () => {
		const documentation = await readDocumentation();

		for (const phrase of [
			"one inspectable contract artifact",
			"Treat it as immutable for that run",
			"literal objective",
			"required scope and allowed files or systems",
			"explicit non-goals",
			"stage boundaries and expected lifecycle order",
			"acceptance criteria and required evidence",
			"`required`",
			"`dependent`",
			"`follow-up`",
			"`unclear`",
			"one row per key",
			"cap the log",
			"A guard failure or missing coordination channel never means approval",
			"`warn`",
			"`block`",
			"`off`",
			"Expected lifecycle state is not a defect",
			"must not reject the patch merely because it is unpushed or unpublished",
			"It controls scope only",
		]) {
			expect(documentation).toContain(phrase);
		}
	});

	test("locks acyclic role-based context and inherited-group guidance", async () => {
		const documentation = await readDocumentation();

		for (const phrase of [
			"A boundary guard is an ordinary downstream reviewer node",
			"Live Intercom steering is activity inside already-running parallel stages, not a new graph edge",
			"Never make a guard watch itself",
			"Late messages do not reopen or mutate its terminal workflow state",
			"releases downstream work only after all started branches settle",
			"Pause/resume, model fallback, durable replay, and nested workflows",
			"Omit `group` for ordinary use",
			"delegated subagents inherit the top-level workflow invocation's stable Intercom group",
			'Use `context: "fresh"` for guards, reviewers, and judges',
			'Use `context: "fork"` plus `forkFromSessionFile` for implementation, debugging, and repair roles',
			'`context: "fork"` alone does not name a fork source',
			"use the earlier worker's `sessionFile` when available",
			"Send a forked continuation only the delta after the fork point",
			"Complete all turns on a retained guard before starting downstream dependency work",
		]) {
			expect(documentation).toContain(phrase);
		}
	});

	test("keeps all three starter examples loadable and on current APIs", async () => {
		const documentation = await readDocumentation();
		const examples = [
			{
				filename: "scope-guard-boundary.ts",
				name: "scope-guard-boundary",
				api: 'ctx.task("scope boundary"',
				inputs: ["scope_contract", "artifact_dir"],
			},
			{
				filename: "scope-guard-retained.ts",
				name: "scope-guard-retained",
				api: 'ctx.stage("retained scope guard"',
				inputs: ["scope_contract", "artifact_dir"],
			},
			{
				filename: "scope-guard-live.ts",
				name: "scope-guard-live",
				api: "ctx.parallel(",
				inputs: ["scope_contract", "worker_session_file", "fallback_policy", "artifact_dir"],
			},
		] as const;
		const tempDirectory = await mkdtemp(resolve(repositoryRoot, "test", ".scope-guard-examples-"));

		try {
			for (const example of examples) {
				const { definition, source } = await loadExample(documentation, example.filename, tempDirectory);
				expect(source).toContain(example.api);
				expect(source).toContain('context: "fresh"');
				expect(source).toContain('context: "fork"');
				expect(source).not.toContain("watchdog:");
				if (example.name === "scope-guard-retained") {
					expect(source.match(/guard\.prompt\(/g)).toHaveLength(1);
					expect(source).toContain("guard.sendUserMessage(");
				}
				if (example.name === "scope-guard-live") {
					expect(source).toContain("forkFromSessionFile: sessionFile");
					expect(source).toContain("fallback_policy:");
					expect(source).toContain('ctx.task("persist scope decisions"');
					expect(source).toContain("{ concurrency: 2, failFast: true }");
					expect(source).not.toContain("group:");
					expect(source.indexOf("ctx.parallel(")).toBeLessThan(source.indexOf("persist scope decisions"));
					expect(source.indexOf("persist scope decisions")).toBeLessThan(
						source.indexOf("independent correctness review"),
					);
				}

				expect(definition.name).toBe(example.name);
				expect(Object.keys(definition.inputs)).toEqual([...example.inputs]);
				expect(definition.outputs).toHaveProperty("decision_log");
			}
		} finally {
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("executes the retained post-prompt lifecycle", async () => {
		const documentation = await readDocumentation();
		const tempDirectory = await mkdtemp(resolve(repositoryRoot, "test", ".scope-guard-retained-run-"));
		const contract = resolve(tempDirectory, "scope.md");
		const prompts = new Map<string, string[]>();

		try {
			await writeFile(contract, "# Immutable scope\nOnly edit docs.\n");
			const { definition } = await loadExample(documentation, "scope-guard-retained.ts", tempDirectory);
			const result = await run(
				definition,
				{ scope_contract: contract, artifact_dir: tempDirectory },
				{
					cwd: tempDirectory,
					store: createStore(),
					ui: testUi(),
					adapters: {
						agentSession: {
							async create(_options, meta) {
								return textSession(meta?.stageName ?? "unknown", prompts);
							},
						},
					},
				},
			);

			expect(result.status).toBe("completed");
			expect(prompts.get("retained scope guard")).toHaveLength(2);
			expect(prompts.get("retained scope guard")?.[1]).toContain("Recheck the complete candidate");
			expect(await fileExists(resolve(tempDirectory, "scope-decisions.md"))).toBe(true);
		} finally {
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("executes live persistence and the block fallback", async () => {
		const documentation = await readDocumentation();
		const tempDirectory = await mkdtemp(resolve(repositoryRoot, "test", ".scope-guard-live-run-"));
		const contract = resolve(tempDirectory, "scope.md");
		const guardTranscript = resolve(tempDirectory, "guard.jsonl");

		try {
			await writeFile(contract, "# Immutable scope\nOnly edit docs.\n");
			await writeFile(guardTranscript, "guard classification transcript\n");
			const { definition } = await loadExample(documentation, "scope-guard-live.ts", tempDirectory);
			const execute = async (
				status: "available" | "unavailable",
				fallbackPolicy: "warn" | "block",
				artifactDir: string,
				onEditor: () => void,
			) => {
				const stageNames: string[] = [];
				return await run(
					definition,
					{
						scope_contract: contract,
						fallback_policy: fallbackPolicy,
						artifact_dir: artifactDir,
					},
					{
						cwd: tempDirectory,
						store: createStore(),
						ui: testUi(onEditor),
						adapters: {
							agentSession: {
								async create(options: CreateAgentSessionOptions, meta) {
									const stageName = meta?.stageName ?? "unknown";
									stageNames.push(stageName);
									if (stageName === "scope guard") {
										return {
											...structuredOutputMockSession(options, { status, evidence: `intercom ${status}` }),
											// A normal stage transcript can exist even when Intercom is unavailable.
											sessionFile: guardTranscript,
										};
									}
									return textSession(stageName, new Map());
								},
							},
						},
						onRunEnd: () => {
							expect(stageNames.indexOf("persist scope decisions")).toBeLessThan(
								stageNames.indexOf("independent correctness review"),
							);
						},
					},
				);
			};

			const availableDir = resolve(tempDirectory, "available");
			let editorCalls = 0;
			const available = await execute("available", "warn", availableDir, () => {
				editorCalls += 1;
			});
			expect(available.status).toBe("completed");
			expect(editorCalls).toBe(0);
			expect(await fileExists(resolve(availableDir, "scope-decisions.md"))).toBe(true);

			const blockedDir = resolve(tempDirectory, "blocked");
			const blocked = await execute("unavailable", "block", blockedDir, () => {
				editorCalls += 1;
			});
			expect(blocked.status).toBe("completed");
			expect(editorCalls).toBe(1);
			expect(await fileExists(resolve(blockedDir, "scope-decisions.md"))).toBe(true);
		} finally {
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});
});
