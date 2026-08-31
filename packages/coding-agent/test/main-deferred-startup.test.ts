import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ComputeDeferExtensionsInput,
	type ComputeInteractiveEngineResourceDeferralInput,
	type ComputeStartupInputCaptureInput,
	computeDeferExtensions,
	computeInteractiveEngineResourceDeferral,
	computeStartupInputCaptureEnabled,
} from "../src/main-deferred-startup.ts";

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

function baseStartupCaptureInput(
	overrides: Partial<ComputeStartupInputCaptureInput> = {},
): ComputeStartupInputCaptureInput {
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
		expect(computeDeferExtensions(baseInput({ resolvedResourcePathCount: 1 }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ hasSystemPromptInput: true }))).toBe(false);
	});

	it("keeps explicit provider or model selection on the synchronous startup path", () => {
		expect(computeDeferExtensions(baseInput({ provider: "anthropic" }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ model: "claude-sonnet" }))).toBe(false);
	});

	it("keeps unstored prompt-required trust on the synchronous path but defers once a decision exists", () => {
		expect(computeDeferExtensions(baseInput({ shouldResolveProjectTrust: true, storedProjectTrust: null }))).toBe(
			false,
		);
		expect(computeDeferExtensions(baseInput({ shouldResolveProjectTrust: true, storedProjectTrust: true }))).toBe(
			true,
		);
		expect(computeDeferExtensions(baseInput({ shouldResolveProjectTrust: true, storedProjectTrust: false }))).toBe(
			true,
		);
	});

	it("does not defer non-interactive, non-TTY, or resumed startup runs", () => {
		expect(computeDeferExtensions(baseInput({ appMode: "print" }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ stdinIsTTY: false }))).toBe(false);
		expect(computeDeferExtensions(baseInput({ hasSessionStartEvent: true }))).toBe(false);
	});

	it("keeps print prompts synchronous so slash commands load before atomic -p runs", () => {
		expect(computeDeferExtensions(baseInput({ appMode: "print" }))).toBe(false);
	});
});

describe("computeInteractiveEngineResourceDeferral", () => {
	const baseEngineInput = (
		overrides: Partial<ComputeInteractiveEngineResourceDeferralInput> = {},
	): ComputeInteractiveEngineResourceDeferralInput => ({
		interactiveEngineChild: true,
		hasSessionStartEvent: false,
		shouldResolveProjectTrust: false,
		storedProjectTrust: null,
		resolvedExtensionPathCount: 0,
		resolvedResourcePathCount: 0,
		hasSystemPromptInput: false,
		unknownFlagCount: 0,
		...overrides,
	});

	it("defers default bundled resources even with an explicit built-in provider and model", () => {
		expect(computeInteractiveEngineResourceDeferral(baseEngineInput())).toBe(true);
	});

	it("keeps trust, user resource paths, system prompts, and extension flags synchronous", () => {
		expect(
			computeInteractiveEngineResourceDeferral(
				baseEngineInput({ shouldResolveProjectTrust: true, storedProjectTrust: null }),
			),
		).toBe(false);
		expect(computeInteractiveEngineResourceDeferral(baseEngineInput({ resolvedExtensionPathCount: 1 }))).toBe(false);
		expect(computeInteractiveEngineResourceDeferral(baseEngineInput({ resolvedResourcePathCount: 1 }))).toBe(false);
		expect(computeInteractiveEngineResourceDeferral(baseEngineInput({ hasSystemPromptInput: true }))).toBe(false);
		expect(computeInteractiveEngineResourceDeferral(baseEngineInput({ unknownFlagCount: 1 }))).toBe(false);
	});

	it("does not defer standalone RPC or replacement-session creation", () => {
		expect(computeInteractiveEngineResourceDeferral(baseEngineInput({ interactiveEngineChild: false }))).toBe(false);
		expect(computeInteractiveEngineResourceDeferral(baseEngineInput({ hasSessionStartEvent: true }))).toBe(false);
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

	it.each([
		{
			resource: "extension",
			approval: "with --approve",
			projectTrustOverride: true,
			resolvedExtensionPathCount: 1,
			resolvedResourcePathCount: 0,
		},
		{
			resource: "extension",
			approval: "without --approve",
			projectTrustOverride: undefined,
			resolvedExtensionPathCount: 1,
			resolvedResourcePathCount: 0,
		},
		{
			resource: "resource",
			approval: "with --approve",
			projectTrustOverride: true,
			resolvedExtensionPathCount: 0,
			resolvedResourcePathCount: 1,
		},
		{
			resource: "resource",
			approval: "without --approve",
			projectTrustOverride: undefined,
			resolvedExtensionPathCount: 0,
			resolvedResourcePathCount: 1,
		},
	])("captures startup input with explicit $resource paths $approval", (testCase) => {
		const input = baseStartupCaptureInput({
			resolvedExtensionPathCount: testCase.resolvedExtensionPathCount,
			resolvedResourcePathCount: testCase.resolvedResourcePathCount,
		});
		input.parsed.projectTrustOverride = testCase.projectTrustOverride;
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

	it("does not start pre-session input capture for explicit provider or model selection", () => {
		const providerInput = baseStartupCaptureInput();
		providerInput.parsed.provider = "extension-provider";
		const modelInput = baseStartupCaptureInput();
		modelInput.parsed.model = "extension-model";
		try {
			expect(computeStartupInputCaptureEnabled(providerInput)).toBe(false);
			expect(computeStartupInputCaptureEnabled(modelInput)).toBe(false);
		} finally {
			removeTempDir(providerInput.sessionCwd);
			removeTempDir(modelInput.sessionCwd);
		}
	});
});
