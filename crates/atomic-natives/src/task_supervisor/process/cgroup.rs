//! A cgroup v2 child per command, where the host's own cgroup is delegated to its user (#5057).
//!
//! A session scan through `/proc` can miss a member that forks and exits while the scan runs. A cgroup closes that
//! gap: freezing it stops every process in it, including any child forked a moment before, so the frozen member list
//! is complete and stable. Members are still selected by session, so processes that started their own session (with
//! `setsid`) are left alone, as everywhere else. Where the host's cgroup is not writable, as under a root-owned login
//! session or in most containers, commands run without one and cleanup relies on the session scan.
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const PREFIX: &str = "atomic-task-";
/// How long a freeze may take before members are listed anyway, as a member in uninterruptible sleep can delay it.
const FREEZE_WAIT: Duration = Duration::from_millis(100);

/// The host's own cgroup directory, when it can hold a command's cgroup.
fn base() -> Option<&'static PathBuf> {
	static BASE: OnceLock<Option<PathBuf>> = OnceLock::new();
	BASE
		.get_or_init(|| {
			if std::env::var_os("ATOMIC_TASK_CGROUP").is_some_and(|value| value == "0") {
				return None;
			}
			let own = fs::read_to_string("/proc/self/cgroup").ok()?;
			let relative = own.lines().find_map(|line| line.strip_prefix("0::"))?;
			if relative.contains(char::is_whitespace) || relative.contains(':') {
				return None;
			}
			let base = Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
			// Moving a process needs write access to the common ancestor's cgroup.procs, and the no-internal-processes
			// rule allows children of a cgroup that holds processes only while it enables no controllers.
			let writable = |path: &Path| {
				std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
					.is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0)
			};
			let usable = writable(&base)
				&& writable(&base.join("cgroup.procs"))
				&& fs::read_to_string(base.join("cgroup.subtree_control"))
					.is_ok_and(|text| text.trim().is_empty());
			if !usable {
				return None;
			}
			sweep(&base);
			Some(base)
		})
		.as_ref()
}

/// Removes empty command cgroups that hosts which died left behind; `rmdir` refuses any that still has a process.
fn sweep(base: &Path) {
	let Ok(entries) = fs::read_dir(base) else { return };
	for entry in entries.filter_map(Result::ok) {
		let name = entry.file_name().to_string_lossy().into_owned();
		let host = name
			.strip_prefix(PREFIX)
			.and_then(|rest| rest.split('-').next()?.parse::<libc::pid_t>().ok());
		// Only a dead host's: a live one's may be empty just before its command moves in.
		let dead = |host: libc::pid_t| {
			let probed = unsafe { libc::kill(host, 0) };
			probed != 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
		};
		if host.is_some_and(dead) {
			let _ = fs::remove_dir(entry.path());
		}
	}
}

pub(super) struct Cgroup {
	path: PathBuf,
}
impl Cgroup {
	/// A new, empty cgroup, and its `cgroup.procs` opened for writing, for a child to move itself into before exec.
	pub(super) fn create() -> Option<(Self, OwnedFd)> {
		static NEXT: AtomicU64 = AtomicU64::new(0);
		let base = base()?;
		let path = base.join(format!(
			"{PREFIX}{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, Ordering::Relaxed)
		));
		fs::create_dir(&path).ok()?;
		let cgroup = Self { path };
		let procs = fs::OpenOptions::new().write(true).open(cgroup.path.join("cgroup.procs")).ok()?;
		// The freezer is what makes the member list complete; without it this cgroup adds nothing.
		cgroup.path.join("cgroup.freeze").exists().then(|| (cgroup, OwnedFd::from(procs)))
	}
	/// Moves the calling process into the cgroup through `procs`. Async-signal-safe, for `pre_exec`; a refusal
	/// leaves the process where it was, which [`Cgroup::holds`] then reports.
	pub(super) fn enter(procs: libc::c_int) {
		let _ = unsafe { libc::write(procs, b"0".as_ptr().cast(), 1) };
	}
	/// Moves a running process in.
	pub(super) fn attach(&self, pid: libc::pid_t) -> bool {
		fs::OpenOptions::new()
			.write(true)
			.open(self.path.join("cgroup.procs"))
			.and_then(|mut procs| procs.write_all(pid.to_string().as_bytes()))
			.is_ok()
	}
	/// Whether `pid` runs in this cgroup.
	pub(super) fn holds(&self, pid: libc::pid_t) -> bool {
		let Ok(own) = fs::read_to_string(format!("/proc/{pid}/cgroup")) else { return false };
		own.lines().filter_map(|line| line.strip_prefix("0::")).any(|relative| {
			Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/')) == self.path
		})
	}
	pub(super) fn path(&self) -> &Path {
		&self.path
	}
	fn freeze(&self, frozen: bool) {
		if fs::write(self.path.join("cgroup.freeze"), if frozen { "1" } else { "0" }).is_err()
			|| !frozen
		{
			return;
		}
		let deadline = Instant::now() + FREEZE_WAIT;
		while Instant::now() < deadline {
			let mut events = String::new();
			let done = fs::File::open(self.path.join("cgroup.events"))
				.and_then(|mut file| file.read_to_string(&mut events))
				.is_ok_and(|_| events.lines().any(|line| line == "frozen 1"));
			if done {
				return;
			}
			std::thread::sleep(Duration::from_micros(200));
		}
	}
	/// Runs `each` on every process in the cgroup while it is frozen, so none can fork or exit meanwhile. A fatal
	/// signal still ends a frozen process; any other is delivered once it thaws. Returns how many `each` accepted.
	pub(super) fn frozen_members(
		&self,
		mut each: impl FnMut(libc::pid_t) -> bool,
	) -> io::Result<usize> {
		self.freeze(true);
		let listed = fs::read_to_string(self.path.join("cgroup.procs"));
		let accepted = listed.map(|text| {
			text.lines().filter_map(|line| line.trim().parse().ok()).filter(|&pid| each(pid)).count()
		});
		self.freeze(false);
		accepted
	}
	/// Removes the cgroup once it is empty. A process that started its own session may still be in it; the cgroup is
	/// then left for a later [`Cgroup::create`] (in any host) to sweep.
	pub(super) fn remove(&self) {
		let _ = fs::remove_dir(&self.path);
	}
}
