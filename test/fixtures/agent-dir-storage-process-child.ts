import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import type { Settings } from "../../packages/coding-agent/src/core/settings-types.js";
import { setCliStorageSelection } from "../../packages/coding-agent/src/core/storage/process-selection.js";

const [agentDir, settingsJson, cliJson] = process.argv.slice(2);
if (agentDir === undefined || settingsJson === undefined) throw new Error("Expected agent directory and settings JSON");
if (cliJson !== undefined) setCliStorageSelection({ flag: "--storage", value: cliJson });
console.log(JSON.stringify(selectSessionStorage(agentDir, { agentDir, settings: JSON.parse(settingsJson) as Settings })));
