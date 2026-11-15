# A descendant that leaves the command's process group, then keeps replacing itself: it forks, the parent exits at once,
# and the child sleeps briefly (argv[2] seconds) before doing the same. Writes its PID, process group and session.
import os, sys, time
os.setpgid(0, 0)
out = sys.argv[1]
open(out, "w").write(str(os.getpid())); open(out + ".pgid", "w").write(str(os.getpgid(0))); open(out + ".sid", "w").write(str(os.getsid(0)) + " " + str(os.getppid()))
while True:
    pid = os.fork()
    if pid:
        os._exit(0)
    open(out, "w").write(str(os.getpid()))
    time.sleep(float(sys.argv[2]) if len(sys.argv) > 2 else 0.0005)
