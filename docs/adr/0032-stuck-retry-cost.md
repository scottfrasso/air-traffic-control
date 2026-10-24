# ADR-0032: A stuck background retry kept a container awake: back off, and price every retry loop

- Status: Accepted.
- Date: 2026-10-24.
- Amends ADR-0030 and ADR-0031 (the main-protection alarm and restore).

## What happened
The October Cloudflare bill showed about $5 of usage, almost all "Container Memory, per GiB-Second". Nothing was
supposed to be running.

- ADR-0030/0031 protect `main`: a Durable Object alarm checks every 2 minutes that `main` is still on the last merged
  commit and, if not, runs a **restore** in the repo's checker container.
- On 10-23 a live test force-pushed an unrelated history to a test repo, `protect-201256`, *before* the hidden ref
  (ADR-0031) existed. The commit to restore was gone, so every restore failed. As designed, the repo froze (no merges).
- But the alarm kept trying the restore **every 2 minutes, forever**, and each try started the container.
- The checker container sleeps after 10 minutes idle. A wake-up every 2 minutes means it **never slept**.
- It's a `standard-3` instance: 8 GiB. Memory bills per GiB-second beyond the plan's allowance.

## Why it cost what it did
- One awake instance: 8 GiB × 3,600 s × $0.0000025 = **$0.072 an hour**, about **$1.73 a day**.
- Two instances were running when we looked (a second test repo had also had failed restores), so about $3.50 a day.
- The repo froze at about 20:12 UTC on 10-23 and the loop ran until we took everything down on 10-24, about 15
  hours, plus the container time of ten end-to-end runs and the other tests that week. That adds up to the ~$5.
- A day of it costs about the same as the whole week of real agent reviews ($2.72).

So the expensive part wasn't the AI or the work. It was an idle 8 GiB machine that a 2-minute timer kept awake.

## Decision
1. **Back off a failed restore.** While a repo is frozen, a restore is tried again right away only if `main` moved;
   otherwise after 1 hour, then 2, 4, 8 ... at most a day apart (`restore-tried:main` holds when, on which head, and
   how many times). A success clears it. Worst case, a repo frozen forever wakes the container about once a day:
   10 minutes, about a cent.
2. **Every background loop gets a price before it ships.** Any timer, alarm or retry that can start a container,
   an agent session or anything else billed per second must state, in its ADR: how often it fires, what one firing
   costs, and what happens when it fails every time. "Fails every time" must not mean "costs the most".
3. **A loop that can't succeed alone stops and says so.** Freezing was right; retrying silently wasn't. A frozen repo
   is an event (`branch.restore_failed`) a person should see; when notifications exist (a later slice), it notifies once.

## Not done yet (worth doing before turning it back on)
- **A cheaper container for small jobs.** Restore and keep need git, not 2 vCPU and 8 GiB. A second, small checker
  class (a `basic` instance) for restore, keep and diff would cut what any background job can cost by about 8×.
- **A per-repo cap on background container runs** in the Checker Durable Object (e.g. 6 an hour for restore and keep),
  as a backstop if some other loop misbehaves.
- **A Cloudflare billing alert** (Notifications → usage-based billing) at a few dollars, so a surprise shows up in a day,
  not at month's end.
- **The 2-minute main check** costs only Durable Object requests (about 720 a day per repo) and an Artifacts read; fine
  for a few repos, but it should slow down for repos nobody has pushed to in a while.

## Consequences
- With the fix, a stuck repo costs pennies a month instead of dollars a day.
- The deployment was taken down on 10-24 (vacation): no Worker, queues, workflows, subscriptions or containers remain;
  the fix ships with the next deploy.
