import assert from "node:assert/strict";
import { once } from "node:events";
import { closeSync, constants, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRuntime } from "../../src/core/model-runtime.js";

const [mode, dir] = process.argv.slice(2);
assert.ok(dir);
const modelsPath = join(dir, "models.json");
const provider = "github-copilot";
const id = "account-new";
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let accountReads = 0;
globalThis.fetch = async (input) => {
	const path = new URL(input instanceof Request ? input.url : input).pathname;
	if (path === "/catalog/api.json") return new Response(null, { status: 404 });
	if (path !== "/account/models") throw new Error(`Unexpected request: ${path}`);
	accountReads++;
	if (mode === "reader") {
		entered.resolve();
		await release.promise;
		throw new Error("An ordinary listing should not request the account");
	}
	if (mode === "account-fifo") {
		renameSync(join(dir, "auth.json"), join(dir, "original"));
		renameSync(join(dir, "next.fifo"), join(dir, "auth.json"));
	} else assert.equal(mode, "writer");
	return Response.json({
		data: [{ id, model_picker_enabled: true, capabilities: { type: "chat", supports: { tool_calls: true } } }],
	});
};
const runtime = await ModelRuntime.create({
	authPath: join(dir, "auth.json"),
	modelsPath,
	catalogBaseUrl: "http://127.0.0.1:9/catalog",
	modelRefreshTimeoutMs: mode === "fifo" ? 120 : 30_000,
});
if (mode === "borrowed") {
	const borrow = async () => {
		const credentials = AuthStorage.inMemory();
		const owner = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		return {
			refresh: owner.getProvider(provider)?.refreshModels,
			owner: new WeakRef(owner),
			credentials: new WeakRef(credentials),
		};
	};
	const borrowed = await borrow();
	for (let i = 0; i < 12; i++) {
		await setImmediate();
		Bun.gc(true);
	}
	assert.equal(borrowed.refresh?.name, "refreshModels");
	console.log(JSON.stringify({ runtime: !!borrowed.owner.deref(), credentials: !!borrowed.credentials.deref() }));
} else if (mode === "account-fifo") {
	const { createAgentSession } = await import("../../src/core/sdk.js");
	const { SessionManager } = await import("../../src/core/session-manager.js");
	const { SettingsManager } = await import("../../src/core/settings-manager.js");
	const { session } = await createAgentSession({
		agentDir: dir,
		cwd: dir,
		modelRuntime: runtime,
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ defaultProvider: provider, defaultModel: id }),
	});
	try {
		// An independent registration refresh may read its own credentials. Finish it before measuring the lookup.
		await runtime.whenRegistrationRefreshesSettled();
		await assert.rejects(session.prompt("hello"), { code: "no_usable_model" });
		let credentialRead = false;
		try {
			const fd = openSync(join(dir, "auth.json"), constants.O_WRONLY | constants.O_NONBLOCK);
			try {
				credentialRead = true;
				writeSync(fd, "{}");
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
		}
		console.log(JSON.stringify({ accountReads, credentialRead }));
	} finally {
		renameSync(join(dir, "original"), join(dir, "auth.json"));
		await session.dispose();
	}
} else if (mode === "fifo") {
	renameSync(join(dir, "next.fifo"), modelsPath);
	const rows = await runtime.getAvailable("openrouter");
	assert.ok(rows.some((model) => model.provider === "openrouter"));
	// A nonblocking writer fails with ENXIO unless a config read is holding the FIFO open.
	let configRead = false;
	try {
		const fd = openSync(modelsPath, constants.O_WRONLY | constants.O_NONBLOCK);
		try {
			configRead = true;
			writeSync(fd, "{}");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
	}
	console.log(JSON.stringify({ configRead }));
} else if (mode === "reader") {
	const listing = runtime.getAvailable(provider);
	await Promise.race([listing, entered.promise]);
	console.log("reader ready");
	await once(process.stdin, "data");
	process.stdin.pause();
	release.resolve();
	await listing;
	console.log(JSON.stringify({ accountReads }));
} else if (mode === "writer") {
	const result = await runtime.refresh({ providers: [provider], allowNetwork: true, force: true });
	assert.deepEqual([...result.errors.values()], []);
	assert.equal(accountReads, 1);
	assert.equal(runtime.getModel(provider, id)?.id, id);
} else {
	assert.equal(mode, "reopen");
	assert.equal(runtime.getModel(provider, id)?.id, id);
	assert.deepEqual(runtime.getCredentialSnapshot(provider)?.availableModelIds, [id]);
}
