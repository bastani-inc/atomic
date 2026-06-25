import fs from "node:fs/promises";
import type { ExtensionContext } from "../extensions/types.ts";
import { displayTodoId } from "./todos-model.ts";
import { getLockPath } from "./todos-paths.ts";
import {
	isTodoOperationError,
	type LockInfo,
	type TodoOperationError,
	type TodoOperationResult,
} from "./todos-types.ts";

const LOCK_TTL_MS = 30 * 60 * 1000;

type TodoLockRelease = () => Promise<void>;

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

async function acquireLock(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<TodoLockRelease | TodoOperationError> {
	const lockPath = getLockPath(todosDir, id);
	const now = Date.now();
	const session = ctx.sessionManager.getSessionFile();

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(lockPath, "wx");
			const info: LockInfo = {
				id,
				pid: process.pid,
				session,
				created_at: new Date(now).toISOString(),
			};
			await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
			await handle.close();
			return async () => {
				try {
					await fs.unlink(lockPath);
				} catch {
					// ignore
				}
			};
		} catch (error) {
			const fsError = error as { code?: string; message?: string };
			if (fsError.code !== "EEXIST") {
				return {
					error: `Failed to acquire lock: ${fsError.message ?? "unknown error"}`,
				};
			}
			const stats = await fs.stat(lockPath).catch(() => null);
			const lockAge = stats ? now - stats.mtimeMs : LOCK_TTL_MS + 1;
			if (lockAge <= LOCK_TTL_MS) {
				const info = await readLockInfo(lockPath);
				const owner = info?.session ? ` (session ${info.session})` : "";
				return {
					error: `Todo ${displayTodoId(id)} is locked${owner}. Try again later.`,
				};
			}
			if (!ctx.hasUI) {
				return {
					error: `Todo ${displayTodoId(id)} lock is stale; rerun in interactive mode to steal it.`,
				};
			}
			const ok = await ctx.ui.confirm(
				"Todo locked",
				`Todo ${displayTodoId(id)} appears locked. Steal the lock?`,
			);
			if (!ok) {
				return { error: `Todo ${displayTodoId(id)} remains locked.` };
			}
			await fs.unlink(lockPath).catch(() => undefined);
		}
	}

	return { error: `Failed to acquire lock for todo ${displayTodoId(id)}.` };
}

export async function withTodoLock<T>(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	fn: () => Promise<TodoOperationResult<T>>,
): Promise<TodoOperationResult<T>> {
	const lock = await acquireLock(todosDir, id, ctx);
	if (isTodoOperationError(lock)) return lock;
	try {
		return await fn();
	} finally {
		await lock();
	}
}
