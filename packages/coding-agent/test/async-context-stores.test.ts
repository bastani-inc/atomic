import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { asyncScope } from "../src/core/async-scope.ts";
import { withOwnResourceAdmission } from "../src/core/resource-admission-scope.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { RecordingAnthropicServer } from "./helpers/recording-anthropic-server.ts";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.ts";

/**
 * Every AsyncLocalStorage that enters a value, with the stack of its first entry. On Node 22 each store entered this
 * way stays in the process-wide list that every promise visits, and makes every await in the process slower.
 */
function recordEnteredStores(): Map<AsyncLocalStorage<unknown>, string> {
	const entered = new Map<AsyncLocalStorage<unknown>, string>();
	const run = AsyncLocalStorage.prototype.run;
	vi.spyOn(AsyncLocalStorage.prototype, "run").mockImplementation(function <R>(
		this: AsyncLocalStorage<unknown>,
		store: unknown,
		callback: (...args: unknown[]) => R,
		...args: unknown[]
	): R {
		if (!Object.is(store, this.getStore()) && !entered.has(this)) entered.set(this, new Error().stack ?? "");
		return run.call(this, store, callback, ...args) as R;
	});
	return entered;
}

const sharedScopes = (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("atomic.async-scopes.v1")];

afterEach(() => {
	vi.restoreAllMocks();
});

test("SDK sessions, their tool calls and model requests share one async context store (#6111)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-async-stores-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	linkSharedTranspileCache(agentDir);
	const server = await RecordingAnthropicServer.start();
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { anthropic: { baseUrl: server.baseUrl } } }),
	);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-test" } }));
	writeFileSync(join(cwd, "note.txt"), "a note\n");
	const entered = recordEnteredStores();
	try {
		for (let index = 0; index < 2; index++) {
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: getFixtureModel("anthropic", "claude-sonnet-4-5")!,
				sessionManager: SessionManager.inMemory(cwd),
				builtins: { intercom: false },
			});
			try {
				server.reply({ toolUse: { name: "read", input: { path: "note.txt" } } }, { text: "It says a note." });
				await session.prompt("What does note.txt say?");
				await session.prompt("Thanks");
				const result = session.messages.find((message) => message.role === "toolResult");
				assert.ok(result?.role === "toolResult" && !result.isError, JSON.stringify(result));
			} finally {
				await session.dispose();
			}
		}
		assert.equal(server.requests.length, 6);
		const others = [...entered].filter(([store]) => store !== sharedScopes).map(([, stack]) => stack);
		assert.deepEqual(others, [], `${others.length} more async context stores were entered`);
		assert.ok(entered.has(sharedScopes as AsyncLocalStorage<unknown>));
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a scope run with the value it already has enters no async context store (#6111)", async () => {
	const entered = recordEnteredStores();
	const scope = asyncScope<string>();
	assert.equal(
		scope.run(undefined as unknown as string, () => "ran"),
		"ran",
	);
	await withOwnResourceAdmission(undefined, async () => {
		await sleep(1);
	});
	assert.equal(entered.size, 0);
	await scope.run("outer", () =>
		scope.run("outer", async () => {
			await sleep(1);
			assert.equal(scope.getStore(), "outer");
		}),
	);
	assert.equal(entered.size, 1);
});

test("a scope calls its operation as AsyncLocalStorage does, entering a value or not", () => {
	const scope = asyncScope<string>();
	const native = new AsyncLocalStorage<string>();
	function receiver(this: unknown): unknown {
		return this;
	}
	assert.equal(
		scope.run("a", () => scope.run("a", receiver)),
		native.run("a", () => native.run("a", receiver)),
	);
	assert.equal(scope.run("b", receiver), native.run("b", receiver));
});

test("a scope keeps each run's value through awaits and timers, beside the other scopes", async () => {
	const session = asyncScope<string>();
	const call = asyncScope<number>();
	const seen: string[] = [];
	const read = (where: string) => seen.push(`${where}: ${session.getStore() ?? "-"} ${call.getStore() ?? "-"}`);
	let open!: () => void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	let escaped: Promise<void> | undefined;
	await session.run("s1", async () => {
		read("outer");
		await call.run(1, async () => {
			await sleep(1);
			read("call");
			// Work the call starts and does not wait for: it runs after every scope above has returned.
			escaped = gate.then(() => new Promise<void>((resolve) => setTimeout(resolve, 1))).then(() => read("escaped"));
			await session.run("s2", async () => {
				await sleep(1);
				read("inner");
				await session.run(undefined as unknown as string, async () => read("cleared"));
			});
			read("after inner");
		});
		read("after call");
	});
	read("outside");
	open();
	await escaped;
	assert.deepEqual(seen, [
		"outer: s1 -",
		"call: s1 1",
		"inner: s2 1",
		"cleared: - 1",
		"after inner: s1 1",
		"after call: s1 -",
		"outside: - -",
		"escaped: s1 1",
	]);
});
