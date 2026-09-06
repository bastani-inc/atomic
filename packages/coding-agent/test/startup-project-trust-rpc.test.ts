import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";
import { bunExecutable, cliPath } from "./cli-test-helpers.ts";

// Real CLI startup, extension loading, and RPC input are structural work.
const REAL_STARTUP_RPC_TIMEOUT_MS = 120_000;

for (const scenario of [
	"approve",
	"deny",
	"cancel",
	"confirm",
	"input",
	"borrowed-approve",
	"borrowed-deny",
	"hung-observer",
	"extension-error",
] as const) {
	// #2873: the child must own startup trust after the input reader and real session are bound.
	test(
		`isolated startup ${scenario} emits live prompt events before an RPC answer`,
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-startup-rpc-"));
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			const marker = join(root, "project-loaded");
			const log = join(root, "events.jsonl");
			const borrowed = scenario.startsWith("borrowed-");
			const resourceCwd = borrowed ? join(root, "borrowed") : cwd;
			mkdirSync(cwd, { recursive: true });
			mkdirSync(join(resourceCwd, ".atomic", "extensions"), { recursive: true });
			const brokenExtension = join(resourceCwd, ".atomic", "extensions", "broken.ts");
			if (scenario === "extension-error")
				writeFileSync(brokenExtension, `export default function() { throw new Error('startup fixture failure'); }`);
			if (!borrowed)
				writeFileSync(
					join(cwd, ".atomic", "settings.json"),
					JSON.stringify({
						defaultProvider: "startup-authorized",
						defaultModel: "project-model",
						defaultThinkingLevel: "high",
					}),
				);
			if (borrowed) {
				mkdirSync(join(resourceCwd, "extensions"), { recursive: true });
				writeFileSync(join(resourceCwd, "extensions", "authorized.ts"), `export default function() {}`);
			}
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(
				join(resourceCwd, ".atomic", "extensions", "forbidden.ts"),
				`
			import { writeFileSync, appendFileSync } from 'node:fs';
			export default function(pi) {
				writeFileSync(${JSON.stringify(marker)}, 'loaded');
				pi.registerProvider('startup-authorized', {
					baseUrl:'https://startup.invalid', api:'openai-completions', apiKey:'local-test-key',
					models:[{id:'project-model', name:'Project model', reasoning:true, input:['text'],
						cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:8192, maxTokens:256}],
				});
				pi.on('session_start', () => appendFileSync(${JSON.stringify(log)}, JSON.stringify({type:'project_start'})+'\\n'));
				pi.on('ui_prompt_start', () => appendFileSync(${JSON.stringify(log)}, JSON.stringify({type:'forbidden_replay'})+'\\n'));
			}
		`,
			);
			const kind = scenario === "confirm" || scenario === "input" ? scenario : "select";
			writeFileSync(
				join(agentDir, "extensions", "reporter.ts"),
				`
			import { appendFileSync } from 'node:fs';
			const record = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry)+'\\n');
			export default function(pi) {
				record({type:'factory'});
				pi.on('session_start', () => record({type:'session_start'}));
				pi.on('session_shutdown', () => record({type:'session_shutdown'}));
				pi.on('ui_prompt_start', (event, ctx) => {
					record({...event, cwd:ctx.cwd, sessionId:ctx.sessionManager.getSessionId(), idle:ctx.isIdle(), trusted:ctx.isProjectTrusted()});
					ctx.ui.notify('startup-start-observed');
					${scenario === "hung-observer" ? "return new Promise(() => {});" : ""}
				});
				pi.on('ui_prompt_end', (event, ctx) => {
					record({...event, cwd:ctx.cwd, sessionId:ctx.sessionManager.getSessionId()});
					ctx.ui.notify('startup-end-observed');
				});
				${
					kind === "select"
						? ""
						: `pi.on('project_trust', async (_event, ctx) => {
					record({type:'trust_hook'});
					const answer = await ctx.ui.${kind}('Hook trust', 'Approve?');
					return {trusted:answer ? 'yes' : 'no'};
				});`
				}
			}
		`,
			);
			const client = new RpcClient({
				cliPath,
				cwd,
				runtimeExecutable: bunExecutable(),
				args: [
					"--no-session",
					"--offline",
					"--no-skills",
					"--no-themes",
					"--no-prompt-templates",
					...(borrowed ? ["-e", resourceCwd] : []),
				],
				env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
				interactiveEngine: { onDiagnostic: () => {} },
			});
			let prompt!: (request: RpcExtensionUIRequest) => void;
			let start!: () => void;
			let end!: () => void;
			const promptPromise = new Promise<RpcExtensionUIRequest>((resolve) => {
				prompt = resolve;
			});
			const startPromise = new Promise<void>((resolve) => {
				start = resolve;
			});
			const endPromise = new Promise<void>((resolve) => {
				end = resolve;
			});
			client.onExtensionUIRequest((request) => {
				if (request.method === kind) prompt(request);
				if (request.method === "notify" && request.message === "startup-start-observed") start();
				if (request.method === "notify" && request.message === "startup-end-observed") end();
			});
			const entries = (): Array<{
				type: string;
				cwd?: string;
				sessionId?: string;
				idle?: boolean;
				trusted?: boolean;
				reason?: string;
				kind?: string;
			}> =>
				readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
			try {
				await client.start();
				const request = await promptPromise;
				await startPromise;
				assert.equal(existsSync(marker), false);
				const before = entries();
				const observed = before.find((entry) => entry.type === "ui_prompt_start");
				assert.ok(observed?.sessionId);
				assert.equal(observed.cwd, realpathSync(cwd));
				assert.equal(observed.idle, true);
				assert.equal(observed.trusted, borrowed);
				assert.equal(observed.reason, "project_trust");
				assert.equal(observed.kind, kind);
				assert.equal(before.filter((entry) => entry.type === "session_start").length, 1);
				if (scenario === "cancel")
					await client.respondExtensionUI({ type: "extension_ui_response", id: request.id, cancelled: true });
				else if (scenario === "confirm")
					await client.respondExtensionUI({ type: "extension_ui_response", id: request.id, confirmed: true });
				else
					await client.respondExtensionUI({
						type: "extension_ui_response",
						id: request.id,
						value:
							scenario === "input"
								? "yes"
								: scenario === "approve" ||
										scenario === "borrowed-approve" ||
										scenario === "hung-observer" ||
										scenario === "extension-error"
									? "Trust (this session only)"
									: "Do not trust (this session only)",
					});
				await endPromise;
				if (scenario === "extension-error") {
					await assert.rejects(client.waitForInteractiveEngineResources(), /startup fixture failure/);
					assert.equal(entries().filter((entry) => entry.type === "project_start").length, 0);
					rmSync(brokenExtension);
					await client.requestInternal({ type: "reload" });
				}
				await client.waitForInteractiveEngineResources();
				const after = entries();
				assert.equal(after.filter((entry) => entry.type === "factory").length, 1);
				assert.equal(
					existsSync(marker),
					scenario !== "deny" && scenario !== "cancel" && scenario !== "borrowed-deny",
				);
				assert.equal(after.filter((entry) => entry.type === "session_start").length, 1);
				assert.equal(after.filter((entry) => entry.type === "session_shutdown").length, 0);
				assert.equal(after.filter((entry) => entry.type === "ui_prompt_start").length, 1);
				assert.equal(after.filter((entry) => entry.type === "ui_prompt_end").length, 1);
				assert.equal(after.find((entry) => entry.type === "ui_prompt_end")?.sessionId, observed.sessionId);
				assert.equal(
					after.some((entry) => entry.type === "forbidden_replay"),
					false,
				);
				assert.equal(after.filter((entry) => entry.type === "trust_hook").length, kind === "select" ? 0 : 1);
				if (!borrowed && scenario !== "deny" && scenario !== "cancel") {
					const state = await client.getState();
					assert.equal(state.model?.id, "project-model");
					assert.equal(state.thinkingLevel, "high");
				}
			} finally {
				await client.stop();
				rmSync(root, { recursive: true, force: true });
			}
		},
		REAL_STARTUP_RPC_TIMEOUT_MS,
	);
}
