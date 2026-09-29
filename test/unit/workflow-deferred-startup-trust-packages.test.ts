import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	createAgentSessionFromServices,
	prepareAgentSessionServices,
} from "../../packages/coding-agent/src/core/agent-session-services.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import workflowExtension from "../../packages/workflows/src/extension/index.js";
import type {
	ExtensionAPI,
	PiExecuteContext,
	PiToolOpts,
	WorkflowToolArgs,
} from "../../packages/workflows/src/extension/public-types.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";

const roots: string[] = [];

afterEach(async () => {
	setDurableBackend(undefined);
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const workflowFactory: ExtensionFactory = (pi) => workflowExtension(pi as unknown as ExtensionAPI);

async function projectWithWorkflowPackage(): Promise<{ project: string; agentDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "atomic-3354-"));
	roots.push(root);
	const pkg = join(root, "pkg");
	const project = join(root, "project");
	const home = join(root, "home");
	const agentDir = join(home, ".atomic", "agent");
	await mkdir(join(pkg, "workflows"), { recursive: true });
	await mkdir(join(project, ".atomic"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "demo-pkg",
			type: "module",
			keywords: ["atomic-package"],
			atomic: { workflows: ["./workflows/hello.ts"] },
		}),
	);
	await writeFile(
		join(pkg, "workflows", "hello.ts"),
		`import { workflow } from "@bastani/atomic/workflows";
export default workflow({ name: "demo-hello", description: "demo", inputs: {}, outputs: {}, run: async () => ({}) });
`,
	);
	await writeFile(join(project, ".atomic", "settings.json"), JSON.stringify({ packages: [pkg] }));
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("ATOMIC_OFFLINE", "1");
	setDurableBackend(new InMemoryDurableBackend());
	return { project, agentDir };
}

async function registeredWorkflowNames(
	session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"],
): Promise<string[]> {
	const tool = session.getToolDefinition("workflow");
	assert.ok(tool, "the workflows extension registers the workflow tool");
	const result = await tool.execute(
		"list-workflows",
		{ action: "list" } as never,
		new AbortController().signal,
		undefined,
		session.extensionRunner.createContext(),
	);
	const details = result.details as WorkflowToolResult;
	assert.equal(details.action, "list");
	return details.items.map((item) => item.name);
}

async function startWithDeferredTrust(trusted: boolean): Promise<{ before: string[]; after: string[] }> {
	const { project, agentDir } = await projectWithWorkflowPackage();
	let completeTrust!: () => Promise<void>;
	const completeServices = await prepareAgentSessionServices({
		cwd: project,
		agentDir,
		settingsManager: SettingsManager.create(project, agentDir, { projectTrusted: false }),
		resourceLoaderOptions: {
			builtinPackagePaths: [],
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			extensionFactories: [workflowFactory],
		},
		resourceLoaderReloadOptions: {
			deferProjectTrust: (complete) => {
				completeTrust = complete;
			},
			resolveProjectTrust: async () => trusted,
		},
	});
	const services = await completeServices();
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(project),
	});
	try {
		await session.bindExtensions({ mode: "tui", uiContext: noOpUIContext });
		const before = await registeredWorkflowNames(session);
		await completeTrust();
		const finalServices = await completeServices();
		await session.completeStartupResources(finalServices.resourceLoader);
		return { before, after: await registeredWorkflowNames(session) };
	} finally {
		await session.dispose();
	}
}

test("registers trusted project package workflows once deferred startup trust completes (#3354)", async () => {
	const { before, after } = await startWithDeferredTrust(true);
	assert.equal(before.includes("demo-hello"), false, "untrusted project packages stay hidden before trust");
	assert.equal(after.includes("demo-hello"), true, `registry after trust: ${after.join(", ")}`);
});

test("keeps project package workflows excluded when deferred startup trust is declined (#3354)", async () => {
	const { before, after } = await startWithDeferredTrust(false);
	assert.equal(before.includes("demo-hello"), false);
	assert.equal(after.includes("demo-hello"), false, `registry after declined trust: ${after.join(", ")}`);
});

type LifecycleHandler = NonNullable<Parameters<NonNullable<ExtensionAPI["on"]>>[1]>;

test("keeps previously discovered workflows when the post-trust refresh fails (#3354)", async () => {
	const { project } = await projectWithWorkflowPackage();
	const workflowPath = join(project, "..", "pkg", "workflows", "hello.ts");
	const handlers = new Map<string, LifecycleHandler>();
	let refreshFails = false;
	let refreshCalls = 0;
	let tool: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> | undefined;
	workflowExtension({
		registerTool: (options) => {
			tool = options as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
		},
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		sendMessage: () => undefined,
		on: (event, handler) => {
			handlers.set(event, handler);
		},
		refreshWorkflowResources: async () => {
			refreshCalls += 1;
			if (refreshFails) throw new Error("post-trust refresh failed");
			return [{ path: workflowPath, enabled: true }];
		},
	});
	assert.ok(tool);
	const listed = async (): Promise<string[]> => {
		const result = await tool!.execute("list-workflows", { action: "list" }, undefined, undefined, {
			hasUI: false,
			sessionId: "deferred-trust-refresh-failure",
		} as PiExecuteContext);
		assert.equal(result.details.action, "list");
		return result.details.items.map((item) => item.name);
	};
	const cwd = process.cwd();
	process.chdir(project);
	try {
		await handlers.get("session_start")?.({ reason: "startup" });
		await handlers.get("resources_discover")?.({ reason: "startup" });
		assert.equal((await listed()).includes("demo-hello"), true);

		refreshFails = true;
		const callsBeforeRefresh = refreshCalls;
		await handlers.get("resources_discover")?.({ reason: "startup" });
		await vi.waitFor(() => assert.ok(refreshCalls > callsBeforeRefresh));
		const after = await listed();
		assert.equal(after.includes("demo-hello"), true, `registry after failed refresh: ${after.join(", ")}`);
	} finally {
		process.chdir(cwd);
		await handlers.get("session_shutdown")?.({ reason: "quit" });
	}
});
