import contextlib
import fcntl
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('test-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class RetentionTests(unittest.TestCase):
    def setUp(self):
        scope = patch.object(worker, "host_processes_visible", return_value=True)
        scope.start()
        self.addCleanup(scope.stop)

    def test_expired_only_and_active_lock_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'owned'
            root.mkdir(mode=0o700)
            old = root / 'run-expired'
            active = root / 'run-active'
            fresh = root / 'run-fresh'
            foreign = root / 'node_modules'
            for p in (old, active, fresh, foreign):
                p.mkdir()
            with (active / 'lock').open('w') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                for p in (old, active):
                    os.utime(p, (time.time() - 90000,) * 2)
                with contextlib.redirect_stdout(io.StringIO()):
                    report = worker.maintain(root)
                self.assertEqual(report['removed'], ['run-expired'])
                for p in (active, fresh, foreign):
                    self.assertTrue(p.exists())

    def test_capacity_failure_is_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(worker, 'capacity', return_value={
                'availableBytes': 524287999, 'usedPercent': 99, 'availableInodes': 100}):
                with contextlib.redirect_stdout(io.StringIO()):
                    report = worker.maintain(Path(directory) / 'owned')
                self.assertFalse(report['healthy'])

    def test_nested_namespace_defers_retention(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'owned'
            root.mkdir(mode=0o700)
            old = root / 'run-expired'
            old.mkdir()
            os.utime(old, (time.time() - 90000,) * 2)
            with patch.object(worker, 'host_processes_visible', return_value=False):
                with contextlib.redirect_stdout(io.StringIO()):
                    report = worker.maintain(root)
                self.assertTrue(report['retentionDeferred'])
                self.assertTrue(old.exists())

    def test_symlink_rejected_without_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target'
            target.mkdir()
            link = Path(directory) / 'link'
            link.symlink_to(target)
            with self.assertRaises(RuntimeError):
                worker.maintain(link)
            self.assertTrue(target.exists())

    def test_process_reference_preserved(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'owned'
            root.mkdir(mode=0o700)
            run = root / 'run-orphan'
            run.mkdir()
            os.utime(run, (time.time() - 90000,) * 2)
            child = subprocess.Popen(['python3', '-c', 'import time; time.sleep(30)', str(run)])
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    worker.maintain(root)
                self.assertTrue(run.exists())
            finally:
                child.terminate()
                child.wait()


if __name__ == '__main__':
    unittest.main()
