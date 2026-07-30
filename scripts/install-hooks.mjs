import { spawnSync } from "node:child_process";

const truthy = new Set(["1", "true", "yes"]);
const installDisabled = truthy.has((process.env.PREK_DISABLE_INSTALL ?? "").toLowerCase());
const isCi =
	truthy.has((process.env.CI ?? "").toLowerCase()) || truthy.has((process.env.GITHUB_ACTIONS ?? "").toLowerCase());

if (installDisabled || isCi) {
	console.log("Skipping prek hook installation.");
	process.exit(0);
}

// npm runs lifecycle scripts under Node, so process.execPath is only Bun when
// invoked via `bun run`. Pick the matching launcher; both resolve the local or
// PATH-installed prek without fetching anything (mirrors the hooks:install script).
const prekArgs = ["--no-install", "prek", "install", "--prepare-hooks"];
const isBun = Boolean(process.versions.bun);
const isWindows = process.platform === "win32";
const [command, args] = isBun ? [process.execPath, ["x", "--bun", ...prekArgs]] : ["npx", prekArgs];

const result = spawnSync(command, args, {
	// npx is a .cmd shim on Windows and needs a shell to spawn.
	shell: !isBun && isWindows,
	stdio: "inherit",
});

if (result.error) {
	console.error(`Failed to install prek hooks: ${result.error.message}`);
	process.exit(1);
}

process.exit(result.status ?? 1);
