import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import { afterAll, describe, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { computeStartupInputCaptureEnabled } from "../src/main-deferred-startup.ts";
import type { EarlyInputCapture } from "../src/main-early-input.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { InteractiveSubmission } from "../src/modes/interactive/interactive-submission.ts";
import { onInteractiveEngineRemoteCommandsChanged } from "../src/modes/interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { RemoteCommandCatalog } from "../src/modes/interactive-engine/remote-command-catalog.ts";
import type { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionPackagePath = join(testDir, "fixtures", "slash-autosend-extension-package");
const workflowPackagePath = join(testDir, "fixtures", "slash-autosend-workflow-package");
const fixturePackagePaths = [extensionPackagePath, workflowPackagePath] as const;
const startupCaptureCwd = mkdtempSync(join(tmpdir(), "atomic-slash-autosend-capture-"));

afterAll(() => {
	rmSync(startupCaptureCwd, { recursive: true, force: true });
});

interface DraftEditor {
	getText(): string;
	setText(text: string): void;
	setAutocompleteProvider(provider: AutocompleteProvider): void;
}

interface DraftProbeContext {
	startupCookedInputRecovered: boolean;
	pendingUserInputs: InteractiveSubmission[];
	startupReplayInputs: string[];
	startupReplayActiveInput?: string;
	startupDraftText?: string;
	inputHandlerReadyRecorded: boolean;
	onInputCallback?: (submission: InteractiveSubmission) => void;
	options: { startupInputCapture?: EarlyInputCapture; deferredModelScopePatterns?: string[] };
	defaultEditor: DraftEditor & { onSubmit?: (text: string) => void | Promise<void> };
	editor: DraftEditor;
	ui: { requestRender(): void };
	autocompleteProviderWrappers: Array<(provider: AutocompleteProvider) => AutocompleteProvider>;
	autocompleteProvider?: AutocompleteProvider;
	createBaseAutocompleteProvider(): AutocompleteProvider;
	advanceStartupInputReplay(submittedText: string): void;
	recoverCookedStartupInput(): boolean;
	drainStartupReplayCommands(): Promise<void>;
}

interface DraftProbe {
	context: DraftProbeContext;
	inputPromise: Promise<InteractiveSubmission>;
	userMessages: string[];
	slashCommandExecutions: string[];
	providerInstallations: number;
}

const interactivePrototype = InteractiveMode.prototype as unknown as {
	getUserInput(this: DraftProbeContext): Promise<InteractiveSubmission>;
	advanceStartupInputReplay(this: DraftProbeContext, submittedText: string): void;
	recoverCookedStartupInput(this: DraftProbeContext): boolean;
	drainStartupReplayCommands(this: DraftProbeContext): Promise<void>;
	setupAutocompleteProvider(this: DraftProbeContext): void;
	completeDeferredStartup(this: DeferredStartupProbeContext): Promise<void>;
};

const baseProvider: AutocompleteProvider = {
	async getSuggestions() {
		return null;
	},
	applyCompletion(lines, cursorLine, cursorCol) {
		return { lines, cursorLine, cursorCol };
	},
};

function fixturePackageCapture(projectTrustOverride: true | undefined): EarlyInputCapture | undefined {
	const enabled = computeStartupInputCaptureEnabled({
		appMode: "interactive",
		stdinIsTTY: true,
		parsed: {
			help: false,
			listModels: undefined,
			projectTrustOverride,
			systemPrompt: undefined,
			appendSystemPrompt: [],
			unknownFlags: new Map(),
			provider: undefined,
			model: undefined,
			resume: false,
			session: undefined,
		},
		sessionCwd: startupCaptureCwd,
		projectTrustStore: { get: () => null },
		resolvedExtensionPathCount: fixturePackagePaths.length,
		resolvedResourcePathCount: 0,
		deprecationWarningCount: 0,
	});
	return enabled ? { consume: () => ({ text: "", submissions: [] }) } : undefined;
}

function createDraftProbe(draft: string, projectTrustOverride: true | undefined): DraftProbe {
	let text = draft;
	let providerInstallations = 0;
	const editor: DraftProbeContext["defaultEditor"] = {
		getText: () => text,
		setText: (next) => {
			text = next;
		},
		setAutocompleteProvider: () => {
			providerInstallations += 1;
		},
	};
	const userMessages: string[] = [];
	const slashCommandExecutions: string[] = [];
	const context: DraftProbeContext = {
		startupCookedInputRecovered: false,
		pendingUserInputs: [],
		startupReplayInputs: [],
		inputHandlerReadyRecorded: true,
		options: { startupInputCapture: fixturePackageCapture(projectTrustOverride) },
		defaultEditor: editor,
		editor,
		ui: { requestRender: vi.fn() },
		autocompleteProviderWrappers: [],
		createBaseAutocompleteProvider: () => baseProvider,
		advanceStartupInputReplay: interactivePrototype.advanceStartupInputReplay,
		recoverCookedStartupInput: interactivePrototype.recoverCookedStartupInput,
		drainStartupReplayCommands: interactivePrototype.drainStartupReplayCommands,
	};
	editor.onSubmit = async (submittedText) => {
		if (submittedText === "/foo") slashCommandExecutions.push(submittedText);
		else userMessages.push(submittedText);
		context.advanceStartupInputReplay(submittedText);
	};
	return {
		context,
		inputPromise: interactivePrototype.getUserInput.call(context),
		userMessages,
		slashCommandExecutions,
		get providerInstallations() {
			return providerInstallations;
		},
	};
}

async function settleStartupRecovery(): Promise<void> {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

async function observeDraftAfterEvent(
	draft: string,
	projectTrustOverride: true | undefined,
	event: (probe: DraftProbe) => Promise<void> | void,
): Promise<{
	editorText: string;
	userMessages: string[];
	slashCommandExecutions: string[];
}> {
	const probe = createDraftProbe(draft, projectTrustOverride);
	await event(probe);
	await settleStartupRecovery();
	const observed = {
		editorText: probe.context.editor.getText(),
		userMessages: [...probe.userMessages],
		slashCommandExecutions: [...probe.slashCommandExecutions],
	};
	probe.context.onInputCallback?.({ text: "cleanup", draft: "cleanup" });
	await probe.inputPromise;
	return observed;
}

interface DeferredStartupProbeContext extends DraftProbeContext {
	deferredStartupPending: boolean;
	promptTurnWorkingLoaderActive: boolean;
	bindCurrentSessionExtensions(): Promise<void>;
	session: {
		reload(options: { reason: "startup" }): Promise<void>;
		resourceLoader: { getThemes(): { themes: [] } };
		extensionRunner: object;
		modelRuntime: { getError(): undefined; getWarning(): undefined };
	};
	rebuildChatFromMessages(): void;
	stopWorkingLoader(): void;
	themeController: { applyFromSettings(): Promise<void> };
	setupAutocompleteProvider(): void;
	setupExtensionShortcuts(runner: object): void;
	retryDeferredModelRestore(container: object): Promise<void>;
	showLoadedResources(options: object): void;
	maybeWarnAboutAnthropicSubscriptionAuth(model?: undefined, container?: object): Promise<void>;
	showStartupNoticesIfNeeded(container: object): void;
	updateAvailableProviderCount(): Promise<void>;
	updateEditorBorderColor(): void;
	showError(message: string): void;
	startupNoticesContainer: object;
	resourceDisclosureContainer: object;
	chatContainer: Container;
}

function asDeferredStartupContext(probe: DraftProbe): DeferredStartupProbeContext {
	return Object.assign(probe.context, {
		deferredStartupPending: true,
		promptTurnWorkingLoaderActive: false,
		bindCurrentSessionExtensions: vi.fn(async () => {}),
		session: {
			reload: vi.fn(async () => {}),
			resourceLoader: { getThemes: () => ({ themes: [] as [] }) },
			extensionRunner: {},
			modelRuntime: { getError: () => undefined, getWarning: () => undefined },
		},
		rebuildChatFromMessages: vi.fn(),
		stopWorkingLoader: vi.fn(),
		themeController: { applyFromSettings: vi.fn(async () => {}) },
		setupAutocompleteProvider: vi.fn(),
		setupExtensionShortcuts: vi.fn(),
		retryDeferredModelRestore: vi.fn(async () => {}),
		showLoadedResources: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
		showStartupNoticesIfNeeded: vi.fn(),
		updateAvailableProviderCount: vi.fn(async () => {}),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		startupNoticesContainer: {},
		resourceDisclosureContainer: {},
		chatContainer: new Container(),
	});
}

function assertDraftWasNotSent(
	draft: string,
	observed: { editorText: string; userMessages: string[]; slashCommandExecutions: string[] },
): void {
	assert.deepEqual(observed, {
		editorText: draft,
		userMessages: [],
		slashCommandExecutions: [],
	});
}

describe("interactive slash drafts while package commands become available", () => {
	for (const { approval, projectTrustOverride } of [
		{ approval: "with --approve", projectTrustOverride: true },
		{ approval: "without --approve", projectTrustOverride: undefined },
	] as const) {
		describe(approval, () => {
			for (const draft of ["/", "/foo"]) {
				test(`keeps ${JSON.stringify(draft)} unsent when package and workflow loading finishes`, async () => {
					const observed = await observeDraftAfterEvent(draft, projectTrustOverride, async (probe) => {
						const context = asDeferredStartupContext(probe);
						await interactivePrototype.completeDeferredStartup.call(context);
						assert.equal(context.deferredStartupPending, false);
					});
					assertDraftWasNotSent(draft, observed);
				});

				test(`keeps ${JSON.stringify(draft)} unsent when the remote command catalog arrives`, async () => {
					const observed = await observeDraftAfterEvent(draft, projectTrustOverride, async (probe) => {
						const catalog = new RemoteCommandCatalog({
							getCommands: async () => [
								{
									name: "foo",
									description: "Fixture command",
									source: "extension",
									sourceInfo: createSyntheticSourceInfo(join(extensionPackagePath, "extension.ts"), {
										source: extensionPackagePath,
									}),
								},
							],
						} as unknown as RpcClient);
						const runtime = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
						Object.defineProperty(runtime, "onRemoteCommandsChanged", {
							value: catalog.onChange.bind(catalog),
						});
						let catalogEvents = 0;
						const unsubscribe = onInteractiveEngineRemoteCommandsChanged(runtime as AgentSessionRuntime, () => {
							catalogEvents += 1;
							interactivePrototype.setupAutocompleteProvider.call(probe.context);
						});
						catalog.refresh();
						await new Promise<void>((resolve) => setImmediate(resolve));
						unsubscribe();
						assert.equal(catalogEvents, 1);
						assert.equal(probe.providerInstallations, 1);
					});
					assertDraftWasNotSent(draft, observed);
				});

				test(`keeps ${JSON.stringify(draft)} unsent when autocomplete is rebuilt`, async () => {
					const observed = await observeDraftAfterEvent(draft, projectTrustOverride, (probe) => {
						interactivePrototype.setupAutocompleteProvider.call(probe.context);
						assert.equal(probe.providerInstallations, 1);
					});
					assertDraftWasNotSent(draft, observed);
				});
			}
		});
	}
});
