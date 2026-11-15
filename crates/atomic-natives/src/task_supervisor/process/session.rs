//! A command's whole process tree on Linux and macOS: every process in the session its leader starts (#5057).
//!
//! Each command runs as the leader of a new session, so the session ID equals the leader's PID. Descendants stay in
//! that session when they move to another process group (GNU `timeout`, `set -m` job control), and leave it only by
//! starting a session of their own (`setsid`), which is the documented way out of a command's cleanup. The kernel does
//! not reuse a PID while it still names a session that has members, so the session ID stays this command's until its
//! last member is gone.
//!
//! Members are found in a delegated cgroup, frozen while it is listed (see `cgroup`), or else by scanning every
//! process. A scan can miss a member that forks and exits while it runs, so a scan that finds none counts only once
//! [`SCAN_CONFIRMATIONS`] consecutive scans agree, and a member that a scan does find after the final SIGKILL is
//! killed again. A process that keeps doing so faster than a scan can still outrun it; cleanup then stays unconfirmed
//! rather than reporting `reaped`.
use std::cell::Cell;
use std::io;

/// Consecutive empty scans that confirm a session empty when no frozen cgroup lists it.
const SCAN_CONFIRMATIONS: u32 = 3;

/// Runs `each` on the PID of every process the kernel lists, zombies included, and returns how many it accepted. On
/// Linux the list is read as it goes, a few entries per call: a process forked meanwhile gets a PID above its
/// parent's, so a member that keeps replacing itself with a child is reached unless it lands just inside the few
/// entries already read ahead. Where no process list can be read, as in a sandbox without `/proc`, there are none.
#[cfg(target_os = "linux")]
fn each_pid(mut each: impl FnMut(libc::pid_t) -> bool) -> usize {
	let fd = unsafe {
		libc::open(c"/proc".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
	};
	if fd < 0 {
		return 0;
	}
	let fd = unsafe { <std::os::fd::OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fd) };
	// About sixteen entries per call, so that the read-ahead stays short.
	let mut buffer = [0u64; 64];
	let mut accepted = 0;
	loop {
		let read = unsafe {
			libc::syscall(
				libc::SYS_getdents64,
				std::os::fd::AsRawFd::as_raw_fd(&fd),
				buffer.as_mut_ptr(),
				std::mem::size_of_val(&buffer),
			)
		};
		if read <= 0 {
			return accepted;
		}
		let bytes =
			unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), read as usize) };
		let mut offset = 0;
		// struct linux_dirent64 { u64 d_ino; i64 d_off; u16 d_reclen; u8 d_type; char d_name[]; }
		while offset + 19 <= bytes.len() {
			let length = u16::from_ne_bytes([bytes[offset + 16], bytes[offset + 17]]) as usize;
			if length == 0 {
				break;
			}
			let name = &bytes[offset + 19..(offset + length).min(bytes.len())];
			let name = &name[..name.iter().position(|&byte| byte == 0).unwrap_or(name.len())];
			if let Some(pid) =
				std::str::from_utf8(name).ok().and_then(|name| name.parse::<libc::pid_t>().ok())
				&& each(pid)
			{
				accepted += 1;
			}
			offset += length;
		}
	}
}
#[cfg(target_os = "macos")]
fn each_pid(mut each: impl FnMut(libc::pid_t) -> bool) -> usize {
	let pids = loop {
		let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
		if count < 0 {
			return 0;
		}
		// Room for processes started between the two calls; a full buffer means it may have been too small.
		let capacity = count as usize + 64;
		let mut pids = vec![0 as libc::pid_t; capacity];
		let bytes = (capacity * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
		let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
		if listed < 0 {
			return 0;
		}
		if (listed as usize) < capacity {
			pids.truncate(listed as usize);
			break pids;
		}
	};
	pids.into_iter().filter(|&pid| each(pid)).count()
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn each_pid(_each: impl FnMut(libc::pid_t) -> bool) -> usize {
	0
}

/// Whether `pid` is in `session` but outside its leader's process group, which the caller signals as a group.
fn outside_group(session: libc::pid_t, pid: libc::pid_t) -> bool {
	pid > 0 && unsafe { libc::getsid(pid) } == session && unsafe { libc::getpgid(pid) } != session
}

/// Sends `signal` (0 probes) to every member of `session` outside its leader's process group that a scan of every
/// process finds, and returns how many accepted it.
pub(super) fn signal_outside_group(session: libc::pid_t, signal: libc::c_int) -> usize {
	each_pid(|pid| outside_group(session, pid) && signal_member(session, pid, signal))
}

/// One command's session, and the cgroup it runs in where there is one.
pub(super) struct Tree {
	session: libc::pid_t,
	#[cfg(target_os = "linux")]
	cgroup: Option<super::cgroup::Cgroup>,
	/// The leader entered the cgroup before exec, so every member is in it; otherwise (a PTY moved in after spawn)
	/// processes are scanned as well.
	#[cfg(target_os = "linux")]
	complete: bool,
	empty_scans: Cell<u32>,
}
impl Tree {
	pub(super) fn new(session: libc::pid_t) -> Self {
		Self {
			session,
			#[cfg(target_os = "linux")]
			cgroup: None,
			#[cfg(target_os = "linux")]
			complete: false,
			empty_scans: Cell::new(0),
		}
	}
	#[cfg(target_os = "linux")]
	pub(super) fn with_cgroup(mut self, cgroup: super::cgroup::Cgroup, complete: bool) -> Self {
		self.cgroup = Some(cgroup);
		self.complete = complete;
		self
	}
	#[cfg(target_os = "linux")]
	pub(super) fn cgroup(&self) -> Option<&super::cgroup::Cgroup> {
		self.cgroup.as_ref()
	}
	/// Sends `signal` to every member outside the leader's process group, and returns how many accepted it.
	pub(super) fn signal_outside_group(&self, signal: libc::c_int) -> usize {
		let session = self.session;
		#[cfg(target_os = "linux")]
		if let Some(cgroup) = &self.cgroup {
			let frozen = cgroup
				.frozen_members(|pid| {
					outside_group(session, pid) && signal_member(session, pid, signal)
				})
				.ok();
			if let Some(accepted) = frozen
				&& self.complete
			{
				return accepted;
			}
			return frozen.unwrap_or(0) + signal_outside_group(session, signal);
		}
		signal_outside_group(session, signal)
	}
	/// How many members outside the leader's group are left. A scan that finds none answers 0 only once
	/// [`SCAN_CONFIRMATIONS`] consecutive scans agree; a frozen cgroup's list is complete at once.
	pub(super) fn members(&self) -> usize {
		let found = self.signal_outside_group(0);
		#[cfg(target_os = "linux")]
		if self.cgroup.is_some() && self.complete {
			return found;
		}
		if found > 0 {
			self.empty_scans.set(0);
			return found;
		}
		self.empty_scans.set(self.empty_scans.get() + 1);
		usize::from(self.empty_scans.get() < SCAN_CONFIRMATIONS)
	}
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

/// An identity for `pid` that a reused PID does not share: its start time, in clock ticks since boot on Linux and in
/// microseconds since the epoch on macOS. None once the process is gone.
pub(super) fn start_time(pid: libc::pid_t) -> Option<u64> {
	#[cfg(target_os = "linux")]
	{
		let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
		// Field 22; the command name before it may hold spaces and parentheses, so count from its closing one.
		stat.rsplit_once(") ")?.1.split_whitespace().nth(19)?.parse().ok()
	}
	#[cfg(target_os = "macos")]
	{
		let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
		let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
		let read = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTBSDINFO,
				0,
				(&mut info as *mut libc::proc_bsdinfo).cast(),
				size,
			)
		};
		(read == size).then(|| info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
	}
	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	{
		let _ = pid;
		None
	}
}
