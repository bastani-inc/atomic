import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { removeTempRootReleasingBroker } from "../../../test/helpers/detached-broker.ts";
import { startPtyProgram } from "../../../test/helpers/pty-program.ts";
import { bunExecutable } from "../../../test/helpers/runtime.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { normalizeModelFailureSignal } from "../src/core/model-fallback-failures.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { cliPath, runCliProcess } from "./cli-test-helpers.js";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.js";
import { createTestResourceLoader } from "./utilities.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const primaryId = "primary-model";
const backupId = "backup-model";
const rawFailure = {
	type: "error",
	error: {
		type: "rate_limit_error",
		message: "This request would exceed your account's rate limit. Please try again later.",
	},
	request_id: "req_local_fixture",
};
const answer = "Reply from the fallback.";
const fallbackDeadlineMs = 10_000;
const cliTimeoutMs = 60_000;
const longAfter = { "retry-after": "305" };
const capGuidance = /rate limit reached.*305s wait exceeds.*60s retry limit.*Switch models or try again/i;
const shortAfter = { "retry-after": "0.05" };

function success(response: ServerResponse): void {
	const frames = [
		{
			type: "message_start",
			message: {
				id: "msg_fixture",
				type: "message",
				role: "assistant",
				content: [],
				model: backupId,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(frames.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

interface FixtureOptions {
	siblings?: number;
	exhaust?: boolean;
	hold?: boolean;
	fallback?: boolean;
	responsesFailure?: { code: string; message: string; headers?: Record<string, string>; http?: "code" | "type" };
}

async function endpoint(
	headers: Record<string, string>,
	{ siblings = 0, exhaust = false, hold = false, fallback = true, responsesFailure }: FixtureOptions = {},
) {
	const requests: { model: string; at: number }[] = [];
	const provider = `limited-${crypto.randomUUID().slice(0, 8)}`;
	const backup = `backup-${crypto.randomUUID().slice(0, 8)}`;
	let releaseBackup: () => void = () => {};
	const backupReady = hold
		? new Promise<void>((resolve) => {
				releaseBackup = resolve;
			})
		: Promise.resolve();
	const server = createServer((request, response) => {
		const body: Buffer[] = [];
		request.on("data", (chunk: Buffer) => body.push(chunk));
		request.on("end", () => {
			const account = request.url?.split("/")[1] ?? "";
			const { model } = JSON.parse(Buffer.concat(body).toString()) as { model: string };
			requests.push({ model: `${account}/${model}`, at: performance.now() });
			if (account === backup && !exhaust) {
				void backupReady.then(() => success(response));
				return;
			}
			if (account === provider && responsesFailure) {
				const { code, message, headers, http } = responsesFailure;
				if (http) {
					response.writeHead(429, { "content-type": "application/json", ...headers });
					response.end(JSON.stringify({ error: { [http]: code, message } }));
				} else {
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(
						`data: ${JSON.stringify({
							type: "response.failed",
							response: { status: "failed", error: { code, message, headers } },
						})}\n\n`,
					);
				}
				return;
			}
			response.writeHead(429, { "content-type": "application/json", ...headers });
			response.end(JSON.stringify(rawFailure));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => {
		releaseBackup();
		server.closeAllConnections();
		return new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const modelConfig = (account: string, ids: string[]) => {
		const base =
			account === provider && responsesFailure
				? getFixtureModel("openai", "gpt-4o-mini")!
				: getFixtureModel("anthropic", "claude-sonnet-4-5")!;
		const baseUrl = `http://127.0.0.1:${address.port}/${account}`;
		const models: Model<"anthropic-messages" | "openai-responses">[] = ids.map((id) => ({
			...base,
			baseUrl,
			provider: account,
			id,
			name: id,
		}));
		return { api: base.api, baseUrl, apiKey: "fixture-key", models };
	};
	const siblingsIds = Array.from({ length: siblings }, (_, index) => `other-model-${index}`);
	const providers = {
		[provider]: modelConfig(provider, [primaryId, ...siblingsIds]),
		[backup]: modelConfig(backup, [backupId]),
	};
	const primaryRef = `${provider}/${primaryId}`;
	const backupRef = `${backup}/${backupId}`;
	const fallbackModels = fallback ? [...siblingsIds.map((id) => `${provider}/${id}`), backupRef] : [];
	return { requests, provider, providers, primaryRef, backupRef, fallbackModels, releaseBackup };
}

async function setupSdk(
	headers: Record<string, string>,
	providerRetries: number,
	fixtureOptions?: Parameters<typeof endpoint>[1],
) {
	const fixture = await endpoint(headers, fixtureOptions);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	for (const [account, config] of Object.entries(fixture.providers)) {
		runtime.registerProvider(account, config);
		cleanups.push(() => runtime.unregisterProvider(account));
	}
	const settingsManager = SettingsManager.inMemory({
		cacheWarming: "off",
		defaultProvider: fixture.provider,
		defaultModel: primaryId,
		fallbackModels: fixture.fallbackModels,
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: providerRetries } },
	});
	const sessionManager = SessionManager.inMemory();
	const { session } = await createAgentSession({
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
	return { ...fixture, session, events, sessionManager };
}

async function prompt({ session }: Awaited<ReturnType<typeof setupSdk>>) {
	const watchdog = setTimeout(() => void session.abort(), fallbackDeadlineMs);
	try {
		await session.prompt("Hello.");
	} finally {
		clearTimeout(watchdog);
	}
}

const cases = [
	{ name: "no Retry-After", headers: () => ({}), retryMs: 1 },
	{ name: "short Retry-After", headers: () => shortAfter, retryMs: 50 },
	{ name: "over-cap Retry-After", headers: () => longAfter, retryMs: undefined },
	{
		name: "over-cap Anthropic reset",
		headers: () => ({
			"anthropic-ratelimit-requests-remaining": "0",
			"anthropic-ratelimit-requests-reset": new Date(Date.now() + 305_000).toISOString(),
		}),
		retryMs: undefined,
	},
];

test.each(cases)("SDK reaches the fallback after a 429 with $name (#6774)", async ({ headers, retryMs }) => {
	const slowReset = retryMs === undefined;
	const harness = await setupSdk(headers(), slowReset ? 1 : 0, { siblings: slowReset ? 1 : 0 });
	await prompt(harness);
	const { requests, session, events, primaryRef, backupRef, sessionManager } = harness;
	const retry = events.find((event) => event.type === "auto_retry_start");
	assert.equal(retry?.delayMs, retryMs, `scheduled same-model retry: ${JSON.stringify(retry)}`);
	assert.deepEqual(
		requests.map(({ model }) => model),
		slowReset ? [primaryRef, backupRef] : [primaryRef, primaryRef, backupRef],
	);
	assert.equal(session.model?.id, backupId);
	assert.ok(events.some((event) => event.type === "model_fallback_start" && event.to === backupRef));
	assert.ok(events.some((event) => event.type === "model_fallback_end" && event.success));
	const entries = sessionManager.getEntries();
	const retryEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "rate-limit-retry");
	const switchEntry = entries.find((entry) => entry.type === "model_change" && entry.modelId === backupId);
	assert.ok(switchEntry?.type === "model_change");
	assert.match(switchEntry.fallback?.reason ?? "", /Provider rate limit reached/);
	if (slowReset) {
		assert.equal(retryEntry, undefined);
		assert.deepEqual(switchEntry.fallback?.skipped, [
			{ model: harness.fallbackModels[0], provider: harness.provider, reason: "rate-limited" },
		]);
	} else {
		assert.ok(retryEntry?.type === "custom");
		assert.deepEqual(retryEntry.data, { model: primaryRef, attempt: 1, delayMs: retryMs });
		if (retryMs === 50)
			assert.ok(requests[1]!.at - requests[0]!.at >= 45, "retried before the server's delay elapsed");
	}
});

const transientResponsesFailures = ["rate_limit_exceeded", "policy_capacity_unavailable"].flatMap((code) =>
	[false, true].map((fallback) => ({ code, fallback })),
);

test.each(transientResponsesFailures)(
	"retries a statusless Responses $code within the budget (fallback enabled: $fallback)",
	async ({ code, fallback }) => {
		const harness = await setupSdk({}, 0, {
			fallback,
			responsesFailure: { code, message: "Request rejected.", headers: shortAfter },
		});
		await prompt(harness);
		const { requests, events, primaryRef, backupRef } = harness;
		assert.deepEqual(
			requests.map(({ model }) => model),
			fallback ? [primaryRef, primaryRef, backupRef] : [primaryRef, primaryRef],
		);
		const retries = events.filter((event) => event.type === "auto_retry_start");
		assert.equal(retries.length, 1);
		assert.equal(retries[0]?.delayMs, 50);
		assert.equal(
			events.some((event) => event.type === "model_fallback_start"),
			fallback,
		);
	},
);

test("an unknown statusless Responses code does not start an automatic retry without a fallback chain", async () => {
	const harness = await setupSdk({}, 0, {
		fallback: false,
		responsesFailure: { code: "new_error_code", message: "Unexpected." },
	});
	await prompt(harness);
	assert.deepEqual(
		harness.requests.map(({ model }) => model),
		[harness.primaryRef],
	);
	assert.equal(
		harness.events.some((event) => event.type === "auto_retry_start"),
		false,
	);
});

test.each([
	{ code: "usage_not_included", http: "type" as const },
	{ code: "api_key_spend_limit_exceeded", http: "code" as const },
	{ code: "project_spend_limit_exceeded", http: "code" as const },
	{ code: "organization_spend_limit_exceeded", http: "code" as const },
	{ code: "api_key_spend_limit_exceeded" },
	{ code: "usage_not_included" },
	{ code: "usage_limit_reached" },
	{ code: "insufficient_quota" },
])("advances without retrying when Responses reports $code", async (failure) => {
	const harness = await setupSdk({}, 1, {
		responsesFailure: { ...failure, message: "Cannot serve.", headers: shortAfter },
	});
	await prompt(harness);
	const { requests, events, primaryRef, backupRef, sessionManager } = harness;
	assert.deepEqual(
		requests.map(({ model }) => model),
		[primaryRef, backupRef],
	);
	const failed = sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
		);
	assert.ok(failed?.type === "message");
	assert.equal(normalizeModelFailureSignal(failed.message).kind, "quota_exhausted");
	assert.equal(
		events.some((event) => event.type === "auto_retry_start"),
		false,
	);
	assert.ok(events.some((event) => event.type === "model_fallback_end" && event.success));
});

test("an exhausted rate-limited chain keeps its failed attempts and ends with actionable guidance (#6774)", async () => {
	const harness = await setupSdk(longAfter, 0, { exhaust: true });
	await prompt(harness);
	const { requests, primaryRef, backupRef, sessionManager, events } = harness;
	assert.deepEqual(
		requests.map(({ model }) => model),
		[primaryRef, backupRef],
	);
	const failures = sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message.errorMessage] : [],
		);
	assert.equal(failures.length, 2);
	for (const failure of failures) {
		assert.match(failure ?? "", capGuidance);
		assert.doesNotMatch(failure ?? "", /rate_limit_error|req_local_fixture/);
	}
	assert.ok(
		events.some(
			(event) => event.type === "model_fallback_end" && !event.success && /rate limit/i.test(event.finalError ?? ""),
		),
	);
});

async function setupCli(headers: Record<string, string>, options: Parameters<typeof endpoint>[1]) {
	const fixture = await endpoint(headers, options);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-rate-limit-fallback-")));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	cleanups.push(() => removeTempRootReleasingBroker(root, agentDir));
	linkSharedTranspileCache(agentDir);
	const write = (file: string, data: object) => writeFileSync(join(agentDir, file), JSON.stringify(data));
	write("trust.json", { [cwd]: true });
	write("settings.json", {
		lastChangelogVersion: "0.0.0",
		onboardedVersion: "0.0.0",
		cacheWarming: "off",
		// The interactive auto-summary is a separate request, not an attempt at the turn under test.
		sessionSummary: { enabled: false },
		defaultProvider: fixture.provider,
		defaultModel: primaryId,
		fallbackModels: fixture.fallbackModels,
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
	});
	write("models.json", { providers: fixture.providers });
	const args = [
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
	];
	const env = { ATOMIC_CODING_AGENT_DIR: agentDir, HOME: root, USERPROFILE: root, TERM: "xterm-256color", CI: "0" };
	return { ...fixture, cwd, args, env };
}

test.each(cases)(
	"print mode reaches the fallback after a 429 with $name (#6774)",
	async ({ headers, retryMs }) => {
		const slowReset = retryMs === undefined;
		const { requests, args, cwd, env, primaryRef, backupRef } = await setupCli(headers(), {
			siblings: slowReset ? 9 : 0,
		});
		const result = await runCliProcess([...args, "-p", "Hello."], {
			cwd,
			env: { ...process.env, ...env },
			timeoutMs: cliTimeoutMs,
		});
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), answer);
		assert.match(result.stderr, /Model fallback:.*Provider rate limit reached/);
		assert.doesNotMatch(result.stderr, /rate_limit_error|req_local_fixture/);
		assert.deepEqual(
			requests.map(({ model }) => model),
			slowReset ? [primaryRef, backupRef] : [primaryRef, primaryRef, backupRef],
		);
	},
	cliTimeoutMs + 5_000,
);

test.each(["--no-fallback", "--model"])(
	"print mode explains an over-cap rate limit without falling back with %s (#6774)",
	async (flag) => {
		const { requests, args, cwd, env, primaryRef } = await setupCli(longAfter, {});
		const result = await runCliProcess(
			[...args, ...(flag === "--model" ? [flag, primaryRef] : [flag]), "-p", "Hello."],
			{
				cwd,
				env: { ...process.env, ...env },
				timeoutMs: cliTimeoutMs,
			},
		);
		assert.equal(result.code, 1, result.stderr);
		assert.match(result.stderr, capGuidance);
		assert.doesNotMatch(result.stderr, /Model fallback:|rate_limit_error|req_local_fixture/);
		assert.deepEqual(
			requests.map(({ model }) => model),
			[primaryRef],
		);
	},
	cliTimeoutMs + 5_000,
);

test.each(cases)(
	"interactive main chat reaches the fallback after a 429 with $name (#6774)",
	async ({ headers, retryMs }) => {
		const slowReset = retryMs === undefined;
		const { requests, args, cwd, env, primaryRef, backupRef, releaseBackup } = await setupCli(headers(), {
			siblings: slowReset ? 9 : 0,
			hold: true,
		});
		const cli = startPtyProgram({
			executable: bunExecutable(),
			args: [cliPath, ...args],
			env,
			cwd,
			cols: 160,
			rows: 40,
			timeoutMs: cliTimeoutMs,
		});
		try {
			await cli.waitForScreen(
				(screen) => screen.includes("❯"),
				cliTimeoutMs - fallbackDeadlineMs,
				"the chat prompt",
			);
			cli.write("Hello.\r");
			await cli.waitForScreen(
				(screen) => screen.includes("Falling back from") && screen.includes(backupRef),
				fallbackDeadlineMs,
				"the model fallback notice",
			);
			releaseBackup();
			await cli.waitForScreen((screen) => screen.includes(answer), fallbackDeadlineMs, "the fallback reply");
			assert.doesNotMatch(cli.screen(), /Error: Provider rate limit|rate_limit_error|req_local_fixture/);
			assert.deepEqual(
				requests.map(({ model }) => model),
				slowReset ? [primaryRef, backupRef] : [primaryRef, primaryRef, backupRef],
			);
		} finally {
			releaseBackup();
			cli.kill();
			await cli.exited;
		}
	},
	cliTimeoutMs + 5_000,
);
