//! Removes command output spools left behind by Atomic processes that have exited (#3313).
use std::{fs, path::Path, sync::Once, time::UNIX_EPOCH};
use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

const SPOOL_PREFIX: &str = "atomic-command-";
/// A process started this long after a spool was last written cannot have written it.
const PID_REUSE_SLACK_SECS: u64 = 2;

static SWEEP: Once = Once::new();

pub(super) fn sweep_orphaned_spools_once() {
	SWEEP.call_once(|| {
		let _ = std::thread::Builder::new()
			.name("spool-sweep".into())
			.spawn(|| sweep_orphaned_spools(&std::env::temp_dir(), std::process::id()));
	});
}

fn spool_owner_pid(name: &str) -> Option<u32> {
	let rest = name.strip_prefix(SPOOL_PREFIX)?;
	let digits = rest.split_once('-')?.0;
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	digits.parse().ok()
}

/// Seconds since the epoch at which `pid` started, or `None` when no live process has that PID.
fn live_process_start(system: &mut System, pid: u32) -> Option<u64> {
	let pid = Pid::from_u32(pid);
	system.refresh_processes_specifics(
		ProcessesToUpdate::Some(&[pid]),
		false,
		ProcessRefreshKind::nothing(),
	);
	system
		.process(pid)
		.filter(|process| !matches!(process.status(), ProcessStatus::Zombie | ProcessStatus::Dead))
		.map(sysinfo::Process::start_time)
}

fn spool_is_orphaned(owner_start: Option<u64>, last_written: u64) -> bool {
	match owner_start {
		None => true,
		Some(started) => started > last_written + PID_REUSE_SLACK_SECS,
	}
}

pub(super) fn sweep_orphaned_spools(directory: &Path, current_pid: u32) -> usize {
	let Ok(entries) = fs::read_dir(directory) else {
		return 0;
	};
	let mut system = System::new();
	let mut removed = 0;
	for entry in entries.flatten() {
		let name = entry.file_name();
		let Some(pid) = name.to_str().and_then(spool_owner_pid) else {
			continue;
		};
		if pid == current_pid {
			continue;
		}
		let Ok(metadata) = entry.metadata() else {
			continue;
		};
		if !metadata.is_file() {
			continue;
		}
		let last_written = metadata
			.modified()
			.ok()
			.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
			.map_or(0, |elapsed| elapsed.as_secs());
		if spool_is_orphaned(live_process_start(&mut system, pid), last_written)
			&& fs::remove_file(entry.path()).is_ok()
		{
			removed += 1;
		}
	}
	removed
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::time::SystemTime;

	#[test]
	fn owner_pid_is_parsed_only_from_spool_names() {
		assert_eq!(spool_owner_pid("atomic-command-4242-task-1.123-abc"), Some(4242));
		assert_eq!(spool_owner_pid("atomic-command-frozen.123-abc"), None);
		assert_eq!(spool_owner_pid("atomic-command--task"), None);
		assert_eq!(spool_owner_pid("other-4242-task"), None);
	}

	#[test]
	fn spool_of_a_reused_pid_is_orphaned_but_a_live_writer_is_not() {
		assert!(spool_is_orphaned(None, 100));
		assert!(spool_is_orphaned(Some(200), 100));
		assert!(!spool_is_orphaned(Some(100), 150));
		assert!(!spool_is_orphaned(Some(101), 100));
	}

	#[test]
	fn sweep_removes_dead_process_spools_and_keeps_live_ones() {
		let directory = std::env::temp_dir().join(format!(
			"atomic-spool-sweep-{}-{}",
			std::process::id(),
			SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
		));
		fs::create_dir_all(&directory).unwrap();
		let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
			.args(if cfg!(windows) { &["/C", "exit"][..] } else { &[][..] })
			.spawn()
			.unwrap();
		let dead_pid = child.id();
		child.wait().unwrap();
		let dead = directory.join(format!("{SPOOL_PREFIX}{dead_pid}-task-0.1-ff"));
		let own = directory.join(format!("{SPOOL_PREFIX}{}-task-0.1-ff", std::process::id()));
		let unrelated = directory.join("atomic-command-frozen.1-ff");
		for path in [&dead, &own, &unrelated] {
			fs::write(path, b"output").unwrap();
		}
		let removed = sweep_orphaned_spools(&directory, std::process::id());
		let dead_exists = dead.exists();
		let own_exists = own.exists();
		let unrelated_exists = unrelated.exists();
		fs::remove_dir_all(&directory).unwrap();
		assert_eq!(removed, 1);
		assert!(!dead_exists, "spool of an exited process was kept");
		assert!(own_exists, "sweep removed the current process's spool");
		assert!(unrelated_exists, "sweep removed a file it does not own");
	}
}
