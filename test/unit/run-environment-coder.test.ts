import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import {
	acquireCoderCli,
	CoderAgentStartTimeoutError,
	type CoderWebSocket,
	createCoderClient,
} from "../../packages/workflows/src/runs/shared/run-environment-coder.js";

interface RecordedRequest {
	readonly url: string;
	readonly init: RequestInit;
}

function json(value: object, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function createFetch(responses: readonly Response[], requests: RecordedRequest[]) {
	let index = 0;
	return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		requests.push({ url: String(input), init });
		const response = responses[index++];
		if (response === undefined) throw new Error(`unexpected request ${String(input)}`);
		return response;
	};
}

class ScriptedSocket implements CoderWebSocket {
	readonly OPEN = 1;
	readyState = 0;
	private readonly listeners = new Map<string, Set<(event: Event | MessageEvent) => void>>();

	constructor(private readonly messages: readonly object[]) {
		queueMicrotask(() => {
			this.readyState = this.OPEN;
			this.emit("open", new Event("open"));
			for (const message of this.messages) {
				this.emit("message", new MessageEvent("message", { data: JSON.stringify(message) }));
			}
		});
	}

	addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: (event: Event | MessageEvent) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.readyState = 3;
	}

	private emit(type: string, event: Event | MessageEvent): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

describe("Coder run-environment client", () => {
	test("resolves deployment-owned template inputs and creates a workspace with every parameter explicit", async () => {
		const requests: RecordedRequest[] = [];
		const client = createCoderClient({
			deployment: "https://coder.test/root/",
			sessionToken: "secret-token",
			fetch: createFetch(
				[
					json({ id: "org-named" }),
					json({ id: "template-1", active_version_id: "version-7" }),
					json([
						{ name: "cpu", default_value: "2" },
						{ name: "region", default_value: "default-region" },
						{ name: "feature", default_value: "off" },
					]),
					json([{ id: "preset-standard", name: "standard", parameters: [{ name: "cpu", value: "4" }] }]),
					json({ id: "workspace-9", latest_build: { id: "build-1" } }),
				],
				requests,
			),
		});

		const workspace = await client.createWorkspace(
			"atomic-run-123",
			{
				deployment: "https://coder.test/root/",
				organization: "engineering",
				template: "dev-large",
				preset: "standard",
				parameters: { region: "configured-region" },
				idleMinutes: 240,
				retentionHours: 12,
			},
			new AbortController().signal,
		);

		assert.equal(workspace.id, "workspace-9");
		assert.deepEqual(
			requests.map((request) => new URL(request.url).pathname),
			[
				"/root/api/v2/organizations/engineering",
				"/root/api/v2/organizations/org-named/templates/dev-large",
				"/root/api/v2/templateversions/version-7/rich-parameters",
				"/root/api/v2/templateversions/version-7/presets",
				"/root/api/v2/users/me/workspaces",
			],
		);
		assert.equal(new Headers(requests[4]?.init.headers).get("Coder-Session-Token"), "secret-token");
		assert.deepEqual(JSON.parse(String(requests[4]?.init.body)), {
			name: "atomic-run-123",
			rich_parameter_values: [
				{ name: "cpu", value: "4" },
				{ name: "region", value: "configured-region" },
				{ name: "feature", value: "off" },
			],
			template_version_id: "version-7",
			template_version_preset_id: "preset-standard",
			ttl_ms: 14_400_000,
		});
	});

	test("creates lifecycle builds and waits for the workspace agent lifecycle to become ready", async () => {
		const requests: RecordedRequest[] = [];
		const socketUrls: string[] = [];
		const client = createCoderClient({
			deployment: "https://coder.test",
			sessionToken: "token",
			fetch: createFetch(
				[json({ id: "build-start" }), json({ id: "build-stop" }), json({ id: "build-delete" })],
				requests,
			),
			webSocket: (url) => {
				socketUrls.push(url);
				return new ScriptedSocket([
					{ build_update: { transition: "start", job_status: "running" } },
					{ agent_update: { id: "agent-1", lifecycle: "ready" } },
				]);
			},
		});

		await client.createBuild("workspace-1", { transition: "start" }, new AbortController().signal);
		await client.waitForAgentReady("workspace-1", { timeoutMs: 1_000 }, new AbortController().signal);
		await client.stopWorkspace("workspace-1", new AbortController().signal);
		await client.deleteWorkspace("workspace-1", new AbortController().signal);

		assert.deepEqual(
			requests.map((request) => JSON.parse(String(request.init.body))),
			[{ transition: "start" }, { transition: "stop" }, { transition: "delete" }],
		);
		assert.deepEqual(socketUrls, ["wss://coder.test/api/v2/workspaces/workspace-1/agent-connection-watch"]);
	});

	test("bounds a workspace whose agent never reports ready", async () => {
		const client = createCoderClient({
			deployment: "https://coder.test",
			sessionToken: "token",
			fetch,
			webSocket: () => new ScriptedSocket([{ agent_update: { id: "agent-1", lifecycle: "starting" } }]),
		});

		await assert.rejects(
			client.waitForAgentReady("workspace-1", { timeoutMs: 10 }, new AbortController().signal),
			CoderAgentStartTimeoutError,
		);
	});
	test("uses the current user's first organization when the binding does not name one", async () => {
		const requests: RecordedRequest[] = [];
		const client = createCoderClient({
			deployment: "https://coder.test",
			sessionToken: "token",
			fetch: createFetch(
				[
					json({ organization_ids: ["org-first", "org-second"] }),
					json({ active_version_id: "version-1" }),
					json([]),
					json({ id: "workspace-1", latest_build: { id: "build-1" } }),
				],
				requests,
			),
		});

		await client.createWorkspace(
			"atomic-run-default-org",
			{
				deployment: "https://coder.test",
				template: "dev",
				parameters: {},
				idleMinutes: 240,
				retentionHours: 12,
			},
			new AbortController().signal,
		);

		assert.deepEqual(
			requests.map((request) => new URL(request.url).pathname),
			[
				"/api/v2/users/me",
				"/api/v2/organizations/org-first/templates/dev",
				"/api/v2/templateversions/version-1/rich-parameters",
				"/api/v2/users/me/workspaces",
			],
		);
	});
});

describe("Coder CLI acquisition", () => {
	test("downloads the deployment version into a deployment-specific cache without consulting PATH", async () => {
		const root = await mkdtemp(join(tmpdir(), "atomic-coder-cli-"));
		const requests: string[] = [];
		const verified: Array<{ path: string; version: string }> = [];
		try {
			const path = await acquireCoderCli({
				deployment: "https://coder.test/base",
				cacheDirectory: root,
				fetch: async (input) => {
					const url = String(input);
					requests.push(url);
					return url.endsWith("/api/v2/buildinfo")
						? json({ deployment_id: "deployment-a", version: "v2.36.3+build" })
						: new Response("deployment-cli-binary");
				},
				platform: "linux",
				architecture: "x64",
				verifyBinary: async (candidate, version) => {
					verified.push({ path: candidate, version });
				},
				signal: new AbortController().signal,
			});

			assert.equal(path, join(root, "coder", "deployment-a", "2.36.3+build", "linux-amd64", "coder"));
			assert.deepEqual(requests, [
				"https://coder.test/base/api/v2/buildinfo",
				"https://coder.test/base/bin/coder-linux-amd64",
			]);
			assert.equal(await readFile(path, "utf8"), "deployment-cli-binary");
			assert.deepEqual(verified, [{ path, version: "v2.36.3+build" }]);

			const cached = await acquireCoderCli({
				deployment: "https://coder.test/base",
				cacheDirectory: root,
				fetch: async (input) => {
					requests.push(String(input));
					return json({ deployment_id: "deployment-a", version: "v2.36.3+build" });
				},
				platform: "linux",
				architecture: "x64",
				verifyBinary: async (candidate, version) => {
					verified.push({ path: candidate, version });
				},
				signal: new AbortController().signal,
			});
			assert.equal(cached, path);
			assert.equal(requests.filter((url) => url.endsWith("/bin/coder-linux-amd64")).length, 1);
			assert.equal(verified.length, 2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
