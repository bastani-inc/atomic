import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { bunExecutable, cliPath, removeTempDirs } from "./cli-test-helpers.ts";

/** A real CLI child plus extension loading is structural work, not a unit-test delay. */
const REAL_RPC_WIRE_PROCESS_TIMEOUT_MS = 120_000;
const RPC_PROMPT_TIMEOUT_MS = 60_000;
const EXPECTED_DELTAS = ["alpha", "-beta", "-gamma"] as const;
const EXPECTED_TEXT = EXPECTED_DELTAS.join("");

const tempDirs: string[] = [];
afterEach(() => removeTempDirs(tempDirs));

function writeDeterministicProvider(root: string): string {
	const extensionPath = join(root, "wire-provider.ts");
	writeFileSync(
		extensionPath,
		`import type { ExtensionAPI } from "@bastani/atomic";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

const chunks = ${JSON.stringify(EXPECTED_DELTAS)};
export default function wireProvider(pi: ExtensionAPI): void {
	pi.registerProvider("wire-test", {
		baseUrl: "https://wire.invalid/v1",
		api: "openai-completions",
		apiKey: "local-test-key",
		models: [{
			id: "deterministic",
			name: "Deterministic",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 256,
		}],
		streamSimple: (model) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = {
					role: "assistant" as const,
					content: [] as Array<{ type: "text"; text: string }>,
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: 0,
				};
				stream.push({ type: "start", partial: structuredClone(partial) });
				partial.content = [{ type: "text", text: "" }];
				stream.push({ type: "text_start", contentIndex: 0, partial: structuredClone(partial) });
				for (const delta of chunks) {
					partial.content[0].text += delta;
					stream.push({ type: "text_delta", contentIndex: 0, delta, partial: structuredClone(partial) });
				}
				stream.push({
					type: "text_end",
					contentIndex: 0,
					content: partial.content[0].text,
					partial: structuredClone(partial),
				});
				stream.push({ type: "done", reason: "stop", message: structuredClone(partial) });
			});
			return stream;
		},
	});
}
`,
	);
	return extensionPath;
}

/**
 * This suite is deliberately unconditional: it has no provider credential gate.
 * It spawns the real CLI in RPC mode, loads a deterministic local extension,
 * then traverses session events -> `toJsonEvent` -> `RpcOutputBuffer` -> JSONL
 * serialization -> `RpcClient` parsing. A direct call to `toJsonEvent` would not
 * prove that the production stdout binding applies the transform before writing.
 */
describe("spawned RPC wire emits delta-only message updates", () => {
	it(
		"preserves ordered deltas that reconstruct the final assistant message",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-rpc-wire-"));
			tempDirs.push(root);
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			const extensionPath = writeDeterministicProvider(root);
			const client = new RpcClient({
				cliPath,
				cwd: process.cwd(),
				runtimeExecutable: bunExecutable(),
				provider: "wire-test",
				model: "deterministic",
				env: {
					ANTHROPIC_API_KEY: "",
					ANTHROPIC_OAUTH_TOKEN: "",
					ATOMIC_CODING_AGENT_DIR: agentDir,
					PI_CODING_AGENT_DIR: "",
				},
				args: ["--no-session", "--no-extensions", "--extension", extensionPath, "--no-tools"],
			});

			try {
				await client.start();
				const events = await client.promptAndWait("respond deterministically", undefined, RPC_PROMPT_TIMEOUT_MS);
				const updates = events.filter((event) => event.type === "message_update");
				expect(updates.length).toBeGreaterThan(0);
				for (const update of updates) {
					expect(update).not.toHaveProperty("message");
					expect(update.assistantMessageEvent).not.toHaveProperty("partial");
				}

				const deltas = updates.flatMap((update) =>
					update.assistantMessageEvent.type === "text_delta" ? [update.assistantMessageEvent.delta] : [],
				);
				expect(deltas).toEqual(EXPECTED_DELTAS);

				const assistantEnd = events.find(
					(event) => event.type === "message_end" && event.message.role === "assistant",
				);
				expect(assistantEnd).toBeDefined();
				if (assistantEnd?.type !== "message_end" || assistantEnd.message.role !== "assistant") return;
				const finalText = assistantEnd.message.content
					.filter((content) => content.type === "text")
					.map((content) => content.text)
					.join("");
				expect(deltas.join("")).toBe(EXPECTED_TEXT);
				expect(finalText).toBe(EXPECTED_TEXT);
			} finally {
				await client.stop();
			}
		},
		REAL_RPC_WIRE_PROCESS_TIMEOUT_MS,
	);
});
