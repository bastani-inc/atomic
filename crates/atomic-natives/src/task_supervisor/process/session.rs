//! A command's whole process tree on Linux and macOS: every process in the session its leader starts (#5057).
//!
//! Each command runs as the leader of a new session, so the session ID equals the leader's PID. Descendants stay in
//! that session when they move to another process group (GNU `timeout`, `set -m` job control), and leave it only by
//! starting a session of their own (`setsid`), which is the documented way out of a command's cleanup. The kernel does
//! not reuse a PID while it still names a session that has members, so the session ID stays this command's until its
//! last member is gone.
use std::io;

/// The PIDs of every process, zombies included, that the kernel lists. A process that exits meanwhile may be missing.
#[cfg(target_os = "linux")]
fn all_pids() -> io::Result<Vec<libc::pid_t>> {
	Ok(std::fs::read_dir("/proc")?
		.filter_map(Result::ok)
		.filter_map(|entry| entry.file_name().to_str()?.parse::<libc::pid_t>().ok())
		.collect())
}
#[cfg(target_os = "macos")]
fn all_pids() -> io::Result<Vec<libc::pid_t>> {
	loop {
		let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
		if count < 0 {
			return Err(io::Error::last_os_error());
		}
		// Room for processes started between the two calls; a full buffer means it may have been too small.
		let capacity = count as usize + 64;
		let mut pids = vec![0 as libc::pid_t; capacity];
		let bytes = (capacity * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
		let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
		if listed < 0 {
			return Err(io::Error::last_os_error());
		}
		if (listed as usize) < capacity {
			pids.truncate(listed as usize);
			return Ok(pids);
		}
	}
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn all_pids() -> io::Result<Vec<libc::pid_t>> {
	Ok(Vec::new())
}

/// The session's members outside the leader's own process group, which the caller signals as a group.
/// Where no process list can be read, as in a sandbox without `/proc`, that is none: cleanup then covers the leader's
/// process group only, as it did before sessions were tracked.
fn outside_group(session: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
	Ok(all_pids()
		.unwrap_or_default()
		.into_iter()
		.filter(|&pid| pid > 0 && unsafe { libc::getsid(pid) } == session)
		.filter(|&pid| unsafe { libc::getpgid(pid) } != session)
		.collect())
}

/// Sends `signal` (0 probes) to every member of `session` outside its leader's process group, and returns how many
/// accepted it. A member that exits meanwhile is skipped.
pub(super) fn signal_outside_group(session: libc::pid_t, signal: libc::c_int) -> io::Result<usize> {
	let mut accepted = 0;
	for pid in outside_group(session)? {
		if signal_member(session, pid, signal) {
			accepted += 1;
		}
	}
	Ok(accepted)
}

/// Signals one member, rechecking its session through a pidfd on Linux, so that a PID freed and handed to a process
/// outside the session between the scan and the signal is never reached.
fn signal_member(session: libc::pid_t, pid: libc::pid_t, signal: libc::c_int) -> bool {
	#[cfg(target_os = "linux")]
	{
		use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
		let fd =
			unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::c_long, 0 as libc::c_long) };
		if fd >= 0 {
			let pidfd = unsafe { OwnedFd::from_raw_fd(fd as std::os::fd::RawFd) };
			if unsafe { libc::getsid(pid) } != session {
				return false;
			}
			let sent = unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					pidfd.as_raw_fd() as libc::c_long,
					signal as libc::c_long,
					std::ptr::null::<libc::siginfo_t>(),
					0 as libc::c_long,
				)
			};
			return sent == 0;
		}
		let error = io::Error::last_os_error().raw_os_error();
		if error == Some(libc::ESRCH) {
			return false;
		}
	}
	// Without a pidfd, recheck just before the signal, which narrows the window to the two calls.
	if unsafe { libc::getsid(pid) } != session {
		return false;
	}
	// EPERM still names a live member, as a zombie on macOS does.
	let sent = unsafe { libc::kill(pid, signal) };
	sent == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
