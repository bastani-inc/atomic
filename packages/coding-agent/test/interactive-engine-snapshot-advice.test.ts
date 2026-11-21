import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { bunExecutable, cliPath, removeTempDirs } from "./cli-test-helpers.ts";

/** Structural cost: two real interactive engine processes boot, load the extension and run a turn each. */
const REAL_ENGINE_TIMEOUT_MS = 240_000;
/** A loaded runner has taken over 60 s to boot the CLI; the first answered request waits for that. */
const CLI_BOOT_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 60_000;

const tempDirs: string[] = [];
afterEach(() => removeTempDirs(tempDirs));

/** A local provider whose model writes a file when given a prompt, then answers once the write's result is back. */
function writeFileWritingProvider(root: string): string {
	const extensionPath = join(root, "file-writing-provider.ts");
	writeFileSync(
		extensionPath,
		`import type { ExtensionAPI } from "@bastani/atomic";
import { createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";

let writes = 0;
export default function fileWritingProvider(pi: ExtensionAPI): void {
	pi.registerProvider("advice-test", {
		baseUrl: "https://advice.invalid/v1",
		api: "openai-completions",
		apiKey: "local-test-key",
		models: [{
			id: "writer",
			name: "Writer",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 256,
		}],
		streamSimple: (model, context) => {
			const stream = createAssistantMessageEventStream();
			const prompted = context.messages.at(-1)?.role === "user";
			const message = {
				role: "assistant" as const,
				content: prompted
					? [{ type: "toolCall" as const, id: "write-" + ++writes, name: "write", arguments: { path: "written-" + writes + ".txt", content: "x\\n" } }]
					: [{ type: "text" as const, text: "done" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: prompted ? ("toolUse" as const) : ("stop" as const),
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: structuredClone(message) });
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		},
	});
}
`,
	);
	return extensionPath;
}

test(
	"an interactive engine reports a new session's store once, and an engine restarted for it does not again",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-engine-snapshot-advice-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		// The host starts a new session in files, which cannot hold snapshots, and hands it to its engine.
		const started = await SessionManager.create(cwd, sessionDir);
		const sessionId = started.getSessionId();
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			provider: "advice-test",
			model: "writer",
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			args: [
				"--session",
				sessionId,
				"--session-dir",
				sessionDir,
				"--offline",
				"--no-extensions",
				"--extension",
				writeFileWritingProvider(root),
				"--no-skills",
				"--no-themes",
				"--no-prompt-templates",
			],
			requestTimeoutMs: CLI_BOOT_TIMEOUT_MS,
			interactiveEngine: { onDiagnostic: () => {}, startedSessionId: sessionId },
		});
		const advice = async (prompt: string) =>
			(await client.promptAndWait(prompt, undefined, TURN_TIMEOUT_MS)).flatMap((event) =>
				event.type === "worktree_snapshot_unavailable" ? [event.reason.code] : [],
			);
		try {
			await client.start();
			await client.getState();
			assert.deepEqual(await advice("write a file"), ["blob-store-unsupported"]);
			assert.deepEqual(await advice("write another"), [], "not on every turn that writes");

			await client.restart(sessionId, { cwd, sessionDirectory: sessionDir });
			await client.getState();
			assert.deepEqual(await advice("write after the restart"), [], "a restarted engine resumes the session");
		} finally {
			await client.stop();
		}
	},
	REAL_ENGINE_TIMEOUT_MS,
);
