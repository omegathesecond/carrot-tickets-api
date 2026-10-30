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

## Fleet-2 remediation (2026-10-29, rework)

This resumed session ran directly on `omevision-fleet-2`; remote Tailscale
identity verification was therefore unnecessary. The existing timer and journal
limits were present, but the capacity service failed (ExecMainStatus=1).
Before remediation root had 10,636,324,864 bytes available out of
160,938,012,672 bytes (df 94% used). Docker/containerd consumed 22 GiB;
Docker reported 16.73 GB of images (14.74 GB reclaimable) and 6.988 GB
build cache (6.246 GB reclaimable). `/root/.claude` consumed 18 GiB.
These are current measurements, not proof of the exact historical allocation
at the original zero-space failure. Unbounded disposable image/build cache
contributes materially to root pressure alongside retained worktrees.

Reclaimed 2.659 GB of unused build cache older than seven days and 14.64 GB
of images older than 30 days with no container reference. All containers,
volumes, worktrees and installed dependencies were preserved. Image cleanup
was a one-time recovery; scheduled cleanup affects build cache only.
After recovery root available was 27,928,870,912 bytes (df 82% used), a
17,292,546,048-byte increase subject to concurrent activity.

Reinstalled the checked-in monitoring script, service, timer and journald
limits on fleet-2. Added `carrot-test-worker-cache.service` and `.timer`:
weekly Docker builder cleanup with a seven-day minimum age and 3 GB cache
retention target. Docker excludes in-use build cache. It never prunes images,
containers or volumes on schedule. Installation additionally requires:

```sh
sudo install -m 644 ops/carrot-test-worker-cache.service ops/carrot-test-worker-cache.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now carrot-test-worker-cache.timer
sudo systemctl start carrot-test-worker-cache.service
```

Both services report Result=success and ExecMainStatus=0; both timers have a
next scheduled run. The capacity monitor reports healthy=true,
retentionDeferred=false, 27,944,820,736 bytes available and 82.64% used.
The existing 15-minute monitor surfaces low capacity as a failed systemd unit;
external paging remains outside this implementation. Rollback additionally
disables/removes the cache timer and service. Removed caches are rebuilt or
pulled when needed; deleted cache/image data cannot be restored locally.

Fleet-2 verification: `env -u TMPDIR -u TMP -u TEMP npm test --
--runTestsByPath src/routes/__tests__/weekend.route.test.ts` passed **19/19**
in 37.542 seconds using real Mongo on root-backed `/tmp`; teardown left
27,957,694,464 bytes available (82.63% used). Log:
`/tmp/fleet2-weekend-tests.log`. Five retention unit tests and `npm run build`
also passed. No production application deploy, credentials or env bindings
changed.


## Lockfile-isolated rework validation (2026-10-29)

Review observed shared Express 4.21.2 despite this branch requiring Express
5.3.0, causing the async MoMo callback rejection check to time out. Do not
replace an active shared `node_modules` to repair a validation environment.
For this pass, archived task commit `7bec7b5` into a separate directory on the
attached data volume and ran `npm ci` there with its own volume-backed cache.
No shared dependencies, active worktrees or credentials were changed. The
isolated install resolved Express **5.3.0**; `npm ls --all --json` exited 0.
The package-lock SHA-256 was
`92965961b92698700b32aeaadcee2b550bed06c51717f7a84125a17484800947`.
Node was v24.19.0 and npm 11.17.0. No application fix was needed.

On fleet-1, with TMPDIR/TMP/TEMP unset, ran the isolated Jest directly with
`--runInBand --runTestsByPath src/routes/__tests__/weekend.route.test.ts
src/routes/__tests__/securityAudit.route.test.ts`: **42/42 passed**, two suites,
51.026 seconds. This includes all 19 weekend Mongo tests and all 23 security
checks, including dependency rejection returning HTTP 500 and a healthy process
afterwards. Mongo used normal root-backed `/tmp`, with host socket permission;
no `/dev/shm` override. `npm run build` and all five Python retention tests also
passed. Logs: `/tmp/carrot-disk-lock-routes.log`,
`/tmp/carrot-disk-lock-build.log`, `/tmp/carrot-disk-npm-ci.log`.

Capacity is a separate result: fleet-1 now has renewed pressure from concurrent
worker activity. Before isolated installation root available was 13,901,225,984
bytes; at the capacity check it was 13,528,559,616 bytes (91.59% by the monitor).
The normal `npm test` wrapper correctly **rejected** this worker before Jest
because usage exceeds its 90% ceiling. After route validation, root available
was 13,508,206,592 bytes (df 92%); changes reflect concurrent worker activity,
not a cleanup claim. The direct Jest command above deliberately
validated dependency correctness separately; it is not a passing capacity-gated
`npm test` claim. Do not lower that threshold or interpret route success as a
healthy worker reserve. The previously verified fleet-2 retention rollout and
27.96 GB after-test reserve remain the fleet-2 evidence; this pass neither
repeated its cleanup nor deleted unrelated fleet-1 data.

To reproduce dependency validation, archive the task HEAD to a fresh writable
volume directory, run `npm ci` there, verify `npm ls --all`, then run the build
and tests there. Prefer the capacity-gated `npm test` command on a worker with a
healthy reserve; direct Jest bypasses that guard and must be reported explicitly.


## Capacity and lint rework (2026-10-29, fleet-2)

Resumed the existing task branch at `d0a6218` without repeating the prior
cleanup or replacing shared dependencies. This session runs on fleet-2.
Root available at entry was 20,675,362,816 bytes (df 87% used), already below
the 90% ceiling. The prior fleet-2 before/after recovery measurements above
remain the cleanup evidence; no additional reclamation is claimed here.
Both installed retention services report Result=success / ExecMainStatus=0;
the 15-minute monitor and weekly build-cache timer both have next runs.
The 21:40 UTC monitor reports healthy=true, retentionDeferred=false,
20,737,261,568 bytes available and 87.11% usage. Journald retains the existing
512 MiB / 14-day limits and 10 GiB free-space reserve.

Resolved the review's 70 lint errors: remove unused imports/bindings while
preserving awaited validation calls, use const for bindings never reassigned,
and type the async error wrapper's callback explicitly. Configure unused-vars
with ignoreRestSiblings for intentional sensitive-field omission in object
serialization; other unused variables still fail lint. No serializers, capacity
thresholds, lockfile, credentials, active worktrees or shared dependencies changed.

Validation uses a fresh archive plus this patch at
`/mnt/HC_Volume_107303380/tmp/carrot-disk-rework-20261029`, with a separate
`npm ci --offline` from the volume-backed cache. Express resolves to 5.3.0;
`npm ls --all --json` exits 0. The lock hash remains
`92965961b92698700b32aeaadcee2b550bed06c51717f7a84125a17484800947`.
Node v24.19.0 / npm 11.17.0. Lint exits 0 (zero errors; 2,006 existing any
warnings), build exits 0, and all five retention tests pass. Logs are
`/tmp/disk-rework-{ci,lint,build,retention,tests}.log` and dependency tree
`/tmp/disk-rework-deps.json`.


The broad 540-suite `env -u TMPDIR -u TMP -u TEMP npm test` run cleared the
capacity guard with 20,674,764,800 bytes available (87.15% used), then passed
21 suites before being deliberately stopped to keep incident validation scoped.
It is **not** a full-suite pass. Sent SIGTERM only to that invocation's wrapper;
its normal teardown removed the owned run directory and reported 20,662,157,312
bytes available (87.16% used). No other processes or artifacts were removed.
The passing suites included weekend service, story service/routes, MoMo sale,
wallet, event questions and reporting. The final focused command retains the
same `npm test` capacity gate, unsets TMPDIR/TMP/TEMP, and runs weekend/security
routes plus updateComment and four analytics service suites.


Final capacity-gated focused result: **7/7 suites, 78/78 tests passed** in
92.7 seconds (all 19 weekend route and all 23 security route checks included).
Command: `env -u TMPDIR -u TMP -u TEMP npm test -- --runTestsByPath
src/routes/__tests__/weekend.route.test.ts
src/routes/__tests__/securityAudit.route.test.ts
src/services/__tests__/updateComment.service.test.ts
src/services/__tests__/analytics.momo.test.ts
src/services/__tests__/analytics.channel.test.ts
src/services/__tests__/analytics.refunds.test.ts
src/services/__tests__/analytics.tagsAndCash.test.ts`.
Before: 20,662,054,912 bytes available, 87.16% used; after teardown:
20,656,832,512 bytes available, 87.16% used. The owned `run-*` directory was
removed; only maintenance.lock remains. Tests used real Mongo with host socket
permission, root-backed `/tmp`, and Express 5.3.0. Log:
`/tmp/disk-rework-focused.log`. Small capacity differences include concurrent
worker activity. Current reserve meets the unchanged guard. Isolated validation
artifacts remain on the attached volume for review; no active dependencies or
worktrees were deleted. No production deploy or merge was performed.


## Reserve recurrence follow-up (2026-10-30, fleet-2)

Reused existing task commit 3038d11 and its isolated dependency installation;
source files, package manifest, lockfile, lint config and test wrapper match
byte-for-byte. No duplicate implementation or shared dependency replacement.
Authenticated host-context dashboard task/session reads both returned HTTP 200.

Root available before recovery: **14,678,687,744 bytes**, df 91% used.
The monitor correctly failed. Docker reported 4.325 GB build cache (3.991 GB
reclaimable), with cache entries last accessed 29–42 hours ago. The weekly
seven-day age cutoff could not reclaim this cache before reserve was exhausted
again. Reduced build-cache retention to **daily**, **24 hours minimum age**,
**1 GB retention target**. These are Docker build caches only, excluding in-use
entries; no containers, images, volumes, worktrees or installed dependencies
were removed. This improves cache headroom but cannot bound unrelated worker
allocations; the unchanged capacity monitor remains the admission gate.

Installed the revised service/timer and ran the service: Docker reclaimed
**3.476 GB**. Root available afterwards: **18,150,899,712 bytes**, **88.72%**
used. Both services report Result=success / ExecMainStatus=0; host monitor
healthy=true, retentionDeferred=false. Existing journal limits remain intact.

Isolated Express **5.3.0** validation: lint exits 0 (zero errors, 2,006 existing
warnings), build passes, five Python retention tests pass. Dependency tree is
retained in /tmp/disk-resume-deps.json; lock SHA-256 remains
92965961b92698700b32aeaadcee2b550bed06c51717f7a84125a17484800947.
Logs: /tmp/disk-resume-{lint,build,tests}.log.

Final normal-TMPDIR capacity-gated focused run: **7 suites / 78 tests passed**
in 96.499 seconds, including all 19 weekend and 23 security route tests, plus
updateComment and the four analytics suites listed in the prior pass. Command
is the same seven-path `env -u TMPDIR -u TMP -u TEMP npm test --
--runTestsByPath ...` above. Before: 18,150,518,784 bytes available (88.72%);
after owned-artifact teardown: **18,164,047,872 bytes** (88.71%). Concurrent
worker allocations account for small measurement changes. This is a focused
suite pass, not a full-suite claim. Daily cache timer next run verified for
2026-10-31 00:11:56 UTC. No production deploy or merge performed.
