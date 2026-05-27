/**
 * Tools Configuration
 *
 * Use tool names to choose which tools are exposed.
 *
 * `tools` is an allowlist. `excludedTools` removes names from the final exposed
 * set after any allowlist is applied, which is useful for keeping the default
 * tools while removing one tool such as ask_user_question.
 *
 * Tool names are matched against all available tools. If you use a custom `cwd`,
 * createAgentSession() applies that cwd when it builds the actual built-in tools.
 *
 * For custom tools, see 06-extensions.ts - custom tools are registered via the
 * extensions system using pi.registerTool().
 */

import { createAgentSession, SessionManager } from "@bastani/atomic";

// Read-only mode (no edit/write)
const { session: readOnlySession } = await createAgentSession({
	tools: ["read", "grep", "find", "ls"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Read-only session created");
readOnlySession.dispose();

// Custom tool selection
const { session: customToolsSession } = await createAgentSession({
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Custom tools session created");
customToolsSession.dispose();

// Keep defaults but remove one tool (for example, no human-in-the-loop prompts)
const { session: defaultsWithoutAskSession } = await createAgentSession({
	excludedTools: ["ask_user_question"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Defaults minus ask_user_question session created");
defaultsWithoutAskSession.dispose();

// Allowlist first, then subtract exclusions
const { session: allowlistWithExclusionSession } = await createAgentSession({
	tools: ["read", "bash", "ask_user_question"],
	excludedTools: ["ask_user_question"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Allowlist with exclusion session created");
allowlistWithExclusionSession.dispose();

// With custom cwd
const customCwd = "/path/to/project";
const { session: customCwdSession } = await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "edit", "write"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Custom cwd session created");
customCwdSession.dispose();

// Or pick specific tools for custom cwd
const { session: specificToolsSession } = await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Specific tools with custom cwd session created");
specificToolsSession.dispose();
