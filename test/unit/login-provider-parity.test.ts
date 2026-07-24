import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TUI } from "@earendil-works/pi-tui";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { defaultModelPerProvider } from "../../packages/coding-agent/src/core/model-resolver-defaults.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../packages/coding-agent/src/core/provider-display-names.ts";
import { createAuthInteraction } from "../../packages/coding-agent/src/core/oauth-provider-bridge.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.ts";
import { LoginDialogComponent } from "../../packages/coding-agent/src/modes/interactive/components/login-dialog.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-auth-routing.ts";
import { getBuiltinApiKeyLoginOptions } from "../../packages/coding-agent/src/modes/interactive/interactive-auth-routing.ts";
import {
  getLoginProviderCompletions,
  resolveLoginProviderReference,
} from "../../packages/coding-agent/src/modes/interactive/login-provider-options.ts";
import type { AuthSelectorProvider } from "../../packages/coding-agent/src/modes/interactive/components/oauth-selector.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const providers: AuthSelectorProvider[] = [
  { id: "anthropic", name: "Anthropic", authType: "oauth" },
  { id: "anthropic", name: "Anthropic", authType: "api_key" },
  { id: "openai", name: "OpenAI", authType: "api_key" },
  { id: "first", name: "Shared", authType: "api_key" },
  { id: "second", name: "Shared", authType: "api_key" },
];

test("API-key login options follow builtin provider auth metadata", () => {
  const options = getBuiltinApiKeyLoginOptions(
    (id) => BUILT_IN_PROVIDER_DISPLAY_NAMES[id] ?? id,
  );
  const optionIds = new Set(options.map((option) => option.id));
  const expectedIds = builtinProviders()
    .filter((provider) => provider.auth.apiKey !== undefined)
    .map((provider) => provider.id);

  assert.deepEqual([...optionIds].sort(), expectedIds.sort());
  assert.ok(optionIds.has("qwen-token-plan"));
  assert.ok(optionIds.has("qwen-token-plan-cn"));
  assert.ok(!optionIds.has("openai-codex"));
  assert.equal(BUILT_IN_PROVIDER_DISPLAY_NAMES.radius, "Radius");
  assert.equal(BUILT_IN_PROVIDER_DISPLAY_NAMES["github-copilot"], "GitHub Copilot");
});

test("login provider reference resolution handles ids, names, methods, and misses", () => {
  assert.deepEqual(resolveLoginProviderReference(providers, "OPENAI"), {
    kind: "direct",
    option: providers[2],
  });
  assert.deepEqual(resolveLoginProviderReference(providers, "OpenAI"), {
    kind: "direct",
    option: providers[2],
  });
  assert.equal(resolveLoginProviderReference(providers, "anthropic").kind, "choose_method");
  assert.deepEqual(resolveLoginProviderReference(providers, "Shared"), {
    kind: "search",
    initialSearch: "Shared",
  });
  assert.deepEqual(resolveLoginProviderReference(providers, "missing"), {
    kind: "search",
    initialSearch: "missing",
  });
});

test("login autocomplete is fuzzy and deduplicates providers with two auth methods", () => {
  const completions = getLoginProviderCompletions(providers, "anth");
  assert.equal(completions?.length, 1);
  assert.equal(completions?.[0]?.value, "anthropic");
  assert.match(completions?.[0]?.description ?? "", /Subscription\/API key/);
});

test("login command advertises its provider argument", () => {
  assert.equal(
    BUILTIN_SLASH_COMMANDS.find((command) => command.name === "login")?.argumentHint,
    "<provider>",
  );
});

test("every installed builtin provider has a preferred default", () => {
  const missing = builtinProviders()
    .map((provider) => provider.id)
    .filter((providerId) => defaultModelPerProvider[providerId] === undefined);
  assert.deepEqual(missing, []);
  assert.equal(defaultModelPerProvider.radius, "auto");
  assert.equal(defaultModelPerProvider.nvidia, "nvidia/nemotron-3-super-120b-a12b");
  assert.equal(defaultModelPerProvider["zai-coding-cn"], "glm-5.1");
  assert.equal(Object.hasOwn(defaultModelPerProvider, "cursor"), false);
});

test("stale Cursor authentication cannot restore the removed provider", () => {
  const authStorage = AuthStorage.inMemory({
    cursor: { type: "api_key", key: "stale-token" },
  });
  const registry = ModelRegistry.inMemory(authStorage);

  assert.equal(authStorage.has("cursor"), true);
  assert.equal(registry.getAll().some((model) => model.provider === "cursor"), false);
  assert.equal(BUILT_IN_PROVIDER_DISPLAY_NAMES.cursor, undefined);
});

test("logout options ignore credentials for removed providers", () => {
  const authStorage = AuthStorage.inMemory({
    anthropic: { type: "api_key", key: "active-token" },
    cursor: { type: "api_key", key: "stale-token" },
  });
  const context = {
    session: { modelRegistry: { authStorage, getProviderDisplayName: (id: string) => id } },
    getLoginProviderOptions: () => [
      { id: "anthropic", name: "Anthropic", authType: "api_key" as const },
    ],
  };

  const options = InteractiveModeBase.prototype.getLogoutProviderOptions.call(
    context as unknown as InteractiveModeBase,
  );
  assert.deepEqual(options.map((option) => option.id), ["anthropic"]);
});

test("auth interaction keeps info links distinct from progress events", () => {
  const progress: string[] = [];
  const info: Array<{ message: string; links: readonly { url: string; label?: string }[] }> = [];
  const interaction = createAuthInteraction({
    onAuth() {},
    onDeviceCode() {},
    async onPrompt() { return ""; },
    async onSelect() { return undefined; },
    onProgress(message) { progress.push(message); },
    onInfo(message, links) { info.push({ message, links }); },
  });
  const links = [{ label: "Setup", url: "https://example.com/setup" }];

  interaction.notify({ type: "progress", message: "Working" });
  interaction.notify({ type: "info", message: "Configure access", links });

  assert.deepEqual(progress, ["Working"]);
  assert.deepEqual(info, [{ message: "Configure access", links }]);
});

test("login dialog renders provider info links as terminal hyperlinks", () => {
  initTheme("dark", false);
  const tui = { requestRender() {} } as unknown as TUI;
  const dialog = new LoginDialogComponent(tui, "test", () => {});
  dialog.showInfo("Configure access", [
    { label: "Setup", url: "https://example.com/setup" },
  ]);
  const rendered = dialog.render(100).join("\n");

  assert.match(rendered, /Configure access/);
  assert.match(rendered, /Setup: https:\/\/example\.com\/setup/);
  assert.match(rendered, /\x1b\]8;;https:\/\/example\.com\/setup\x07/);
});
