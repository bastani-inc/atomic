import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AtomicOAuthLoginCallbacks } from "../../packages/coding-agent/src/core/oauth-login.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { loginRpcOAuthProvider } from "../../packages/coding-agent/src/modes/rpc/rpc-oauth-client.ts";
import type { RpcModelCatalog } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { bunExecutable, moduleDir } from "../helpers/runtime.js";

test.sequential("real isolated child discovers and acquires engine-only custom OAuth", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-engine-oauth-"));
	const agentDir = join(temp, "agent");
	const logFile = join(temp, "oauth.log");
	const callbackLog: string[] = [];
	const client = new RpcClient({
		cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
		cwd: join(moduleDir(import.meta.url), "../.."),
		runtimeExecutable: bunExecutable(),
		env: { ATOMIC_CODING_AGENT_DIR: agentDir, ATOMIC_CUSTOM_OAUTH_LOG: logFile },
		args: [
			"--no-session",
			"--no-extensions",
			"--extension",
			join(moduleDir(import.meta.url), "fixtures", "custom-oauth-extension.ts"),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--offline",
		],
		interactiveEngine: { onDiagnostic: () => {} },
	});
	try {
		await client.start();
		await client.waitForInteractiveEngineBound();
		const before = await client.requestInternal<RpcModelCatalog>({ type: "get_available_models" });
		assert.deepEqual(
			before.oauthProviders?.find(({ id }) => id === "corp-oauth"),
			{
				id: "corp-oauth",
				name: "Corp OAuth",
				loginLabel: "Sign in to Corp",
				usesCallbackServer: true,
			},
		);
		assert.equal(
			before.oauthProviders?.some(({ id }) => id === "openrouter"),
			true,
		);
		assert.equal(
			before.oauthProviders?.some(({ id }) => id === "kimi-coding"),
			true,
		);
		assert.equal(JSON.stringify(before).includes("engine-token"), false);
		const refreshesBeforeLogin = existsSync(logFile)
			? (readFileSync(logFile, "utf8").match(/^refresh:/gm)?.length ?? 0)
			: 0;
		const callbacks: AtomicOAuthLoginCallbacks = {
			onAuth: ({ url }) => callbackLog.push(`auth:${url}`),
			onDeviceCode: ({ userCode }) => callbackLog.push(`device:${userCode}`),
			onProgress: (message) => callbackLog.push(`progress:${message}`),
			onInfo: (message) => callbackLog.push(`info:${message}`),
			onPrompt: async () => {
				callbackLog.push("prompt");
				return "acme";
			},
			onSelect: async () => {
				callbackLog.push("select");
				return "primary";
			},
			onManualCodeInput: async () => {
				callbackLog.push("manual");
				return "code";
			},
		};
		const result = await loginRpcOAuthProvider(client, "corp-oauth", callbacks);
		assert.equal(result.cancelled, false);
		assert.deepEqual(callbackLog, [
			"auth:https://corp.invalid/login",
			"device:CORP-CODE",
			"progress:waiting",
			"info:corp-info",
			"prompt",
			"select",
			"manual",
		]);
		assert.equal(
			result.cancelled
				? false
				: result.models.some(({ provider, id }) => provider === "corp-oauth" && id === "corp-model"),
			true,
		);
		assert.equal(JSON.stringify(result).includes("engine-token"), false);
		const engineLog = readFileSync(logFile, "utf8");
		assert.match(engineLog, new RegExp(`engine:(?!${process.pid}\\b)\\d+`));
		assert.equal(engineLog.match(/^refresh:/gm)?.length ?? 0, refreshesBeforeLogin);
		assert.match(readFileSync(join(agentDir, "auth.json"), "utf8"), /engine-token-acme-primary-code/);
		const logout = await client.logoutProvider("corp-oauth");
		assert.equal(
			logout.models.some(({ provider }) => provider === "corp-oauth"),
			false,
		);
		assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8").includes("corp-oauth"), false);
	} finally {
		await client.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 20_000);
