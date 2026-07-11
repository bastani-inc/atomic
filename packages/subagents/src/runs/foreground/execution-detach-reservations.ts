import type { IntercomDetachRoute } from "./execution-detach-route.js";

interface Reservation {
	route: IntercomDetachRoute;
	timer: ReturnType<typeof setTimeout>;
}

function identity(event: IntercomDetachRoute): string | undefined {
	if (typeof event.requestId !== "string" || event.requestId.length === 0
		|| typeof event.messageId !== "string" || event.messageId.length === 0
		|| typeof event.senderId !== "string" || event.senderId.length === 0
		|| typeof event.runtimeGeneration !== "number") return undefined;
	return `${event.requestId}\0${event.messageId}\0${event.senderId}\0${event.runtimeGeneration}`;
}

function sameRoute(left: IntercomDetachRoute, right: IntercomDetachRoute): boolean {
	return left.requestId === right.requestId && left.messageId === right.messageId
		&& left.senderId === right.senderId && left.runtimeGeneration === right.runtimeGeneration
		&& left.childIntercomTarget === right.childIntercomTarget
		&& left.runId === right.runId && left.agent === right.agent && left.childIndex === right.childIndex;
}

export class IntercomDetachReservations {
	private readonly entries = new Map<string, Reservation>();

	reserve(event: IntercomDetachRoute): boolean {
		const key = identity(event);
		if (!key || this.entries.has(key)) return false;
		const timer = setTimeout(() => this.entries.delete(key), 1000);
		timer.unref?.();
		this.entries.set(key, { route: event, timer });
		return true;
	}

	commit(event: IntercomDetachRoute): boolean {
		const key = identity(event);
		if (!key) return false;
		const reservation = this.entries.get(key);
		if (!reservation || !sameRoute(event, reservation.route)) return false;
		clearTimeout(reservation.timer);
		this.entries.delete(key);
		return true;
	}

	clear(): void {
		for (const reservation of this.entries.values()) clearTimeout(reservation.timer);
		this.entries.clear();
	}
}
