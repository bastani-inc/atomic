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

fn is_digits(text: &str) -> bool {
	!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Owner PID of a complete spool name,
/// `atomic-command-<pid>-task-<environment>-<owner>-<task>.<nanos>-<32 hex>`.
/// Any other name, even one sharing the prefix, is not a spool this sweep owns.
fn spool_owner_pid(name: &str) -> Option<u32> {
	let (pid, rest) = name.strip_prefix(SPOOL_PREFIX)?.split_once('-')?;
	let (task, suffix) = rest.strip_prefix("task-")?.split_once('.')?;
	let (timestamp, random) = suffix.split_once('-')?;
	let task_parts: Vec<&str> = task.split('-').collect();
	let is_spool = is_digits(pid)
		&& task_parts.len() == 3
		&& task_parts.iter().all(|part| is_digits(part))
		&& is_digits(timestamp)
		&& random.len() == 32
		&& random.bytes().all(|byte| byte.is_ascii_hexdigit());
	if is_spool { pid.parse().ok() } else { None }
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

	fn spool_name(pid: u32) -> String {
		let base = std::path::PathBuf::from(format!("{SPOOL_PREFIX}{pid}-task-7-0-3"));
		let spool = super::super::spool_candidate_at(&base, 123_456_789).unwrap();
		spool.file_name().unwrap().to_str().unwrap().to_owned()
	}

	#[test]
	fn owner_pid_is_parsed_only_from_spool_names() {
		let random = "0123456789abcdef0123456789abcdef";
		assert_eq!(spool_owner_pid(&spool_name(4242)), Some(4242));
		assert_eq!(
			spool_owner_pid(&format!("atomic-command-4242-task-1-2-3.9-{random}")),
			Some(4242)
		);
		assert_eq!(spool_owner_pid("atomic-command-frozen.123-abc"), None);
		assert_eq!(spool_owner_pid("atomic-command--task"), None);
		assert_eq!(spool_owner_pid("other-4242-task"), None);
		assert_eq!(spool_owner_pid("atomic-command-4242-notes.txt"), None);
		assert_eq!(spool_owner_pid("atomic-command-4242-task-1-2-3"), None);
		assert_eq!(spool_owner_pid("atomic-command-4242-task-1-2-3.9-abc"), None);
		assert_eq!(spool_owner_pid(&format!("atomic-command-4242-task-1-2.9-{random}")), None);
		assert_eq!(spool_owner_pid(&format!("atomic-command-4242-task-1-2-3.9-{random}.bak")), None);
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
		let dead = directory.join(spool_name(dead_pid));
		let own = directory.join(spool_name(std::process::id()));
		let unrelated = directory.join("atomic-command-frozen.1-ff");
		let foreign = directory.join(format!("{SPOOL_PREFIX}{dead_pid}-notes.txt"));
		for path in [&dead, &own, &unrelated, &foreign] {
			fs::write(path, b"output").unwrap();
		}
		let removed = sweep_orphaned_spools(&directory, std::process::id());
		let dead_exists = dead.exists();
		let own_exists = own.exists();
		let unrelated_exists = unrelated.exists();
		let foreign_exists = foreign.exists();
		fs::remove_dir_all(&directory).unwrap();
		assert_eq!(removed, 1);
		assert!(!dead_exists, "spool of an exited process was kept");
		assert!(own_exists, "sweep removed the current process's spool");
		assert!(unrelated_exists, "sweep removed a file it does not own");
		assert!(foreign_exists, "sweep removed a non-spool file of an exited PID");
	}
}
