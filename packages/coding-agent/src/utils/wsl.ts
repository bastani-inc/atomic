import { readFile } from "node:fs/promises";

let procVersionIsWSL: Promise<boolean> | undefined;

function checkProcVersion(): Promise<boolean> {
	procVersionIsWSL ??= readFile("/proc/version", "utf-8").then(
		(release) => /microsoft|wsl/i.test(release),
		() => false,
	);
	return procVersionIsWSL;
}

/** Windows Subsystem for Linux, where Windows executables are reachable through interop. */
export async function isWSL(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}

	return checkProcVersion();
}
