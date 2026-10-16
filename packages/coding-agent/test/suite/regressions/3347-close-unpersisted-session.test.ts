import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../../src/index.ts";

describe("regression #3347: closing a committed session", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(responses: string[]) {
		const tempDir = join(tmpdir(), `pi-3347-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
						},
					],
					builtinPackagePaths: [],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(tempDir, sessionDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime };
	}

	it("switching to an earlier session preserves committed setup entries (#3347)", async () => {
		const { runtime } = await createRuntimeForTest(["earlier reply"]);
		await runtime.session.prompt("earlier");
		const earlierSessionFile = runtime.session.sessionFile!;
		expect(existsSync(earlierSessionFile)).toBe(true);

		expect((await runtime.newSession()).cancelled).toBe(false);
		await runtime.session.sessionManager.appendModelChange("faux", "faux-1");
		const unsavedSessionFile = runtime.session.sessionFile!;
		expect(unsavedSessionFile).not.toBe(earlierSessionFile);
		expect(existsSync(unsavedSessionFile)).toBe(true);
		const committed = readFileSync(unsavedSessionFile, "utf8");

		expect((await runtime.switchSession(earlierSessionFile)).cancelled).toBe(false);

		expect(runtime.session.sessionFile).toBe(earlierSessionFile);
		expect(readFileSync(unsavedSessionFile, "utf8")).toBe(committed);
	});

	it("disposing a session before any message preserves its committed header (#3347)", async () => {
		const { runtime } = await createRuntimeForTest([]);
		const unsavedSessionFile = runtime.session.sessionFile!;
		const committed = readFileSync(unsavedSessionFile, "utf8");

		await runtime.dispose();

		expect(readFileSync(unsavedSessionFile, "utf8")).toBe(committed);
	});

	it("disposing a session leaves the already committed conversation unchanged (#3347)", async () => {
		const { runtime } = await createRuntimeForTest(["saved reply"]);
		await runtime.session.prompt("saved");
		const savedSessionFile = runtime.session.sessionFile!;
		const committed = readFileSync(savedSessionFile, "utf8");

		await runtime.dispose();

		const persisted = readFileSync(savedSessionFile, "utf8");
		expect(persisted).toBe(committed);
		expect(persisted).toContain('"type":"session"');
		expect(persisted).toContain("saved reply");
	});
});
