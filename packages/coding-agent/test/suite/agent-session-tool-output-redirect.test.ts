import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	generatePreview,
	getPersistenceThreshold,
	redirectOversizedToolResult,
} from "../../src/core/tools/oversized-tool-result.js";
import {
	DEFAULT_MAX_RESULT_SIZE_CHARS,
	PERSISTED_OUTPUT_CLOSING_TAG,
	PERSISTED_OUTPUT_TAG,
	PREVIEW_SIZE_BYTES,
} from "../../src/core/tools/tool-limits.js";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function textTool(
	name: string,
	text: string,
	details?: Record<string, unknown>,
	maxResultSizeChars?: number,
): AgentTool & { maxResultSizeChars?: number } {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: Type.Object({}),
		maxResultSizeChars,
		execute: async () => ({
			content: [{ type: "text", text }],
			details,
		}),
	};
}

function getFirstToolResultMessage(harness: Harness): Extract<(typeof harness.session.messages)[number], { role: "toolResult" }> {
	const message = harness.session.messages.find((candidate) => candidate.role === "toolResult");
	if (!message || message.role !== "toolResult") {
		throw new Error("Expected a toolResult message");
	}
	return message;
}

/** Parse the persisted file path out of a `<persisted-output>` message. */
function persistedFilePath(message: string): string {
	const match = message.match(/Full output saved to: (.+)/);
	if (!match) {
		throw new Error(`No persisted file path found in message:\n${message}`);
	}
	return match[1]!.trim();
}

describe("AgentSession oversized tool output persistence", () => {
	const harnesses: Harness[] = [];
	const cleanupPaths: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("leaves below-threshold tool results unchanged", async () => {
		const originalOutput = "BELOW-THRESHOLD-SENTINEL: concise output";
		const harness = await createHarness({ tools: [textTool("small_output", originalOutput, { source: "test" })] });
		harnesses.push(harness);
		let followUpToolResultText = "";

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("small_output", {}, { id: "tool-small-output" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				followUpToolResultText = toolResult ? getMessageText(toolResult) : "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("run small tool");

		const toolResult = getFirstToolResultMessage(harness);
		expect(getMessageText(toolResult)).toBe(originalOutput);
		expect(followUpToolResultText).toBe(originalOutput);
		expect(getMessageText(toolResult)).not.toContain(PERSISTED_OUTPUT_TAG);
		// Details are passed through untouched.
		expect(toolResult.details).toEqual({ source: "test" });
	});

	it("persists above-threshold tool output to a file and replaces content with a <persisted-output> preview", async () => {
		const body = "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 10_000);
		const originalOutput = `BEGIN-OVERSIZED-SENTINEL\n${body}\nEND-OVERSIZED-SENTINEL`;
		const harness = await createHarness({ tools: [textTool("huge_output", originalOutput, { source: "test" })] });
		harnesses.push(harness);
		let followUpToolResultText = "";

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("huge_output", {}, { id: "tool-huge-output" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				followUpToolResultText = toolResult ? getMessageText(toolResult) : "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("run huge tool");

		const toolResult = getFirstToolResultMessage(harness);
		const compactText = getMessageText(toolResult);

		expect(compactText).toContain(PERSISTED_OUTPUT_TAG);
		expect(compactText).toContain(PERSISTED_OUTPUT_CLOSING_TAG);
		expect(compactText).toContain("Output too large");
		expect(compactText).toContain("Full output saved to:");
		expect(compactText).toContain("Preview (first 2KB):");
		// The preview shows the head of the output, never the tail.
		expect(compactText).toContain("BEGIN-OVERSIZED-SENTINEL");
		expect(compactText).not.toContain("END-OVERSIZED-SENTINEL");
		// The exact same compact message is what the model sees on the follow-up turn.
		expect(followUpToolResultText).toBe(compactText);
		expect(followUpToolResultText).not.toContain("END-OVERSIZED-SENTINEL");
		// Details are passed through untouched.
		expect(toolResult.details).toEqual({ source: "test" });

		const filePath = persistedFilePath(compactText);
		cleanupPaths.push(dirname(filePath));
		expect(compactText).toContain(filePath);
		expect(existsSync(filePath)).toBe(true);
		// The full, original output is preserved on disk.
		expect(readFileSync(filePath, "utf8")).toBe(originalOutput);
	});

	it("honors a tool-level Infinity opt-out so self-bounded tools keep oversized output inline", async () => {
		const originalOutput = `SELF-BOUNDED-SENTINEL\n${"s".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 10)}`;
		const harness = await createHarness({ tools: [textTool("self_bounded", originalOutput, undefined, Infinity)] });
		harnesses.push(harness);
		let followUpToolResultText = "";

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("self_bounded", {}, { id: "tool-self-bounded" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				followUpToolResultText = toolResult ? getMessageText(toolResult) : "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("run self-bounded tool");

		const toolResult = getFirstToolResultMessage(harness);
		expect(getMessageText(toolResult)).toBe(originalOutput);
		expect(followUpToolResultText).toBe(originalOutput);
		expect(getMessageText(toolResult)).not.toContain(PERSISTED_OUTPUT_TAG);
	});

	it("honors a lower per-tool character cap", async () => {
		const originalOutput = "PER-TOOL-CAP";
		const harness = await createHarness({ tools: [textTool("tiny_cap", originalOutput, undefined, 5)] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tiny_cap", {}, { id: "tool-tiny-cap" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run tiny-cap tool");

		const compactText = getMessageText(getFirstToolResultMessage(harness));
		expect(compactText).toContain(PERSISTED_OUTPUT_TAG);
		const filePath = persistedFilePath(compactText);
		cleanupPaths.push(dirname(filePath));
		expect(readFileSync(filePath, "utf8")).toBe(originalOutput);
	});

	describe("threshold boundary (50,000 chars)", () => {
		it("does NOT persist content at exactly the threshold", async () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "atomic-oversized-at-"));
			cleanupPaths.push(tempRoot);
			const replacement = await redirectOversizedToolResult({
				toolName: "t",
				toolCallId: "call-at-threshold",
				result: { content: [{ type: "text", text: "y".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS) }], details: undefined },
				isError: false,
				sessionId: "session-1",
				sessionDir: tempRoot,
			});
			expect(replacement).toBeUndefined();
		});

		it("persists content one character over the threshold", async () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "atomic-oversized-over-"));
			cleanupPaths.push(tempRoot);
			const replacement = await redirectOversizedToolResult({
				toolName: "t",
				toolCallId: "call-over-threshold",
				result: {
					content: [{ type: "text", text: "y".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1) }],
					details: undefined,
				},
				isError: false,
				sessionId: "session-1",
				sessionDir: tempRoot,
			});
			expect(replacement).toBeDefined();
			expect(replacement?.content[0]?.text).toContain(PERSISTED_OUTPUT_TAG);
		});

		it("does NOT persist content over the default threshold when the tool opts out with Infinity", async () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "atomic-oversized-opt-out-"));
			cleanupPaths.push(tempRoot);
			expect(getPersistenceThreshold(Infinity)).toBe(Infinity);
			const replacement = await redirectOversizedToolResult({
				toolName: "t",
				toolCallId: "call-opt-out",
				result: {
					content: [{ type: "text", text: "i".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1) }],
					details: undefined,
				},
				isError: false,
				sessionId: "session-1",
				sessionDir: tempRoot,
				maxResultSizeChars: Infinity,
			});
			expect(replacement).toBeUndefined();
		});
	});

	it("reports persisted output size in UTF-8 bytes while keeping the threshold character-based", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "atomic-oversized-utf8-"));
		cleanupPaths.push(tempRoot);
		const text = "é".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1);
		const replacement = await redirectOversizedToolResult({
			toolName: "utf8",
			toolCallId: "call-utf8",
			result: { content: [{ type: "text", text }], details: undefined },
			isError: false,
			sessionId: "session-1",
			sessionDir: tempRoot,
		});
		expect(replacement?.content[0]?.text).toContain("Output too large (97.7KB)");
	});

	it("preserves isError=true and passes details through for an oversized error result", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "atomic-oversized-err-"));
		cleanupPaths.push(tempRoot);
		const replacement = await redirectOversizedToolResult({
			toolName: "boom",
			toolCallId: "call-error",
			result: {
				content: [{ type: "text", text: "z".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 5) }],
				details: { exitCode: 1 },
			},
			isError: true,
			sessionId: "session-1",
			sessionDir: tempRoot,
		});
		expect(replacement?.isError).toBe(true);
		expect(replacement?.details).toEqual({ exitCode: 1 });
	});

	it("leaves the result unchanged when the output cannot be persisted (graceful degradation)", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "atomic-oversized-fail-"));
		cleanupPaths.push(tempRoot);
		// Point sessionDir at a regular file so directory creation fails portably (ENOTDIR).
		const sessionDirAsFile = join(tempRoot, "session-dir-is-a-file");
		writeFileSync(sessionDirAsFile, "i am a file, not a directory");

		const replacement = await redirectOversizedToolResult({
			toolName: "t",
			toolCallId: "call-write-failure",
			result: {
				content: [{ type: "text", text: "q".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 5) }],
				details: undefined,
			},
			isError: false,
			sessionId: "session-1",
			sessionDir: sessionDirAsFile,
		});
		expect(replacement).toBeUndefined();
	});

	it("never persists tool results that contain image blocks", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "atomic-oversized-img-"));
		cleanupPaths.push(tempRoot);
		const replacement = await redirectOversizedToolResult({
			toolName: "t",
			toolCallId: "call-image",
			result: {
				content: [
					{ type: "text", text: "w".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 5) },
					{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
				],
				details: undefined,
			},
			isError: false,
			sessionId: "session-1",
			sessionDir: tempRoot,
		});
		expect(replacement).toBeUndefined();
	});

	it("re-uses the existing persisted file on a repeated (replayed) call (idempotent wx write)", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "atomic-oversized-dedup-"));
		cleanupPaths.push(tempRoot);
		const result = {
			content: [{ type: "text" as const, text: "d".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 5) }],
			details: undefined,
		};
		const first = await redirectOversizedToolResult({
			toolName: "t",
			toolCallId: "call-dedup",
			result,
			isError: false,
			sessionId: "session-1",
			sessionDir: tempRoot,
		});
		const second = await redirectOversizedToolResult({
			toolName: "t",
			toolCallId: "call-dedup",
			result,
			isError: false,
			sessionId: "session-1",
			sessionDir: tempRoot,
		});
		const firstPath = persistedFilePath(first?.content[0]?.text ?? "");
		const secondPath = persistedFilePath(second?.content[0]?.text ?? "");
		expect(secondPath).toBe(firstPath);
		expect(existsSync(firstPath)).toBe(true);
	});

	describe("generatePreview", () => {
		it("returns the content unchanged when within the preview budget", () => {
			const small = "short\ncontent";
			expect(generatePreview(small, PREVIEW_SIZE_BYTES)).toEqual({ preview: small, hasMore: false });
		});

		it("truncates oversized content at a newline boundary and flags hasMore", () => {
			const big = `${"a".repeat(1500)}\n${"b".repeat(1500)}`; // newline at index 1500
			const { preview, hasMore } = generatePreview(big, 2000);
			expect(hasMore).toBe(true);
			// Newline at 1500 > 2000 * 0.5, so the cut happens at the newline.
			expect(preview).toBe("a".repeat(1500));
		});

		it("falls back to the hard limit when no newline is near the cut point", () => {
			const big = "c".repeat(5000);
			const { preview, hasMore } = generatePreview(big, 2000);
			expect(hasMore).toBe(true);
			expect(preview).toBe("c".repeat(2000));
		});

		it("keeps multibyte previews within the byte budget", () => {
			const big = "é".repeat(3000);
			const { preview, hasMore } = generatePreview(big, 2000);
			expect(hasMore).toBe(true);
			expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(2000);
			expect(preview).toBe("é".repeat(1000));
		});
	});
});
