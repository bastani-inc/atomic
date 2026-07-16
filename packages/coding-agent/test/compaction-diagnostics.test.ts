/**
 * Vertical-slice tests for compaction planner diagnostic sidecar.
 *
 * Covers:
 * 1. Diagnostic metadata capture (payload fields).
 * 2. Persisted sidecar content, permissions, and path surfacing in error message.
 * 3. In-memory and write-failure fallback (original RangePlanError preserved).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai/compat";
import {
	buildDiagnosticPayload,
	type CompactionDiagnostic,
	type DiagnosticContext,
	diagnosticSidecarPath,
	writeDiagnosticSidecar,
} from "../src/core/compaction/range-planner-diagnostics.ts";
import { RangePlanError, planDeletedLineRanges } from "../src/core/compaction/range-planner.ts";
import type { NumberedRegion, VerbatimCompactionParameters } from "../src/core/compaction/compaction-types.ts";

// ============================================================================
// Helpers
// ============================================================================

function createMockModel(): Model<Api> {
	return {
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		api: "anthropic-messages",
		contextWindow: 200_000,
		maxTokens: 8192,
		reasoning: false,
		supportsImages: true,
		baseUrl: "https://api.anthropic.com",
	} as Model<Api>;
}

function createMockUsage(): Usage {
	return {
		input: 5000,
		output: 200,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 5200,
		cost: { input: 0.01, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.012 },
	};
}

function createMockResponse(text: string, stopReason = "stop" as string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createMockUsage(),
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function createMinimalRegion(lineCount = 50): NumberedRegion {
	return {
		__brand: "NumberedRegion",
		lines: Array.from({ length: lineCount }, (_, i) => `${i + 1}→ line ${i + 1}`),
		headerLineNumbers: new Set<number>(),
		priorMarkerNs: new Map<number, number>(),
		protectedLineNumbers: new Set<number>([1, 2]),
		tokenEstimate: lineCount * 10,
	} as NumberedRegion;
}

function createTestDir(): string {
	const dir = join(tmpdir(), `compaction-diag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ============================================================================
// 1. Diagnostic metadata capture
// ============================================================================

describe("compaction diagnostics: metadata capture", () => {
	it("buildDiagnosticPayload produces all required fields", () => {
		const model = createMockModel();
		const response = createMockResponse("not valid json", "stop");
		const ctx: DiagnosticContext = {
			sessionFilePath: "/tmp/fake-session.jsonl",
			model,
			requestMaxTokens: 4096,
			response,
			rawResponseText: "not valid json",
			failureCategory: "malformed_output",
			failureMessage: "Compaction range planning returned malformed output",
		};

		const payload = buildDiagnosticPayload(ctx);

		expect(payload.version).toBe(1);
		expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(payload.failureCategory).toBe("malformed_output");
		expect(payload.failureMessage).toBe("Compaction range planning returned malformed output");
		expect(payload.rawResponse).toBe("not valid json");
		expect(payload.stopReason).toBe("stop");
		expect(payload.providerError).toBeUndefined();
		expect(payload.usage).toEqual(createMockUsage());
		expect(payload.requestMaxTokens).toBe(4096);
		expect(payload.model).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			api: "anthropic-messages",
			contextWindow: 200_000,
			maxTokens: 8192,
		});
	});

	it("captures provider error from response.errorMessage", () => {
		const model = createMockModel();
		const response = createMockResponse("", "error");
		(response as { errorMessage?: string }).errorMessage = "rate_limit_exceeded";
		const ctx: DiagnosticContext = {
			sessionFilePath: "/tmp/fake.jsonl",
			model,
			requestMaxTokens: 8192,
			response,
			rawResponseText: "",
			failureCategory: "provider_error",
			failureMessage: "rate_limit_exceeded",
		};

		const payload = buildDiagnosticPayload(ctx);
		expect(payload.providerError).toBe("rate_limit_exceeded");
		expect(payload.stopReason).toBe("error");
	});

	it("handles undefined response gracefully for stream errors", () => {
		const model = createMockModel();
		const ctx: DiagnosticContext = {
			sessionFilePath: "/tmp/fake.jsonl",
			model,
			requestMaxTokens: 4096,
			response: undefined,
			rawResponseText: "",
			failureCategory: "stream_error",
			failureMessage: "Connection reset",
		};

		const payload = buildDiagnosticPayload(ctx);
		expect(payload.stopReason).toBeUndefined();
		expect(payload.providerError).toBeUndefined();
		expect(payload.usage).toBeUndefined();
		expect(payload.rawResponse).toBe("");
	});

	it("does not include API keys, headers, prompt, or transcript", () => {
		const model = createMockModel();
		const ctx: DiagnosticContext = {
			sessionFilePath: "/tmp/fake.jsonl",
			model,
			requestMaxTokens: 4096,
			response: createMockResponse("garbage output"),
			rawResponseText: "garbage output",
			failureCategory: "malformed_output",
			failureMessage: "Compaction range planning returned malformed output",
		};

		const payload = buildDiagnosticPayload(ctx);
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toContain("apiKey");
		expect(serialized).not.toContain("headers");
		expect(serialized).not.toContain("prompt");
		expect(serialized).not.toContain("numbered-transcript");
		expect(serialized).not.toContain("systemPrompt");
	});
});

// ============================================================================
// 2. Persisted sidecar: content, permissions, path surfaced in error
// ============================================================================

describe("compaction diagnostics: persisted sidecar", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = createTestDir();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("writes sidecar with correct content next to session file", () => {
		const sessionFile = join(testDir, "2026-07-15_abc123.jsonl");
		// Create an empty session file so the directory exists
		const model = createMockModel();
		const response = createMockResponse("some garbage", "stop");

		const path = writeDiagnosticSidecar({
			sessionFilePath: sessionFile,
			model,
			requestMaxTokens: 4096,
			response,
			rawResponseText: "some garbage",
			failureCategory: "malformed_output",
			failureMessage: "Compaction range planning returned malformed output",
		});

		expect(path).toBeDefined();
		expect(path!.startsWith(testDir)).toBe(true);
		expect(path!).toContain("compaction-diagnostic");
		expect(path!.endsWith(".json")).toBe(true);
		expect(existsSync(path!)).toBe(true);

		const content = JSON.parse(readFileSync(path!, "utf-8")) as CompactionDiagnostic;
		expect(content.version).toBe(1);
		expect(content.failureCategory).toBe("malformed_output");
		expect(content.rawResponse).toBe("some garbage");
		expect(content.model.provider).toBe("anthropic");
	});

	it("sets 0600 file permissions on the sidecar", () => {
		const sessionFile = join(testDir, "session.jsonl");
		const model = createMockModel();

		const path = writeDiagnosticSidecar({
			sessionFilePath: sessionFile,
			model,
			requestMaxTokens: 4096,
			response: createMockResponse("x", "stop"),
			rawResponseText: "x",
			failureCategory: "no_usable_ranges",
			failureMessage: "No ranges",
		});

		expect(path).toBeDefined();
		const stat = statSync(path!);
		// 0o600 = owner read/write only (octal 100600 on Linux)
		const mode = stat.mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("diagnosticSidecarPath generates correct filename pattern", () => {
		const sessionFile = "/home/user/.atomic/sessions/2026-07-15_abc123.jsonl";
		const result = diagnosticSidecarPath(sessionFile);

		expect(result).toContain("2026-07-15_abc123-compaction-diagnostic-");
		expect(result.endsWith(".json")).toBe(true);
		expect(result.startsWith("/home/user/.atomic/sessions/")).toBe(true);
	});

	it("RangePlanError.message includes diagnostic path when sidecar is written", async () => {
		const sessionFile = join(testDir, "test-session.jsonl");
		const model = createMockModel();
		const region = createMinimalRegion(50);
		const params: VerbatimCompactionParameters = {
			compression_ratio: 0.5,
			preserve_recent: 2,
			query: "test",
		};

		// Mock streamFn that returns malformed output
		const mockStreamFn = async () => ({
			result: async () => createMockResponse("This is not JSON at all", "stop"),
			events: async function* () { yield { type: "done" as const, reason: "stop" as const, message: createMockResponse("") }; },
		});

		let caughtError: RangePlanError | undefined;
		try {
			await planDeletedLineRanges(
				region, params, model,
				{ apiKey: "test-key" },
				undefined, undefined, 16384, 25,
				{ streamFn: mockStreamFn as never, sessionFilePath: sessionFile },
			);
		} catch (error) {
			caughtError = error as RangePlanError;
		}

		expect(caughtError).toBeInstanceOf(RangePlanError);
		expect(caughtError!.name).toBe("RangePlanError");
		expect(caughtError!.message).toContain("malformed output");
		expect(caughtError!.message).toContain("(diagnostic:");
		expect(caughtError!.diagnosticPath).toBeDefined();
		expect(existsSync(caughtError!.diagnosticPath!)).toBe(true);

		// Verify the sidecar does NOT contain the API key
		const content = readFileSync(caughtError!.diagnosticPath!, "utf-8");
		expect(content).not.toContain("test-key");
	});
});

// ============================================================================
// 3. In-memory / write-failure fallback
// ============================================================================

describe("compaction diagnostics: in-memory and write-failure fallback", () => {
	it("returns undefined when sessionFilePath is undefined (in-memory session)", () => {
		const model = createMockModel();
		const path = writeDiagnosticSidecar({
			sessionFilePath: undefined,
			model,
			requestMaxTokens: 4096,
			response: createMockResponse("garbage"),
			rawResponseText: "garbage",
			failureCategory: "malformed_output",
			failureMessage: "Compaction range planning returned malformed output",
		});

		expect(path).toBeUndefined();
	});

	it("returns undefined when directory does not exist (write failure)", () => {
		const model = createMockModel();
		const path = writeDiagnosticSidecar({
			sessionFilePath: "/nonexistent/path/that/should/fail/session.jsonl",
			model,
			requestMaxTokens: 4096,
			response: createMockResponse("garbage"),
			rawResponseText: "garbage",
			failureCategory: "malformed_output",
			failureMessage: "Compaction range planning returned malformed output",
		});

		expect(path).toBeUndefined();
	});

	it("RangePlanError preserves original message when sidecar write fails", async () => {
		const model = createMockModel();
		const region = createMinimalRegion(50);
		const params: VerbatimCompactionParameters = {
			compression_ratio: 0.5,
			preserve_recent: 2,
			query: "test",
		};

		const mockStreamFn = async () => ({
			result: async () => createMockResponse("not json", "stop"),
			events: async function* () { yield { type: "done" as const, reason: "stop" as const, message: createMockResponse("") }; },
		});

		let caughtError: RangePlanError | undefined;
		try {
			await planDeletedLineRanges(
				region, params, model,
				{ apiKey: "key" },
				undefined, undefined, 16384, 25,
				// Non-existent path → write will fail → fallback
				{ streamFn: mockStreamFn as never, sessionFilePath: "/no/such/dir/session.jsonl" },
			);
		} catch (error) {
			caughtError = error as RangePlanError;
		}

		expect(caughtError).toBeInstanceOf(RangePlanError);
		expect(caughtError!.name).toBe("RangePlanError");
		expect(caughtError!.message).toBe("Compaction range planning returned malformed output");
		expect(caughtError!.diagnosticPath).toBeUndefined();
		// Original error classification preserved
		expect(caughtError!.attempts).toBe(1);
		expect(caughtError!.providerOverflow).toBe(false);
	});

	it("RangePlanError preserves original message for in-memory session", async () => {
		const model = createMockModel();
		const region = createMinimalRegion(50);
		const params: VerbatimCompactionParameters = {
			compression_ratio: 0.5,
			preserve_recent: 2,
			query: "test",
		};

		const mockStreamFn = async () => ({
			result: async () => createMockResponse("not json", "stop"),
			events: async function* () { yield { type: "done" as const, reason: "stop" as const, message: createMockResponse("") }; },
		});

		let caughtError: RangePlanError | undefined;
		try {
			await planDeletedLineRanges(
				region, params, model,
				{ apiKey: "key" },
				undefined, undefined, 16384, 25,
				// No sessionFilePath → in-memory
				{ streamFn: mockStreamFn as never },
			);
		} catch (error) {
			caughtError = error as RangePlanError;
		}

		expect(caughtError).toBeInstanceOf(RangePlanError);
		expect(caughtError!.message).toBe("Compaction range planning returned malformed output");
		expect(caughtError!.diagnosticPath).toBeUndefined();
	});

	it("preserves RangePlanError type classification for callers", async () => {
		const model = createMockModel();
		const region = createMinimalRegion(50);
		const params: VerbatimCompactionParameters = {
			compression_ratio: 0.5,
			preserve_recent: 2,
			query: "test",
		};

		// Simulate provider error
		const errorResponse = createMockResponse("", "error");
		(errorResponse as { errorMessage?: string }).errorMessage = "context_length_exceeded";

		const mockStreamFn = async () => ({
			result: async () => errorResponse,
			events: async function* () { yield { type: "error" as const, reason: "error" as const, error: errorResponse }; },
		});

		let caughtError: RangePlanError | undefined;
		try {
			await planDeletedLineRanges(
				region, params, model,
				{ apiKey: "key" },
				undefined, undefined, 16384, 25,
				{ streamFn: mockStreamFn as never },
			);
		} catch (error) {
			caughtError = error as RangePlanError;
		}

		expect(caughtError).toBeInstanceOf(RangePlanError);
		expect(caughtError!.name).toBe("RangePlanError");
		expect(caughtError!.attempts).toBe(1);
		expect(caughtError!.lastResponseExcerpt).toBe("");
		// Error type preserved for caller inspection
		expect(caughtError instanceof Error).toBe(true);
	});
});
