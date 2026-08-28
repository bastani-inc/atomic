import assert from "node:assert/strict";
import { replacePathFilesystem } from "../../packages/coding-agent/src/core/tools/path-utils.js";

export interface ControlFilesystemFailureSpy {
	readonly calls: readonly string[];
	assertUntouched(): void;
	restore(): void;
}

/** Replace local read-path probing with operations that record and reject every call. */
export function installControlFilesystemFailureSpy(): ControlFilesystemFailureSpy {
	const calls: string[] = [];
	const fail = (operation: string): never => {
		calls.push(operation);
		throw new Error(`control filesystem call: ${operation}`);
	};
	const restore = replacePathFilesystem({
		access: async () => fail("access"),
		accessSync: () => fail("accessSync"),
	});
	return {
		calls,
		assertUntouched() {
			assert.deepEqual(calls, []);
		},
		restore,
	};
}
