import type { ForkOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import type {
	DistributiveOmit,
	WorkerInbound,
	WorkerReply,
	WorkerRequest,
	WorkerStart,
} from "../../packages/workflows/src/workers/protocol.js";

/** A worker process as the coordinator sees it: IPC both ways, driven by the test instead of a worker's loop. */
export class FakeWorker extends EventEmitter {
	readonly pid: number;
	readonly start: WorkerStart;
	/** How the coordinator forked it: its environment among them. */
	readonly options: ForkOptions;
	connected = true;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	/** The worker's stderr, when the test gives it one; a forked worker without one logs nothing. */
	readonly stderr: PassThrough | undefined;
	/** Messages the coordinator pushed without a request: pool control, stage commands, shared limits. */
	readonly pushed: Exclude<WorkerInbound, WorkerReply>[] = [];
	/** Deliveries the coordinator sent on a pending delivery request, which stays pending. */
	readonly deliveries: NonNullable<WorkerReply["delivery"]>[] = [];
	/** Set to make every push to this worker fail, as for a channel that closed. */
	refusePushes = false;
	killedWith?: NodeJS.Signals;
	private sequence = 0;
	private readonly replies = new Map<number, (reply: WorkerReply) => void>();

	constructor(pid: number, args: readonly string[], options: ForkOptions, stderr?: PassThrough) {
		super();
		this.pid = pid;
		this.start = JSON.parse(args[0]!) as WorkerStart;
		this.options = options;
		this.stderr = stderr;
	}

	send(message: WorkerInbound, callback?: (error: Error | null) => void): boolean {
		if ("kind" in message) {
			if (this.refusePushes) {
				callback?.(new Error("channel closed"));
				return false;
			}
			this.pushed.push(message);
		} else if (message.delivery !== undefined) this.deliveries.push(message.delivery);
		else {
			this.replies.get(message.id)?.(message);
			this.replies.delete(message.id);
		}
		callback?.(null);
		return true;
	}

	request(body: DistributiveOmit<WorkerRequest, "id">): Promise<WorkerReply> {
		const id = ++this.sequence;
		return new Promise((resolve) => {
			this.replies.set(id, resolve);
			this.emit("message", { ...body, id });
		});
	}

	/** Sends a request without waiting for its reply, which `reply(id)` then awaits. */
	ask(body: DistributiveOmit<WorkerRequest, "id">): { readonly id: number; readonly reply: Promise<WorkerReply> } {
		const id = ++this.sequence;
		const reply = new Promise<WorkerReply>((resolve) => this.replies.set(id, resolve));
		this.emit("message", { ...body, id });
		return { id, reply };
	}

	/** Sends a message the coordinator does not answer, such as a delivery acknowledgement. */
	tell(message: WorkerRequest): void {
		this.emit("message", message);
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.exitCode !== null || this.signalCode !== null) return false;
		this.killedWith = signal;
		this.exit(null, signal);
		return true;
	}

	/** Ends the worker as its process exiting would: the channel closes, then it exits. */
	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.connected = false;
		this.stderr?.end();
		setImmediate(() => {
			this.emit("disconnect");
			this.emit("exit", code, signal);
			this.emit("close", code, signal);
		});
	}

	disconnect(): void {
		this.connected = false;
		this.emit("disconnect");
	}
}
