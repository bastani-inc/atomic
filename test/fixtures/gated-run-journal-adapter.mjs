// A run-journal storage adapter whose first open waits for `globalThis.__gatedJournal.firstOpen`, as a database that
// stops answering and comes back would. Each open calls `opened()` and counts in `opens`; each journal it hands out is
// a SQLite file at `options.path` whose close counts in `closes` and fails with `closeFailure` when one is set.
import { openSqlRunJournal } from "@bastani/atomic/workflows";

export default {
	atomicStorageAdapter: 1,
	async openRunJournal(options) {
		const gate = globalThis.__gatedJournal;
		gate.opens += 1;
		gate.opened();
		if (gate.opens === 1) await gate.firstOpen;
		const journal = await openSqlRunJournal(String(options.path));
		const close = journal.close.bind(journal);
		journal.close = async () => {
			gate.closes += 1;
			await close();
			if (gate.closeFailure !== undefined) throw gate.closeFailure;
		};
		return journal;
	},
};
