import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { beforeAll, test, vi } from "vitest";
import type { AuthStatus } from "../src/core/provider-composer.ts";
import type { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

function renderText(lines: string[]): string {
	// stripVTControlCharacters keeps APC payloads, so drop the TUI's zero-width cursor markers (e.g. \x1b_pi:fc\x07) first
	return stripVTControlCharacters(lines.join("\n").replace(/\x1b_[^\x07]*\x07/g, ""));
}

function createHarness() {
	const stored = new Map<string, "api_key" | "oauth">([
		["kimi-coding", "api_key"],
		["anthropic", "oauth"],
	]);
	const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
	let selector: OAuthSelectorComponent | undefined;
	const host = {
		defaultEditor,
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		session: {
			isBashRunning: false,
			isCompacting: false,
			isStreaming: false,
			scopedModels: [],
			promptTemplates: [],
			extensionRunner: { getRegisteredCommands: () => [] },
			resourceLoader: { getSkills: () => ({ skills: [] }) },
			modelRuntime: {
				getProviders: () => [
					{ id: "kimi-coding", name: "Kimi For Coding" },
					{ id: "environment", name: "Environment only" },
					{ id: "config", name: "Config only" },
					{ id: "absent", name: "Unconfigured" },
				],
				getOAuthProviderMetadata: () => [{ id: "anthropic", name: "Anthropic" }],
				getApiKeyLoginProviderMetadata: () => [],
				getStoredCredentialType: (id: string) => stored.get(id),
				getProviderAuthStatus: (id: string): AuthStatus => ({
					configured: id !== "absent",
					source: stored.has(id) ? "stored" : id === "environment" ? "environment" : "models_json_key",
				}),
			},
		},
		runtimeHost: {
			logoutProvider: vi.fn(async (id: string) => {
				stored.delete(id);
				return { authStatus: { configured: false } };
			}),
		},
		settingsManager: { getEnableSkillCommands: () => false },
		sessionManager: { getCwd: () => process.cwd() },
		skillCommands: new Map(),
		fdPath: null,
		ui: { requestRender: vi.fn() },
		showSelector: (factory: (done: () => void) => { component: OAuthSelectorComponent }) => {
			selector = factory(vi.fn()).component;
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
		updateAvailableProviderCount: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		isExtensionCommand: () => false,
		flushPendingBashComponents: vi.fn(),
		onInputCallback: vi.fn(),
	};
	Object.setPrototypeOf(host, InteractiveMode.prototype);
	const mode = host as unknown as InteractiveMode;
	mode.setupEditorSubmitHandler();
	const provider: AutocompleteProvider = mode.createBaseAutocompleteProvider();
	return { host, stored, provider, submit: defaultEditor.onSubmit!, selector: () => selector };
}

async function suggest(provider: AutocompleteProvider, line: string) {
	return provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
}

test("logout completion lists stored providers and applies canonical identity without changing authentication", async () => {
	const { provider, stored, host } = createHarness();
	const before = [...stored];
	const suggestions = await suggest(provider, "/logout ");
	assert.deepEqual(suggestions, {
		prefix: "",
		items: [
			{ value: "anthropic", label: "anthropic", description: "Anthropic · Subscription" },
			{ value: "kimi-coding", label: "kimi-coding", description: "Kimi For Coding · API key" },
		],
	});
	const line = "/logout kimi";
	const filtered = await suggest(provider, line);
	assert.equal(filtered?.prefix, "kimi");
	assert.equal(filtered?.items.length, 1);
	const lines = [line];
	assert.deepEqual(provider.applyCompletion(lines, 0, line.length, filtered!.items[0]!, filtered!.prefix), {
		lines: ["/logout kimi-coding"],
		cursorLine: 0,
		cursorCol: "/logout kimi-coding".length,
	});
	assert.deepEqual(lines, [line]);
	assert.deepEqual([...stored], before);
	assert.equal(host.runtimeHost.logoutProvider.mock.calls.length, 0);
});

test("submitting a completed logout opens the filtered selector and waits for normal selection", async () => {
	const { provider, submit, host, stored, selector } = createHarness();
	const line = "/logout kimi";
	const suggestions = await suggest(provider, line);
	assert.ok(suggestions);
	const applied = provider.applyCompletion([line], 0, line.length, suggestions.items[0]!, suggestions.prefix);
	await submit(applied.lines[0]!);
	assert.equal(host.onInputCallback.mock.calls.length, 0);
	assert.equal(host.runtimeHost.logoutProvider.mock.calls.length, 0);
	assert.equal(stored.size, 2);
	assert.ok(selector());
	const rendered = renderText(selector()!.render(100));
	assert.match(rendered, /kimi-coding/);
	assert.match(rendered, /Kimi For Coding/);
	assert.doesNotMatch(rendered, /Anthropic/);
	selector()!.handleInput("\r");
	await vi.waitFor(() => assert.equal(host.showStatus.mock.calls.length, 1));
	assert.deepEqual(host.runtimeHost.logoutProvider.mock.calls, [["kimi-coding"]]);
	assert.deepEqual([...stored], [["anthropic", "oauth"]]);
	assert.equal(host.updateAvailableProviderCount.mock.calls.length, 1);
	assert.equal(host.setupAutocompleteProvider.mock.calls.length, 1);
});

test("logout filtering matches IDs, display names and auth labels and reflects current stored credentials", async () => {
	const { provider, stored, host } = createHarness();
	for (const query of ["kimi", "KIMI", "For Coding", "API key"]) {
		assert.deepEqual(
			(await suggest(provider, `/logout ${query}`))?.items.map((item) => item.value),
			["kimi-coding"],
		);
	}
	assert.deepEqual(
		(await suggest(provider, "/logout Subscription"))?.items.map((item) => item.value),
		["anthropic"],
	);
	assert.equal(await suggest(provider, "/logout nonexistent-provider"), null);
	assert.ok((await suggest(provider, "/log"))?.items.some((item) => item.value === "logout"));
	stored.clear();
	assert.equal(await suggest(provider, "/logout "), null);
	assert.equal(host.runtimeHost.logoutProvider.mock.calls.length, 0);
});

for (const search of ["", "   ", "kimi", "Kimi  For Coding", "anthropic", "nonexistent-provider"]) {
	test(`logout search ${JSON.stringify(search)} opens or cancels without removing credentials`, async () => {
		const { submit, host, stored, selector } = createHarness();
		const before = [...stored];
		await submit(`/logout\t${search}`);
		assert.ok(selector());
		const rendered = renderText(selector()!.render(100));
		assert.ok(rendered.includes(search.trim()));
		if (search === "nonexistent-provider") {
			assert.match(rendered, /No matching providers/);
			selector()!.handleInput("\r");
		}
		selector()!.handleInput("\x1b");
		assert.deepEqual([...stored], before);
		assert.equal(host.onInputCallback.mock.calls.length, 0);
		assert.equal(host.runtimeHost.logoutProvider.mock.calls.length, 0);
	});
}

test("bare logout preserves the selector and OAuth removal remains selection-only", async () => {
	const { submit, host, stored, selector } = createHarness();
	await submit("/logout");
	assert.ok(selector());
	assert.equal(host.runtimeHost.logoutProvider.mock.calls.length, 0);
	selector()!.handleInput("\r");
	await vi.waitFor(() => assert.equal(host.showStatus.mock.calls.length, 1));
	assert.deepEqual(host.runtimeHost.logoutProvider.mock.calls, [["anthropic"]]);
	assert.deepEqual([...stored], [["kimi-coding", "api_key"]]);
});

test("logout without stored credentials explains the boundary; similar command names remain prompts", async () => {
	const { submit, host, stored, selector } = createHarness();
	stored.clear();
	await submit("/logout kimi-coding");
	assert.equal(selector(), undefined);
	assert.match(host.showStatus.mock.calls[0]![0], /No stored credentials to remove/);
	assert.equal(host.onInputCallback.mock.calls.length, 0);
	await submit("/logoutx kimi-coding");
	assert.deepEqual(host.onInputCallback.mock.calls, [
		[{ text: "/logoutx kimi-coding", draft: "/logoutx kimi-coding" }],
	]);
	assert.equal(host.runtimeHost.logoutProvider.mock.calls.length, 0);
});
