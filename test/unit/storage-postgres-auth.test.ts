import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { StorageConfigError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { createCloudPasswordProvider } from "../../packages/storage-postgres/auth.js";

const MINUTE = 60_000;
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	while (cleanups.length > 0) await cleanups.pop()?.();
});

interface FakeCli {
	readonly dir: string;
	/** The argument lists of every invocation, in order. */
	calls(): string[][];
	/** How many invocations ran to completion. */
	finished(): number;
}

/**
 * Fake `az`, `aws` and `gcloud` executables on an otherwise empty PATH. Each prints `stdout`, writes `stderr`, exits
 * with `exitCode`, after `delayMs`, and records its arguments.
 */
function fakeCli(
	commands: Record<string, { stdout?: string; stderr?: string; exitCode?: number; delayMs?: number }>,
): FakeCli {
	const dir = mkdtempSync(join(tmpdir(), "atomic-pg-auth-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "calls.jsonl");
	writeFileSync(log, "");
	for (const [name, behaviour] of Object.entries(commands)) {
		const script = join(dir, `${name}.mjs`);
		writeFileSync(
			script,
			`import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const behaviour = ${JSON.stringify(behaviour)};
setTimeout(() => {
	if (behaviour.stdout) process.stdout.write(behaviour.stdout);
	if (behaviour.stderr) process.stderr.write(behaviour.stderr);
	process.exitCode = behaviour.exitCode ?? 0;
	appendFileSync(${JSON.stringify(log)}, JSON.stringify(["finished"]) + "\\n");
}, behaviour.delayMs ?? 0);
`,
		);
		if (process.platform === "win32") {
			writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
		} else {
			writeFileSync(join(dir, name), `#!${process.execPath}\nimport(${JSON.stringify(script)});\n`);
			chmodSync(join(dir, name), 0o755);
		}
	}
	vi.stubEnv("PATH", dir);
	const entries = () =>
		readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string[]);
	return {
		dir,
		calls: () => entries().filter((entry) => entry[0] !== "finished"),
		finished: () => entries().filter((entry) => entry[0] === "finished").length,
	};
}

interface FakeServer {
	readonly origin: string;
	readonly host: string;
	readonly requests: { url: string; method: string; headers: IncomingMessage["headers"]; body: string }[];
}

async function fakeServer(
	respond: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<FakeServer> {
	const requests: FakeServer["requests"] = [];
	const server: Server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			requests.push({ url: request.url ?? "", method: request.method ?? "", headers: request.headers, body });
			respond(request, response, body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const { port } = server.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, requests };
}

function json(response: ServerResponse, status: number, body: object): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

/** A local port nothing listens on, so a metadata request is refused at once. */
async function closedOrigin(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `127.0.0.1:${port}`;
}

/** Isolates a test from the developer's real cloud environment. */
async function noAmbientCloud(): Promise<void> {
	const closed = await closedOrigin();
	for (const name of [
		"AZURE_FEDERATED_TOKEN_FILE",
		"AZURE_CLIENT_ID",
		"AZURE_TENANT_ID",
		"AZURE_AUTHORITY_HOST",
		"IDENTITY_ENDPOINT",
		"IDENTITY_HEADER",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
	])
		vi.stubEnv(name, undefined);
	vi.stubEnv("AZURE_POD_IDENTITY_AUTHORITY_HOST", `http://${closed}`);
	vi.stubEnv("GCE_METADATA_HOST", closed);
	vi.stubEnv("PATH", "");
}

function useClock(start: number): (ms: number) => void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(start);
	return (ms) => vi.setSystemTime(Date.now() + ms);
}

function rejectsWithoutSecrets(error: Error, secrets: readonly string[], reason = "auth-unavailable"): true {
	assert.ok(error instanceof StorageConfigError, `expected StorageConfigError, got ${error}`);
	assert.equal(error.field, "auth");
	assert.equal(error.reason, reason);
	const text = `${error.message}\n${error.stack}\n${error.hint ?? ""}\n${String(error.cause)}`;
	for (const secret of secrets) assert.equal(text.includes(secret), false, `error text leaks ${secret}`);
	return true;
}

const options = { host: "db.example.com", port: 5432, user: "atomic" } as const;

test("Azure Entra takes the managed identity token from IMDS and caches it until 5 minutes before expiry (#4793)", async () => {
	await noAmbientCloud();
	let issued = 0;
	const imds = await fakeServer((_request, response) => {
		issued++;
		json(response, 200, {
			access_token: `imds-token-${issued}`,
			expires_on: String(Math.floor(Date.now() / 1000) + 60 * 60),
			resource: "https://ossrdbms-aad.database.windows.net",
		});
	});
	vi.stubEnv("AZURE_POD_IDENTITY_AUTHORITY_HOST", imds.origin);
	vi.stubEnv("AZURE_CLIENT_ID", "user-assigned-id");
	const advance = useClock(Date.UTC(2026, 10, 14, 12));
	const password = createCloudPasswordProvider({ ...options, auth: "azure-entra" });

	assert.equal(await password(), "imds-token-1");
	advance(54 * MINUTE);
	assert.equal(await password(), "imds-token-1");
	advance(2 * MINUTE);
	assert.equal(await password(), "imds-token-2");

	assert.equal(imds.requests.length, 2);
	const url = new URL(imds.requests[0].url, imds.origin);
	assert.equal(url.pathname, "/metadata/identity/oauth2/token");
	assert.equal(url.searchParams.get("resource"), "https://ossrdbms-aad.database.windows.net");
	assert.equal(url.searchParams.get("client_id"), "user-assigned-id");
	assert.equal(url.searchParams.get("api-version"), "2018-02-01");
	assert.equal(imds.requests[0].headers.metadata, "true");
});

test("Azure Entra falls back to `az account get-access-token --resource-type oss-rdbms` and honours expires_on (#4793)", async () => {
	await noAmbientCloud();
	const expiresOn = Math.floor(Date.UTC(2026, 10, 14, 12, 20) / 1000);
	const cli = fakeCli({
		az: {
			stdout: JSON.stringify({
				accessToken: "az-cli-token",
				expiresOn: "2026-11-14 12:20:00.000000",
				expires_on: expiresOn,
			}),
		},
	});
	const advance = useClock(Date.UTC(2026, 10, 14, 12));
	const password = createCloudPasswordProvider({ ...options, auth: "azure-entra" });

	assert.equal(await password(), "az-cli-token");
	advance(14 * MINUTE);
	assert.equal(await password(), "az-cli-token");
	assert.equal(cli.calls().length, 1);
	advance(2 * MINUTE);
	await password();
	assert.equal(cli.calls().length, 2);
	assert.deepEqual(cli.calls()[0].slice(0, 5), [
		"account",
		"get-access-token",
		"--resource-type",
		"oss-rdbms",
		"--output",
	]);
});

test("Azure Entra exchanges an AKS workload identity token for a database token (#4793)", async () => {
	await noAmbientCloud();
	const authority = await fakeServer((_request, response) =>
		json(response, 200, { access_token: "workload-token", expires_in: 3600, token_type: "Bearer" }),
	);
	const dir = mkdtempSync(join(tmpdir(), "atomic-pg-federated-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "token"), "federated-assertion\n");
	vi.stubEnv("AZURE_FEDERATED_TOKEN_FILE", join(dir, "token"));
	vi.stubEnv("AZURE_CLIENT_ID", "client-1");
	vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
	vi.stubEnv("AZURE_AUTHORITY_HOST", `${authority.origin}/`);

	assert.equal(await createCloudPasswordProvider({ ...options, auth: "azure-entra" })(), "workload-token");
	const [request] = authority.requests;
	assert.equal(request.method, "POST");
	assert.equal(request.url, "/tenant-1/oauth2/v2.0/token");
	const form = new URLSearchParams(request.body);
	assert.equal(form.get("client_assertion"), "federated-assertion");
	assert.equal(form.get("client_id"), "client-1");
	assert.equal(form.get("scope"), "https://ossrdbms-aad.database.windows.net/.default");
	assert.equal(form.get("grant_type"), "client_credentials");
	assert.equal(form.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
	assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
});

test("Azure Entra uses the App Service and Container Apps identity endpoint when one is set (#4793)", async () => {
	await noAmbientCloud();
	const endpoint = await fakeServer((_request, response) =>
		json(response, 200, {
			access_token: "app-service-token",
			expires_on: String(Math.floor(Date.now() / 1000) + 3600),
		}),
	);
	vi.stubEnv("IDENTITY_ENDPOINT", `${endpoint.origin}/msi/token`);
	vi.stubEnv("IDENTITY_HEADER", "identity-header-secret");

	assert.equal(await createCloudPasswordProvider({ ...options, auth: "azure-entra" })(), "app-service-token");
	const url = new URL(endpoint.requests[0].url, endpoint.origin);
	assert.equal(url.pathname, "/msi/token");
	assert.equal(url.searchParams.get("resource"), "https://ossrdbms-aad.database.windows.net");
	assert.equal(url.searchParams.get("api-version"), "2019-08-01");
	assert.equal(url.searchParams.get("client_id"), null);
	assert.equal(endpoint.requests[0].headers["x-identity-header"], "identity-header-secret");
});

test("AWS RDS IAM generates a token with the CLI for the host, port, user and region, cached for its 15-minute life less 5 (#4793)", async () => {
	await noAmbientCloud();
	const host = "atomic.cluster-abc.eu-west-2.rds.amazonaws.com";
	const token = `${host}:5432/?Action=connect&DBUser=atomic&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261114T120000Z&X-Amz-Expires=900&X-Amz-Signature=deadbeef`;
	const cli = fakeCli({ aws: { stdout: `${token}\n` } });
	const advance = useClock(Date.UTC(2026, 10, 14, 12));
	const password = createCloudPasswordProvider({ host, port: 5432, user: "atomic", auth: "aws-iam" });

	assert.equal(await password(), token);
	advance(9 * MINUTE);
	await password();
	assert.equal(cli.calls().length, 1);
	advance(2 * MINUTE);
	await password();
	assert.equal(cli.calls().length, 2);
	assert.deepEqual(cli.calls()[0], [
		"rds",
		"generate-db-auth-token",
		"--hostname",
		host,
		"--port",
		"5432",
		"--username",
		"atomic",
		"--region",
		"eu-west-2",
	]);
});

test("AWS RDS IAM leaves the region to the CLI's own configuration when the host does not name one (#4793)", async () => {
	await noAmbientCloud();
	const cli = fakeCli({ aws: { stdout: "proxy.internal:5432/?Action=connect&X-Amz-Signature=abc\n" } });
	await createCloudPasswordProvider({ host: "proxy.internal", port: 6432, user: "atomic", auth: "aws-iam" })();
	assert.deepEqual(cli.calls()[0].slice(-2), ["--username", "atomic"]);
});

test("GCP Cloud SQL IAM takes the access token from the metadata server, cached until 5 minutes before expiry (#4793)", async () => {
	await noAmbientCloud();
	let issued = 0;
	const metadata = await fakeServer((_request, response) => {
		issued++;
		json(response, 200, { access_token: `ya29.metadata-${issued}`, expires_in: 3599, token_type: "Bearer" });
	});
	vi.stubEnv("GCE_METADATA_HOST", metadata.host);
	const advance = useClock(Date.UTC(2026, 10, 14, 12));
	const password = createCloudPasswordProvider({ ...options, auth: "gcp-iam" });

	assert.equal(await password(), "ya29.metadata-1");
	advance(54 * MINUTE);
	assert.equal(await password(), "ya29.metadata-1");
	advance(MINUTE);
	assert.equal(await password(), "ya29.metadata-2");
	assert.equal(metadata.requests[0].url, "/computeMetadata/v1/instance/service-accounts/default/token");
	assert.equal(metadata.requests[0].headers["metadata-flavor"], "Google");
});

test("GCP Cloud SQL IAM falls back to `gcloud auth print-access-token` and refreshes it after a minute (#4793)", async () => {
	await noAmbientCloud();
	const cli = fakeCli({ gcloud: { stdout: "ya29.gcloud-token\n" } });
	const advance = useClock(Date.UTC(2026, 10, 14, 12));
	const password = createCloudPasswordProvider({ ...options, auth: "gcp-iam" });

	assert.equal(await password(), "ya29.gcloud-token");
	advance(59_000);
	await password();
	assert.equal(cli.calls().length, 1);
	advance(2_000);
	await password();
	assert.equal(cli.calls().length, 2);
	assert.deepEqual(cli.calls()[0], ["auth", "print-access-token"]);
});

test("concurrent new connections share one token fetch (#4793)", async () => {
	await noAmbientCloud();
	const cli = fakeCli({ gcloud: { stdout: "ya29.shared\n", delayMs: 100 } });
	const password = createCloudPasswordProvider({ ...options, auth: "gcp-iam" });
	assert.deepEqual(await Promise.all([password(), password(), password()]), [
		"ya29.shared",
		"ya29.shared",
		"ya29.shared",
	]);
	assert.equal(cli.calls().length, 1);
});

test("a failure is reported per source with the CLI's reason, typed and without credentials (#4793)", async () => {
	await noAmbientCloud();
	fakeCli({
		az: {
			stderr:
				"ERROR: AADSTS700024 assertion eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl expired. Run 'az login'.\nTraceback secret-line\n",
			exitCode: 1,
		},
	});
	await assert.rejects(createCloudPasswordProvider({ ...options, auth: "azure-entra" })(), (error: Error) => {
		rejectsWithoutSecrets(error, ["eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl", "secret-line"]);
		assert.match(error.message, /azure-entra/);
		assert.match(error.message, /managed identity/);
		assert.match(error.message, /AADSTS700024/);
		assert.match(error.message, /az login/);
		return true;
	});
});

test("a missing CLI and an unreachable metadata server name each source tried (#4793)", async () => {
	await noAmbientCloud();
	await assert.rejects(createCloudPasswordProvider({ ...options, auth: "gcp-iam" })(), (error: Error) => {
		rejectsWithoutSecrets(error, []);
		assert.match(error.message, /metadata server/);
		assert.match(error.message, /`gcloud` was not found on PATH/);
		return true;
	});
	await assert.rejects(createCloudPasswordProvider({ ...options, auth: "aws-iam" })(), (error: Error) => {
		rejectsWithoutSecrets(error, []);
		assert.match(error.message, /`aws` was not found on PATH/);
		return true;
	});
});

test("output a provider cannot parse is refused without echoing it (#4793)", async () => {
	await noAmbientCloud();
	fakeCli({ az: { stdout: "not json eyJleaked-token-text" } });
	await assert.rejects(createCloudPasswordProvider({ ...options, auth: "azure-entra" })(), (error: Error) =>
		rejectsWithoutSecrets(error, ["eyJleaked-token-text", "not json"]),
	);
	const imds = await fakeServer((_request, response) => json(response, 200, { access_token: "" }));
	vi.stubEnv("AZURE_POD_IDENTITY_AUTHORITY_HOST", imds.origin);
	await assert.rejects(createCloudPasswordProvider({ ...options, auth: "azure-entra" })(), (error: Error) =>
		rejectsWithoutSecrets(error, []),
	);
});

test("an HTTP error from a metadata endpoint reports its status and description, not its body (#4793)", async () => {
	await noAmbientCloud();
	const imds = await fakeServer((_request, response) =>
		json(response, 400, { error: "invalid_request", error_description: "Identity not found", leaked: "body-secret" }),
	);
	vi.stubEnv("AZURE_POD_IDENTITY_AUTHORITY_HOST", imds.origin);
	await assert.rejects(createCloudPasswordProvider({ ...options, auth: "azure-entra" })(), (error: Error) => {
		rejectsWithoutSecrets(error, ["body-secret"]);
		assert.match(error.message, /HTTP 400: Identity not found/);
		return true;
	});
});

test("each source is bounded by timeoutMs (#4793)", async () => {
	await noAmbientCloud();
	const hanging = await fakeServer(() => {});
	vi.stubEnv("GCE_METADATA_HOST", hanging.host);
	fakeCli({ gcloud: { stdout: "ya29.late\n", delayMs: 10_000 } });
	const started = performance.now();
	await assert.rejects(
		createCloudPasswordProvider({ ...options, auth: "gcp-iam", timeoutMs: 300 })(),
		(error: Error) => {
			rejectsWithoutSecrets(error, ["ya29.late"]);
			assert.match(error.message, /metadata server: timed out after 300 ms/);
			assert.match(error.message, /gcloud CLI: timed out after 300 ms/);
			return true;
		},
	);
	// Two 300 ms bounds; a generous ceiling that still fails long before the fake CLI's 10 s answer.
	assert.ok(performance.now() - started < 5_000);
});

test("a failed fetch is not cached: the next connection tries again (#4793)", async () => {
	await noAmbientCloud();
	let ready = false;
	const metadata = await fakeServer((_request, response) =>
		ready ? json(response, 200, { access_token: "ya29.recovered", expires_in: 3600 }) : json(response, 503, {}),
	);
	vi.stubEnv("GCE_METADATA_HOST", metadata.host);
	const password = createCloudPasswordProvider({ ...options, auth: "gcp-iam" });
	await assert.rejects(password(), StorageConfigError);
	ready = true;
	assert.equal(await password(), "ya29.recovered");
});

test("a host or user name a CLI could misread is refused before anything runs (#4793)", async () => {
	await noAmbientCloud();
	const cli = fakeCli({ aws: { stdout: "token\n" } });
	for (const [host, user] of [
		["db.example.com & calc", "atomic"],
		["db.example.com", "atomic|whoami"],
		["--debug", "atomic"],
		["db.example.com", ""],
	]) {
		assert.throws(
			() => createCloudPasswordProvider({ host, port: 5432, user, auth: "aws-iam" }),
			(error: Error) => rejectsWithoutSecrets(error, [], "invalid-auth-target"),
		);
	}
	assert.equal(cli.calls().length, 0);
});

/** The hint of the error a provider's reader rejects with. */
async function failureHint(password: () => Promise<string>): Promise<string> {
	const error = await password().then(
		() => assert.fail("expected the reader to reject"),
		(rejection: Error) => rejection,
	);
	rejectsWithoutSecrets(error, []);
	return (error as StorageConfigError).hint ?? "";
}

test("each cloud's failure names every source tried, its reason, and what to do (#4793)", async () => {
	await noAmbientCloud();
	fakeCli({ az: { exitCode: 2 }, gcloud: { stdout: "  \n" } });
	assert.equal(
		await failureHint(createCloudPasswordProvider({ ...options, auth: "azure-entra" })),
		"azure-entra found no token (managed identity (IMDS): unreachable (ECONNREFUSED); az CLI: exited with code 2: no output). " +
			"Run on an Azure host with a managed identity or AKS workload identity, or sign in with `az login`, and grant that principal a database role",
	);
	const metadata = await fakeServer((_request, response) => {
		response.writeHead(503);
		response.end("unavailable <html>");
	});
	vi.stubEnv("GCE_METADATA_HOST", metadata.host);
	assert.equal(
		await failureHint(createCloudPasswordProvider({ ...options, auth: "gcp-iam" })),
		"gcp-iam found no token (metadata server: HTTP 503; gcloud CLI: returned no token). " +
			"Run on Google Cloud with a service account that is a Cloud SQL IAM user, or sign in with `gcloud auth login`",
	);
	assert.equal(
		await failureHint(createCloudPasswordProvider({ ...options, auth: "aws-iam" })),
		"aws-iam found no token (aws CLI: `aws` was not found on PATH). " +
			"Install the AWS CLI v2 and give it credentials (instance profile, IRSA, AWS_* variables or a profile) allowed `rds-db:connect` for this user",
	);
});

test("a CLI failure carries its first stderr line, bounded, with long opaque runs redacted (#4793)", async () => {
	await noAmbientCloud();
	const opaque = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA";
	const nearlyOpaque = "a".repeat(31);
	const long = "word ".repeat(60).trim();
	fakeCli({
		az: { stderr: `\n  ERROR: rejected '${opaque}' near ${nearlyOpaque}\nsecond line\n`, exitCode: 1 },
		gcloud: { stderr: `${long}\n`, exitCode: 1 },
	});
	const azure = await failureHint(createCloudPasswordProvider({ ...options, auth: "azure-entra" }));
	assert.match(
		azure,
		new RegExp(`az CLI: exited with code 1: ERROR: rejected '\\[redacted\\]' near ${nearlyOpaque}\\)`),
	);
	const gcp = await failureHint(createCloudPasswordProvider({ ...options, auth: "gcp-iam" }));
	assert.ok(gcp.includes(`gcloud CLI: exited with code 1: ${long.slice(0, 200)}…)`), gcp);
});

test("output without a usable token or expiry is refused by name (#4793)", async () => {
	await noAmbientCloud();
	const cases: [string, string][] = [
		["null", "returned output that is not a JSON object"],
		["[1]", "returned output that is not a JSON object"],
		[JSON.stringify({ accessToken: 42, expires_on: 2_000_000_000 }), "returned no accessToken"],
		[JSON.stringify({ accessToken: "   ", expires_on: 2_000_000_000 }), "returned no accessToken"],
		[JSON.stringify({ accessToken: "az-token" }), "returned a token without an expiry"],
	];
	for (const [stdout, reason] of cases) {
		fakeCli({ az: { stdout } });
		const hint = await failureHint(createCloudPasswordProvider({ ...options, auth: "azure-entra" }));
		assert.ok(hint.includes(`az CLI: ${reason})`), `${stdout} → ${hint}`);
	}
	const imds = await fakeServer((request, response) =>
		json(
			response,
			200,
			request.url?.includes("client_id") ? { access_token: "t" } : { access_token: "t", expires_on: "0" },
		),
	);
	vi.stubEnv("AZURE_POD_IDENTITY_AUTHORITY_HOST", imds.origin);
	vi.stubEnv("PATH", "");
	vi.stubEnv("AZURE_CLIENT_ID", "missing-expiry");
	assert.match(
		await failureHint(createCloudPasswordProvider({ ...options, auth: "azure-entra" })),
		/managed identity \(IMDS\): returned a token without an expiry;/,
	);
});

test("tokens are trimmed, and the AWS token is its first output line (#4793)", async () => {
	await noAmbientCloud();
	fakeCli({ gcloud: { stdout: "  ya29.padded  \n" }, aws: { stdout: "host:5432/?X-Amz-Signature=1\nnotice\n" } });
	assert.equal(await createCloudPasswordProvider({ ...options, auth: "gcp-iam" })(), "ya29.padded");
	assert.equal(await createCloudPasswordProvider({ ...options, auth: "aws-iam" })(), "host:5432/?X-Amz-Signature=1");
	const imds = await fakeServer((_request, response) =>
		json(response, 200, { access_token: " padded ", expires_in: 3600 }),
	);
	vi.stubEnv("AZURE_POD_IDENTITY_AUTHORITY_HOST", `${imds.origin}//`);
	assert.equal(await createCloudPasswordProvider({ ...options, auth: "azure-entra" })(), "padded");
	assert.equal(new URL(imds.requests[0].url, imds.origin).pathname, "/metadata/identity/oauth2/token");
});

test("older az versions are read from their local-time expiresOn (#4793)", async () => {
	await noAmbientCloud();
	const cli = fakeCli({
		az: {
			stdout: JSON.stringify({ accessToken: "old-az", expiresOn: "2026-11-14 12:20:00.000000", expires_on: "" }),
		},
	});
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 10, 14, 12));
	const password = createCloudPasswordProvider({ ...options, auth: "azure-entra" });
	await password();
	vi.setSystemTime(new Date(2026, 10, 14, 12, 14));
	await password();
	assert.equal(cli.calls().length, 1);
	vi.setSystemTime(new Date(2026, 10, 14, 12, 16));
	await password();
	assert.equal(cli.calls().length, 2);
});

test("a token with 5 minutes or less to live is used once and not cached; the cache ends exactly at its refresh time (#4793)", async () => {
	await noAmbientCloud();
	let lifetimeSeconds = 5 * 60;
	const metadata = await fakeServer((_request, response) =>
		json(response, 200, { access_token: "ya29.short", expires_in: lifetimeSeconds }),
	);
	vi.stubEnv("GCE_METADATA_HOST", metadata.host);
	const advance = useClock(Date.UTC(2026, 10, 14, 12));
	const password = createCloudPasswordProvider({ ...options, auth: "gcp-iam" });
	await password();
	await password();
	assert.equal(metadata.requests.length, 2);
	lifetimeSeconds = 10 * 60;
	await password();
	advance(5 * MINUTE - 1);
	await password();
	assert.equal(metadata.requests.length, 3);
	advance(1);
	await password();
	assert.equal(metadata.requests.length, 4);
});

test("an endpoint error without a description reports its error code (#4793)", async () => {
	await noAmbientCloud();
	const metadata = await fakeServer((_request, response) => json(response, 403, { error: "access_denied" }));
	vi.stubEnv("GCE_METADATA_HOST", metadata.host);
	assert.match(
		await failureHint(createCloudPasswordProvider({ ...options, auth: "gcp-iam" })),
		/metadata server: HTTP 403: access_denied;/,
	);
});

test("Azure uses workload identity only with all three variables, and the identity endpoint only with its header (#4793)", async () => {
	await noAmbientCloud();
	const imds = await fakeServer((_request, response) =>
		json(response, 200, { access_token: "imds", expires_in: 3600 }),
	);
	vi.stubEnv("AZURE_POD_IDENTITY_AUTHORITY_HOST", imds.origin);
	vi.stubEnv("AZURE_FEDERATED_TOKEN_FILE", "/nonexistent/token");
	vi.stubEnv("AZURE_CLIENT_ID", "client-1");
	vi.stubEnv("IDENTITY_ENDPOINT", "http://127.0.0.1:9/msi/token");
	assert.equal(await createCloudPasswordProvider({ ...options, auth: "azure-entra" })(), "imds");
	vi.stubEnv("AZURE_FEDERATED_TOKEN_FILE", undefined);
	vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
	assert.equal(await createCloudPasswordProvider({ ...options, auth: "azure-entra" })(), "imds");
	assert.equal(imds.requests.length, 2);
});

test("Azure passes a user-assigned identity to the App Service endpoint and the authority host without its trailing slashes (#4793)", async () => {
	await noAmbientCloud();
	const endpoint = await fakeServer((_request, response) =>
		json(response, 200, { access_token: "app", expires_in: 3600 }),
	);
	vi.stubEnv("IDENTITY_ENDPOINT", `${endpoint.origin}/msi/token`);
	vi.stubEnv("IDENTITY_HEADER", "header");
	vi.stubEnv("AZURE_CLIENT_ID", "user-assigned");
	await createCloudPasswordProvider({ ...options, auth: "azure-entra" })();
	assert.equal(new URL(endpoint.requests[0].url, endpoint.origin).searchParams.get("client_id"), "user-assigned");

	const dir = mkdtempSync(join(tmpdir(), "atomic-pg-federated-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "token"), "assertion");
	vi.stubEnv("AZURE_FEDERATED_TOKEN_FILE", join(dir, "token"));
	vi.stubEnv("AZURE_TENANT_ID", "tenant/2");
	vi.stubEnv("AZURE_AUTHORITY_HOST", `${endpoint.origin}//`);
	await createCloudPasswordProvider({ ...options, auth: "azure-entra" })();
	assert.equal(endpoint.requests[1].url, "/tenant%2F2/oauth2/v2.0/token");
});

test("AWS takes the region from commercial, GovCloud and China RDS host names only (#4793)", async () => {
	await noAmbientCloud();
	const cli = fakeCli({ aws: { stdout: "token\n" } });
	const hosts: [string, string | undefined][] = [
		["db.abc.us-gov-west-1.rds.amazonaws.com", "us-gov-west-1"],
		["db.abc.cn-north-1.rds.amazonaws.com.cn", "cn-north-1"],
		["db.abc.ap-southeast-12.rds.amazonaws.com", "ap-southeast-12"],
		["db.abc.us-east-1.rds.amazonaws.com.example.org", undefined],
	];
	for (const [host] of hosts)
		await createCloudPasswordProvider({ host, port: 5432, user: "atomic", auth: "aws-iam" })();
	assert.deepEqual(
		cli.calls().map((args) => (args.at(-2) === "--region" ? args.at(-1) : undefined)),
		hosts.map(([, region]) => region),
	);
});

test("a timed-out CLI is stopped, not left running (#4793)", async () => {
	await noAmbientCloud();
	const cli = fakeCli({ gcloud: { stdout: "ya29.late\n", delayMs: 1_500 } });
	await assert.rejects(
		createCloudPasswordProvider({ ...options, auth: "gcp-iam", timeoutMs: 300 })(),
		StorageConfigError,
	);
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	assert.equal(cli.calls().length, 1);
	assert.equal(cli.finished(), 0);
});

test("a refused host or user says what is allowed, and only AWS, which passes them to its CLI, refuses them (#4793)", async () => {
	await noAmbientCloud();
	for (const auth of ["azure-entra", "gcp-iam"] as const)
		createCloudPasswordProvider({ host: "db.example.com", port: 5432, user: "Atomic Writers", auth });
	assert.throws(
		() => createCloudPasswordProvider({ host: "db.example.com", port: 5432, user: "a b", auth: "aws-iam" }),
		(error: StorageConfigError) => {
			assert.equal(
				error.hint,
				'The aws-iam token needs a user without spaces, quotes or shell metacharacters, not starting with "-"',
			);
			return true;
		},
	);
});
