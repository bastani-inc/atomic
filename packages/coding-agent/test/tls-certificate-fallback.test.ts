/**
 * A model request refused for its endpoint's TLS certificate is sent once: no same-model retry, and, like a rejected
 * credential, it moves on to the next fallback model, which is tried once too (#6114). Real AgentSession retry and
 * fallback machinery and the real OpenAI-compatible adapter against a local endpoint with a self-signed certificate.
 */

import assert from "node:assert/strict";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { createTestCertificate } from "../../../test/helpers/tls-certificates.js";
import { parseArgs } from "../src/cli/args.js";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { buildSessionOptions } from "../src/main-session-options.js";
import { createTestResourceLoader } from "./utilities.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An HTTPS endpoint showing a self-signed certificate; counts the connections made to it. */
async function selfSignedEndpoint(): Promise<{ baseUrl: string; host: string; connections(): number }> {
	const certificate = createTestCertificate({ subject: "localhost", altNames: ["localhost"] });
	let connections = 0;
	const server: Server = createServer({ cert: certificate.cert, key: certificate.key }, (_request, response) =>
		response.end(),
	);
	server.on("connection", () => connections++);
	server.on("tlsClientError", () => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const host = `localhost:${address.port}`;
	return { baseUrl: `https://${host}/v1`, host, connections: () => connections };
}

test("a refused certificate is sent once and moves to the next fallback model, which ends the turn with its own failure while the switch keeps the certificate problem (#6114)", async () => {
	const endpoint = await selfSignedEndpoint();
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const selfHosted: Model<"openai-completions"> = {
		id: "self-hosted-model",
		name: "Self-hosted",
		api: "openai-completions",
		provider: "self-hosted",
		baseUrl: endpoint.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1_000,
	};
	runtime.registerProvider("self-hosted", {
		api: "openai-completions",
		baseUrl: endpoint.baseUrl,
		apiKey: "fixture-key",
		models: [selfHosted],
	});
	cleanups.push(() => runtime.unregisterProvider("self-hosted"));
	// The fallback refuses its credential: a failure of its own, not a certificate.
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	const backup: Model<"anthropic-messages"> = { ...base, provider: "backup", id: "backup-model", name: "Backup" };
	let backupRequests = 0;
	runtime.registerProvider("backup", {
		api: base.api,
		baseUrl: base.baseUrl,
		apiKey: "fixture-key",
		models: [backup],
		streamSimple: (requestModel) => {
			backupRequests++;
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: base.api,
				provider: "backup",
				model: requestModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
				timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider("backup"));
	const settingsManager = SettingsManager.inMemory({
		defaultProvider: "self-hosted",
		defaultModel: "self-hosted-model",
		fallbackModels: ["backup/backup-model"],
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 1 },
	});
	const { options, diagnostics } = buildSessionOptions(parseArgs([]), [], false, runtime, settingsManager);
	assert.deepEqual(diagnostics, []);
	const sessionManager = SessionManager.inMemory();
	const { session } = await createAgentSession({
		...options,
		cwd: process.cwd(),
		modelRuntime: runtime,
		settingsManager,
		sessionManager,
		resourceLoader: createTestResourceLoader(),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => session.dispose());
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));

	await session.prompt("Say which model you are.");

	assert.equal(endpoint.connections(), 1, "the refused certificate was asked for again");
	assert.equal(backupRequests, 1);
	assert.deepEqual(
		events.filter((event) => event.type === "auto_retry_start"),
		[],
	);
	const certificateProblem = `The TLS certificate for ${endpoint.host} was not accepted (DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate`;
	// The switch says why, as `-p` prints it and the session records it, with the code, the host and the fix.
	const switches = events.filter((event) => event.type === "model_fallback_start");
	assert.equal(switches.length, 1);
	const reason = switches[0]?.type === "model_fallback_start" ? switches[0].reason : "";
	assert.ok(reason.startsWith(certificateProblem), reason);
	assert.ok(reason.includes("NODE_EXTRA_CA_CERTS"), reason);
	const recorded = sessionManager
		.getEntries()
		.findLast((entry) => entry.type === "model_change" && entry.provider === "backup");
	assert.ok(recorded?.type === "model_change" && recorded.fallback?.reason?.startsWith(certificateProblem));
	// The refused attempt stays in the session's history with its message, as the transcript showed it when it ended;
	// the turn ends with the fallback's own failure.
	const failures = sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
		.map((message) => (message as AssistantMessage).errorMessage ?? "");
	assert.equal(failures.length, 2, failures.join("\n"));
	assert.ok(failures[0]?.startsWith(certificateProblem), failures[0]);
	assert.match(failures[1] ?? "", /authentication_error/);
	const shown = events.flatMap((event) =>
		event.type === "message_end" && event.message.role === "assistant"
			? [(event.message as AssistantMessage).errorMessage ?? ""]
			: [],
	);
	assert.ok(shown[0]?.startsWith(certificateProblem), shown.join("\n"));
});

/** A plain-HTTP gateway that answers every request with `respond`; counts the requests. */
async function gateway(respond: (response: ServerResponse) => void): Promise<{ baseUrl: string; requests(): number }> {
	let requests = 0;
	const server = createHttpServer((request, response) => {
		requests++;
		request.resume();
		request.on("end", () => respond(response));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return { baseUrl: `http://127.0.0.1:${address.port}`, requests: () => requests };
}

/** How many retries a session with `retry.maxRetries: 3` started for one prompt to a model of `api` at `baseUrl`. */
async function retriesFor(api: "pi-messages" | "openai-completions", baseUrl: string): Promise<number> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const model: Model<typeof api> = {
		id: "gateway-model",
		name: "Gateway",
		api,
		provider: "gateway",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1_000,
	};
	runtime.registerProvider("gateway", { api, baseUrl, apiKey: "fixture-key", models: [model] });
	cleanups.push(() => runtime.unregisterProvider("gateway"));
	const settingsManager = SettingsManager.inMemory({
		defaultProvider: "gateway",
		defaultModel: "gateway-model",
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 1 },
	});
	const { options } = buildSessionOptions(parseArgs([]), [], false, runtime, settingsManager);
	const { session } = await createAgentSession({
		...options,
		cwd: process.cwd(),
		modelRuntime: runtime,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => session.dispose());
	let retries = 0;
	session.subscribe((event) => {
		if (event.type === "auto_retry_start") retries++;
	});
	await session.prompt("hello");
	return retries;
}

test("a gateway's 502 or stream error that names a certificate code keeps its same-model retries (#6114)", async () => {
	const relayed = { message: "upstream connect error: certificate has expired", code: "CERT_HAS_EXPIRED" };
	const answered = await gateway((response) => {
		response.writeHead(502, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: relayed }));
	});
	assert.equal(await retriesFor("pi-messages", answered.baseUrl), 3);
	assert.equal(answered.requests(), 4);

	const streamed = await gateway((response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`data: ${JSON.stringify({ error: relayed })}\n\n`);
	});
	assert.equal(await retriesFor("openai-completions", `${streamed.baseUrl}/v1`), 3);
	assert.equal(streamed.requests(), 4);
});
