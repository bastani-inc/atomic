import type { SqliteDatabase } from "@bastani/atomic/storage";
import { describe, it } from "vitest";
import type { WithSessionStore } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { StorageBackend } from "../helpers/storage-backends.js";

/**
 * Rows that fail on a backend because of an open bug, by suite and test name, with the issue. They run as `it.fails`,
 * so the row turns red once the bug is fixed and the fix removes its entry.
 */
const KNOWN_FAILURES: ReadonlyMap<string, string> = new Map();

export function backendLabel(backend: StorageBackend): string {
	return backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
}

/** A describe/it runner for `backend`: skipped rows when the backend is, known failures as `it.fails`. */
export function runnerFor(backend: StorageBackend, options?: { readonly includeSuite?: (suite: string) => boolean }) {
	const { skipReason } = backend;
	let suite = "";
	return {
		describe(name: string, body: () => void) {
			if (options?.includeSuite && !options.includeSuite(name)) return;
			describe(name, () => {
				const outer = suite;
				suite = name;
				try {
					body();
				} finally {
					suite = outer;
				}
			});
		},
		it(name: string, body: () => Promise<void>, timeoutMs?: number) {
			const issue = KNOWN_FAILURES.get(`${suite} > ${name}`);
			if (skipReason !== undefined) it.skip(name, body);
			else if (issue !== undefined) it.fails(`${name} (known failure, ${issue})`, body, timeoutMs);
			else it(name, body, timeoutMs);
		},
	};
}

export function withSqlSessionStore(backend: StorageBackend): WithSessionStore {
	return async (body) => {
		const scope = await backend.openScope();
		try {
			const open = async (database: SqliteDatabase) => SqlSessionStore.open(database, { prefix: scope.prefix });
			let store = await open(await scope.connect());
			await body({
				get store() {
					return store;
				},
				async reopen() {
					store = await open(await scope.connect());
					return store;
				},
			});
		} finally {
			await scope.close();
		}
	};
}
