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
	try_lock_file_shared, try_shared_advisory_lock,
};

/// Set in the child process that takes the lock at this path and holds it until it is killed.
const HOLD_ENV: &str = "ATOMIC_ADVISORY_LOCK_TEST_HOLD";
const HOLD_SHARED_ENV: &str = "ATOMIC_SHARED_ADVISORY_LOCK_TEST_HOLD";

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

#[cfg(windows)]
#[test]
fn denied_write_access_is_an_error_not_lock_contention_5317() {
	let dir = scratch();
	let path = dir.join("readonly.lock");
	fs::write(&path, "").unwrap();
	let mut permissions = fs::metadata(&path).unwrap().permissions();
	permissions.set_readonly(true);
	fs::set_permissions(&path, permissions.clone()).unwrap();
	let exclusive = try_advisory_lock(path.to_string_lossy().into_owned(), 0);
	let shared = try_shared_advisory_lock(path.to_string_lossy().into_owned(), 0);
	permissions.set_readonly(false);
	fs::set_permissions(&path, permissions).unwrap();
	fs::remove_dir_all(dir).unwrap();
	assert!(
		exclusive.is_err(),
		"the existing exclusive lock API must preserve a denied-write error"
	);
	assert!(shared.is_err(), "the shared lock API must preserve a denied-write error");
}

#[cfg(windows)]
fn set_test_dacl(path: &std::path::Path, definition: &str) -> std::io::Result<()> {
	use std::os::windows::ffi::OsStrExt;
	use windows_sys::Win32::{
		Foundation::LocalFree,
		Security::{
			Authorization::{
				ConvertStringSecurityDescriptorToSecurityDescriptorW, SE_FILE_OBJECT,
				SetNamedSecurityInfoW,
			},
			DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, PROTECTED_DACL_SECURITY_INFORMATION,
		},
	};
	let definition: Vec<u16> = definition.encode_utf16().chain(Some(0)).collect();
	let mut descriptor = std::ptr::null_mut();
	if unsafe {
		ConvertStringSecurityDescriptorToSecurityDescriptorW(
			definition.as_ptr(),
			1,
			&mut descriptor,
			std::ptr::null_mut(),
		)
	} == 0
	{
		return Err(std::io::Error::last_os_error());
	}
	let result = (|| {
		let mut present = 0;
		let mut defaulted = 0;
		let mut dacl = std::ptr::null_mut();
		if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
			== 0
		{
			return Err(std::io::Error::last_os_error());
		}
		let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
		let error = unsafe {
			SetNamedSecurityInfoW(
				wide.as_ptr(),
				SE_FILE_OBJECT,
				DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				dacl,
				std::ptr::null(),
			)
		};
		if error == 0 { Ok(()) } else { Err(std::io::Error::from_raw_os_error(error as i32)) }
	})();
	unsafe { LocalFree(descriptor) };
	result
}

#[cfg(windows)]
#[test]
fn acl_denied_lock_path_is_an_error_not_contention_5317() {
	struct RestoreDacl(PathBuf);
	impl Drop for RestoreDacl {
		fn drop(&mut self) {
			let _ = set_test_dacl(&self.0, "D:P(A;;FA;;;WD)");
		}
	}
	let dir = scratch();
	let path = dir.join("denied.lock");
	fs::write(&path, "").unwrap();
	let restore = RestoreDacl(path.clone());
	set_test_dacl(&path, "D:P(D;;0x1ff;;;WD)(A;;FA;;;WD)").unwrap();
	let exclusive = try_advisory_lock(path.to_string_lossy().into_owned(), 0);
	let shared = try_shared_advisory_lock(path.to_string_lossy().into_owned(), 0);
	drop(restore);
	fs::remove_dir_all(dir).unwrap();
	assert!(exclusive.is_err(), "an ACL denial must remain an exclusive-lock error");
	assert!(shared.is_err(), "an ACL denial must remain a shared-lock error");
}

#[cfg(windows)]
#[test]
fn delete_pending_is_contention_until_its_last_handle_closes_5317() {
	use std::os::windows::ffi::OsStrExt;
	use windows_sys::Win32::Storage::FileSystem::DeleteFileW;
	let dir = scratch();
	let path = dir.join("pending.lock");
	let held = fs::File::create(&path).unwrap();
	let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
	assert_ne!(unsafe { DeleteFileW(wide.as_ptr()) }, 0);
	let exclusive = try_advisory_lock(path.to_string_lossy().into_owned(), 0);
	let shared = try_shared_advisory_lock(path.to_string_lossy().into_owned(), 0);
	let waiting_path = path.clone();
	let (started, waiting) = std::sync::mpsc::channel();
	let waiter = thread::spawn(move || {
		started.send(()).unwrap();
		try_lock_file_shared(&waiting_path, Duration::from_secs(10))
	});
	waiting.recv().unwrap();
	thread::sleep(Duration::from_millis(20));
	drop(held);
	assert!(
		exclusive.unwrap().is_none(),
		"a pending deletion is not a permanent exclusive-lock error"
	);
	assert!(shared.unwrap().is_none(), "a pending deletion is not a permanent shared-lock error");
	let acquired = waiter.join().unwrap().unwrap();
	assert!(acquired.is_some(), "a pending opener recreates the path after the last handle closes");
	drop(acquired);
	fs::remove_dir_all(dir).unwrap();
}

/// Not a test of its own: the child process of the kill test, which holds the lock until it is killed.
#[test]
fn advisory_lock_holder_child() {
	if let Some(path) = std::env::var_os(HOLD_SHARED_ENV) {
		let _held = try_lock_file_shared(PathBuf::from(path).as_path(), Duration::ZERO)
			.unwrap()
			.expect("the child takes the shared lock");
		println!("held");
		loop {
			thread::sleep(Duration::from_secs(60));
		}
	}
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

#[test]
fn shared_locks_coexist_and_refuse_exclusive_lock_until_all_release_or_die_5317() {
	let dir = scratch();
	let path = dir.join("open.lock");
	let first = try_shared_advisory_lock(path.to_string_lossy().into_owned(), 0)
		.unwrap()
		.expect("first shared holder");
	let second = try_lock_file_shared(&path, Duration::ZERO).unwrap().expect("second shared holder");
	let mut child = Command::new(std::env::current_exe().unwrap())
		.args(["--exact", "advisory_lock_holder_child", "--nocapture", "--test-threads=1"])
		.env(HOLD_SHARED_ENV, &path)
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.spawn()
		.unwrap();
	let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
	assert!(lines.any(|line| line.is_ok_and(|line| line.trim_end().ends_with("held"))));
	assert!(try_lock_file(&path, Duration::ZERO).unwrap().is_none());
	let mut first = first;
	first.release();
	assert!(try_lock_file(&path, Duration::ZERO).unwrap().is_none());
	drop(second);
	assert!(try_lock_file(&path, Duration::ZERO).unwrap().is_none());
	child.kill().unwrap();
	child.wait().unwrap();
	let exclusive = try_lock_file(&path, Duration::from_secs(10))
		.unwrap()
		.expect("exclusive lock succeeds once all shared holders release or die");
	assert!(try_lock_file_shared(&path, Duration::ZERO).unwrap().is_none());
	drop(exclusive);
	fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lock_reopens_current_path_when_previous_file_was_unlinked_5317() {
	let dir = scratch();
	let path = dir.join("unlinked.lock");
	let exclusive = try_lock_file(&path, Duration::ZERO).unwrap().expect("initial holder");
	let lock_path = path.clone();
	let waiter = thread::spawn(move || {
		try_lock_file_shared(&lock_path, Duration::from_secs(10))
			.unwrap()
			.expect("waiter locks replacement file")
	});
	thread::sleep(Duration::from_millis(20));
	fs::remove_file(&path).unwrap();
	drop(exclusive);
	let shared = waiter.join().unwrap();
	assert!(path.is_file(), "reopened replacement lock file exists at path");
	assert!(
		try_lock_file(&path, Duration::ZERO).unwrap().is_none(),
		"shared lock is held on the file currently at path"
	);
	drop(shared);
	fs::remove_dir_all(dir).unwrap();
}
