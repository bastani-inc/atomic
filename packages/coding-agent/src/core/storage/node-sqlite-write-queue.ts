import { mkdirSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A ticket its owner has not refreshed for this long belongs to a process that died or stopped waiting. */
const TICKET_STALE_MS = 2_000;
/** Stale tickets older than this are removed by whichever writer notices them. */
const TICKET_REMOVE_AFTER_MS = 10 * TICKET_STALE_MS;

let ticketSequence = 0;

function ticketName(): string {
	ticketSequence += 1;
	return `${String(Date.now()).padStart(15, "0")}-${process.pid}-${ticketSequence}`;
}

/**
 * First come, first served for SQLite's write lock across processes. SQLite has no queue for `BEGIN IMMEDIATE`: a
 * writer that polls after `SQLITE_BUSY` loses to one that begins the moment the lock is free, and a busy process
 * can take the lock again and again while another waits for its whole deadline (#3978). A writer that has been
 * refused takes a ticket, a file named by the time it started waiting, in a directory next to the database; it then
 * attempts the lock only once no live older ticket is ahead of it, and a writer that arrives while tickets wait
 * queues behind them instead of overtaking. Uncontended writers only list an absent or empty directory.
 */
export class SqliteWriteQueue {
	private readonly directory: string;

	constructor(databasePath: string) {
		this.directory = `${databasePath}-writers`;
	}

	/** Whether another writer's live ticket is waiting, so a new writer must queue behind it. */
	othersWaiting(): boolean {
		return this.liveTickets().length > 0;
	}

	join(): SqliteWriteTicket {
		mkdirSync(this.directory, { recursive: true });
		const name = ticketName();
		const path = join(this.directory, name);
		writeFileSync(path, "", { flag: "wx" });
		return new SqliteWriteTicket(this, name, path);
	}

	/** Live tickets, oldest first; stale ones long abandoned are removed on the way. */
	liveTickets(except?: string): string[] {
		let names: string[];
		try {
			names = readdirSync(this.directory);
		} catch {
			return [];
		}
		const now = Date.now();
		const live: string[] = [];
		for (const name of names) {
			if (name === except) continue;
			let age: number;
			try {
				age = now - statSync(join(this.directory, name)).mtimeMs;
			} catch {
				continue;
			}
			if (age < TICKET_STALE_MS) live.push(name);
			else if (age > TICKET_REMOVE_AFTER_MS) {
				try {
					unlinkSync(join(this.directory, name));
				} catch {
					// Another writer removed it first.
				}
			}
		}
		return live.sort();
	}
}

export class SqliteWriteTicket {
	private left = false;
	private readonly queue: SqliteWriteQueue;
	private readonly name: string;
	private readonly path: string;

	constructor(queue: SqliteWriteQueue, name: string, path: string) {
		this.queue = queue;
		this.name = name;
		this.path = path;
	}

	/** Marks this ticket live and reports whether an older live ticket is still ahead of it. */
	behindOthers(): boolean {
		if (this.left) return false;
		const now = new Date();
		try {
			utimesSync(this.path, now, now);
		} catch {
			// The ticket was removed as stale while this writer stalled: take the place it would have had.
			writeFileSync(this.path, "");
		}
		return this.queue.liveTickets(this.name).some((other) => other < this.name);
	}

	leave(): void {
		if (this.left) return;
		this.left = true;
		try {
			unlinkSync(this.path);
		} catch {
			// Already removed.
		}
	}
}
