/**
 * Status file writer — subscribes to store updates and emits an atomic
 * status JSON file for CI polling.
 *
 * Behaviour:
 * - Only active when config.statusFile === true.
 * - Default path: <projectRoot>/.atomic/workflows/status.json
 * - Atomic write via temp-file + rename (no torn reads by CI consumers).
 * - Flushes on every store update; guaranteed to flush on run terminal states
 *   (completed | failed | killed).
 * - Write errors surfaced as level:"warning" WorkflowNotice via store;
 *   duplicate errors are deduplicated so one notice per distinct error message.
 *
 * cross-ref: src/shared/types.ts WorkflowRuntimeConfig
 *            src/store.ts Store
 *            src/store-types.ts StoreSnapshot
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import { readInspectionStoreSnapshot } from "../shared/inspection-store-snapshot.js";
import type { Store } from "../shared/store.js";
import type { WorkflowRuntimeConfig } from "../shared/types.js";
import { StatusSnapshotSerializer } from "./status-snapshot-serializer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STATUS_SUBPATH = join(CONFIG_DIR_NAME, "workflows", "status.json");
const STATUS_WRITE_INTERVAL_MS = 16;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusWriterOpts {
	/**
	 * Project root used to resolve the default status file path.
	 * Defaults to process.cwd() when absent.
	 */
	projectRoot?: string;
}

export interface StatusWriter {
	/** Wait until all currently queued status writes have reached disk. */
	flush(): Promise<void>;
	/** Stop receiving store updates and cancel any pending flush. */
	unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective status file path.
 *
 * Priority:
 * 1. config.statusFilePath (explicit override)
 * 2. <projectRoot>/.atomic/workflows/status.json  (default)
 */
export function resolveStatusFilePath(
	config: Pick<WorkflowRuntimeConfig, "statusFilePath">,
	opts: StatusWriterOpts = {},
): string {
	if (config.statusFilePath) return config.statusFilePath;
	const root = opts.projectRoot ?? process.cwd();
	return join(root, DEFAULT_STATUS_SUBPATH);
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write `content` to `path` atomically using a sibling temp file + rename.
 * Creates parent directories as needed.
 */
export async function atomicWriteJson(path: string, content: string): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmpPath = `${path}.tmp`;
	await writeFile(tmpPath, content, "utf8");
	await rename(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStatusWriter(
	store: Store,
	config: WorkflowRuntimeConfig,
	opts: StatusWriterOpts = {},
): StatusWriter {
	if (!config.statusFile) {
		return { async flush() {}, unsubscribe() {} };
	}

	const filePath = resolveStatusFilePath(config, opts);

	// Track last error message to deduplicate warning notices and avoid
	// re-entrant infinite loops when writes keep failing.
	let lastErrorMessage: string | null = null;

	let active = true;
	let writing = false;
	let pending = false;
	let drainPromise: Promise<void> | null = null;
	const serializer = new StatusSnapshotSerializer();

	function recordWriteError(err: unknown): void {
		const msg = err instanceof Error ? err.message : String(err);
		// Deduplicate: only record one notice per distinct error message.
		if (msg === lastErrorMessage) return;
		lastErrorMessage = msg;
		store.recordNotice({
			id: `status-writer-error-${Date.now()}`,
			level: "warning",
			message: `atomic-workflows: status file write failed (${filePath}): ${msg}`,
			createdAt: Date.now(),
		});
	}

	async function drainWrites(): Promise<void> {
		if (writing) return;
		writing = true;
		try {
			while (active && pending) {
				await new Promise<void>((resolve) => setTimeout(resolve, STATUS_WRITE_INTERVAL_MS));
				if (!active) break;
				pending = false;
				try {
					await mkdir(dirname(filePath), { recursive: true });
					if (!active) break;
					const content = await serializer.serialize(readInspectionStoreSnapshot(store));
					if (!active) break;
					await atomicWriteJson(filePath, content);
					lastErrorMessage = null;
				} catch (err: unknown) {
					if (active) recordWriteError(err);
				}
			}
		} finally {
			writing = false;
		}
	}

	function ensureDrain(): Promise<void> {
		drainPromise ??= drainWrites().finally(() => {
			drainPromise = null;
			if (active && pending) void ensureDrain();
		});
		return drainPromise;
	}

	const unsubscribeStore = store.subscribeInvalidation(() => {
		pending = true;
		void ensureDrain();
	});

	return {
		async flush() {
			while (active && (pending || drainPromise !== null)) {
				await ensureDrain();
			}
		},
		unsubscribe() {
			active = false;
			pending = false;
			unsubscribeStore();
			serializer.close();
		},
	};
}
