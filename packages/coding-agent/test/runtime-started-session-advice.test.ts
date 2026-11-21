import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";

useTemporaryAgentDir();

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A runtime on an opened session kept in files, which cannot hold snapshots, and a fork of it the host made. With
 * `linked`, both are made through a link to the session directory, so the switch names the fork's file another way.
 */
async function runtimeWithFork(options: { readonly linked?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "runtime-started-session-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const cwd = join(dir, "project");
	const sessionDir = join(dir, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const madeIn = options.linked ? join(dir, "linked-sessions") : sessionDir;
	if (options.linked) symlinkSync(sessionDir, madeIn, "junction");
	const faux = registerFauxProvider();
	cleanups.push(() => faux.unregister());
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(dir, "models.json") });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ ...model }] });
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const services =
			options.services ??
			(await createAgentSessionServices({
				cwd: options.cwd,
				agentDir: dir,
				modelRuntime,
				resourceLoaderOptions: { builtinPackagePaths: [], noSkills: true, noPromptTemplates: true, noThemes: true },
			}));
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			model: faux.getModel(),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const original = await SessionManager.create(cwd, madeIn);
	await original.appendMessage({ role: "user", content: "earlier work", timestamp: 1 });
	const fork = await original.forkTo(cwd, madeIn);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: dir,
		sessionManager: await SessionManager.open(join(sessionDir, basename(original.getSessionFile()!)), sessionDir),
	});
	cleanups.push(() => runtime.dispose());
	let writes = 0;
	/** The storage reports of one turn that writes a file. */
	const advice = async () => {
		const reported: string[] = [];
		const unsubscribe = runtime.session.subscribe((event) => {
			if (event.type === "worktree_snapshot_unavailable") reported.push(event.reason.code ?? "");
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: join(cwd, `written-${++writes}.txt`), content: "x\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		try {
			await runtime.session.prompt("write a file");
		} finally {
			unsubscribe();
		}
		return reported;
	};
	return { runtime, original, fork, sessionDir, advice };
}

test("a switch to a fork the host just made reports its store once; switching back to it by ID does not", async () => {
	const { runtime, original, fork, sessionDir, advice } = await runtimeWithFork();
	assert.deepEqual(await advice(), [], "the opened session reports nothing");

	const switched = await runtime.switchSession(fork.getSessionId(), {
		sessionDirectory: sessionDir,
		startedSession: fork,
	});
	assert.equal(switched.cancelled, false);
	assert.deepEqual(await advice(), ["blob-store-unsupported"]);
	assert.deepEqual(await advice(), [], "not on every turn that writes");

	await runtime.switchSession(original.getSessionId(), { sessionDirectory: sessionDir });
	await runtime.switchSession(fork.getSessionId(), { sessionDirectory: sessionDir });
	assert.deepEqual(await advice(), [], "switching back by ID reports nothing");
});

test("a fork made through a link to its session directory reports its store once when the switch names it the direct way", async () => {
	const { runtime, fork, sessionDir, advice } = await runtimeWithFork({ linked: true });
	assert.notEqual(join(sessionDir, basename(fork.getSessionFile()!)), fork.getSessionFile());
	await runtime.switchSession(fork.getSessionId(), { sessionDirectory: sessionDir, startedSession: fork });
	assert.deepEqual(await advice(), ["blob-store-unsupported"]);
});
