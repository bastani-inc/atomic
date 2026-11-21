import { createModuleRequire } from "./module-require.js";

/** What this module uses of Bun's foreign function interface. */
interface BunFfi {
	dlopen(
		path: string,
		symbols: { ExitProcess: { args: ["u32"]; returns: "void" } },
	): { symbols: { ExitProcess(code: number): void } };
}

/**
 * End the process with `code` once its exit listeners have run, as `process.exit` does. A Windows status can use all
 * 32 bits, as STATUS_CONTROL_C_EXIT (0xC000013A) does. Node hands it to Windows whole, but Bun keeps only its low
 * byte, so under Bun on Windows the process then ends through ExitProcess, after the other exit listeners. That skips
 * the rest of Bun's own exit, such as writing a profile it was asked for: call this only once the process has
 * nothing left to finish, its storage closed.
 */
export function exitWithStatus(code: number): never {
	if (process.platform === "win32" && process.versions.bun !== undefined && code > 0xff) {
		try {
			const ffi = createModuleRequire(import.meta.url)("bun:ffi") as BunFfi;
			const kernel32 = ffi.dlopen("kernel32.dll", { ExitProcess: { args: ["u32"], returns: "void" } });
			process.on("exit", () => kernel32.symbols.ExitProcess(code));
		} catch {
			// Without it the process still exits, with the low byte of its status.
		}
	}
	return process.exit(code);
}
