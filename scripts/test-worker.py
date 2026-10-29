#!/usr/bin/env python3
"""Own only this API's disposable test data; never prune repositories or dependencies."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

GIB = 1024 ** 3


def capacity(path):
    s = os.statvfs(path)
    free = s.f_bavail * s.f_frsize
    total = s.f_blocks * s.f_frsize
    return {'path': str(path), 'availableBytes': free, 'totalBytes': total,
            'usedPercent': round(100 * (1 - free / total), 2),
            'availableInodes': s.f_favail}


def host_processes_visible():
    # A nested PID namespace cannot prove that a host mongod is absent.
    return Path("/proc/1/comm").read_text().strip() == "systemd"


def maintain(root):
    # Creation is atomic; refuse symlinks and shared/foreign writable directories.
    root.mkdir(mode=0o700, exist_ok=True)
    st = root.lstat()
    if root.is_symlink() or not root.is_dir() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise RuntimeError(f'Unsafe test artifact directory: {root}')
    with (root / 'maintenance.lock').open('w') as maintenance_lock:
        fcntl.flock(maintenance_lock, fcntl.LOCK_EX)
        removed = []
        for run in root.glob('run-*') if host_processes_visible() else []:
            if run.is_symlink() or not run.is_dir():
                raise RuntimeError(f'Unexpected artifact: {run}')
            # The lock file is created before any Mongo process starts. No lock means
            # an interrupted mkdir; age still prevents racing a new invocation.
            if time.time() - run.stat().st_mtime < 86400:
                continue
            lock = run / 'lock'
            fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as handle:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                # A killed wrapper can leave mongod alive. Never remove a dbPath
                # still referenced by any process on this Linux worker.
                for proc in Path('/proc').glob('[0-9]*/cmdline'):
                    try:
                        if str(run).encode() in proc.read_bytes():
                            break
                    except (FileNotFoundError, ProcessLookupError):
                        continue
                else:
                    shutil.rmtree(run)
                    removed.append(run.name)
    report = {'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'root': capacity('/'), 'temp': capacity(root), 'removed': removed,
              'retentionDeferred': not host_processes_visible()}
    report['healthy'] = all(x['availableBytes'] >= 10 * GIB and x['usedPercent'] < 90
                            and x['availableInodes'] >= 10000
                            for x in (report['root'], report['temp']))
    print(json.dumps(report), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--maintain', action='store_true')
    args, jest_args = parser.parse_known_args()
    root = Path(tempfile.gettempdir()) / f'carrot-api-tests-{os.getuid()}'
    report = maintain(root)
    if args.maintain:
        return 0 if report['healthy'] and not report['retentionDeferred'] else 1
    if not report['healthy']:
        raise RuntimeError('Test worker capacity below reserve: need 10 GiB free, <90% used and 10000 inodes. See ops/test-worker.md')
    run = Path(tempfile.mkdtemp(prefix='run-', dir=root))
    with (run / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        env = dict(os.environ, TMPDIR=str(run))
        child = None
        def stop(signum, _frame):
            if child is not None:
                os.killpg(child.pid, signum)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, stop)
        try:
            child = subprocess.Popen(['node', 'node_modules/jest/bin/jest.js', '--runInBand', *jest_args],
                                     env=env, start_new_session=True)
            result = child.wait()
        finally:
            if child is not None:
                # Include orphaned mongod descendants in teardown, even if Jest
                # failed during beforeAll. Wait before removing its storage.
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    time.sleep(1)
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            shutil.rmtree(run)
    print(json.dumps({'after': capacity(root)}), flush=True)
    return result


if __name__ == '__main__':
    sys.exit(main())
