import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";
import { jobBlock } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const publishPath = join(root, ".github/workflows/publish.yml");
const TOKEN = "oidc-secret-token-value";
const AUDIENCE = "https%3A%2F%2Fatomic-version-adoption.bastani-atomic.workers.dev%2Fv1%2Fpublished-versions";
const ENDPOINT_HOST = "https://atomic-version-adoption.bastani-atomic.workers.dev/v1/published-versions";
const OIDC_URL = "https://vstoken.actions.githubusercontent.com/_apis/oidc/token";

let workspaces: string[] = [];

afterEach(() => {
	for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
	workspaces = [];
});

function registrationScript(workflow: string): string {
	const job = jobBlock(workflow, "register-published-version", "cleanup-draft-github-release");
	const marker = "        run: |\n";
	const start = job.indexOf(marker);
	assert.notEqual(start, -1, "register-published-version must have a run block");
	return job.slice(start + marker.length).replace(/^ {10}/gm, "");
}

function writeExecutable(path: string, source: string): void {
	writeFileSync(path, source);
	chmodSync(path, 0o755);
}

function runRegistration(options: {
	version?: string;
	oidcCodes?: string[];
	oidcBodies?: string[];
	registerCodes?: string[];
	requestUrl?: string;
}): { exitCode: number; stdout: string; stderr: string; curlLog: string[]; sleepLog: string[] } {
	const dir = mkdtempSync(join(tmpdir(), "atomic-register-version-"));
	workspaces.push(dir);
	const bin = join(dir, "bin");
	const state = join(dir, "state");
	mkdirSync(bin);
	mkdirSync(state);
	const curlLog = join(state, "curl.log");
	const sleepLog = join(state, "sleep.log");
	writeFileSync(curlLog, "");
	writeFileSync(sleepLog, "");
	writeFileSync(join(state, "oidc.count"), "0");
	writeFileSync(join(state, "oidc-body.count"), "0");
	writeFileSync(join(state, "register.count"), "0");
	writeFileSync(join(state, "oidc-codes.json"), JSON.stringify(options.oidcCodes ?? ["200"]));
	writeFileSync(
		join(state, "oidc-bodies.json"),
		JSON.stringify(options.oidcBodies ?? [`{"value":${JSON.stringify(TOKEN)}}`]),
	);
	writeFileSync(join(state, "register-codes.json"), JSON.stringify(options.registerCodes ?? ["204"]));
	writeExecutable(
		join(bin, "curl"),
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = ${JSON.stringify(state)};
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(state, "curl.log"), JSON.stringify(argv) + "\\n");
const output = argv.includes("--output") ? argv[argv.indexOf("--output") + 1] : undefined;
const writeOut = argv.includes("--write-out") ? argv[argv.indexOf("--write-out") + 1] : undefined;
const url = argv.find((arg) => typeof arg === "string" && arg.startsWith("http")) || "";
function take(countFile, valuesFile) {
	const n = Number(fs.readFileSync(countFile, "utf8"));
	fs.writeFileSync(countFile, String(n + 1));
	const values = JSON.parse(fs.readFileSync(valuesFile, "utf8"));
	return values[Math.min(n, values.length - 1)];
}
if (url.includes("audience=")) {
	const code = take(path.join(state, "oidc.count"), path.join(state, "oidc-codes.json"));
	const body = take(path.join(state, "oidc-body.count"), path.join(state, "oidc-bodies.json"));
	if (output && output !== "/dev/null") fs.writeFileSync(output, body);
	if (writeOut === "%{http_code}") process.stdout.write(String(code));
	process.exit(code === "000" ? 6 : 0);
}
const code = take(path.join(state, "register.count"), path.join(state, "register-codes.json"));
if (output && output !== "/dev/null") fs.writeFileSync(output, "");
if (writeOut === "%{http_code}") process.stdout.write(String(code));
process.exit(code === "000" ? 6 : 0);
`,
	);
	writeExecutable(
		join(bin, "sleep"),
		`#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(sleepLog)}
`,
	);

	const workflow = readFileSync(publishPath, "utf8");
	const scriptPath = join(dir, "register.sh");
	writeFileSync(scriptPath, registrationScript(workflow.replaceAll("\r\n", "\n")));
	chmodSync(scriptPath, 0o755);
	const result = spawnSyncCollect(["bash", scriptPath], {
		env: {
			...process.env,
			PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
			VERSION: options.version ?? "0.9.20",
			ACTIONS_ID_TOKEN_REQUEST_URL: options.requestUrl ?? OIDC_URL,
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
		},
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
		curlLog: readFileSync(curlLog, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => line),
		sleepLog: readFileSync(sleepLog, "utf8").trim().split("\n").filter(Boolean),
	};
}

test("registration client posts the exact audience and version and succeeds on 204", () => {
	const result = runRegistration({ version: "0.9.20" });
	assert.equal(result.exitCode, 0, result.stderr);
	assert.match(result.stdout, /::add-mask::oidc-secret-token-value/);
	assert.equal(result.sleepLog.length, 0);
	const calls = result.curlLog.map((line) => JSON.parse(line) as string[]);
	assert.equal(calls.length, 2);
	assert.ok(calls[0]?.some((arg) => arg.includes(`audience=${AUDIENCE}`)));
	assert.ok(calls[0]?.includes("--max-redirs"));
	assert.ok(calls[0]?.includes("0"));
	assert.ok(!calls[0]?.includes("-L"));
	assert.ok(calls[1]?.includes("-X"));
	assert.ok(calls[1]?.includes("POST"));
	assert.ok(calls[1]?.some((arg) => arg === `${ENDPOINT_HOST}?version=0.9.20`));
	assert.ok(calls[1]?.includes("Authorization: Bearer oidc-secret-token-value"));
	assert.doesNotMatch(result.stderr, /oidc-secret-token-value/);
});

test("registration client accepts alpha.REVISION versions", () => {
	const result = runRegistration({ version: "0.9.20-alpha.1" });
	assert.equal(result.exitCode, 0, result.stderr);
	const calls = result.curlLog.map((line) => JSON.parse(line) as string[]);
	assert.ok(calls[1]?.some((arg) => arg === `${ENDPOINT_HOST}?version=0.9.20-alpha.1`));
});

test("registration client retries curl 000 then succeeds", () => {
	const result = runRegistration({
		version: "0.9.20",
		registerCodes: ["000", "204"],
	});
	assert.equal(result.exitCode, 0, result.stderr);
	assert.deepEqual(result.sleepLog, ["4"]);
	assert.equal(result.curlLog.length, 4);
});

test("registration client retries OIDC transport 000 then succeeds", () => {
	const result = runRegistration({
		oidcCodes: ["000", "200"],
		oidcBodies: ["", `{"value":${JSON.stringify(TOKEN)}}`],
	});
	assert.equal(result.exitCode, 0, result.stderr);
	assert.deepEqual(result.sleepLog, ["4"]);
});

test("registration client treats HTTP 401 as terminal and does not retry", () => {
	const result = runRegistration({ registerCodes: ["401"] });
	assert.equal(result.exitCode, 1);
	assert.match(result.stderr, /Registration failed with HTTP 401/);
	assert.equal(result.sleepLog.length, 0);
	assert.equal(result.curlLog.length, 2);
});

test("registration client rejects a redirect status without following it", () => {
	const result = runRegistration({ registerCodes: ["302"] });
	assert.equal(result.exitCode, 1);
	assert.match(result.stderr, /Registration failed with HTTP 302/);
	assert.equal(result.sleepLog.length, 0);
});

test("registration client rejects a non-string OIDC token without printing it", () => {
	const result = runRegistration({
		oidcBodies: ['{"value":123}'],
		oidcCodes: ["200"],
	});
	assert.equal(result.exitCode, 1);
	assert.match(result.stderr, /OIDC token acquisition failed/);
	assert.doesNotMatch(result.stdout, /123/);
	assert.doesNotMatch(result.stderr, /123/);
	assert.doesNotMatch(result.stdout, /::add-mask::/);
	assert.doesNotMatch(result.stdout, /oidc-secret-token-value/);
	assert.doesNotMatch(result.stderr, /oidc-secret-token-value/);
	assert.equal(result.curlLog.length, 1);
});

test("registration client rejects a non-GitHub OIDC request URL before any network call", () => {
	const result = runRegistration({
		requestUrl: "https://oidc.example.invalid/token",
	});
	assert.equal(result.exitCode, 1);
	assert.match(result.stderr, /OIDC request URL is not a GitHub Actions token endpoint/);
	assert.equal(result.curlLog.length, 0);
	assert.doesNotMatch(result.stdout, /::add-mask::/);
});

test("registration client rejects http, userinfo, and suffix-confused OIDC request URLs", () => {
	for (const requestUrl of [
		"http://vstoken.actions.githubusercontent.com/_apis/oidc/token",
		"https://user:pass@vstoken.actions.githubusercontent.com/_apis/oidc/token",
		"https://actions.githubusercontent.com.evil.example/_apis/oidc/token",
		"https://example.com/_apis/oidc/token",
	]) {
		const result = runRegistration({ requestUrl });
		assert.equal(result.exitCode, 1, requestUrl);
		assert.match(result.stderr, /OIDC request URL is not a GitHub Actions token endpoint/);
		assert.equal(result.curlLog.length, 0, requestUrl);
	}
});

test("registration client accepts the GitHub token-acquisition host even when it equals the JWT issuer host", () => {
	const result = runRegistration({
		requestUrl: "https://token.actions.githubusercontent.com/_apis/idtoken/github",
	});
	assert.equal(result.exitCode, 0, result.stderr);
	assert.equal(result.curlLog.length, 2);
});

test("registration client refuses 0.0.0 before any network call", () => {
	const result = runRegistration({ version: "0.0.0" });
	assert.equal(result.exitCode, 1);
	assert.match(result.stderr, /Refusing 0\.0\.0/);
	assert.equal(result.curlLog.length, 0);
});
