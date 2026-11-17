export function localShipRows(database) {
	const current = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ship_rows'").get();
	const table = current === undefined ? "ship_events" : "ship_rows";
	return database.prepare(`SELECT work, generation, COUNT(*) AS n FROM ${table} GROUP BY work, generation`).all();
}
