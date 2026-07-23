import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { GroupedResultIntercomMessageInput } from "../../intercom/result-intercom.js";
import type { ResultFileData } from "./result-watcher-data.js";

const CLAIMS_DIR = ".claims";
const CLAIM_SCHEDULE_PREFIX = "@claim/";

export interface FrozenCompletionEnvelope {
	local: Record<string, unknown>;
	intercom?: GroupedResultIntercomMessageInput;
}
export interface ResultFileClaimMeta {
	version: 1;
	id: string;
	originalFile: string;
	state: "active" | "delivered" | "undelivered";
	createdAt: number;
	sourceSignature?: string;
	envelope?: FrozenCompletionEnvelope;
	intercomDelivered?: boolean;
	localDelivered?: boolean;
	noProgressFailures?: number;
}

export interface ResultFileClaim {
	id: string;
	dir: string;
	payloadPath: string;
	metaPath: string;
	meta: ResultFileClaimMeta;
}

export interface ResultClaimFs {
	mkdirSync?: typeof fs.mkdirSync;
	renameSync?: typeof fs.renameSync;
	readFileSync?: typeof fs.readFileSync;
	writeFileSync?: typeof fs.writeFileSync;
	readdirSync?: typeof fs.readdirSync;
	rmSync?: typeof fs.rmSync;
	rmdirSync?: typeof fs.rmdirSync;
}

function api(fsApi: ResultClaimFs) {
	return {
		mkdirSync: fsApi.mkdirSync ?? fs.mkdirSync,
		renameSync: fsApi.renameSync ?? fs.renameSync,
		readFileSync: fsApi.readFileSync ?? fs.readFileSync,
		writeFileSync: fsApi.writeFileSync ?? fs.writeFileSync,
		rmSync: fsApi.rmSync ?? fs.rmSync,
		rmdirSync: fsApi.rmdirSync ?? fs.rmdirSync,
	};
}

export function claimScheduleKey(id: string): string {
	return `${CLAIM_SCHEDULE_PREFIX}${id}`;
}

export function claimIdFromScheduleKey(key: string): string | undefined {
	return key.startsWith(CLAIM_SCHEDULE_PREFIX) ? key.slice(CLAIM_SCHEDULE_PREFIX.length) : undefined;
}

export function loadResultClaim(resultsDir: string, id: string, fsApi: ResultClaimFs = fs): ResultFileClaim | undefined {
	try {
		const dir = path.join(resultsDir, CLAIMS_DIR, id);
		const metaPath = path.join(dir, "claim.json");
		const payloadPath = path.join(dir, "result.json");
		const meta = JSON.parse((fsApi.readFileSync ?? fs.readFileSync)(metaPath, "utf-8")) as ResultFileClaimMeta;
		if (meta.version !== 1 || meta.id !== id || !path.basename(meta.originalFile)) return undefined;
		return { id, dir, payloadPath, metaPath, meta };
	} catch {
		return undefined;
	}
}

export function listResultClaims(resultsDir: string, fsApi: ResultClaimFs = fs): ResultFileClaim[] {
	const claimsDir = path.join(resultsDir, CLAIMS_DIR);
	try {
		return (fsApi.readdirSync ?? fs.readdirSync)(claimsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => loadResultClaim(resultsDir, entry.name, fsApi))
			.filter((claim): claim is ResultFileClaim => Boolean(claim));
	} catch {
		return [];
	}
}

export function claimPublicResult(
	resultsDir: string,
	file: string,
	fsApi: ResultClaimFs = fs,
	createId: () => string = randomUUID,
): ResultFileClaim {
	const f = api(fsApi);
	const claimsDir = path.join(resultsDir, CLAIMS_DIR);
	f.mkdirSync(claimsDir, { recursive: true });
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const id = createId();
		const dir = path.join(claimsDir, id);
		try {
			f.mkdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		const metaPath = path.join(dir, "claim.json");
		const payloadPath = path.join(dir, "result.json");
		const meta: ResultFileClaimMeta = {
			version: 1, id, originalFile: path.basename(file), state: "active", createdAt: Date.now(),
		};
		try {
			f.writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, "utf-8");
			f.renameSync(path.join(resultsDir, file), payloadPath);
			return { id, dir, payloadPath, metaPath, meta };
		} catch (error) {
			f.rmSync(dir, { recursive: true, force: true });
			throw error;
		}
	}
	throw new Error(`Unable to allocate a result claim for '${file}'`);
}

export function readClaimData(claim: ResultFileClaim, fsApi: ResultClaimFs = fs): { raw: string; data: ResultFileData } {
	const raw = (fsApi.readFileSync ?? fs.readFileSync)(claim.payloadPath, "utf-8");
	return { raw, data: JSON.parse(raw) as ResultFileData };
}

export function updateResultClaim(
	claim: ResultFileClaim,
	patch: Partial<Omit<ResultFileClaimMeta, "version" | "id" | "originalFile" | "createdAt">>,
	fsApi: ResultClaimFs = fs,
): void {
	const f = api(fsApi);
	claim.meta = { ...claim.meta, ...patch };
	const temporary = path.join(claim.dir, `.claim-${randomUUID()}.tmp`);
	f.writeFileSync(temporary, `${JSON.stringify(claim.meta)}\n`, "utf-8");
	f.renameSync(temporary, claim.metaPath);
}

export function removeResultClaim(claim: ResultFileClaim, fsApi: ResultClaimFs = fs): void {
	const f = api(fsApi);
	f.rmSync(claim.dir, { recursive: true, force: true });
	try { f.rmdirSync(path.dirname(claim.dir)); } catch { /* another active claim keeps the shared directory */ }
}

export function recoverTerminalClaim(claim: ResultFileClaim, fsApi: ResultClaimFs = fs): "active" | "removed" {
	if (claim.meta.state === "active") return "active";
	removeResultClaim(claim, fsApi);
	return "removed";
}
