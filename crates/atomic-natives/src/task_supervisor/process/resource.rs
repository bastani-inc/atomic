#[cfg(unix)]
use super::*;

/// A pipe command's leader: started without fork on Linux and macOS (see `crate::spawn`), by the standard library
/// elsewhere.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) type PipeChild = crate::spawn::SpawnedChild;
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub(super) type PipeChild = std::process::Child;

#[cfg(unix)]
pub(super) enum ProcessResource {
	Pipe(PipeChild),
	Pty(crate::pty::SupervisedPty),
}
#[cfg(unix)]
impl ProcessResource {
	pub(super) fn id(&self) -> u32 {
		match self {
			Self::Pipe(child) => child.id(),
			#[cfg(target_os = "macos")]
			Self::Pty(pty) => pty.child.id(),
			#[cfg(not(target_os = "macos"))]
			Self::Pty(pty) => pty.child.process_id().expect("portable-pty Unix child has PID"),
		}
	}
	pub(super) fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
		match self {
			Self::Pipe(child) => child.try_wait(),
			#[cfg(target_os = "macos")]
			Self::Pty(pty) => pty.child.try_wait(),
			#[cfg(not(target_os = "macos"))]
			Self::Pty(pty) => {
				let child: &mut dyn portable_pty::Child = &mut *pty.child;
				child
					.downcast_mut::<std::process::Child>()
					.ok_or_else(|| io::Error::other("portable-pty did not return Unix Child"))?
					.try_wait()
			},
		}
	}
}
