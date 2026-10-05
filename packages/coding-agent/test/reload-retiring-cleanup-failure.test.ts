import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

class NontransactionalResourceLoader extends DefaultResourceLoader {
	supportsTransactionalReload(): boolean {
		return false;
	}
}

const reloadModes = ["transactional", "nontransactional"] as const;

test.each(reloadModes)(
	"a %s reload whose retiring cleanup fails keeps a published successor and names the cleanup error (#3425)",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "reload-retiring-cleanup-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const settingsPath = join(agentDir, "settings.json");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ fallbackModels: [] }));
		const settingsManager = SettingsManager.create(cwd, agentDir);
		let next = 0;
		let successor: number | undefined;
		const factory: ExtensionFactory = (pi) => {
			const generation = ++next;
			let startReason: string | undefined;
			pi.registerTool({
				name: "generation_probe",
				label: "generation probe",
				description: "Report the extension generation that owns this tool.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: `generation ${generation}` }], details: {} }),
			});
			pi.on("session_start", (event) => {
				startReason = event.reason;
				if (event.reason !== "reload") return;
				successor = generation;
				pi.appendEntry("reload-successor-started", { generation });
			});
			pi.on("session_shutdown", (event) => {
				if (event.reason === "reload" && startReason === "startup")
					throw new Error(`forced cleanup failure in generation ${generation}`);
			});
		};
		const Loader = mode === "transactional" ? DefaultResourceLoader : NontransactionalResourceLoader;
		const resourceLoader = new Loader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			extensionFactories: [factory],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		try {
			await session.bindExtensions({});
			const retiringRunner = session.extensionRunner;
			writeFileSync(settingsPath, JSON.stringify({ fallbackModels: ["edited/before-reload"] }));

			await assert.rejects(session.reload(), (error: Error & { code?: string }) => {
				assert.equal(error.code, "ShutdownFailed");
				assert.match(
					error.message,
					/^Reload retiring cleanup failed: .*forced cleanup failure in generation \d+$/,
					"the reported reload error names the nested cleanup exception",
				);
				return true;
			});

			assert.ok(session.extensionRunner !== retiringRunner, "a successor replaces the retiring runner");
			const probe = session.agent.state.tools.find((tool) => tool.name === "generation_probe");
			assert.ok(probe, "the successor's tools stay registered");
			const result = await probe.execute("probe-call", {}, new AbortController().signal);
			const [content] = result.content;
			assert.equal(content?.type === "text" ? content.text : undefined, `generation ${successor}`);
			assert.equal(
				session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "reload-successor-started").length,
				1,
				"effects the successor queued during session_start are published",
			);
			assert.deepEqual(session.settingsManager.getFallbackModels(), ["edited/before-reload"]);
		} finally {
			await session.dispose().catch((error: Error & { code?: string }) => {
				assert.equal(error.code, "ShutdownFailed");
			});
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test.each(reloadModes)(
	"a %s reload reports nested aggregate and raw shutdown causes verbatim (#3425)",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "reload-aggregate-cleanup-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const factory: ExtensionFactory = (pi) => {
			pi.on("session_shutdown", (event) => {
				if (event.reason === "reload")
					throw new AggregateError(
						[new Error("nested-a"), new AggregateError([new Error("nested-b"), " raw cause  "], "hidden")],
						"outer",
					);
			});
		};
		const Loader = mode === "transactional" ? DefaultResourceLoader : NontransactionalResourceLoader;
		const resourceLoader = new Loader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			extensionFactories: [factory],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		try {
			await session.bindExtensions({});
			await assert.rejects(session.reload(), (error: Error & { code?: string }) => {
				assert.ok(error instanceof AggregateError);
				assert.equal(error.code, "ShutdownFailed");
				assert.match(error.message, /^Reload retiring cleanup failed: .*: nested-a; nested-b; {2}raw cause {2}$/);
				return true;
			});
		} finally {
			await session.dispose().catch((error: Error & { code?: string }) => {
				assert.equal(error.code, "ShutdownFailed");
			});
			rmSync(root, { recursive: true, force: true });
		}
	},
);
