import { vi } from "vitest";

/**
 * Every store on PostgreSQL under long prefixes (#4793): the tests are in test/helpers/postgres-store-identifiers.ts,
 * loaded here after a test-only bypass of PostgreSQL's prefix length check (#5067), so the stores also open under a
 * prefix longer than any a user may choose and their names must still agree. The setup files load the storage modules
 * first, so the bypass takes fresh copies of them, in the sources and in the built package the workflows import.
 */

type PrefixModule = typeof import("../../packages/coding-agent/src/core/storage/prefix.js");
const withoutLengthCheck = async (original: () => Promise<PrefixModule>): Promise<PrefixModule> => {
	const module = await original();
	return { ...module, validateStoragePrefix: (prefix?: string) => module.validateStoragePrefix(prefix) };
};
vi.resetModules();
vi.doMock("../../packages/coding-agent/src/core/storage/prefix.js", withoutLengthCheck);
vi.doMock("../../packages/coding-agent/dist/core/storage/prefix.js", withoutLengthCheck);
await import("../helpers/postgres-store-identifiers.js");
