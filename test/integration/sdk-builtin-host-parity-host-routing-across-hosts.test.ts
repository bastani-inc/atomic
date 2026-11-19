import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import {
	createAgentSession,
	type HostInputOptions,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { WorkflowProcessHome } from "../helpers/workflow-process.js";
import { attachedCliPresentation, forwardCliDialogs } from "./fixtures/sdk-host-cli.js";

const HOSTS = ["node", "cli"] as const;
/** Each host opens two real sessions, including a full builtin loader, then settles and disposes its workflow. */
const REAL_BUILTIN_HOST_PAIR_TIMEOUT_MS = HOSTS.length * 60_000;

// #3105: one on-disk definition, identical runtime policy, real CLI dialog bridge.
test.each(["true", "false", "cancelled", "invalid", "late"] as const)(
	"unchanged workflow across hosts: %s (#3105, #5520)",
	async (reply) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-same-host-source-"));
		const directory = join(cwd, ".atomic", "workflows");
		mkdirSync(directory, { recursive: true });
		const effect = join(cwd, "effects.jsonl");
		const source = join(directory, "sdk-host-durable.ts");
		writeFileSync(source, readFileSync(new URL("../fixtures/sdk-host-durable-workflow.ts", import.meta.url)));
		vi.stubEnv("ATOMIC_FAULT_TEST_HOME", cwd);
		const hash = () => createHash("sha256").update(readFileSync(source)).digest("hex");
		const original = hash();
		const text = "  durable text  ";
		const options = {
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: SettingsManager.inMemory(),
			builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		};
		try {
			for (const host of HOSTS) {
				const presentation = attachedCliPresentation(text, reply);
				const requests: HostInputOptions[] = [];
				const late = Promise.withResolvers<boolean>();
				const { session: cli } = await createAgentSession({
					...options,
					sessionManager: SessionManager.inMemory(cwd),
					extensionBindings: { uiContext: presentation.uiContext },
				});
				const humanInput =
					host === "cli"
						? forwardCliDialogs(cli.extensionRunner!.createContext().ui)
						: {
								input: async () => text,
								confirm: async (_title: string, _message: string, options: HostInputOptions) => {
									requests.push(options);
									if (reply === "late" || reply === "cancelled") return late.promise;
									return (reply === "invalid" ? "true" : reply === "true") as boolean;
								},
								select: async () => undefined,
								editor: async () => undefined,
								questionnaire: async () => ({ answers: [], cancelled: true }),
							};
				const { session } = await createAgentSession({
					...options,
					sessionManager: SessionManager.inMemory(cwd),
					extensionBindings: { humanInput },
				});
				try {
					const tool = session.agent.state.tools.find((t) => t.name === "workflow")!;
					await tool.execute(
						"run",
						{ action: "run", workflow: "sdk-host-durable", inputs: {} },
						new AbortController().signal,
					);
					await vi.waitFor(
						() =>
							assert.equal(
								host === "cli" ? presentation.dialogs.length : requests.length,
								host === "cli" ? 2 : 1,
							),
						{ timeout: 5000 },
					);
					if (reply === "late" || reply === "cancelled") {
						await session.bindExtensions({ humanInput: null });
						if (host === "cli")
							assert.equal(presentation.activeDialog, false, "actual CLI abort handler dismissed the dialog");
						else assert.equal(requests[0]!.signal.aborted, true);
						if (reply === "late") {
							presentation.lateTrue();
							late.resolve(true);
						}
					}
					// Drain adapter settlement before asserting that malformed/stale replies cannot advance.
					await new Promise((resolve) => setImmediate(resolve));
					await vi.waitFor(
						async () => {
							const result = await tool.execute("status", { action: "status" }, new AbortController().signal);
							assert.equal(
								(result.details as { runs: { status: string }[] }).runs[0]?.status,
								reply === "true" || reply === "false" ? "completed" : "running",
								JSON.stringify({ host, dialogs: presentation.dialogs, details: result.details }),
							);
							if (reply !== "true" && reply !== "false")
								assert.match(JSON.stringify(result.details), /"promptKind":"confirm"/);
							else
								assert.deepEqual(
									(result.details as { snapshots: { result: unknown }[] }).snapshots[0]?.result,
									{ text, approved: reply === "true" },
								);
						},
						{ timeout: 5000 },
					);
					if (host === "cli") assert.deepEqual(presentation.dialogs, ["input", "confirm"]);
					assert.equal(hash(), original);
				} finally {
					await session.dispose();
					await cli.dispose();
				}
			}
			if (reply === "true")
				assert.deepEqual(
					readFileSync(effect, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
					[{ text }, { text }],
				);
			else assert.equal(existsSync(effect), false);
		} finally {
			vi.unstubAllEnvs();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
	REAL_BUILTIN_HOST_PAIR_TIMEOUT_MS,
);

const REAL_PERSISTED_HOST_HANDOFF_TIMEOUT_MS = 120_000;

test.each(["node", "cli"] as const)(
	"persisted handoff from %s to the other host",
	async (host) => {
		const home = new WorkflowProcessHome();
		type Receipt = {
			runId: string;
			hash: string;
			requestId: string;
			dialogs: string[];
			pending?: { kind: string; message: string };
		};
		try {
			const first = home.client(
				{ HANDOFF_HOST: host, HANDOFF_PHASE: "start", ATOMIC_WORKFLOW_ARTIFACT_DIR: join(home.path, "artifacts") },
				"sdk-host-durable-client.ts",
			);
			const before = await first.request<Receipt>("start");
			assert.equal(before.pending?.kind, "confirm");
			assert.equal(existsSync(join(home.path, "effects.jsonl")), false);
			await first.exit();
			const second = home.client(
				{
					HANDOFF_HOST: host === "node" ? "cli" : "node",
					HANDOFF_PHASE: "resume",
					ATOMIC_WORKFLOW_ARTIFACT_DIR: join(home.path, "artifacts"),
				},
				"sdk-host-durable-client.ts",
			);
			const after = await second.request<Receipt>("resume", before.runId);
			assert.equal(after.runId, before.runId);
			assert.equal(after.hash, before.hash);
			assert.equal(after.pending?.kind, before.pending?.kind);
			assert.equal(after.pending?.message, before.pending?.message);
			assert.notEqual(after.requestId, before.requestId);
			assert.deepEqual(
				host === "cli" ? before.dialogs : after.dialogs,
				host === "cli" ? ["input", "confirm"] : ["confirm"],
			);
			assert.equal(
				readFileSync(join(home.path, "receipts.jsonl"), "utf8"),
				`${JSON.stringify({ text: "  durable text  " })}\n`,
			);
			assert.equal(
				readFileSync(join(home.path, "effects.jsonl"), "utf8"),
				`${JSON.stringify({ text: "  durable text  " })}\n`,
			);
		} finally {
			await home.cleanup();
		}
	},
	REAL_PERSISTED_HOST_HANDOFF_TIMEOUT_MS,
);
