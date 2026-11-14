/**
 * Opening an adapter selection's database the way the storage provider does, for the checks that run before a
 * selection is trusted: `atomic storage join`, `atomic storage status` and a named export or import selection.
 */

import type { SqliteDatabase } from "./database.js";
import {
	loadStorageAdapter,
	resolveAdapterOptions,
	type StorageAdapterModule,
	type StorageOpenContext,
	type StorageSelection,
} from "./provider.js";

export type AdapterSelection = Extract<StorageSelection, { kind: "adapter" }>;

/**
 * Open `selection` through `adapter.openDatabase` with its secrets resolved as the provider resolves them. Throws
 * when the adapter has no `openDatabase` hook.
 */
export async function openAdapterSelectionDatabase(
	selection: AdapterSelection,
	context: StorageOpenContext,
	adapter?: StorageAdapterModule,
): Promise<SqliteDatabase> {
	const loaded = adapter ?? (await loadStorageAdapter(selection.module, context));
	if (loaded.openDatabase === undefined) throw new Error(`${selection.module} has no openDatabase hook`);
	const options = await resolveAdapterOptions(selection, context);
	return loaded.openDatabase(options, context);
}
