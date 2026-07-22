# Durable Scheduled Wakes and one Proactive Sweep provide the Brain's second clock

Scheduled Wakes live with the Brain inbox in the application database. Creating a wake is a
local Brain effect; its effect row and wake row commit together. Due, boot, and deployment-cron
scans atomically admit at most one `brain.wake` input per wake identity. The wake is consumed
only when the Brain Batch containing that input settles.

Cron and boot also admit at most one outstanding Proactive Sweep. It is a liveness sentinel,
not tick history. `overdue` remains a derived Belief Projection signal observed by the Brain;
there is no Graph watcher. Process timers and deployment cron trigger scans but are never
durable truth.

## Rejected

- A generic scheduler or workflow per wake.
- A single mutable global next-wake value.
- Automatic dead-lettering of valid local wakes, because it would silently discard an owed decision.
