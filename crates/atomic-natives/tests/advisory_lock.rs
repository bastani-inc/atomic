//! The operating-system advisory lock behind lock takeovers (#5193): exclusive, bounded in its wait, released on
//! close, and released by the kernel when its holder is killed.
use std::{
	fs,
	io::{BufRead, BufReader},
	path::PathBuf,
	process::{Command, Stdio},
	sync::atomic::{AtomicUsize, Ordering},
	thread,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use atomic_natives::advisory_lock::{
	rename_no_replace, rename_no_replace_napi, try_advisory_lock, try_lock_file,
};

/// Set in the child process that takes the lock at this path and holds it until it is killed.
const HOLD_ENV: &str = "ATOMIC_ADVISORY_LOCK_TEST_HOLD";

fn scratch() -> PathBuf {
	static NEXT: AtomicUsize = AtomicUsize::new(0);
	let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
	let dir = std::env::temp_dir().join(format!(
		"atomic-advisory-lock-{}-{nanos}-{}",
		std::process::id(),
		NEXT.fetch_add(1, Ordering::Relaxed)
	));
	fs::create_dir_all(&dir).unwrap();
	dir
}

#[test]
fn acquires_a_lock_and_creates_its_file_5193() {
	let dir = scratch();
	let path = dir.join("settings.json.lock.takeover.lock");
	let held = try_lock_file(&path, Duration::ZERO).unwrap();
	assert!(held.is_some(), "a free lock is taken at once");
	assert!(path.is_file());
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
	}
	drop(held);
	fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_held_lock_refuses_another_taker_until_it_is_released_5193() {
	let dir = scratch();
	let path = dir.join("held.lock");
	let first = try_lock_file(&path, Duration::ZERO).unwrap().expect("first taker");
	// Another open file of the same process contends like another process would.
	assert!(try_lock_file(&path, Duration::ZERO).unwrap().is_none());
	let started = Instant::now();
	assert!(try_lock_file(&path, Duration::from_millis(60)).unwrap().is_none());
	assert!(
		started.elapsed() >= Duration::from_millis(60),
		"a taker waits for as long as it was given"
	);
	first.unlock().unwrap();
	assert!(
		try_lock_file(&path, Duration::ZERO).unwrap().is_some(),
		"a released lock is taken at once"
	);
	fs::remove_dir_all(dir).unwrap();
}

#[test]
fn closing_the_file_releases_the_lock_and_a_waiting_taker_gets_it_5193() {
	let dir = scratch();
	let path = dir.join("closed.lock");
	let first = try_lock_file(&path, Duration::ZERO).unwrap().expect("first taker");
	let closer = thread::spawn(move || {
		thread::sleep(Duration::from_millis(50));
		drop(first);
	});
	let second = try_lock_file(&path, Duration::from_secs(10)).unwrap();
	closer.join().unwrap();
	assert!(second.is_some(), "a taker that waits gets the lock once its holder closes it");
	fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_lock_in_a_missing_directory_is_an_error_not_contention_5193() {
	let dir = scratch();
	let missing = dir.join("missing").join("x.lock");
	let io_err = try_lock_file(&missing, Duration::ZERO).unwrap_err();
	let code = io_err.raw_os_error().expect("os error code");
	let suffix = format!("(os error {code})");
	let napi_err = try_advisory_lock(missing.to_string_lossy().into_owned(), 0)
		.err()
		.expect("missing dir fails");
	assert_eq!(napi_err.reason, io_err.to_string());
	assert_eq!(napi_err.reason.matches(&suffix).count(), 1);
	let from = dir.join("missing");
	let to = dir.join("elsewhere");
	let rename_io_err = rename_no_replace(&from, &to).unwrap_err();
	let rename_err = rename_no_replace_napi(
		from.to_string_lossy().into_owned(),
		to.to_string_lossy().into_owned(),
	)
	.unwrap_err();
	assert_eq!(rename_err.reason, rename_io_err.to_string());
	fs::remove_dir_all(dir).unwrap();
}

/// Not a test of its own: the child process of the kill test, which holds the lock until it is killed.
#[test]
fn advisory_lock_holder_child() {
	let Some(path) = std::env::var_os(HOLD_ENV) else { return };
	let _held = try_lock_file(PathBuf::from(path).as_path(), Duration::ZERO)
		.unwrap()
		.expect("the child takes the lock");
	println!("held");
	loop {
		thread::sleep(Duration::from_secs(60));
	}
}

#[test]
fn the_kernel_releases_the_lock_of_a_killed_holder_5193() {
	let dir = scratch();
	let path = dir.join("killed.lock");
	let mut child = Command::new(std::env::current_exe().unwrap())
		.args(["--exact", "advisory_lock_holder_child", "--nocapture", "--test-threads=1"])
		.env(HOLD_ENV, &path)
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.spawn()
		.unwrap();
	let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
	assert!(
		lines.any(|line| line.is_ok_and(|line| line.trim_end().ends_with("held"))),
		"the child reports it holds the lock"
	);
	assert!(try_lock_file(&path, Duration::ZERO).unwrap().is_none(), "the child's lock is held");
	// SIGKILL on Unix, TerminateProcess on Windows: the holder never releases the lock itself.
	child.kill().unwrap();
	child.wait().unwrap();
	assert!(
		try_lock_file(&path, Duration::from_secs(10)).unwrap().is_some(),
		"the lock of a killed holder is released by the kernel"
	);
	fs::remove_dir_all(dir).unwrap();
}

#[test]
fn renames_only_while_nothing_is_at_the_target_5193() {
	let dir = scratch();
	let (aside, back) = (dir.join("lock.dead"), dir.join("lock"));
	fs::create_dir(&aside).unwrap();
	fs::create_dir(&back).unwrap();
	assert!(
		!rename_no_replace(&aside, &back).unwrap(),
		"an empty directory at the target is never replaced"
	);
	assert!(aside.is_dir() && back.is_dir());
	fs::remove_dir(&back).unwrap();
	assert!(rename_no_replace(&aside, &back).unwrap(), "a free target is renamed to");
	assert!(!aside.exists() && back.is_dir());
	let (file, taken) = (dir.join("claim.dead"), dir.join("claim"));
	fs::write(&file, "moved").unwrap();
	fs::write(&taken, "live").unwrap();
	assert!(!rename_no_replace(&file, &taken).unwrap(), "a file at the target is never replaced");
	assert_eq!(fs::read_to_string(&taken).unwrap(), "live");
	assert!(rename_no_replace(&dir.join("missing"), &dir.join("elsewhere")).is_err());
	fs::remove_dir_all(dir).unwrap();
}
