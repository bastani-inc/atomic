import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { isSyntheticPath } from "../src/core/source-info.ts";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.ts";

const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;
const RAW_TOKEN = "github_pat_runtime_test_token";
const EXCHANGED_TOKEN = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com";
const tempDirs: string[] = [];

function writeModelsJson(provider: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-copilot-header-test-"));
	tempDirs.push(dir);
	const path = join(dir, "models.json");
	writeFileSync(path, JSON.stringify({ providers: { "github-copilot": provider } }));
	return path;
}

function anthropicResponse(): Response {
	const events = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
		})}`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		})}`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
	];
	return new Response(`${events.join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequestHeaders(
	token: string,
	options: { headers?: Record<string, string>; modelsPath?: string | null } = {},
): Promise<Headers> {
	vi.stubEnv("COPILOT_GITHUB_TOKEN", token);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: options.modelsPath ?? null,
		allowModelNetwork: false,
	});
	const model = runtime.getModel("github-copilot", "claude-sonnet-4.6");
	expect(model).toBeDefined();
	const sessionRoot = mkdtempSync(join(tmpdir(), "atomic-copilot-session-test-"));
	tempDirs.push(sessionRoot);
	const cwd = join(sessionRoot, "project");
	const agentDir = join(sessionRoot, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	linkSharedTranspileCache(agentDir);
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		model: model!,
		modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(cwd),
		builtins: NO_BUILTINS,
	});
	expect(
		extensionsResult.extensions.map((extension) => extension.path).filter((path) => !isSyntheticPath(path)),
	).toEqual([]);

	let request: Request | undefined;
	const fetchStub: typeof globalThis.fetch = async (input, init) => {
		request = input instanceof Request ? input : new Request(input, init);
		return anthropicResponse();
	};

	try {
		await (
			await session.agent.streamFunction(
				model!,
				{ messages: [{ role: "user", content: "say ok", timestamp: Date.now() }] },
				{ fetch: fetchStub, headers: options.headers },
			)
		).result();
	} finally {
		session.dispose();
	}

	expect(request).toBeDefined();
	return request!.headers;
}

describe("GitHub Copilot integration id through the agent runtime", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("sends the developer CLI integration id for a raw environment token", async () => {
		const headers = await captureRequestHeaders(RAW_TOKEN);

		expect(headers.get("Copilot-Integration-Id")).toBe("copilot-developer-cli");
		expect(headers.get("Authorization")).toBe(`Bearer ${RAW_TOKEN}`);
	});

	it("keeps the catalog integration id for an exchanged Copilot token", async () => {
		const headers = await captureRequestHeaders(EXCHANGED_TOKEN);

		expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
		expect(headers.get("Authorization")).toBe(`Bearer ${EXCHANGED_TOKEN}`);
	});

	it("keeps a per-request integration id override for a raw token", async () => {
		const headers = await captureRequestHeaders(RAW_TOKEN, {
			headers: { "Copilot-Integration-Id": "request-override" },
		});

		expect(headers.get("Copilot-Integration-Id")).toBe("request-override");
	});

	it("keeps a models.json provider integration id override for a raw token", async () => {
		const modelsPath = writeModelsJson({
			headers: { "Copilot-Integration-Id": "provider-override" },
		});
		const headers = await captureRequestHeaders(RAW_TOKEN, { modelsPath });

		expect(headers.get("Copilot-Integration-Id")).toBe("provider-override");
	});

	it("keeps an explicit models.json model vscode-chat override for a raw token", async () => {
		const modelsPath = writeModelsJson({
			modelOverrides: {
				"claude-sonnet-4.6": {
					headers: { "Copilot-Integration-Id": "vscode-chat" },
				},
			},
		});
		const headers = await captureRequestHeaders(RAW_TOKEN, { modelsPath });

		expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
	});
});
