import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDeferExtensions, computeStartupInputCaptureEnabled, type ComputeDeferExtensionsInput, type ComputeStartupInputCaptureInput } from "../src/main-deferred-startup.ts";

function baseInput(overrides: Partial<ComputeDeferExtensionsInput> = {}): ComputeDeferExtensionsInput {
	return {
		appMode: "interactive",
		stdinIsTTY: true,
		hasSessionStartEvent: false,
		help: false,
		listModels: undefined,
		shouldResolveProjectTrust: false,
		storedProjectTrust: null,
		resolvedExtensionPathCount: 0,
		resolvedResourcePathCount: 0,
		hasSystemPromptInput: false,
		unknownFlagCount: 0,
		provider: undefined,
		model: undefined,
		...overrides,
	};
}

function baseStartupCaptureInput(overrides: Partial<ComputeStartupInputCaptureInput> = {}): ComputeStartupInputCaptureInput {
	const sessionCwd = mkdtempSync(join(tmpdir(), "atomic-startup-capture-"));
	return {
		appMode: "interactive",
		stdinIsTTY: true,
		parsed: {
			help: false,
			listModels: undefined,
			projectTrustOverride: undefined,
			systemPrompt: undefined,
			appendSystemPrompt: [],
			unknownFlags: new Map(),
			provider: undefined,
			model: undefined,
			resume: false,
			session: undefined,
		},
		sessionCwd,
		projectTrustStore: { get: () => null },
		resolvedExtensionPathCount: 0,
		resolvedResourcePathCount: 0,
		deprecationWarningCount: 0,
		...overrides,
	};
}

function removeTempDir(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

describe("computeDeferExtensions", () => {
	it("defers for an interactive TTY even when model scope is configured elsewhere", () => {
		expect(computeDeferExtensions(baseInput())).toBe(true);
	});

	it("keeps CLI flags that need pre-paint resolution on the synchronous path", () => {
		expect(computeDeferExtensions(baseInput({ help: true }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ listModels: "all" }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ resolvedExtensionPathCount: 1 }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ unknownFlagCount: 1 }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ provider: "anthropic" }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ model: "claude-sonnet" }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ resolvedResourcePathCount: 1 }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ hasSystemPromptInput: true }))).toBe(false);
	});

	it("keeps unstored prompt-required trust on the synchronous path but defers once a decision exists", () => {
		expect(computeDeferExtensions(baseInput({ shouldResolveProjectTrust: true, storedProjectTrust: null }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ shouldResolveProjectTrust: true, storedProjectTrust: true }))).toBe(true);
		expect(computeDeferExtensions(baseInput({ shouldResolveProjectTrust: true, storedProjectTrust: false }))).toBe(true);
	});

	it("does not defer non-interactive, non-TTY, or resumed startup runs", () => {
		expect(computeDeferExtensions(baseInput({ appMode: "print" }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ stdinIsTTY: false }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ hasSessionStartEvent: true }))).toBe(false);
	});
});

describe("computeStartupInputCaptureEnabled", () => {
	it("captures startup input for the plain deferred interactive path", () => {
		const input = baseStartupCaptureInput();
		try {
			expect(computeStartupInputCaptureEnabled(input)).toBe(true);
		} finally {
			removeTempDir(input.sessionCwd);
		}
	});

	it("does not start pre-session input capture for resume picker startup", () => {
		const input = baseStartupCaptureInput();
		input.parsed.resume = true;
		try {
			expect(computeStartupInputCaptureEnabled(input)).toBe(false);
		} finally {
			removeTempDir(input.sessionCwd);
		}
	});

	it("does not start pre-session input capture for session fork confirmation startup", () => {
		const input = baseStartupCaptureInput();
		input.parsed.session = "other-project-session";
		try {
			expect(computeStartupInputCaptureEnabled(input)).toBe(false);
		} finally {
			removeTempDir(input.sessionCwd);
		}
	});
});
