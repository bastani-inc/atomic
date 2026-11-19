import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { bunExecutable, moduleDir, sleep } from "../helpers/runtime.js";

/** Real Bun CLI startup, an engine child, one stuck call and its late result. */
const REAL_ENGINE_TIMEOUT_MS = 120_000;
/** How long this engine lets a call run on after its turn is interrupted. */
const ENGINE_GRACE_MS = 300;
/** The interrupt must end the engine's turn well within this, grace included. */
const ABORT_BUDGET_MS = 10_000;
/** How long the released fixture may take to finish in the engine child. */
const TOOL_FINISH_BUDGET_MS = 20_000;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("\n") : "";
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test(
	"Esc ends the isolated engine's turn while a tool call ignores the interrupt, and its late output does not enter the conversation (#5486)",
	async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-tool-abort-grace-"));
		const started = join(tempDir, "stuck.started");
		const requests = join(tempDir, "requests");
		const client = new RpcClient({
			cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
			cwd: join(moduleDir(import.meta.url), "../.."),
			runtimeExecutable: bunExecutable(),
			provider: "stuck-tool-fixture",
			model: "stuck-tool-model",
			env: {
				ATOMIC_CODING_AGENT_DIR: join(tempDir, "agent"),
				ATOMIC_TOOL_ABORT_GRACE_MS: String(ENGINE_GRACE_MS),
				ATOMIC_STUCK_TOOL_STARTED_FILE: started,
				ATOMIC_STUCK_TOOL_REQUESTS_FILE: requests,
			},
			args: [
				"--no-session",
				"--approve",
				"--no-extensions",
				"--extension",
				join(moduleDir(import.meta.url), "fixtures", "stuck-tool-extension.ts"),
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--offline",
			],
			interactiveEngine: { onDiagnostic: () => {} },
		});
		try {
			await client.start();
			await client.waitForInteractiveEngineBound();
			await client.prompt("go");
			const deadline = Date.now() + ABORT_BUDGET_MS;
			while (!existsSync(started)) {
				assert.ok(Date.now() < deadline, "the stuck call never started");
				await sleep(20);
			}
			assert.notEqual(Number(readFileSync(started, "utf8")), process.pid, "the call runs in the engine child");

			assert.ok(await settlesWithin(client.abort(), ABORT_BUDGET_MS), "the interrupted engine turn ends");
			const result = (await client.getMessages()).find((message) => message.role === "toolResult");
			assert.ok(result?.role === "toolResult");
			assert.equal(result.isError, true);
			assert.match(textOf(result.content), /^Operation aborted: stuck did not stop within 0\.3 seconds/);

			const requestsBefore = readFileSync(requests, "utf8");
			const transcript = await client.getMessages();
			writeFileSync(`${started}.release`, "");
			const finishDeadline = Date.now() + TOOL_FINISH_BUDGET_MS;
			while (!existsSync(`${started}.returned`)) {
				assert.ok(Date.now() < finishDeadline, "the tool never finished");
				await sleep(20);
			}
			assert.deepEqual(await client.getMessages(), transcript, "the late result does not change the conversation");
			assert.equal(readFileSync(requests, "utf8"), requestsBefore, "the late result starts no turn");
		} finally {
			writeFileSync(`${started}.release`, "");
			await client.stop();
			rmSync(tempDir, { recursive: true, force: true });
		}
	},
	REAL_ENGINE_TIMEOUT_MS,
);
