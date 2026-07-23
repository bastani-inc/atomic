import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../..");

test("session cleanup retires old OAuth waiters before same-server replacement auth", () => {
  const fixtureDir = mkdtempSync(join(repoRoot, ".mcp-oauth-reset-"));
  try {
    const authFlowUrl = new URL("../../packages/mcp/mcp-auth-flow.js", import.meta.url).href;
    const callbackUrl = new URL("../../packages/mcp/mcp-callback-server.js", import.meta.url).href;
    const providerUrl = new URL("../../packages/mcp/mcp-oauth-provider.js", import.meta.url).href;
    const authStoreUrl = new URL("../../packages/mcp/mcp-auth.js", import.meta.url).href;
    const script = `
import { mock } from "bun:test";
const fixtureDir = ${JSON.stringify(fixtureDir)};
let browserLaunchCount = 0;
mock.module("open", () => ({ default: async () => { browserLaunchCount += 1; } }));
process.env.MCP_OAUTH_DIR = fixtureDir + "/auth";
const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
process.env.MCP_OAUTH_CALLBACK_PORT = String(probe.port);
await probe.stop(true);
let registrations = 0;
let tokenRequests = 0;
let serverUrl = "";
const oauthServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.includes(".well-known/oauth-protected-resource")) {
      return Response.json({ resource: serverUrl, authorization_servers: [oauthServer.url.origin], scopes_supported: ["read"] });
    }
    if (url.pathname.includes(".well-known/oauth-authorization-server")) {
      return Response.json({
        issuer: oauthServer.url.origin,
        authorization_endpoint: oauthServer.url.origin + "/authorize",
        token_endpoint: oauthServer.url.origin + "/token",
        registration_endpoint: oauthServer.url.origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      registrations += 1;
      const metadata = await request.json();
      return Response.json({ client_id: "test-client", redirect_uris: metadata.redirect_uris, token_endpoint_auth_method: "none" }, { status: 201 });
    }
    if (url.pathname === "/token") {
      tokenRequests += 1;
      return Response.json({ access_token: "fresh-token", token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  },
});
serverUrl = oauthServer.url.origin + "/mcp";
const { authenticate, shutdownOAuth } = await import(${JSON.stringify(authFlowUrl)});
const { getPendingAuthCount, isCallbackServerRunning } = await import(${JSON.stringify(callbackUrl)});
const { getOAuthCallbackPort } = await import(${JSON.stringify(providerUrl)});
const { getOAuthState } = await import(${JSON.stringify(authStoreUrl)});
const waitFor = async (label, predicate) => {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for " + label);
    await Bun.sleep(5);
  }
};
const browserLaunches = () => browserLaunchCount;
try {
  const old = authenticate("same-server", serverUrl);
  const oldJoiner = authenticate("same-server", serverUrl);
  await waitFor("old callback", () => getPendingAuthCount() === 1 && browserLaunches() === 1);
  const oldState = getOAuthState("same-server");
  if (!oldState) throw new Error("old OAuth state was not stored");

  const oldResultsPromise = Promise.allSettled([old, oldJoiner]);
  let oldSettled = false;
  void oldResultsPromise.then(() => { oldSettled = true; });
  await shutdownOAuth("session_restart");
  const oldSettledAfterCleanup = oldSettled;
  const pendingAfterCleanup = getPendingAuthCount();
  const callbackRunningAfterCleanup = isCallbackServerRunning();
  const fresh = authenticate("same-server", serverUrl);
  const freshJoiner = authenticate("same-server", serverUrl);
  await waitFor("fresh callback", () => getPendingAuthCount() === 1 && browserLaunches() === 2);
  const freshState = getOAuthState("same-server");
  if (!freshState) throw new Error("fresh OAuth state was not stored");
  const response = await fetch("http://localhost:" + getOAuthCallbackPort() + "/callback?code=fresh-code&state=" + encodeURIComponent(freshState));
  const freshResults = await Promise.all([fresh, freshJoiner]);
  const oldResults = await oldResultsPromise;
  const oldMessages = oldResults.map((result) => result.status === "rejected" && result.reason instanceof Error ? result.reason.message : "resolved");
  console.log(JSON.stringify({ oldMessages, oldSettledAfterCleanup, pendingAfterCleanup, callbackRunningAfterCleanup, oldState, freshState, freshResults, pending: getPendingAuthCount(), browserLaunches: browserLaunches(), registrations, tokenRequests, callbackStatus: response.status }));
} finally {
  await shutdownOAuth("test_cleanup");
  await oauthServer.stop(true);
}
`;
    const result = spawnSync("bun", ["--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
      oldMessages: string[];
      oldSettledAfterCleanup: boolean;
      pendingAfterCleanup: number;
      callbackRunningAfterCleanup: boolean;
      oldState: string;
      freshState: string;
      freshResults: string[];
      pending: number;
      browserLaunches: number;
      registrations: number;
      tokenRequests: number;
      callbackStatus: number;
    };
    assert.equal(output.oldSettledAfterCleanup, true, "cleanup must settle retired callers before returning");
    assert.equal(output.pendingAfterCleanup, 0, "cleanup must remove every retired callback waiter");
    assert.equal(output.callbackRunningAfterCleanup, false, "cleanup must stop the retired callback server");
    assert.equal(output.oldMessages.length, 2);
    for (const message of output.oldMessages) {
      assert.match(message, /session.*restart|reset.*retry/i);
    }
    assert.notEqual(output.oldState, output.freshState);
    assert.deepEqual(output.freshResults, ["authenticated", "authenticated"]);
    assert.equal(output.pending, 0);
    assert.equal(output.browserLaunches, 2, "each lifecycle should start one shared browser flow");
    assert.equal(output.registrations, 2, "each lifecycle should register only its one producer");
    assert.equal(output.tokenRequests, 1);
    assert.equal(output.callbackStatus, 200);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("reset drains callback startup before replacement authentication publishes a fresh server", () => {
  const fixtureDir = mkdtempSync(join(repoRoot, ".mcp-oauth-startup-drain-"));
  try {
    const authFlowUrl = new URL("../../packages/mcp/mcp-auth-flow.js", import.meta.url).href;
    const callbackUrl = new URL("../../packages/mcp/mcp-callback-server.js", import.meta.url).href;
    const providerUrl = new URL("../../packages/mcp/mcp-oauth-provider.js", import.meta.url).href;
    const authStoreUrl = new URL("../../packages/mcp/mcp-auth.js", import.meta.url).href;
    const script = `
import { mock } from "bun:test";
import * as realHttp from "node:http";
const events = [];
let releaseFirstPublication;
const firstPublicationGate = new Promise((resolve) => { releaseFirstPublication = resolve; });
let markFirstListening;
const firstListening = new Promise((resolve) => { markFirstListening = resolve; });
let serverCount = 0;
const realCreateServer = realHttp.createServer;
const mockedHttp = {
  ...realHttp,
  createServer(...args) {
    const candidate = realCreateServer(...args);
    const id = ++serverCount;
    const listen = candidate.listen.bind(candidate);
    candidate.listen = (...listenArgs) => {
      const callbackIndex = listenArgs.findIndex((value) => typeof value === "function");
      const callback = listenArgs[callbackIndex];
      listenArgs[callbackIndex] = () => {
        events.push("listening:" + id);
        if (id === 1) {
          markFirstListening();
          void firstPublicationGate.then(() => {
            events.push("publish:" + id);
            callback();
          });
        } else {
          events.push("publish:" + id);
          callback();
        }
      };
      return listen(...listenArgs);
    };
    const close = candidate.close.bind(candidate);
    candidate.close = (callback) => {
      events.push("close:" + id);
      return close(callback);
    };
    return candidate;
  },
};
mock.module("http", () => mockedHttp);
mock.module("node:http", () => mockedHttp);
mock.module("open", () => ({ default: async () => { events.push("browser"); } }));
const fixtureDir = ${JSON.stringify(fixtureDir)};
process.env.MCP_OAUTH_DIR = fixtureDir + "/auth";
const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
process.env.MCP_OAUTH_CALLBACK_PORT = String(probe.port);
await probe.stop(true);
let serverUrl = "";
const oauthServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.includes(".well-known/oauth-protected-resource")) {
      return Response.json({ resource: serverUrl, authorization_servers: [oauthServer.url.origin] });
    }
    if (url.pathname.includes(".well-known/oauth-authorization-server")) {
      return Response.json({
        issuer: oauthServer.url.origin,
        authorization_endpoint: oauthServer.url.origin + "/authorize",
        token_endpoint: oauthServer.url.origin + "/token",
        registration_endpoint: oauthServer.url.origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      const metadata = await request.json();
      events.push("register");
      return Response.json({ client_id: "test-client", redirect_uris: metadata.redirect_uris, token_endpoint_auth_method: "none" }, { status: 201 });
    }
    if (url.pathname === "/token") {
      events.push("token");
      return Response.json({ access_token: "fresh-token", token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  },
});
serverUrl = oauthServer.url.origin + "/mcp";
const { authenticate, shutdownOAuth } = await import(${JSON.stringify(authFlowUrl)});
const { getPendingAuthCount, isCallbackServerRunning } = await import(${JSON.stringify(callbackUrl)});
const { getOAuthCallbackPort } = await import(${JSON.stringify(providerUrl)});
const { getOAuthState } = await import(${JSON.stringify(authStoreUrl)});
const waitFor = async (label, predicate) => {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for " + label + ": " + events.join(","));
    await Bun.sleep(2);
  }
};
try {
  const old = authenticate("same-server", serverUrl);
  await firstListening;
  const oldResult = old.then(
    () => "resolved",
    (error) => error instanceof Error ? error.message : String(error),
  );
  let cleanupSettled = false;
  const cleanup = shutdownOAuth("session_restart").then(() => { cleanupSettled = true; events.push("cleanup"); });
  const fresh = authenticate("same-server", serverUrl);
  let freshSettled = false;
  void fresh.then(() => { freshSettled = true; }, () => { freshSettled = true; });
  await oldResult;
  await Bun.sleep(20);
  const blocked = { cleanupSettled, freshSettled, serverCount, events: [...events] };
  releaseFirstPublication();
  await cleanup;
  await waitFor("fresh callback", () => getPendingAuthCount() === 1 && events.includes("browser"));
  const freshState = getOAuthState("same-server");
  if (!freshState) throw new Error("fresh OAuth state was not stored");
  const response = await fetch("http://localhost:" + getOAuthCallbackPort() + "/callback?code=fresh-code&state=" + encodeURIComponent(freshState));
  const freshResult = await fresh;
  const beforeFinalStop = { running: isCallbackServerRunning(), serverCount, events: [...events] };
  await shutdownOAuth("test_cleanup");
  console.log(JSON.stringify({ blocked, freshResult, callbackStatus: response.status, beforeFinalStop, events, oldMessage: await oldResult }));
} finally {
  await shutdownOAuth("test_finally");
  await oauthServer.stop(true);
}
`;
    const result = spawnSync("bun", ["--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
      blocked: { cleanupSettled: boolean; freshSettled: boolean; serverCount: number; events: string[] };
      freshResult: string;
      callbackStatus: number;
      beforeFinalStop: { running: boolean; serverCount: number; events: string[] };
      events: string[];
      oldMessage: string;
    };
    assert.equal(output.blocked.cleanupSettled, false, "cleanup must wait for the actual old producer");
    assert.equal(output.blocked.freshSettled, false);
    assert.equal(output.blocked.serverCount, 1, "replacement startup must wait behind teardown");
    assert.deepEqual(output.blocked.events, ["listening:1"]);
    assert.match(output.oldMessage, /session.*restart|reset.*retry/i);
    assert.equal(output.freshResult, "authenticated");
    assert.equal(output.callbackStatus, 200);
    assert.equal(output.beforeFinalStop.running, true);
    assert.equal(output.beforeFinalStop.serverCount, 2);
    assert.deepEqual(output.beforeFinalStop.events.slice(0, 6), [
      "listening:1", "publish:1", "close:1", "cleanup", "listening:2", "publish:2",
    ]);
    assert.equal(output.events.filter((event) => event === "close:1").length, 1);
    assert.equal(output.events.filter((event) => event === "close:2").length, 1);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}, 20_000);
