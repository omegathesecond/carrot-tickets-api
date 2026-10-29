# Test worker disk incident and prevention

## Investigation (2026-10-29 UTC)

The Comments review reported all 19 weekend route tests failing because MongoDB
had 0 bytes available against its 524,288,000-byte minimum. This is storage
exhaustion during Mongo startup, before route assertions, rather than 19 route
regressions. Moving TMPDIR to /dev/shm bypassed that filesystem; it did not fix
root retention. Earlier fleet-2 dependency reclamation recovered 7.5 GB, leaving
95% usage (manager incident evidence).

This implementation ran on **omevision-fleet-1**. The incident description
references reclaimed fleet-2 dependencies; that alone does not identify the
host on which the tests ran. Original failure evidence is also retained locally
in `/tmp/comments-api-tests-full.log`. Measurements below are current worker
evidence, not a reconstruction of deleted files.
The historical exact per-directory allocation is unavailable. Persistent growth
from disposable checkouts/dependencies and unbounded worker artifacts is the
likely contributing cause; the confirmed immediate cause is Mongo's free-space
check. Do not describe sandbox DNS or socket EPERM as a public service outage.

Measured consumers on this worker (`du -x`, rounded):

| Consumer | Allocated |
| --- | ---: |
| /root | 48 GiB |
| /root/Documents | 22 GiB (20 GiB companies, 1.9 GiB contracts) |
| /root/.claude | 20 GiB, including 18 GiB worktrees |
| /root/.codex | 2.4 GiB |
| /root/.pub-cache and .gradle | 1.3 GiB and 1.1 GiB |
| /var/log | 2.6 GiB, including 2.2 GiB system journal |
| /tmp/mongo-mem-* | Seven legacy directories, approximately 200 MiB each |

Rows overlap; do not sum parent/child rows. The broad /tmp inventory contains
many disposable checkouts and Postgres clusters; sandbox permissions prevent a
complete allocation census. None of those existing directories were deleted:
there is no reliable ownership/liveness record for them. Worktrees, dependencies,
credentials, production code and environment bindings were preserved.

Before changes: `/dev/sda1` total **160938012672 bytes**, available
**21247975424 bytes** (19.79 GiB), 86.80% used (df rounds to 87%).
After bounded journal retention: available **22974881792 bytes** (21.40 GiB),
85.72% used (df rounds to 86%). Net gain **1726906368 bytes** (1.61 GiB),
subject to concurrent worker activity. Journal usage reduced to **485.2 MiB**.
The journald restart applied retention; subsequent explicit vacuum freed 0B.

## Durable behavior

`npm test` now invokes `scripts/test-worker.py` (Linux, Python 3 standard library,
Node dependencies already installed). It runs Jest serially to bound per-run
Mongo concurrency, checks root **and** the selected temp filesystem, and fails
loudly below 10 GiB available, at 90% usage, or below 10,000 free inodes. Use
`npm test -- <Jest arguments>`; do not supply maxWorkers with serial execution.
Direct `npx jest` bypasses these protections.

Each invocation owns a private `carrot-api-tests-<uid>/run-*` below the normal
Python temp directory. The wrapper exports that directory as the child's TMPDIR
on the same filesystem, holds an advisory lock, forwards termination signals,
terminates its process group and removes its own artifacts after Jest exits.
It does not force /dev/shm, change Mongo storage requirements, or fabricate data.
A SIGKILL may leave artifacts; maintenance deletes only runs older than 24 hours,
with no held lock and no live process command referencing their path. Symlinks,
unsafe permissions and unreadable process state fail loudly. Nested PID
namespaces explicitly defer retention rather than assume host processes absent.
Only the systemd host monitor performs that cleanup in this environment.

`ops/carrot-test-worker.timer` runs maintenance every 15 minutes, independent of
this worktree. Capacity reports are JSON in journald; insufficient reserve fails
the unit visibly (`systemctl --failed`, `journalctl -u carrot-test-worker`).
There is no external paging integration in this task. Journal retention is
host-wide: at most 512 MiB, at most 14 days, with 10 GiB kept free. This sacrifices
old system logs, never active application worktrees or dependencies. Copy any
incident logs needed long term to approved incident storage before they expire.

## Installation / rollout

Installed and enabled on fleet-1 during this task. This is worker-local
remediation, not a claim of fleet-wide rollout. Apply to other test workers
through their normal host-management workflow.
Run from the API repo on each Linux/systemd test worker:

```sh
sudo install -d /usr/local/lib/carrot-test-worker /etc/systemd/journald.conf.d
sudo install -m 644 scripts/test-worker.py /usr/local/lib/carrot-test-worker/test-worker.py
sudo install -m 644 ops/carrot-test-worker.service ops/carrot-test-worker.timer /etc/systemd/system/
sudo install -m 644 ops/carrot-test-worker-journal.conf /etc/systemd/journald.conf.d/60-carrot-test-worker.conf
sudo systemctl daemon-reload
sudo systemctl restart systemd-journald
sudo systemctl enable --now carrot-test-worker.timer
sudo systemctl start carrot-test-worker.service
systemctl show carrot-test-worker.service -p Result -p ExecMainStatus
systemctl list-timers carrot-test-worker.timer
journalctl -u carrot-test-worker.service -n 10
```

Rollback: disable the timer, remove the two units, the installed script and this
journald drop-in; daemon-reload and restart journald. Deleted old journal entries
cannot be restored. No application deploy or production branch merge is needed.

## Validation

- `env -u TMPDIR -u TMP -u TEMP npm test -- --runTestsByPath src/routes/__tests__/weekend.route.test.ts`: **19/19 passed**, 32.842 seconds, real Mongo on root-backed `/tmp`; 21,238,894,592 bytes available before and 21,213,163,520 after test teardown, before journal reclamation.
- `npm run build`: passed.
- `python3 -m unittest discover -s scripts -p test_worker_test.py`: five tests cover age/lock retention, live process preservation, symlink refusal, low capacity, and PID namespace deferral.
- Installed timer active; service Result=success, ExecMainStatus=0; healthy JSON in journal.
- Sandbox-only Mongo attempts fail with `listen EPERM`; the successful run used narrowly approved host socket access. No API/dependency errors were hidden.
