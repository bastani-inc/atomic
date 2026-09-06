import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createAgentSessionFromServices, prepareAgentSessionServices } from "../src/core/agent-session-services.ts";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import type { ProjectTrustContext, UIPromptEndEvent, UIPromptStartEvent } from "../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

// #2873: ordinary handlers must observe the actual startup wait with a live session.
for (const decision of ["approve", "deny", "cancel", "error", "override", "no-ui"] as const) {
	test(`startup trust ${decision} retains safe reporters and gates project code`, async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-trust-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const marker = join(root, "project-loaded");
		const projectStart = join(root, "project-started");
		const projectPrompt = join(root, "project-prompt");
		mkdirSync(join(cwd, ".atomic", "extensions"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(cwd, ".atomic", "extensions", "marker.ts"),
			`
			import { writeFileSync } from 'node:fs';
			export default function(pi) {
				writeFileSync(${JSON.stringify(marker)}, 'loaded');
				pi.on('session_start', () => writeFileSync(${JSON.stringify(projectStart)}, 'started'));
				pi.on('ui_prompt_start', () => writeFileSync(${JSON.stringify(projectPrompt)}, 'unexpected'));
			}
		`,
		);
		let completeTrust!: () => Promise<void>;
		let context!: ProjectTrustContext;
		let answer!: (answer: string | undefined) => void;
		let rejectAnswer!: (error: Error) => void;
		let shown!: () => void;
		const promptShown = new Promise<void>((resolve) => {
			shown = resolve;
		});
		const response = new Promise<string | undefined>((resolve, reject) => {
			answer = resolve;
			rejectAnswer = reject;
		});
		let observed!: () => void;
		const startObserved = new Promise<void>((resolve) => {
			observed = resolve;
		});
		const events: Array<UIPromptStartEvent | UIPromptEndEvent> = [];
		let factories = 0;
		let starts = 0;
		let shutdowns = 0;
		let selectedOptions: string[] = [];
		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const completeServices = await prepareAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				extensionFactories: [
					(pi) => {
						factories++;
						pi.on("session_start", () => {
							starts++;
						});
						pi.on("session_shutdown", () => {
							shutdowns++;
						});
						pi.on("ui_prompt_start", (event, ctx) => {
							assert.equal(ctx.cwd, cwd);
							assert.equal(ctx.sessionManager.getSessionId(), sessionManager.getSessionId());
							assert.equal(ctx.isIdle(), true);
							assert.equal(ctx.isProjectTrusted(), false);
							events.push(event);
							observed();
						});
						pi.on("ui_prompt_end", (event, ctx) => {
							assert.equal(ctx.sessionManager.getSessionId(), sessionManager.getSessionId());
							events.push(event);
						});
					},
				],
			},
			resourceLoaderReloadOptions: {
				deferProjectTrust: (complete) => {
					completeTrust = complete;
				},
				resolveProjectTrust: ({ extensionsResult }) =>
					resolveProjectTrusted({
						cwd,
						trustStore: new ProjectTrustStore(agentDir),
						extensionsResult,
						projectTrustContext: context,
						trustOverride: decision === "override" ? true : undefined,
					}),
			},
		});
		const services = await completeServices();
		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		try {
			assert.equal(existsSync(marker), false);
			const runner = session.extensionRunner;
			await session.bindExtensions({
				mode: "tui",
				uiContext: {
					...noOpUIContext,
					select: async (_title, options) => {
						selectedOptions = options;
						shown();
						return response;
					},
				},
			});
			const ui = runner.getUIContext();
			context = {
				cwd,
				mode: decision === "no-ui" ? "rpc" : "tui",
				hasUI: decision !== "no-ui",
				ui: {
					...noOpUIContext,
					select: (title, options, opts) =>
						runner.withProjectTrustPrompt("select", title, () => ui.select(title, options, opts)),
				},
			};
			const completion = completeTrust();
			if (decision !== "override" && decision !== "no-ui") {
				await promptShown;
				await startObserved;
				assert.equal(events.length, 1);
				assert.equal(events[0].reason, "project_trust");
				assert.equal(existsSync(marker), false);
				assert.equal(starts, 1);
				assert.equal(shutdowns, 0);
				if (decision === "error") rejectAnswer(new Error("prompt failed"));
				else
					answer(
						decision === "cancel"
							? undefined
							: selectedOptions.find((option) =>
									decision === "approve"
										? option === "Trust (this session only)"
										: option === "Do not trust (this session only)",
								),
					);
			}
			if (decision === "error") await assert.rejects(completion, /prompt failed/);
			else {
				await completion;
				const finalServices = await completeServices();
				await session.completeStartupResources(finalServices.resourceLoader);
			}
			await runner.flushUIPromptNotifications(1_000);
			const allowed = decision === "approve" || decision === "override";
			assert.equal(existsSync(marker), allowed);
			assert.equal(existsSync(projectStart), allowed);
			assert.equal(existsSync(projectPrompt), false);
			assert.equal(events.length, decision === "override" || decision === "no-ui" ? 0 : 2);
			assert.equal(session.extensionRunner, runner);
			assert.equal(factories, 1);
			assert.equal(starts, 1);
			assert.equal(shutdowns, 0);
		} finally {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
}
