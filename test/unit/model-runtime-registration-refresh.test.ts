import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { ENV_OFFLINE, getEnvNames } from "../../packages/coding-agent/src/config.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const PROVIDER = "held-catalog";
const TURNS_FOR_AN_EARLY_ANSWER = 20;

const releases: Array<() => void> = [];
afterEach(() => {
	while (releases.length > 0) releases.pop()?.();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/**
 * A runtime whose credential listing, which a refresh's availability pass reads, waits until the test lets it go, so a
 * refresh started by a provider registration stays in flight for as long as the test needs.
 */
async function runtimeWithHeldCredentialListing() {
	const credentials = AuthStorage.inMemory();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	const list = credentials.list.bind(credentials);
	const held: Array<() => void> = [];
	const arrivals: Array<() => void> = [];
	vi.spyOn(credentials, "list").mockImplementation(async (options) => {
		await new Promise<void>((resolve) => {
			held.push(resolve);
			for (const arrived of arrivals.splice(0)) arrived();
		});
		return list(options);
	});
	const release = () => {
		for (const resolve of held.splice(0)) resolve();
	};
	releases.push(release);
	return {
		runtime,
		release,
		held: () => held.length,
		reached: () =>
			held.length > 0 ? Promise.resolve() : new Promise<void>((resolve) => arrivals.push(() => resolve())),
	};
}

function settlement(promise: Promise<void>) {
	let settled = false;
	const done = promise.then(() => {
		settled = true;
	});
	return { done, settled: () => settled };
}

async function turns(count: number): Promise<void> {
	for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve));
}

test("waiting for registration refreshes lasts until the refresh a registration started has finished (#4480)", async () => {
	const { runtime, release, held, reached } = await runtimeWithHeldCredentialListing();
	runtime.registerProvider(PROVIDER, { apiKey: "catalog-key", refreshModels: async () => [] });
	await reached();

	const wait = settlement(runtime.whenRegistrationRefreshesSettled());
	await turns(TURNS_FOR_AN_EARLY_ANSWER);
	assert.equal(wait.settled(), false, "the registration's refresh is still in its availability pass");

	release();
	await wait.done;
	assert.equal(held(), 0, "no availability pass of a registration is left waiting");
});

test("waiting for registration refreshes also waits for one a registration starts meanwhile (#4480)", async () => {
	const { runtime, release, reached } = await runtimeWithHeldCredentialListing();
	runtime.registerProvider(PROVIDER, { apiKey: "catalog-key", refreshModels: async () => [] });
	await reached();
	const wait = settlement(runtime.whenRegistrationRefreshesSettled());

	release();
	runtime.unregisterProvider(PROVIDER);
	await reached();
	await turns(TURNS_FOR_AN_EARLY_ANSWER);
	assert.equal(wait.settled(), false, "the refresh the unregistration started is still running");

	release();
	await wait.done;
});

test("the refresh a registration starts reads only cached catalogs, and one superseded in the same turn is dropped (#4480)", async () => {
	for (const name of getEnvNames(ENV_OFFLINE)) vi.stubEnv(name, "0");
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const passes: boolean[] = [];
	const config = {
		apiKey: "catalog-key",
		refreshModels: async ({ allowNetwork }: { allowNetwork: boolean }) => {
			passes.push(allowNetwork);
			return [];
		},
	};

	runtime.registerProvider(PROVIDER, config);
	runtime.registerProvider(PROVIDER, config);
	await runtime.whenRegistrationRefreshesSettled();

	assert.deepEqual(passes, [false], "one catalog pass, from the cache, for the two registrations");
});
