import { type ExecFileException, execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { pathExists } from "../../../core/tools/path-utils.ts";
import { createChildProcessEnvironment } from "../../../utils/child-process.ts";
import { helperLaunchAsync, missingHelperOptions } from "../../../utils/helper-command.ts";

export interface DeleteSessionFileResult {
	ok: boolean;
	method: "trash" | "unlink" | "store";
	error?: string;
}

const TRASH_TIMEOUT_MS = 30_000;

interface TrashResult {
	status: number | null;
	stderr: string;
	error?: Error;
}

async function runTrash(args: string[]): Promise<TrashResult> {
	const env = createChildProcessEnvironment();
	const launch = await helperLaunchAsync("trash", { env });
	return new Promise((resolve) => {
		execFile(
			launch.file,
			args,
			{ encoding: "utf-8", env, timeout: TRASH_TIMEOUT_MS, ...missingHelperOptions(launch) },
			(error: ExecFileException | null, _stdout: string, stderr: string) => {
				if (!error) {
					resolve({ status: 0, stderr });
					return;
				}
				if (typeof error.code === "number") resolve({ status: error.code, stderr });
				else resolve({ status: null, stderr, error });
			},
		);
	});
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink
 */
export async function deleteSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	// Try `trash` first (if installed)
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = await runTrash(trashArgs);

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	// If trash reports success, or the file is gone afterwards, treat it as successful
	if (trashResult.status === 0 || !(await pathExists(sessionPath))) {
		return { ok: true, method: "trash" };
	}

	// Fallback to permanent deletion
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}
