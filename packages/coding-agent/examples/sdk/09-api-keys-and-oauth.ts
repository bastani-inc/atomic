/**
 * API Keys and OAuth
 *
 * Configure credential and model resolution through ModelRuntime.
 */

import { createAgentSession, ModelRuntime, SessionManager } from "@bastani/atomic";

// Default: createAgentSession builds a runtime from the active agent directory's
// auth.json and models.json.
const { session: defaultAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
});
console.log("Session with default credential and model configuration");
defaultAuthSession.dispose();

// Custom credential and model configuration locations
const customRuntime = await ModelRuntime.create({
	authPath: "/tmp/my-app/auth.json",
	modelsPath: "/tmp/my-app/models.json",
});
const { session: customAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime: customRuntime,
});
console.log("Session with custom credential and model configuration");
customAuthSession.dispose();

// Runtime API key override (not persisted to disk)
const runtimeKeyRuntime = await ModelRuntime.create();
await runtimeKeyRuntime.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime: runtimeKeyRuntime,
});
console.log("Session with runtime API key override");
runtimeKeySession.dispose();

// No models.json - only built-in models
const builtinsOnlyRuntime = await ModelRuntime.create({ modelsPath: null });
const { session: builtInModelsSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime: builtinsOnlyRuntime,
});
console.log("Session with only built-in models");
builtInModelsSession.dispose();
