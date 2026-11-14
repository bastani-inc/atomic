import assert from "node:assert/strict";
import { inspect } from "node:util";
import { afterEach, test, vi } from "vitest";
import type { StorageConfigError } from "../../packages/coding-agent/src/core/storage/errors.js";
import type { CloudPasswordOptions } from "../../packages/storage-postgres/auth.js";

const MINUTE = 60_000;
const options = { host: "db.example.com", port: 5432, user: "atomic" } as const;

afterEach(() => {
	vi.doUnmock("@azure/identity");
	vi.doUnmock("@aws-sdk/rds-signer");
	vi.doUnmock("google-auth-library");
	vi.resetModules();
	vi.useRealTimers();
});

/** The provider module, loaded after the SDK fakes are registered. */
async function provider(settings: CloudPasswordOptions): Promise<() => Promise<string>> {
	const { createCloudPasswordProvider } = await import("../../packages/storage-postgres/auth.js");
	return createCloudPasswordProvider(settings);
}

interface AzureCall {
	readonly scope: string;
	readonly signal: AbortSignal;
}

/** A fake `@azure/identity` whose `DefaultAzureCredential.getToken` answers with `issue`. */
function fakeAzure(issue: (call: AzureCall) => Promise<{ token: string; expiresOnTimestamp: number } | null>): {
	calls: AzureCall[];
	constructed: () => number;
} {
	const calls: AzureCall[] = [];
	let constructed = 0;
	vi.doMock("@azure/identity", () => ({
		DefaultAzureCredential: class {
			constructor() {
				constructed++;
			}
			getToken(scope: string, { abortSignal }: { abortSignal: AbortSignal }) {
				const call = { scope, signal: abortSignal };
				calls.push(call);
				return issue(call);
			}
		},
	}));
	return { calls, constructed: () => constructed };
}

/** A fake `@aws-sdk/rds-signer` whose `Signer.getAuthToken` answers with `sign`. */
function fakeAws(sign: () => Promise<string>): { configs: object[]; signed: () => number } {
	const configs: object[] = [];
	let signed = 0;
	vi.doMock("@aws-sdk/rds-signer", () => ({
		Signer: class {
			constructor(config: object) {
				configs.push(config);
			}
			getAuthToken() {
				signed++;
				return sign();
			}
		},
	}));
	return { configs, signed: () => signed };
}

/** A fake `google-auth-library` whose `GoogleAuth.getAccessToken` answers with `issue`. */
function fakeGcp(issue: () => Promise<string | null | undefined>): { options: object[]; issued: () => number } {
	const created: object[] = [];
	let issued = 0;
	vi.doMock("google-auth-library", () => ({
		GoogleAuth: class {
			constructor(settings: object) {
				created.push(settings);
			}
			getAccessToken() {
				issued++;
				return issue();
			}
		},
	}));
	return { options: created, issued: () => issued };
}

function useClock(start: number): (ms: number) => void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(start);
	return (ms) => vi.setSystemTime(Date.now() + ms);
}

/**
 * Whether `error` is a `StorageConfigError`. The provider is loaded afresh for each set of SDK fakes, with its own copy
 * of the storage module, so `instanceof` against this file's copy cannot tell.
 */
function isConfigError(error: unknown): error is StorageConfigError {
	return error instanceof Error && error.name === "StorageConfigError";
}

/** The error the reader rejects with, checked to be an `auth-unavailable` refusal that shows none of `secrets`. */
async function failure(password: () => Promise<string>, secrets: readonly string[] = []): Promise<StorageConfigError> {
	const error = await password().then(
		() => assert.fail("expected the reader to reject"),
		(rejection: Error) => rejection,
	);
	assert.ok(isConfigError(error), inspect(error));
	assert.equal(error.field, "auth");
	assert.equal(error.reason, "auth-unavailable");
	const rendered = inspect(error, { depth: null });
	for (const secret of secrets) assert.equal(rendered.includes(secret), false, `error leaks ${secret}: ${rendered}`);
	return error;
}

test("Azure Entra asks DefaultAzureCredential for the database scope and reuses the token until 5 minutes before it expires (#4793)", async () => {
	const advance = useClock(Date.UTC(2026, 10, 14, 12));
	let issued = 0;
	const azure = fakeAzure(async () => ({ token: `entra-${++issued}`, expiresOnTimestamp: Date.now() + 60 * MINUTE }));
	const password = await provider({ ...options, auth: "azure-entra" });

	assert.equal(await password(), "entra-1");
	advance(55 * MINUTE - 1);
	assert.equal(await password(), "entra-1");
	advance(1);
	assert.equal(await password(), "entra-2");
	assert.deepEqual(
		azure.calls.map((call) => call.scope),
		["https://ossrdbms-aad.database.windows.net/.default", "https://ossrdbms-aad.database.windows.net/.default"],
	);
	assert.equal(azure.constructed(), 1, "one credential serves every connection");
});

test("AWS RDS IAM signs a token with the RDS Signer for each connection, in the region the host names (#4793)", async () => {
	let signed = 0;
	const aws = fakeAws(async () => `rds-token-${++signed}`);
	const host = "atomic.cluster-abc.eu-west-2.rds.amazonaws.com";
	const password = await provider({ host, port: 6432, user: "atomic", auth: "aws-iam" });

	assert.equal(await password(), "rds-token-1");
	assert.equal(await password(), "rds-token-2");
	assert.deepEqual(aws.configs, [{ hostname: host, port: 6432, username: "atomic", region: "eu-west-2" }]);
});

test("AWS RDS IAM leaves the region to the SDK unless an RDS host name gives one (#4793)", async () => {
	const aws = fakeAws(async () => "token");
	const hosts: [string, string | undefined][] = [
		["db.abc.us-gov-west-1.rds.amazonaws.com", "us-gov-west-1"],
		["db.abc.cn-north-1.rds.amazonaws.com.cn", "cn-north-1"],
		["db.abc.ap-southeast-12.rds.amazonaws.com", "ap-southeast-12"],
		["db.abc.us-east-1.rds.amazonaws.com.example.org", undefined],
		["proxy.internal", undefined],
	];
	for (const [host] of hosts) await (await provider({ host, port: 5432, user: "atomic", auth: "aws-iam" }))();
	assert.deepEqual(
		aws.configs.map((config) => (config as { region?: string }).region),
		hosts.map(([, region]) => region),
	);
});

test("GCP Cloud SQL IAM asks GoogleAuth for a sqlservice.login token for each connection (#4793)", async () => {
	let issued = 0;
	const gcp = fakeGcp(async () => `ya29.token-${++issued}`);
	const password = await provider({ ...options, auth: "gcp-iam" });

	assert.equal(await password(), "ya29.token-1");
	assert.equal(await password(), "ya29.token-2");
	assert.deepEqual(gcp.options, [{ scopes: ["https://www.googleapis.com/auth/sqlservice.login"] }]);
});

test("concurrent new connections share one token request (#4793)", async () => {
	let release: (token: string) => void = () => {};
	const gcp = fakeGcp(() => new Promise((resolve) => (release = resolve)));
	const password = await provider({ ...options, auth: "gcp-iam" });
	const readers = Promise.all([password(), password(), password()]);
	await vi.waitFor(() => assert.equal(gcp.issued(), 1));
	release("ya29.shared");
	assert.deepEqual(await readers, ["ya29.shared", "ya29.shared", "ya29.shared"]);
	assert.equal(gcp.issued(), 1);
});

/** Makes `name` fail to import, as a package that is not installed does. */
function uninstalled(name: string): void {
	vi.doMock(name, () => {
		throw Object.assign(new Error(`Cannot find package '${name}'`), { code: "ERR_MODULE_NOT_FOUND" });
	});
}

test("a missing SDK names the package and how to install it, and is tried again next time (#4793)", async () => {
	const expected = {
		"azure-entra": ["@azure/identity", "4.14.1"],
		"aws-iam": ["@aws-sdk/rds-signer", "3.1169.0"],
		"gcp-iam": ["google-auth-library", "11.3.4"],
	} as const;
	for (const [auth, [name, version]] of Object.entries(expected) as [
		keyof typeof expected,
		readonly [string, string],
	][]) {
		uninstalled(name);
		const error = await failure(await provider({ ...options, auth }));
		assert.ok(
			error.message.includes(`${auth} auth needs the optional package ${name}, which could not be loaded (`),
			error.message,
		);
		assert.ok(error.message.includes(`\`atomic install npm:${name}@${version}\``), error.message);
		assert.ok(error.message.includes(`\`npm install ${name}@${version}\``), error.message);
	}
	const password = await provider({ ...options, auth: "gcp-iam" });
	await failure(password);
	vi.doUnmock("google-auth-library");
	fakeGcp(async () => "ya29.installed");
	assert.equal(await password(), "ya29.installed");
});

test("an SDK failure is reported on one bounded line with credentials and issued tokens redacted (#4793)", async () => {
	const advance = useClock(Date.UTC(2026, 10, 14, 12));
	const opaque = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
	let calls = 0;
	fakeAzure(async () => {
		if (++calls === 1) return { token: "short-tok", expiresOnTimestamp: Date.now() + 6 * MINUTE };
		throw new Error(
			`ChainedTokenCredential authentication failed.\n  ManagedIdentityCredential: assertion ${opaque} rejected\n  AzureCliCredential: token short-tok expired ${"x ".repeat(200)}`,
		);
	});
	const password = await provider({ ...options, auth: "azure-entra" });
	await password();
	advance(2 * MINUTE);
	const error = await failure(password, [opaque, "short-tok"]);
	assert.match(
		error.message,
		/azure-entra found no token \(ChainedTokenCredential authentication failed\. ManagedIdentityCredential: assertion \[redacted\] rejected AzureCliCredential: token \[redacted\] expired x x /,
	);
	assert.match(error.message, /…\)\. Run where DefaultAzureCredential finds an identity/);
	assert.equal(error.message.includes("\n"), false);
});

test("each cloud's failure says what to do (#4793)", async () => {
	fakeAws(() => Promise.reject(new Error("Could not load credentials from any providers")));
	assert.equal(
		(await failure(await provider({ ...options, auth: "aws-iam" }))).hint,
		"aws-iam found no token (Could not load credentials from any providers). Give the AWS SDK credentials (instance profile, IRSA, AWS_* variables or a profile) allowed `rds-db:connect` for this user",
	);
	fakeGcp(() => Promise.reject("Could not load the default credentials"));
	assert.equal(
		(await failure(await provider({ ...options, auth: "gcp-iam" }))).hint,
		"gcp-iam found no token (Could not load the default credentials). Run where Application Default Credentials find a service account that is a Cloud SQL IAM user, or run `gcloud auth application-default login`",
	);
	fakeAzure(() => Promise.reject(new Error("")));
	assert.equal(
		(await failure(await provider({ ...options, auth: "azure-entra" }))).hint,
		"azure-entra found no token (no reason given). Run where DefaultAzureCredential finds an identity (managed identity, AKS workload identity, AZURE_* variables, or `az login`), and grant it a database role",
	);
});

test("an SDK that answers without a token is refused (#4793)", async () => {
	fakeAzure(async () => null);
	fakeAws(async () => "");
	fakeGcp(async () => null);
	for (const auth of ["azure-entra", "aws-iam", "gcp-iam"] as const)
		assert.match(
			(await failure(await provider({ ...options, auth }))).message,
			/found no token \(returned no token\)/,
		);
	vi.doMock("@azure/identity", () => ({
		DefaultAzureCredential: class {
			getToken = async () => ({ token: "", expiresOnTimestamp: 0 });
		},
	}));
	vi.resetModules();
	assert.match((await failure(await provider({ ...options, auth: "azure-entra" }))).message, /returned no token/);
});

test("a token request is bounded by timeoutMs and aborted when it runs out (#4793)", async () => {
	const azure = fakeAzure(() => new Promise(() => {}));
	const started = performance.now();
	const error = await failure(await provider({ ...options, auth: "azure-entra", timeoutMs: 200 }));
	assert.match(error.message, /azure-entra found no token \(timed out after 200 ms\)/);
	assert.equal(azure.calls[0].signal.aborted, true);
	// A 200 ms bound; a ceiling well short of a hang, with headroom for a loaded machine.
	assert.ok(performance.now() - started < 5_000);
});

test("a failed request is not reused: the next connection asks again (#4793)", async () => {
	let ready = false;
	fakeGcp(async () => {
		if (!ready) throw new Error("metadata server unavailable");
		return "ya29.recovered";
	});
	const password = await provider({ ...options, auth: "gcp-iam" });
	await failure(password);
	ready = true;
	assert.equal(await password(), "ya29.recovered");
});

test("cloud auth needs a host and a user, and says which is missing (#4793)", async () => {
	for (const [host, user, missing] of [
		["", "atomic", "host"],
		["db.example.com", "", "user"],
	])
		await assert.rejects(provider({ host, port: 5432, user, auth: "aws-iam" }), (error: StorageConfigError) => {
			assert.ok(isConfigError(error), inspect(error));
			assert.equal(error.reason, "invalid-auth-target");
			assert.equal(error.hint, `aws-iam auth needs a ${missing} in the URL`);
			return true;
		});
});
