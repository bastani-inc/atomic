import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "vitest";
import { runCliProcess } from "./cli-test-helpers.ts";

const provider = "github-copilot";
const id = "account-chat-fast";
let home: string;
let agentDir: string;
let cwd: string;
let url: string;
let server: Server;
let wires: string[];

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atomic-print-account-"));
	agentDir = join(home, "agent");
	cwd = join(home, "project");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	wires = [];
	server = createServer(async (req, res) => {
		wires.push(`${req.method} ${req.url}`);
		if (req.url === "/account/models" && req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id, capabilities: { type: "chat", supports: { tool_calls: true } } }] }));
			return;
		}
		if (req.url === "/account/chat/completions" && req.method === "POST") {
			let body = "";
			for await (const chunk of req) body += chunk;
			if (JSON.parse(body).model === id) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(
					'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"fixture-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				);
				return;
			}
		}
		res.writeHead(404).end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/account`;
	await writeFile(
		join(agentDir, "auth.json"),
		JSON.stringify({ [provider]: { type: "api_key", key: "github_pat_example" } }),
	);
	await configure(id);
});
afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((done) => server.close(() => done()));
	await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
});
async function configure(defaultModel: string, local = false) {
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: url,
					...(local ? { models: [{ id, name: "Fixture chat", api: "openai-completions" }] } : {}),
				},
			},
		}),
	);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel }));
}
function print(args: string[], offline = false) {
	return runCliProcess(["--print", "--no-extensions", "--no-skills", "--no-tools", ...args], {
		cwd,
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			TEMP: home,
			TMP: home,
			HOME: home,
			USERPROFILE: home,
			ATOMIC_CODING_AGENT_DIR: agentDir,
			ATOMIC_MODEL_CATALOG_URL: `${url}/catalog`,
			ATOMIC_OFFLINE: offline ? "1" : "0",
			AWS_EC2_METADATA_DISABLED: "true",
		},
	});
}

it("prints using the missing model named by saved settings (#5685)", async () => {
	const out = await print(["--no-session", "hello"]);
	assert.equal(out.code, 0, out.stderr);
	assert.equal(out.stdout.trim(), "fixture-ok");
	assert.deepEqual(wires, ["GET /account/models", "POST /account/chat/completions"]);
}, 90_000);

it("prints cache advice and exits without an account lookup when there is no input (#5685)", async () => {
	const out = await print(["--no-session"]);
	assert.equal(out.code, 1);
	assert.match(out.stderr, /atomic update --models/);
	assert.deepEqual(wires, []);
}, 90_000);

it("a fatal print startup diagnostic does not request the account list (#5685)", async () => {
	const extension = join(cwd, "broken.ts");
	await writeFile(extension, 'export default function broken() { throw new Error("fixture failed to load"); }');
	const out = await print(["--no-session", "--extension", extension, "hello"]);
	assert.equal(out.code, 1);
	assert.match(out.stderr, /fixture failed to load/);
	assert.deepEqual(wires, []);
}, 90_000);

it("resuming a different unavailable conversation model keeps the print restore advice (#5685)", async () => {
	const sessionId = "8721d489-d556-44d0-8133-ea185f5eee15";
	await configure(id, true);
	const seed = await print(["--session-id", sessionId, "--model", `${provider}/${id}`, "hello"], true);
	assert.equal(seed.code, 0, seed.stderr);
	assert.equal(seed.stdout.trim(), "fixture-ok");
	await configure("gpt-6.1-sol");
	wires.length = 0;
	const out = await print(["--session", sessionId, "hello"]);
	assert.equal(out.code, 1);
	assert.match(out.stderr, /Could not restore model github-copilot\/account-chat-fast/);
	assert.deepEqual(wires, []);
}, 150_000);
