/**
 * Worker thread of a compile-cache helper: it compares the installation with the snapshot taken when the helper started,
 * every few milliseconds, and ends the helper's process at once when it changed. A worker thread, because the helper's
 * own thread is busy for seconds at a time while Node loads a module graph.
 */
import { workerData } from "node:worker_threads";
import {
	type InstallationSnapshot,
	installationChanged,
	readInstallationSnapshot,
} from "./compile-cache-installation.ts";

const { packageDir, start, intervalMs } = workerData as {
	packageDir: string;
	start: InstallationSnapshot;
	intervalMs: number;
};

setInterval(() => {
	if (installationChanged(start, readInstallationSnapshot(packageDir))) process.kill(process.pid, "SIGKILL");
}, intervalMs);
