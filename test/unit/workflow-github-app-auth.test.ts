import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import { startWorkflowFleetController } from "../../packages/workflows/src/workers/fleet-controller.js";
import type { WorkflowFleetController } from "../../packages/workflows/src/workers/fleet-types.js";
import {
	type CommandProvisionerOptions,
	createWorkerHostProvisioner,
	WorkerProvisionerError,
} from "../../packages/workflows/src/workers/provisioners/index.js";
import { FAKE_APP_ID, FakeGitHubApp, verifiedJwt } from "../helpers/fake-github-app.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { FakeCloud } from "../helpers/provisioner-conformance.js";
import { sleep } from "../helpers/runtime.js";

const never = () => new AbortController().signal;
/** How long a hung token request lasts before its timeout stops it. */
const HUNG_REQUEST_MS = 300;
const posixOnly = test.skipIf(process.platform === "win32");

const GH_PRESET: CommandProvisionerOptions = {
	kind: "command",
	up: ["gh", "workflow", "run", "atomic-workers.yml", "--repo", "acme/flows", "--ref", "main", "--field", "workers=1"],
	upEach: true,
	down: ["gh", "run", "cancel", "{id}", "--repo", "acme/flows"],
	list: [
		"gh",
		"run",
		"list",
		"--repo",
		"acme/flows",
		"--workflow",
		"atomic-workers.yml",
		"--status",
		"queued",
		"--json",
		"databaseId,status,createdAt",
		"--limit",
		"100",
	],
	listFormat: { id: "databaseId", state: "status", since: "createdAt", states: { queued: "pending", "*": "running" } },
	timeoutMs: 10_000,
};

const APP_ENV = [
	"ATOMIC_GITHUB_APP_ID",
	"ATOMIC_GITHUB_APP_INSTALLATION_ID",
	"ATOMIC_GITHUB_APP_PRIVATE_KEY_FILE",
	"ATOMIC_GITHUB_APP_REPOSITORY",
	"ATOMIC_GITHUB_HOST",
	"ATOMIC_GITHUB_API_URL",
	"GH_TOKEN",
	"FAKE_GH_APP",
];
const savedEnv = new Map(APP_ENV.map((name) => [name, process.env[name]]));
for (const name of APP_ENV) delete process.env[name];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

/** A fake GitHub API and a fake `gh` that accepts only installation tokens. */
async function fixture(prefix = ""): Promise<{ github: FakeGitHubApp; cloud: FakeCloud }> {
	const github = await FakeGitHubApp.start(prefix);
	const cloud = FakeCloud.create("gh");
	cloud.installCli("gh");
	process.env.FAKE_GH_APP = "1";
	cleanups.push(
		() => github.close(),
		() => cloud.dispose(),
	);
	return { github, cloud };
}

function appProvisioner(
	github: FakeGitHubApp,
	githubApp: Record<string, string | number> = {},
	options: Partial<CommandProvisionerOptions> = {},
) {
	return createWorkerHostProvisioner({
		...GH_PRESET,
		auth: { githubApp: { ...github.auth(), ...githubApp } },
		...options,
	});
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof Error, `rejected with a non-Error: ${String(error)}`);
		return error;
	}
	assert.fail("expected a rejection");
}

/** Everything an error carries that could reach a fleet event, the journal or a log. */
function errorText(error: Error): string {
	return [String(error), JSON.stringify(error), error.stack ?? "", String(error.cause ?? "")].join("\n");
}

/** The base64 body of a PEM key: what must never leak, whole or in part. */
function keyBody(pem: string): string[] {
	return pem
		.split("\n")
		.filter((line) => line !== "" && !line.startsWith("-----"))
		.slice(0, 3);
}

describe("GitHub App auth for the command provisioner (#4768)", () => {
	posixOnly(
		"the app JWT is RS256, signed by the app's key, issued 30 s back for 10 minutes, iss the app (#4768)",
		async () => {
			const { github } = await fixture();
			const before = Math.floor(Date.now() / 1000);
			await appProvisioner(github).list(never());
			const after = Math.floor(Date.now() / 1000);
			assert.equal(github.requests.length, 1);
			const jwt = verifiedJwt(github.requests[0]!.jwt!, github.publicKey);
			assert.ok(jwt !== undefined, "the JWT's signature does not verify with the app's public key");
			assert.deepEqual(jwt.header, { alg: "RS256", typ: "JWT" });
			assert.deepEqual(Object.keys(jwt.claims).toSorted(), ["exp", "iat", "iss"]);
			assert.equal(String(jwt.claims.iss), FAKE_APP_ID);
			const iat = jwt.claims.iat as number;
			assert.ok(iat >= before - 30 && iat <= after - 30, `iat ${iat} is not 30 s before ${before}..${after}`);
			assert.equal((jwt.claims.exp as number) - iat, 600, "GitHub refuses a JWT valid for more than 10 minutes");
		},
	);

	posixOnly("the installation token is narrowed to actions: write on the one repository (#4768)", async () => {
		const { github } = await fixture();
		await appProvisioner(github).list(never());
		const [request] = github.requests;
		assert.equal(request!.method, "POST");
		assert.equal(request!.path, "/app/installations/4242/access_tokens");
		assert.equal(request!.headers["x-github-api-version"], "2022-11-28");
		assert.deepEqual(JSON.parse(request!.body), { repositories: ["flows"], permissions: { actions: "write" } });
	});

	posixOnly("a token is reused until 5 minutes before it expires, then minted afresh (#4768)", async () => {
		const { github } = await fixture();
		const fleet = appProvisioner(github);
		await fleet.list(never());
		await fleet.scaleTo(1, never());
		await fleet.list(never());
		assert.equal(github.requests.length, 1, "an hour-long token was minted again");

		github.expiresInMs = 5 * 60_000 + 30_000;
		const later = appProvisioner(github);
		await later.list(never());
		await later.list(never());
		assert.equal(github.requests.length, 2, "a token 5.5 minutes from expiry was not reused");

		github.expiresInMs = 5 * 60_000 - 2_000;
		const expiring = appProvisioner(github);
		await expiring.list(never());
		await expiring.list(never());
		assert.equal(github.requests.length, 4, "a token within 5 minutes of expiry was reused");
	});

	posixOnly("GH_TOKEN reaches only the gh child's environment (#4768)", async () => {
		const { github, cloud } = await fixture();
		process.env.GH_TOKEN = "ambient-user-token";
		const fleet = appProvisioner(github);
		await fleet.scaleTo(1, never());
		const [host] = await fleet.list(never());
		await fleet.drain(host!.id, never());
		assert.equal(process.env.GH_TOKEN, "ambient-user-token");
		const seen = cloud.ghEnv();
		assert.ok(seen.length >= 4);
		for (const env of seen) assert.deepEqual(env, { GH_TOKEN: "ghs_fake1" });
	});

	posixOnly(
		"GitHub Enterprise Server: minted from its API, passed as GH_ENTERPRISE_TOKEN with GH_HOST (#4768)",
		async () => {
			const { github, cloud } = await fixture("/api/v3");
			await appProvisioner(github, { host: "ghe.acme.test" }).list(never());
			assert.equal(github.requests[0]!.path, "/api/v3/app/installations/4242/access_tokens");
			assert.deepEqual(cloud.ghEnv(), [{ GH_ENTERPRISE_TOKEN: "ghs_fake1", GH_HOST: "ghe.acme.test" }]);
		},
	);

	posixOnly("a GHE.com host keeps GH_TOKEN, with GH_HOST (#4768)", async () => {
		const { github, cloud } = await fixture();
		await appProvisioner(github, { host: "acme.ghe.com" }).list(never());
		assert.deepEqual(cloud.ghEnv(), [{ GH_TOKEN: "ghs_fake1", GH_HOST: "acme.ghe.com" }]);
	});

	test("without apiUrl, the API is GitHub's for github.com, api.<host> for GHE.com, <host>/api/v3 otherwise (#4768)", async () => {
		const { github } = await fixture();
		for (const [host, url] of [
			["127.0.0.1:9", "https://127.0.0.1:9/api/v3/app/installations/4242/access_tokens"],
			["localhost.ghe.com:9", "https://api.localhost.ghe.com:9/app/installations/4242/access_tokens"],
		] as const) {
			const { apiUrl: _apiUrl, ...auth } = github.auth();
			const fleet = createWorkerHostProvisioner({ ...GH_PRESET, auth: { githubApp: { ...auth, host } } });
			const error = await rejection(fleet.list(never()));
			assert.ok(error instanceof WorkerProvisionerError);
			assert.equal(error.code, "unavailable");
			assert.ok(error.message.startsWith(`the GitHub App token request to ${url} failed`), error.message);
		}
		const { apiUrl: _apiUrl, ...auth } = github.auth();
		const fleet = createWorkerHostProvisioner({ ...GH_PRESET, auth: { githubApp: auth }, timeoutMs: 1 });
		const error = await rejection(fleet.list(never()));
		assert.match(
			error.message,
			/^the GitHub App token request to https:\/\/api\.github\.com\/app\/installations\/4242\/access_tokens /,
		);
	});

	posixOnly(
		"401, 403, 404 and 422 reject as auth; 429, 5xx and malformed replies degrade; no key leaks (#4768)",
		async () => {
			const { github, cloud } = await fixture();
			const cases: [number, object, WorkerProvisionerError["code"], RegExp][] = [
				[
					401,
					{ message: "A JSON web token could not be decoded" },
					"auth",
					/HTTP 401: A JSON web token could not be decoded/,
				],
				[
					403,
					{ message: "Resource not accessible by integration" },
					"auth",
					/HTTP 403: Resource not accessible by integration/,
				],
				[404, { message: "Not Found" }, "auth", /HTTP 404: Not Found/],
				[422, { message: "The permissions requested are not granted to this installation." }, "auth", /HTTP 422/],
				[429, { message: "API rate limit exceeded" }, "unavailable", /HTTP 429: API rate limit exceeded/],
				[502, { message: "Server Error" }, "unavailable", /HTTP 502: Server Error/],
				[201, { token: 7 }, "malformed", /did not return a token/],
				[201, { token: "ghs_x", expires_at: "soon" }, "malformed", /did not return a token/],
			];
			for (const [status, body, code, message] of cases) {
				github.replies.push({ status, body });
				const error = await rejection(appProvisioner(github).list(never()));
				assert.ok(error instanceof WorkerProvisionerError, String(error));
				assert.equal(error.code, code, `HTTP ${status}`);
				assert.match(error.message, message);
				const text = errorText(error);
				for (const line of keyBody(github.privateKeyPem))
					assert.ok(!text.includes(line), `the key leaked: ${text}`);
				assert.doesNotMatch(text, /eyJ/, "the JWT leaked");
			}
			assert.deepEqual(cloud.calls(), [], "a command ran without a token");
			// Recovered: the next call mints and runs.
			assert.deepEqual(await appProvisioner(github).list(never()), []);
		},
	);

	posixOnly("a token request that hangs is stopped at the timeout, or when the signal aborts (#4768)", async () => {
		const { github } = await fixture();
		github.replies.push("hang");
		const started = Date.now();
		const error = await rejection(appProvisioner(github, {}, { timeoutMs: HUNG_REQUEST_MS }).list(never()));
		assert.ok(error instanceof WorkerProvisionerError);
		assert.equal(error.code, "timeout");
		assert.match(error.message, new RegExp(`did not finish within ${HUNG_REQUEST_MS} ms`));
		assert.ok(Date.now() - started < 5_000);

		github.replies.push("hang");
		const abort = new AbortController();
		const call = rejection(appProvisioner(github, {}, { timeoutMs: HUNG_REQUEST_MS }).list(abort.signal));
		await until(() => github.requests.length === 2);
		const reason = new Error("stopping");
		abort.abort(reason);
		assert.equal(await call, reason);
		// @octokit/auth-app shares a pending request among its callers: let the abandoned one time out before the next test.
		await sleep(2 * HUNG_REQUEST_MS);
	});

	posixOnly("a private key readable by others, missing, or not a key is refused, never quoted (#4768)", async () => {
		const { github, cloud } = await fixture();
		const leaky = `${github.privateKeyFile}.leaky`;
		writeFileSync(leaky, github.privateKeyPem);
		chmodSync(leaky, 0o640);
		const garbage = `${github.privateKeyFile}.garbage`;
		// A PEM block that is not a key; its label is joined so secret scanners do not take it for one.
		const label = ["RSA", "PRIVATE", "KEY"].join(" ");
		const secretish = `-----BEGIN ${label}-----\nTUlJRXBBSUJBQUtDQVFFQXNlY3JldGtleW1hdGVyaWFs\n-----END ${label}-----\n`;
		writeFileSync(garbage, secretish);
		chmodSync(garbage, 0o600);
		const cases: [string, RegExp][] = [
			[leaky, /is readable by other users; restrict it with chmod 600/],
			[`${github.privateKeyFile}.missing`, /cannot be read \(ENOENT\)/],
			[garbage, /is not a PEM private key/],
		];
		for (const [file, message] of cases) {
			const error = await rejection(appProvisioner(github, { privateKeyFile: file }).list(never()));
			assert.ok(error instanceof WorkerProvisionerError);
			assert.equal(error.code, "auth");
			assert.match(error.message, message);
			const text = errorText(error);
			for (const line of [...keyBody(github.privateKeyPem), "TUlJRXBBSUJBQUtDQVFFQXNlY3JldGtleW1hdGVyaWFs"])
				assert.ok(!text.includes(line), `the key leaked: ${text}`);
		}
		assert.equal(github.requests.length, 0);
		assert.deepEqual(cloud.calls(), []);
	});

	test("app settings missing from the configuration come from ATOMIC_GITHUB_* variables (#4768)", async () => {
		const { github } = await fixture();
		const auth = github.auth();
		const missing = () => createWorkerHostProvisioner({ ...GH_PRESET, auth: { githubApp: {} } });
		assert.throws(missing, {
			name: "TypeError",
			message:
				"Invalid command provisioner options: auth.githubApp.appId is required: set it, or ATOMIC_GITHUB_APP_ID.",
		});
		process.env.ATOMIC_GITHUB_APP_ID = auth.appId;
		process.env.ATOMIC_GITHUB_APP_INSTALLATION_ID = auth.installationId;
		process.env.ATOMIC_GITHUB_APP_PRIVATE_KEY_FILE = auth.privateKeyFile;
		assert.throws(missing, {
			message:
				"Invalid command provisioner options: auth.githubApp.repository is required: set it, or ATOMIC_GITHUB_APP_REPOSITORY.",
		});
		process.env.ATOMIC_GITHUB_APP_REPOSITORY = "acme/flows";
		process.env.ATOMIC_GITHUB_API_URL = auth.apiUrl;
		if (process.platform !== "win32") {
			await missing().list(never());
			assert.equal(github.requests[0]!.path, "/app/installations/4242/access_tokens");
		}
		// The configuration wins over the environment.
		process.env.ATOMIC_GITHUB_APP_INSTALLATION_ID = "999";
		if (process.platform !== "win32") {
			await createWorkerHostProvisioner({ ...GH_PRESET, auth: { githubApp: { installationId: 4242 } } }).list(
				never(),
			);
			assert.equal(github.requests[1]!.path, "/app/installations/4242/access_tokens");
		}
	});

	test("bad app settings throw a TypeError naming the option (#4768)", () => {
		const base = { appId: "1", installationId: "2", privateKeyFile: "/k.pem", repository: "acme/flows" };
		const cases: [object, string][] = [
			[{ auth: "app" }, "auth must be an object with githubApp."],
			[{ auth: {} }, "auth must be an object with githubApp."],
			[{ auth: { githubApp: [] } }, "auth.githubApp must be an object."],
			[
				{ auth: { githubApp: { ...base, appId: "" } } },
				"auth.githubApp.appId must be a non-empty string or a positive integer.",
			],
			[
				{ auth: { githubApp: { ...base, installationId: "x1" } } },
				"auth.githubApp.installationId must be a positive integer.",
			],
			[
				{ auth: { githubApp: { ...base, installationId: 0 } } },
				"auth.githubApp.installationId must be a positive integer.",
			],
			[
				{ auth: { githubApp: { ...base, privateKeyFile: 3 } } },
				"auth.githubApp.privateKeyFile must be a non-empty string.",
			],
			[{ auth: { githubApp: { ...base, repository: "flows" } } }, "auth.githubApp.repository must be owner/name."],
			[
				{ auth: { githubApp: { ...base, host: "https://ghe" } } },
				"auth.githubApp.host must be a host name, such as github.com.",
			],
			[
				{ auth: { githubApp: { ...base, apiUrl: "ftp://x" } } },
				"auth.githubApp.apiUrl must be an http or https URL.",
			],
		];
		for (const [options, message] of cases)
			assert.throws(() => createWorkerHostProvisioner({ ...GH_PRESET, ...(options as object) }), {
				name: "TypeError",
				message: `Invalid command provisioner options: ${message}`,
			});
	});
});

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) assert.fail("timed out");
		await sleep(10);
	}
}

posixOnly(
	"a fleet controller whose GitHub App is refused is degraded, keeps the key out of its journal, and recovers (#4768)",
	async () => {
		const { github } = await fixture();
		const directory = makeLibsqlDirectory();
		const libsql = new URL("../../packages/storage-libsql/libsql.js", import.meta.url).pathname;
		const journal = {
			adapter: libsql,
			options: { url: pathToFileURL(join(directory, "shared.db")).href },
			prefix: "acme_",
		};
		for (let index = 0; index < 3; index++)
			github.replies.push({ status: 401, body: { message: "A JSON web token could not be decoded" } });
		const events: string[] = [];
		const controller: WorkflowFleetController = await startWorkflowFleetController({
			journal,
			agentDir: join(directory, "agent"),
			provisioner: appProvisioner(github),
			tickMs: 100,
			onEvent: (event) => events.push(event.kind),
		});
		cleanups.push(async () => {
			await controller.stop();
			await removeLibsqlDirectory(directory);
		});
		await until(() => controller.status().degraded !== undefined, 20_000);
		const degraded = controller.status().degraded!;
		assert.equal(degraded.error.name, "WorkerProvisionerError");
		assert.match(degraded.error.message, /HTTP 401: A JSON web token could not be decoded/);
		await until(() => events.includes("recovered"), 20_000);
		assert.equal(controller.status().degraded, undefined);
		await controller.stop();
		const { SqlFleetStore } = await import("../../packages/workflows/src/durable/journal/sql-fleet.js");
		const { resolveRunJournal } = await import("../../packages/workflows/src/durable/journal/resolution.js");
		const reader = await resolveRunJournal({ journal, agentDir: join(directory, "reader") });
		try {
			const recorded = JSON.stringify(await (await SqlFleetStore.open(reader)).recent(50));
			assert.match(recorded, /HTTP 401/);
			for (const line of keyBody(github.privateKeyPem))
				assert.ok(!recorded.includes(line), "the key reached the journal");
			assert.doesNotMatch(recorded, /ghs_fake|eyJ/);
		} finally {
			await reader.close();
		}
	},
);
