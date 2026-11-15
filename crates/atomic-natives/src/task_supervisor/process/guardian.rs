//! Ends supervised commands' sessions when the host process dies (#5057).
//!
//! A host killed with SIGKILL, by the OOM killer, or by an exit that skips owner close cannot clean up its commands.
//! One small `/bin/sh` guardian per host, in a session of its own, holds the read end of a socket whose only write
//! end the host holds. The host tells it which sessions to watch. When the host dies the kernel closes its end, the
//! guardian reads end-of-file and kills every process still in a watched session, then exits. A command's session is
//! unwatched as soon as its cleanup confirms the session empty, so the guardian never reaches a reused session ID.
use std::collections::BTreeSet;
use std::io;
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Reads `+ <sid>` and `- <sid>` lines until end-of-file, then SIGKILLs each watched session three times over, so that
/// a member that forks while the first pass runs is still found. Linux lists sessions in `/proc`; elsewhere `pkill -s`.
const SCRIPT: &str = r#"trap '' HUP INT QUIT TERM PIPE TSTP TTIN TTOU
s=' '
while read -r op id; do
	case $op in
	+) case $s in *" $id "*) ;; *) s="$s$id " ;; esac ;;
	-) case $s in *" $id "*) s="${s%% $id *} ${s#* $id }" ;; esac ;;
	esac
done
[ "$s" = ' ' ] && exit 0
for pass in 1 2 3; do
	if [ -r /proc/self/stat ]; then
		for f in /proc/[0-9]*/stat; do
			read -r l < "$f" || continue
			set -- ${l##*) }
			case $s in *" $4 "*) p=${f#/proc/}; kill -KILL "${p%/stat}" ;; esac
		done
	else
		for id in $s; do pkill -KILL -s "$id"; done
	fi
done
"#;

struct Guardian {
	child: Child,
	host: UnixStream,
}
struct State {
	guardian: Option<Guardian>,
	watched: BTreeSet<libc::pid_t>,
}
static STATE: Mutex<State> = Mutex::new(State { guardian: None, watched: BTreeSet::new() });

fn spawn() -> io::Result<Guardian> {
	use std::os::unix::process::CommandExt;
	let (host, guardian) = UnixStream::pair()?;
	#[cfg(target_os = "macos")]
	{
		use std::os::fd::AsRawFd;
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
	Ok(Guardian { child, host })
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
		use std::os::fd::AsRawFd;
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
		let lines: String = state.watched.iter().map(|sid| format!("+ {sid}\n")).collect();
		if !lines.is_empty() && !send(state.guardian.as_mut()?, &lines) {
			discard(state);
			return None;
		}
	}
	state.guardian.as_mut()
}

/// Kills `session` if the host dies before [`unwatch`]. Best effort: without a guardian the command still runs.
pub(super) fn watch(session: libc::pid_t) {
	let mut state = STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
	if state.watched.contains(&session) {
		return;
	}
	let sent = guardian(&mut state).is_none_or(|guardian| send(guardian, &format!("+ {session}\n")));
	state.watched.insert(session);
	if !sent {
		// Restarted on the next watch with every watched session, this one included.
		discard(&mut state);
	}
}

/// Stops watching `session`, once its cleanup confirmed it empty.
pub(super) fn unwatch(session: libc::pid_t) {
	let mut state = STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
	if !state.watched.remove(&session) {
		return;
	}
	if let Some(guardian) = state.guardian.as_mut()
		&& !send(guardian, &format!("- {session}\n"))
	{
		// Restarted on the next watch with only the sessions still watched.
		discard(&mut state);
	}
}

/// Synchronously sends SIGKILL to every process in every watched session, for a host about to exit without closing
/// its task owners. Each session's cleanup still confirms it empty and unwatches it as usual.
pub(super) fn kill_watched() {
	let watched: Vec<libc::pid_t> = STATE
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner)
		.watched
		.iter()
		.copied()
		.collect();
	for session in watched {
		let _ = unsafe { libc::kill(-session, libc::SIGKILL) };
		let _ = super::session::signal_outside_group(session, libc::SIGKILL);
	}
}
