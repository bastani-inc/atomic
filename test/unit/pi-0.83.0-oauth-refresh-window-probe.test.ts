/**
 * P4 probe — the inherited shorter OAuth refresh window (upstream pi #7168).
 *
 * pi-ai now refreshes a stored OAuth credential that has under five minutes of
 * validity left, rather than waiting for it to expire. That widens the window in
 * which *every* concurrent Atomic session — subagents, workflow stages, RPC
 * children — decides at the same moment that the shared credential needs
 * refreshing. The stated risk (R2) is that the widened window amplifies into a
 * refresh storm: one refresh per session instead of one refresh per credential.
 *
 * The suppression lives on Atomic's side of the seam. `AuthStorage.modify` takes
 * the cross-process `auth.json` lock, and pi-ai re-checks expiry inside that
 * lock; each session here therefore gets its own `AuthStorage` over one shared
 * file, which is exactly what separate sessions have.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { afterEach, test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";

/** Enough concurrency to storm, small enough to stay well inside the budget. */
const CONCURRENT_SESSIONS = 6;
const PROVIDER_ID = "refresh-window-probe";
const FIVE_MINUTES_MS = 5 * 60 * 1000;

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sharedAuthFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-refresh-window-"));
	temporaryDirectories.push(directory);
	return join(directory, "auth.json");
}

interface RefreshProbe {
	readonly authPath: string;
	readonly refreshes: () => number;
	readonly sessions: ReadonlyArray<ReturnType<typeof createModels>>;
}

async function createRefreshProbe(remainingValidityMs: number): Promise<RefreshProbe> {
	const authPath = sharedAuthFile();
	const seed = AuthStorage.create(authPath);
	await seed.modify(PROVIDER_ID, async () => ({
		type: "oauth",
		access: "stored-access",
		refresh: "stored-refresh",
		expires: Date.now() + remainingValidityMs,
	}));

	let refreshes = 0;
	const provider = (): Provider => ({
		id: PROVIDER_ID,
		name: "Refresh Window Probe",
		auth: {
			oauth: {
				name: "OAuth",
				login: async () => {
					throw new Error("the probe never logs in");
				},
				refresh: async (credential: Credential & { type: "oauth" }) => {
					refreshes += 1;
					// Hold the lock long enough that a second refresher would have to be
					// a real concurrency failure rather than a scheduling accident.
					await new Promise((resolve) => setTimeout(resolve, 25));
					return { ...credential, access: "rotated-access", expires: Date.now() + 60 * 60 * 1000 };
				},
				toAuth: async (credential: Credential & { type: "oauth" }) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [],
		stream: () => {
			throw new Error("the probe never streams");
		},
		streamSimple: () => {
			throw new Error("the probe never streams");
		},
	});

	const sessions = Array.from({ length: CONCURRENT_SESSIONS }, () => {
		const models = createModels({ credentials: AuthStorage.create(authPath) });
		models.setProvider(provider());
		return models;
	});

	return { authPath, refreshes: () => refreshes, sessions };
}

test("concurrent sessions inside the five-minute window refresh the shared credential once", async () => {
	// Still valid, but inside the window: this credential would not have been
	// refreshed at all before the change, so it is the case the change created.
	const probe = await createRefreshProbe(FIVE_MINUTES_MS - 60_000);

	const resolved = await Promise.all(probe.sessions.map((models) => models.getAuth(PROVIDER_ID)));

	assert.equal(probe.refreshes(), 1, `${CONCURRENT_SESSIONS} sessions produced ${probe.refreshes()} refreshes`);
	assert.deepEqual(
		resolved.map((result) => result?.auth),
		Array.from({ length: CONCURRENT_SESSIONS }, () => ({ apiKey: "rotated-access" })),
		"every session must observe the one rotated credential",
	);

	const persisted = await AuthStorage.create(probe.authPath).read(PROVIDER_ID);
	assert.equal(persisted?.type, "oauth");
	assert.equal((persisted as Credential & { type: "oauth" }).access, "rotated-access");
});

test("a credential outside the window is not refreshed by any concurrent session", async () => {
	// The path that already worked: a comfortably valid credential must not be
	// touched, or the shorter window would mean a refresh on every resolution.
	const probe = await createRefreshProbe(FIVE_MINUTES_MS + 60 * 60 * 1000);

	const resolved = await Promise.all(probe.sessions.map((models) => models.getAuth(PROVIDER_ID)));

	assert.equal(probe.refreshes(), 0);
	assert.deepEqual(
		resolved.map((result) => result?.auth),
		Array.from({ length: CONCURRENT_SESSIONS }, () => ({ apiKey: "stored-access" })),
	);
});

test("a session that arrives after the rotation reuses it instead of refreshing again", async () => {
	const probe = await createRefreshProbe(FIVE_MINUTES_MS - 60_000);

	await Promise.all(probe.sessions.map((models) => models.getAuth(PROVIDER_ID)));
	// A late session — the next subagent, the next workflow stage — reads the
	// rotated credential from the shared file and must find nothing to do.
	const late = createModels({ credentials: AuthStorage.create(probe.authPath) });
	late.setProvider(probe.sessions[0]!.getProviders()[0]!);
	const resolved = await late.getAuth(PROVIDER_ID);

	assert.equal(probe.refreshes(), 1);
	assert.deepEqual(resolved?.auth, { apiKey: "rotated-access" });
});
