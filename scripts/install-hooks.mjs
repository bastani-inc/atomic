import { spawnSync } from "node:child_process";

const truthy = new Set(["1", "true", "yes"]);
const installDisabled = truthy.has(
  (process.env.PREK_DISABLE_INSTALL ?? "").toLowerCase(),
);
const isCi =
  truthy.has((process.env.CI ?? "").toLowerCase()) ||
  truthy.has((process.env.GITHUB_ACTIONS ?? "").toLowerCase());

if (installDisabled || isCi) {
  console.log("Skipping prek hook installation.");
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  ["x", "--bun", "--no-install", "prek", "install", "--prepare-hooks"],
  {
    shell: false,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`Failed to install prek hooks: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
