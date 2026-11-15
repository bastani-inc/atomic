//! Ends supervised commands' sessions when the host process dies (#5057).
//!
//! A host killed with SIGKILL, by the OOM killer, or by an exit that skips owner close cannot clean up its commands.
//! One small `/bin/sh` guardian per host, in a session of its own, holds the read end of a socket whose only write
//! end the host holds. The host tells it which sessions to watch. When the host dies the kernel closes its end, the
//! guardian reads end-of-file and kills every process still in a watched session, then exits.
//!
//! A session ID names one session only while it has members; once the last is gone a new process with that PID can
//! lead an unrelated session. So a session is unwatched as soon as its cleanup confirms it empty, and the guardian
//! records the leader's start time when it is told to watch it and skips a session whose leader PID now names a
//! different process. A guardian that dies first (a command ran `pkill sh`) closes its end of the socket; the host
//! notices at once, starts another and tells it every session still watched.
use std::collections::BTreeMap;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

/// Reads `+ <sid> <cgroup or -> [<start time, for tests>]` and `- <sid>` lines until end-of-file. On `+` it records the leader's start time
/// (field 22 of `/proc/<sid>/stat` on Linux, `ps -o lstart=` elsewhere). At end-of-file it keeps each session whose
/// leader is gone or still has that start time, freezes the session's cgroup if it has one and kills the members it
/// lists, then SIGKILLs every process in those sessions with `pkill -s` (or, without it, a `/proc` scan) until three
/// passes in a row find none, so that a member that forks while a pass runs is still found.
const SCRIPT: &str = r#"trap '' HUP INT QUIT TERM PIPE TSTP TTIN TTOU
ident() {
	v=
	if [ -r /proc/self/stat ]; then
		read -r l < "/proc/$1/stat" && set -- ${l##*) } && v=${20}
	else
		v=$(ps -o lstart= -p "$1")
	fi
}
s=' '
while read -r op id cg recorded; do
	case $op in
	+) case $s in *" $id "*) ;; *) s="$s$id "; ident "$id"; v=${recorded:-$v}; eval "i_$id=\$v; c_$id=\$cg" ;; esac ;;
	-) case $s in *" $id "*) s="${s%% $id *} ${s#* $id }" ;; esac ;;
	esac
done
k=' '
for id in $s; do
	ident "$id"
	eval "w=\$i_$id"
	if [ -z "$v" ] || [ "$v" = "$w" ]; then k="$k$id "; fi
done
[ "$k" = ' ' ] && exit 0
for id in $k; do
	eval "cg=\$c_$id"
	[ -n "$cg" ] && [ "$cg" != - ] && [ -w "$cg/cgroup.freeze" ] || continue
	echo 1 > "$cg/cgroup.freeze"
	f=0; n=0
	while [ "$f" != 1 ] && [ $n -lt 2000 ]; do
		while read -r key val; do [ "$key" = frozen ] && f=$val; done < "$cg/cgroup.events"
		n=$((n+1))
	done
	while read -r p; do
		read -r l < "/proc/$p/stat" || continue
		set -- ${l##*) }
		[ "$4" = "$id" ] && kill -KILL "$p"
	done < "$cg/cgroup.procs"
	echo 0 > "$cg/cgroup.freeze"
	rmdir "$cg"
done
quiet=0; pass=0
while [ $quiet -lt 3 ] && [ $pass -lt 50 ]; do
	pass=$((pass+1)); hit=0
	if command -v pkill >/dev/null; then
		for id in $k; do pkill -KILL -s "$id" && hit=1; done
	elif [ -r /proc/self/stat ]; then
		for f in /proc/[0-9]*/stat; do
			read -r l < "$f" || continue
			set -- ${l##*) }
			case $k in *" $4 "*) p=${f#/proc/}; kill -KILL "${p%/stat}" && hit=1 ;; esac
		done
	fi
	if [ $hit = 1 ]; then quiet=0; else quiet=$((quiet+1)); fi
done
"#;

struct Guardian {
	child: Child,
	host: UnixStream,
}
/// What the host knows of a watched session: its leader's start time and its cgroup.
struct Watched {
	start: Option<u64>,
	cgroup: Option<PathBuf>,
}
struct State {
	guardian: Option<Guardian>,
	watched: BTreeMap<libc::pid_t, Watched>,
}
static STATE: Mutex<State> = Mutex::new(State { guardian: None, watched: BTreeMap::new() });

fn lock() -> std::sync::MutexGuard<'static, State> {
	STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn line(session: libc::pid_t, watched: &Watched) -> String {
	let cgroup =
		watched.cgroup.as_ref().map_or_else(|| "-".into(), |path| path.display().to_string());
	format!("+ {session} {cgroup}\n")
}

fn spawn() -> io::Result<Guardian> {
	use std::os::unix::process::CommandExt;
	let (host, guardian) = UnixStream::pair()?;
	#[cfg(target_os = "macos")]
	{
		let on: libc::c_int = 1;
		unsafe {
			libc::setsockopt(
				host.as_raw_fd(),
				libc::SOL_SOCKET,
				libc::SO_NOSIGPIPE,
				(&on as *const libc::c_int).cast(),
				std::mem::size_of::<libc::c_int>() as libc::socklen_t,
			)
		};
	}
	host.set_nonblocking(true)?;
	let mut command = Command::new("/bin/sh");
	command
		.arg("-c")
		.arg(SCRIPT)
		.stdin(Stdio::from(std::os::fd::OwnedFd::from(guardian)))
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.current_dir("/");
	// A session of its own: terminal signals and the host's process-group signals never reach it.
	unsafe {
		command.pre_exec(|| {
			if libc::setsid() < 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(())
		});
	}
	let child = command.spawn()?;
	let monitor = host.try_clone();
	let id = child.id();
	if let Ok(monitor) = monitor {
		let _ = std::thread::Builder::new()
			.name("task-guardian".into())
			.spawn(move || replace_when_dead(&monitor, id));
	}
	Ok(Guardian { child, host })
}

/// Waits until the guardian `id` closes its end of the socket, which it does only by exiting, then starts another
/// for the sessions still watched, unless the host replaced it meanwhile.
fn replace_when_dead(monitor: &UnixStream, id: u32) {
	let mut poll = libc::pollfd { fd: monitor.as_raw_fd(), events: libc::POLLIN, revents: 0 };
	loop {
		let ready = unsafe { libc::poll(&mut poll, 1, -1) };
		if ready > 0 {
			break;
		}
		if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
			return;
		}
	}
	// A guardian that cannot start at all must not be restarted in a tight loop.
	std::thread::sleep(Duration::from_millis(20));
	let mut state = lock();
	if state.guardian.as_ref().is_none_or(|guardian| guardian.child.id() != id) {
		return;
	}
	if let Some(mut dead) = state.guardian.take() {
		let _ = dead.child.kill();
		let _ = dead.child.wait();
	}
	if !state.watched.is_empty() {
		let _ = guardian(&mut state);
	}
}

/// Drops a guardian that can no longer be told what to watch. SIGKILL first: closing the socket while it lives would
/// read as the host's death and kill every watched session.
fn discard(state: &mut State) {
	if let Some(mut guardian) = state.guardian.take() {
		let _ = guardian.child.kill();
		let _ = guardian.child.wait();
	}
}

fn send(guardian: &mut Guardian, line: &str) -> bool {
	let bytes = line.as_bytes();
	#[cfg(target_os = "linux")]
	{
		let sent = unsafe {
			libc::send(
				guardian.host.as_raw_fd(),
				bytes.as_ptr().cast(),
				bytes.len(),
				libc::MSG_NOSIGNAL,
			)
		};
		sent == bytes.len() as isize
	}
	#[cfg(not(target_os = "linux"))]
	{
		use std::io::Write;
		guardian.host.write_all(bytes).is_ok()
	}
}

/// A live guardian that has every watched session, starting one when there is none or the last one died.
fn guardian(state: &mut State) -> Option<&mut Guardian> {
	let dead = match &mut state.guardian {
		Some(guardian) => !matches!(guardian.child.try_wait(), Ok(None)),
		None => true,
	};
	if dead {
		discard(state);
		state.guardian = Some(spawn().ok()?);
		let lines: String =
			state.watched.iter().map(|(session, watched)| line(*session, watched)).collect();
		if !lines.is_empty() && !send(state.guardian.as_mut()?, &lines) {
			discard(state);
			return None;
		}
	}
	state.guardian.as_mut()
}

/// Kills `session`, and every process its cgroup lists in it, if the host dies before [`unwatch`]. Best effort:
/// without a guardian the command still runs. Must run while the leader is unreaped, so that its start time is its own.
pub(super) fn watch(session: libc::pid_t, cgroup: Option<PathBuf>) {
	let mut state = lock();
	if state.watched.contains_key(&session) {
		return;
	}
	let watched = Watched { start: super::session::start_time(session), cgroup };
	let entry = line(session, &watched);
	let sent = guardian(&mut state).is_none_or(|guardian| send(guardian, &entry));
	state.watched.insert(session, watched);
	if !sent {
		// The replacement is told every watched session, this one included.
		discard(&mut state);
		let _ = guardian(&mut state);
	}
}

/// Stops watching `session`, as soon as its cleanup confirmed it empty.
pub(super) fn unwatch(session: libc::pid_t) {
	let mut state = lock();
	if state.watched.remove(&session).is_none() {
		return;
	}
	let sent =
		state.guardian.as_mut().is_none_or(|current| send(current, &format!("- {session}\n")));
	if !sent {
		discard(&mut state);
		if !state.watched.is_empty() {
			let _ = guardian(&mut state);
		}
	}
}

/// Whether `session` is watched; for tests.
#[cfg(test)]
pub(super) fn watching(session: libc::pid_t) -> bool {
	lock().watched.contains_key(&session)
}

/// Synchronously sends SIGKILL to every process in every watched session, for a host about to exit without closing
/// its task owners, skipping a session whose leader PID now names another process. Each session's cleanup still
/// confirms it empty and unwatches it as usual.
pub(super) fn kill_watched() {
	let watched: Vec<(libc::pid_t, Option<u64>)> =
		lock().watched.iter().map(|(session, watched)| (*session, watched.start)).collect();
	for (session, start) in watched {
		kill_session(session, start);
	}
}

/// SIGKILLs every process in `session`, unless its leader's PID now names a process that did not start at `start`.
fn kill_session(session: libc::pid_t, start: Option<u64>) {
	let now = super::session::start_time(session);
	if now.is_some() && now != start {
		return;
	}
	let _ = unsafe { libc::kill(-session, libc::SIGKILL) };
	for _ in 0..3 {
		super::session::signal_outside_group(session, libc::SIGKILL);
	}
}

#[cfg(test)]
pub(super) mod testing {
	use super::*;
	/// Starts a guardian of its own, tells it to watch `session` as the host would, and closes the socket as a dying
	/// host does, then waits for it to finish. `recorded` replaces the leader start time the guardian would record,
	/// as when the leader exited and its PID was handed to another process before the host died.
	pub(in crate::task_supervisor) fn guardian_after_host_death(
		session: libc::pid_t,
		recorded: Option<&str>,
	) {
		let mut guardian = spawn().unwrap();
		let line = match recorded {
			Some(start) => format!("+ {session} - {start}\n"),
			None => format!("+ {session} -\n"),
		};
		assert!(send(&mut guardian, &line));
		let Guardian { mut child, host } = guardian;
		// The guardian's monitor holds another descriptor of the socket, so closing this one is not enough.
		let _ = host.shutdown(std::net::Shutdown::Write);
		let _ = child.wait();
	}
	/// What the crash kill does for one watched session whose leader was recorded as starting at `start`.
	pub(in crate::task_supervisor) fn crash_kill(session: libc::pid_t, start: u64) {
		kill_session(session, Some(start));
	}
}
