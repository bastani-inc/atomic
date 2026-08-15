/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { getBuiltinPackagePaths } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	type InlineExtension,
} from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { allToolNames, defaultToolNames } from "../../packages/coding-agent/src/core/tools/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function sessionRoots(prefix: string): { cwd: string; agentDir: string } {
	const cwd = tempDir(prefix);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { cwd, agentDir };
}

/**
 * Structural cost, not a slow test: the case performs a full builtin-package
 * loader reload (workflows, subagents, mcp, web-access, i-have-adhd, intercom)
 * and creates a real agent session from the result. Do not reuse this budget
 * for a test that merely inspects data.
 */
const BUILTIN_PACKAGE_SESSION_TIMEOUT_MS = 120_000;

/** Every tool contributed by Atomic's builtin extension packages. */
const BUILTIN_EXTENSION_TOOLS = ["workflow", "subagent", "intercom", "mcp", "web_search"] as const;

type ToolOptions = Pick<CreateAgentSessionOptions, "tools" | "excludedTools" | "noTools" | "customTools">;

async function createSession(
	// undefined leaves the setting unset; [] requests zero initial built-ins.
	defaultTools: string[] | undefined,
	options: ToolOptions = {},
	extensionFactories: InlineExtension[] = [],
	builtinPackagePaths: string[] = [],
) {
	const { cwd, agentDir } = sessionRoots("atomic-default-tools-");
	const settingsManager = SettingsManager.inMemory(
		defaultTools === undefined ? {} : { defaultTools: [...defaultTools] },
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		builtinPackagePaths,
		extensionFactories,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader,
		...options,
	});
	return session;
}

function staticExtensionTool(name: string): InlineExtension {
	return (pi) => {
		pi.registerTool({
			name,
			label: name,
			description: "Statically registered extension tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
	};
}

describe("defaultTools setting", () => {
	test(
		'keeps every builtin extension tool registered and active under defaultTools: ["read"]',
		async () => {
			const session = await createSession(["read"], {}, [], getBuiltinPackagePaths());
			try {
				await session.bindExtensions({});

				const registered = session.getAllTools().map((tool) => tool.name);
				const active = session.getActiveToolNames();

				// The companion fix (upstream 541045ae): a narrow defaultTools must
				// narrow only the initial built-in selection. allowedToolNames stays
				// undefined, so every builtin extension tool survives both
				// registration and the active set — including `mcp`, which only
				// registers during session_start.
				for (const bundled of BUILTIN_EXTENSION_TOOLS) {
					assert.ok(
						registered.includes(bundled),
						`expected the bundled '${bundled}' tool to stay registered, got: ${registered.join(", ")}`,
					);
					assert.ok(
						active.includes(bundled),
						`expected the bundled '${bundled}' tool to stay active, got: ${active.join(", ")}`,
					);
				}

				// "read" is the only initially active built-in; the others stay
				// registered (reachable via /tools) but inactive.
				assert.ok(active.includes("read"));
				for (const builtin of allToolNames) {
					assert.ok(registered.includes(builtin), `expected built-in '${builtin}' to stay registered`);
					if (builtin !== "read") {
						assert.equal(
							active.includes(builtin),
							false,
							`expected built-in '${builtin}' to start inactive under defaultTools: ["read"]`,
						);
					}
				}

				// The system prompt advertises active tools only.
				assert.ok(session.systemPrompt.includes("- read:"), "expected the active read tool in the system prompt");
				assert.equal(
					session.systemPrompt.includes("- bash:"),
					false,
					"expected inactive built-ins to leave the system prompt",
				);
			} finally {
				session.dispose();
			}
		},
		BUILTIN_PACKAGE_SESSION_TIMEOUT_MS,
	);

	test("keeps extension and SDK custom tools enabled alongside a narrow selection", async () => {
		const session = await createSession(
			["read"],
			{
				customTools: [
					{
						name: "sdk_tool",
						label: "SDK Tool",
						description: "SDK custom tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				],
			},
			[
				staticExtensionTool("static_tool"),
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Dynamically registered extension tool",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		);
		try {
			await session.bindExtensions({});

			assert.deepEqual([...session.getActiveToolNames()].sort(), [
				"dynamic_tool",
				"read",
				"sdk_tool",
				"static_tool",
			]);
			const registered = session
				.getAllTools()
				.map((tool) => tool.name)
				.sort();
			assert.deepEqual(registered, [
				"ask_user_question",
				"bash",
				"dynamic_tool",
				"edit",
				"find",
				"ls",
				"read",
				"sdk_tool",
				"search",
				"static_tool",
				"todo",
				"write",
			]);
		} finally {
			session.dispose();
		}
	});

	test("preserves explicit tool option precedence over the setting", async () => {
		const allowlistedSession = await createSession(["read", "find"], { tools: ["read"] });
		try {
			assert.deepEqual(allowlistedSession.getActiveToolNames(), ["read"]);
		} finally {
			allowlistedSession.dispose();
		}

		const excludedSession = await createSession(["read", "find"], { excludedTools: ["read"] });
		try {
			assert.deepEqual(excludedSession.getActiveToolNames(), ["find"]);
		} finally {
			excludedSession.dispose();
		}

		const toolLessSession = await createSession(["read"], { noTools: "all" });
		try {
			assert.deepEqual(toolLessSession.getAllTools(), []);
			assert.deepEqual(toolLessSession.getActiveToolNames(), []);
		} finally {
			toolLessSession.dispose();
		}
	});

	test('noTools: "builtin" ignores the configured defaults but keeps extension tools', async () => {
		const session = await createSession(["read"], { noTools: "builtin" }, [staticExtensionTool("static_tool")]);
		try {
			assert.deepEqual(session.getActiveToolNames(), ["static_tool"]);
			assert.ok(
				session
					.getAllTools()
					.map((tool) => tool.name)
					.includes("read"),
				'expected built-ins to stay registered under noTools: "builtin"',
			);
		} finally {
			session.dispose();
		}
	});

	test("an unset setting keeps the standard built-in defaults; an empty list keeps none", async () => {
		const unsetSession = await createSession(undefined);
		try {
			assert.deepEqual(unsetSession.getActiveToolNames(), [...defaultToolNames]);
		} finally {
			unsetSession.dispose();
		}

		const emptySession = await createSession([], {}, [staticExtensionTool("static_tool")]);
		try {
			assert.deepEqual(emptySession.getActiveToolNames(), ["static_tool"]);
			for (const builtin of allToolNames) {
				assert.ok(
					emptySession
						.getAllTools()
						.map((tool) => tool.name)
						.includes(builtin),
					`expected built-in '${builtin}' to stay registered under defaultTools: []`,
				);
			}
		} finally {
			emptySession.dispose();
		}
	});
});
