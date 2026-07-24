import type { RpcClient } from "../rpc/rpc-client.js";
import { sleep } from "../../utils/sleep.js";

export class RemoteQueuePause {
	private paused = false;
	private pauseRequest: Promise<void> | undefined;
	private readonly client: Pick<RpcClient, "requestInternal">;

	constructor(client: Pick<RpcClient, "requestInternal">) {
		this.client = client;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	synchronize(paused: boolean): void {
		this.paused = paused;
		this.pauseRequest = undefined;
	}

	pause(): void {
		if (this.paused) return;
		this.paused = true;
		const request = this.client.requestInternal<void>({ type: "pause_queued_messages" });
		this.pauseRequest = request;
		void request.catch(() => {});
	}

	async resume(): Promise<boolean> {
		if (!this.paused) return false;
		if (this.pauseRequest) await this.pauseRequest;
		const { released } = await this.client.requestInternal<{ released: boolean }>({ type: "resume_queued_messages" });
		this.pauseRequest = undefined;
		this.paused = false;
		return released;
	}

	async settleBeforeAbort(): Promise<void> {
		if (this.pauseRequest) await Promise.race([this.pauseRequest, sleep(100)]);
	}
}
