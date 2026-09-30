import assert from "node:assert/strict";
import { inspect } from "node:util";
import { type OAuthClientProvider, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, test, vi } from "vitest";
import { getOAuthState } from "../../packages/mcp/mcp-auth.js";
import { authenticate, completeAuth, shutdownOAuth, startAuth } from "../../packages/mcp/mcp-auth-flow.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const browser = vi.hoisted(() => ({ url: "https://example.com/authorize", open: vi.fn() }));
vi.mock("open", () => ({ default: browser.open }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@modelcontextprotocol/sdk/client/auth.js")>()),
	auth: async (provider: OAuthClientProvider) => {
		await provider.redirectToAuthorization(new URL(browser.url));
		return "REDIRECT";
	},
}));
afterEach(async () => {
	await shutdownOAuth();
	vi.unstubAllEnvs();
	browser.open.mockReset();
});

// Regression for #3088: manual login instructions retain the complete authorization URL.
test("MCP browser failure retains non-sensitive manual URL without a raw cause", async () => {
	const dir = makeTempDirectory("mcp-browser-diagnostics-");
	vi.stubEnv("MCP_OAUTH_DIR", dir);
	const { authorizationUrl } = await startAuthorization("https://example.com", {
		clientInformation: { client_id: "public" },
		redirectUrl: "http://127.0.0.1:19823/callback",
		state: "a7b93f010fd67b927558e1aeb0562340",
		scope: "read",
	});
	assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
	assert.ok(authorizationUrl.searchParams.get("code_challenge"));
	browser.url = authorizationUrl.href;
	browser.open.mockRejectedValue(new Error("browser stderr containing PRIVATE_CAUSE"));
	try {
		await assert.rejects(authenticate("browser", "https://example.com/mcp"), (error: Error) => {
			assert.ok(error.message.includes(`Please open this URL manually: ${browser.url}`));
			assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /PRIVATE_CAUSE/);
			return true;
		});
		assert.equal(browser.open.mock.calls[0]?.[0], browser.url);
		assert.equal(getOAuthState("browser"), undefined);
		await assert.rejects(completeAuth("browser", "unused"), /No pending OAuth flow/);
	} finally {
		await shutdownOAuth();
		removeTempDirectory(dir);
	}
});

// Regression for #3088: intentional login instructions include credentials, unlike diagnostics.
test("MCP browser failure and startAuth both retain complete credential-bearing URLs", async () => {
	const dir = makeTempDirectory("mcp-browser-secrets-");
	vi.stubEnv("MCP_OAUTH_DIR", dir);
	browser.open.mockRejectedValue(new Error("browser stderr containing PRIVATE_CAUSE"));
	try {
		for (const url of [
			"https://user:PRIVATE_PASSWORD@example.com/authorize",
			"https://example.com/authorize?token=PRIVATE_TOKEN",
			"https://example.com/authorize?resource=https%3A%2F%2Fexample.com%2Fmcp%3Fkey%3DPRIVATE_KEY",
			"https://example.com/authorize#PRIVATE_FRAGMENT",
		]) {
			browser.url = url;
			assert.equal((await startAuth("manual", "https://example.com/mcp")).authorizationUrl, url);
			await assert.rejects(authenticate("browser", "https://example.com/mcp"), (error: Error) => {
				assert.equal(error.message, `Could not open browser. Please open this URL manually: ${url}`);
				assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /PRIVATE_CAUSE/);
				return true;
			});
			assert.equal(browser.open.mock.lastCall?.[0], url);
		}
	} finally {
		await shutdownOAuth();
		removeTempDirectory(dir);
	}
});

// Regression for #3088: the SDK can carry configured endpoint credentials in resource.
test("MCP browser failure retains SDK resource credentials in manual instructions", async () => {
	const dir = makeTempDirectory("mcp-browser-resource-");
	vi.stubEnv("MCP_OAUTH_DIR", dir);
	const endpoint = "https://example.com/mcp?PRIVATE_TOKEN=";
	const { authorizationUrl } = await startAuthorization("https://example.com", {
		clientInformation: { client_id: "public" },
		redirectUrl: "http://127.0.0.1:19823/callback",
		state: "ordinary-state",
		resource: new URL(endpoint),
	});
	browser.url = authorizationUrl.href;
	browser.open.mockRejectedValue(new Error("PRIVATE_CAUSE"));
	try {
		assert.equal((await startAuth("manual", endpoint)).authorizationUrl, browser.url);
		await assert.rejects(authenticate("browser", endpoint), (error: Error) => {
			assert.equal(error.message, `Could not open browser. Please open this URL manually: ${browser.url}`);
			assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /PRIVATE_CAUSE/);
			return true;
		});
		assert.equal(browser.open.mock.lastCall?.[0], browser.url);
	} finally {
		await shutdownOAuth();
		removeTempDirectory(dir);
	}
});

// Regression for #3088: credential overlap must not alter intentional OAuth instructions.
test("MCP browser failure retains configured credential overlap", async () => {
	const dir = makeTempDirectory("mcp-browser-overlap-");
	vi.stubEnv("MCP_OAUTH_DIR", dir);
	browser.open.mockRejectedValue(new Error("PRIVATE_CAUSE"));
	try {
		for (const [endpoint, authorizationPath, state] of [
			["https://example.com/PRIVATE_PATH_TOKEN/mcp", "/PRIVATE_PATH_TOKEN/authorize", "ordinary-state"],
			["https://example.com/PRIVATE%2fPATH/mcp", "/PRIVATE%2FPATH/authorize", "ordinary-state"],
			["https://example.com/PRIVATE%2FPATH/mcp", "/authorize", "PRIVATE/PATH"],
			["https://example.com/mcp?PRIVATE_KEY=", "/authorize", "PRIVATE_KEY"],
			["https://example.com/mcp?key=PRIVATE+VALUE", "/authorize", "PRIVATE VALUE"],
		]) {
			const { authorizationUrl } = await startAuthorization("https://example.com", {
				clientInformation: { client_id: "public" },
				redirectUrl: "http://127.0.0.1:19823/callback",
				state,
			});
			authorizationUrl.pathname = authorizationPath!;
			browser.url = authorizationUrl.href;
			assert.equal((await startAuth("manual", endpoint!)).authorizationUrl, browser.url);
			await assert.rejects(authenticate("browser", endpoint!), (error: Error) => {
				assert.equal(error.message, `Could not open browser. Please open this URL manually: ${browser.url}`);
				assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /PRIVATE_CAUSE/);
				return true;
			});
			assert.equal(browser.open.mock.lastCall?.[0], browser.url);
		}
	} finally {
		await shutdownOAuth();
		removeTempDirectory(dir);
	}
});

// Regression for #3088: resolved origins and public routing words retain manual instructions.
for (const [endpoint, path, clientId] of [
	[`\${RISK_ORIGIN}/mcp`, "/authorize", "public"],
	["$env:RISK_ORIGIN/mcp", "/authorize", "public"],
	[`https://example.com/\${RISK_TOKEN}/mcp`, "/PRIVATE_INTERPOLATED_CREDENTIAL/authorize", "public"],
	// Regression for #3088: a substitution may appear without its configured prefix.
	[`https://example.com/access-\${RISK_TOKEN}/mcp`, "/PRIVATE_INTERPOLATED_CREDENTIAL/authorize", "public"],
	["https://example.com/mcp", "/authorize", "mcp"],
	["https://example.com/mcp", "/mcp/authorize", "public"],
	["https://example.com/api/v2/my-service", "/api/v2/my-service/authorize", "my-service"],
]) {
	test(`MCP browser fallback uses resolved endpoint and public routing: ${endpoint} ${path} ${clientId}`, async () => {
		const dir = makeTempDirectory("mcp-browser-resolved-");
		vi.stubEnv("MCP_OAUTH_DIR", dir);
		vi.stubEnv("RISK_ORIGIN", "https://example.com");
		vi.stubEnv("RISK_TOKEN", "PRIVATE_INTERPOLATED_CREDENTIAL");
		const { authorizationUrl } = await startAuthorization("https://example.com", {
			clientInformation: { client_id: clientId! },
			redirectUrl: "http://127.0.0.1:19823/callback",
			state: "ordinary-state",
		});
		authorizationUrl.pathname = path!;
		browser.url = authorizationUrl.href;
		browser.open.mockImplementation(async () => {
			vi.stubEnv("RISK_TOKEN", "CHANGED_AFTER_DISCOVERY");
			throw new Error("PRIVATE_CAUSE");
		});
		try {
			await assert.rejects(authenticate("browser", endpoint!), (error: Error) => {
				assert.equal(error.message, `Could not open browser. Please open this URL manually: ${browser.url}`);
				assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /PRIVATE_CAUSE/);
				return true;
			});
			assert.equal(browser.open.mock.lastCall?.[0], browser.url);
		} finally {
			await shutdownOAuth();
			removeTempDirectory(dir);
		}
	});
}

// Regression for #3088: environment mutation must not change the SDK URL shown to the user.
test("MCP browser fallback retains an interpolated path word using the attempt snapshot", async () => {
	const dir = makeTempDirectory("mcp-browser-word-");
	vi.stubEnv("MCP_OAUTH_DIR", dir);
	vi.stubEnv("RISK_TOKEN", "private");
	const { authorizationUrl } = await startAuthorization("https://example.com", {
		clientInformation: { client_id: "public" },
		redirectUrl: "http://127.0.0.1:19823/callback",
		state: "ordinary-state",
	});
	authorizationUrl.pathname = "/private/authorize";
	browser.url = authorizationUrl.href;
	browser.open.mockImplementation(async () => {
		vi.stubEnv("RISK_TOKEN", "changed");
		throw new Error("PRIVATE_CAUSE");
	});
	try {
		await assert.rejects(authenticate("browser", `https://example.com/\${RISK_TOKEN}/mcp`), (error: Error) => {
			assert.equal(error.message, `Could not open browser. Please open this URL manually: ${browser.url}`);
			assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /PRIVATE_CAUSE/);
			return true;
		});
	} finally {
		await shutdownOAuth();
		removeTempDirectory(dir);
	}
});

test("joined MCP sign-ins receive the pending authorization URL (#10186)", async () => {
	const dir = makeTempDirectory("mcp-browser-join-");
	vi.stubEnv("MCP_OAUTH_DIR", dir);
	const notices: string[] = [];
	let opened!: () => void;
	const opening = new Promise<void>((resolve) => {
		opened = resolve;
	});
	let failOpen!: (error: Error) => void;
	browser.open.mockImplementation(() => {
		opened();
		return new Promise<void>((_resolve, reject) => {
			failOpen = reject;
		});
	});
	const first = authenticate("joined", "https://example.com/mcp", undefined, (url) => notices.push(`first:${url}`));
	const failure = assert.rejects(first, /Could not open browser/);
	try {
		await opening;
		const second = authenticate("joined", "https://example.com/mcp", undefined, (url) =>
			notices.push(`second:${url}`),
		);
		assert.equal(first, second);
		assert.deepEqual(notices, [`first:${browser.url}`, `second:${browser.url}`]);
		failOpen(new Error("browser unavailable"));
		await failure;
	} finally {
		await shutdownOAuth();
		removeTempDirectory(dir);
	}
});
