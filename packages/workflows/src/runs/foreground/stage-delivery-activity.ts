/**
 * Internal stage delivery-activity channel.
 *
 * An accepted *idle* stage delivery starts a real backend turn long before the
 * public `agent_start` clears the session's ordered extension event queue. The
 * attached stage chat therefore had no signal to paint `Working` with, and the
 * pane looked idle while the model was already running.
 *
 * This channel carries only that fact — "an idle delivery was admitted and is
 * now starting a turn" — as a workflow-internal event, so the chat can start
 * its existing Working lifecycle without fabricating SDK lifecycle events or
 * reordering the public event stream.
 *
 * Streaming deliveries (`steer` / `followUp`) never emit here: they join an
 * in-flight turn that already owns the indicator.
 *
 * cross-ref:
 *   - src/runs/foreground/stage-runner-send-user-message.ts (emitter)
 *   - src/tui/stage-chat-view-delivery-activity.ts (consumer)
 */

export type StageDeliveryActivityEvent =
	| { readonly type: "delivery_start"; readonly deliveryId: number }
	| { readonly type: "delivery_settled"; readonly deliveryId: number };

export type StageDeliveryActivityListener = (event: StageDeliveryActivityEvent) => void;

export class StageDeliveryActivity {
	private readonly listeners = new Set<StageDeliveryActivityListener>();
	private readonly active = new Set<number>();
	private nextDeliveryId = 0;

	/**
	 * Register `listener`, then synchronously replay every currently-active
	 * delivery as `delivery_start`.
	 *
	 * A stage chat can attach after a delivery was admitted — a late `/workflow
	 * attach`, or a remount — and would otherwise see nothing until the public
	 * `agent_start` finally arrives. Registering before replaying matters:
	 * snapshotting first would drop a start or settlement that lands in between.
	 */
	subscribe(listener: StageDeliveryActivityListener): () => void {
		this.listeners.add(listener);
		for (const deliveryId of [...this.active]) {
			if (!this.listeners.has(listener)) break;
			listener({ type: "delivery_start", deliveryId });
		}
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Report an admitted idle delivery that is about to start a turn. */
	start(): number {
		const deliveryId = ++this.nextDeliveryId;
		this.active.add(deliveryId);
		this.emit({ type: "delivery_start", deliveryId });
		return deliveryId;
	}

	/** Keep one correlated delivery active for the full asynchronous operation. */
	async runWithLease<T>(operation: () => Promise<T>): Promise<T> {
		const deliveryId = this.start();
		try {
			return await operation();
		} finally {
			this.settle(deliveryId);
		}
	}

	/** Report that a delivery finished, failed, or started no turn at all. */
	settle(deliveryId: number | undefined): void {
		if (deliveryId === undefined || !this.active.delete(deliveryId)) return;
		this.emit({ type: "delivery_settled", deliveryId });
	}

	/** Settle every outstanding delivery, then drop listeners. */
	dispose(): void {
		for (const deliveryId of [...this.active]) this.settle(deliveryId);
		this.listeners.clear();
	}

	private emit(event: StageDeliveryActivityEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}
