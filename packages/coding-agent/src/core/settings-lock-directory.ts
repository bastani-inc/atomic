import { Worker } from "node:worker_threads";
import { evalWorkerExecArgv } from "../utils/worker-threads.js";

const QUEUED = 0;
const CREATING = 1;
const CREATED = 2;
const FAILED = 3;
const CLAIMED = 4;

const CREATOR_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { mkdirSync } = require("node:fs");
parentPort.on("message", ({ id, path, state, gate }) => {
  const slot = new Int32Array(state);
  if (Atomics.compareExchange(slot, 0, ${QUEUED}, ${CREATING}) !== ${QUEUED}) {
    parentPort.postMessage({ id, claimed: true });
    return;
  }
  let failure;
  try {
    mkdirSync(path);
  } catch (error) {
    failure = { code: error && error.code, message: String(error && error.message) };
  }
  if (gate) Atomics.wait(new Int32Array(gate), 0, 0);
  Atomics.store(slot, 0, failure ? ${FAILED} : ${CREATED});
  Atomics.notify(slot, 0);
  parentPort.postMessage(failure ? { id, ...failure } : { id });
});
`;

let publicationGate: SharedArrayBuffer | undefined;

export function gateLockDirectoryPublication(gate: SharedArrayBuffer | undefined): void {
	publicationGate = gate;
}

interface CreatorReply {
	readonly id: number;
	readonly claimed?: boolean;
	readonly code?: string;
	readonly message?: string;
}

interface PendingCreation {
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

let creator: Worker | undefined;
let nextId = 0;
const pending = new Map<number, PendingCreation>();

function creatorWorker(): Worker {
	if (creator) return creator;
	const worker = new Worker(CREATOR_SOURCE, { eval: true, execArgv: evalWorkerExecArgv() });
	worker.unref();
	worker.on("message", (reply: CreatorReply) => {
		const creation = pending.get(reply.id);
		if (!creation) return;
		pending.delete(reply.id);
		if (pending.size === 0) worker.unref();
		if (reply.claimed)
			creation.reject(
				Object.assign(new Error("The process exited before the lock was taken"), { code: "ECANCELED" }),
			);
		else if (reply.code !== undefined || reply.message !== undefined)
			creation.reject(Object.assign(new Error(reply.message ?? "mkdir failed"), { code: reply.code }));
		else creation.resolve();
	});
	worker.on("error", (error) => {
		if (creator === worker) creator = undefined;
		for (const [id, creation] of pending) {
			pending.delete(id);
			creation.reject(error);
		}
	});
	creator = worker;
	return worker;
}

export interface LockDirectoryCreation {
	readonly created: Promise<void>;
	readonly state: Int32Array;
}

export function createLockDirectory(path: string): LockDirectoryCreation {
	const state = new SharedArrayBuffer(4);
	const id = nextId++;
	const created = new Promise<void>((resolve, reject) => {
		pending.set(id, { resolve, reject });
	});
	const worker = creatorWorker();
	if (pending.size === 1) worker.ref();
	worker.postMessage({ id, path, state, gate: publicationGate });
	return { created, state: new Int32Array(state) };
}

export function lockDirectoryCreatedBeforeExit(creation: LockDirectoryCreation): boolean {
	const previous = Atomics.compareExchange(creation.state, 0, QUEUED, CLAIMED);
	if (previous === QUEUED || previous === CLAIMED) return false;
	while (Atomics.load(creation.state, 0) === CREATING) Atomics.wait(creation.state, 0, CREATING);
	return Atomics.load(creation.state, 0) === CREATED;
}
