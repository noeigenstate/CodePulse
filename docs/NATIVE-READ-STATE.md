# Native client acknowledgement

The shared server listens for the Windows client's explicit read events and
keeps the persisted unread-list poll as a fallback. A read receipt clears only
the matching completed turn's `unread` flag. HUD, desktop and the device
projection share that acknowledgement. Layout, card identity/order, titles and
the device's low-flicker refresh policy are unchanged.

## Why polling alone missed reads

The earlier adapter also used the ordinary dashboard snapshot. After that
surface's expiry period, unread results can remain in the canonical hub solely
for the HUD's longer retention, while being omitted or masked as read in the
ordinary snapshot. The adapter consequently could not acknowledge the very
cards still orange in HUD. Both receipt matching and polling now include these
retained rows (`findSession` / `snapshotForPresentation`). Acknowledgement does
not resurrect an expired dashboard card or alter either surface's retention.

The client can mark a result unread and then read between two one-second polls,
or coalesce both changes before saving its global-state file. This occurs when
opening a completed task quickly or staying in a task as it finishes. Absence
from an unread list alone cannot distinguish that from a task the native client
does not know about. The earlier adapter therefore left some reminders orange.

## Compatibility sources and boundaries

The passive Windows observer connects only to an already running
`\\.\pipe\codex-ipc` router. The inspected client protocol uses a four-byte
little-endian length followed by UTF-8 JSON. The observer initializes as
`codepulse-read-observer` and consumes only version 3
`thread-read-state-changed` broadcasts for the local host. It declines every
request-discovery probe immediately and rejects any forwarded application
request. It never starts a native router/server, claims thread ownership,
resumes/stops a task, sends approval decisions, or publishes broadcasts.

The event's ChatGPT identity tuple is hashed and matched to the single identity
and local-host scope in `CODEX_HOME/.codex-global-state.json`, key
`electron-thread-read-state-v1`, version 1. Raw identity fields, unrelated
broadcast contents, chat text and credentials are not logged or stored. No auth
file is read. Frames above 64 KiB are skipped without retaining their payload.
The connection retries with bounded backoff; it does not keep the app alive.

These are private compatibility formats, not a stable public API. Unsupported
versions, other identity schemas, ambiguous accounts/hosts and remote/durable
hosts are deliberately ignored. Non-Windows platforms retain file polling.

## Result matching

- Receipt arrival binds synchronously to a known native session and its current
  external turn ID, before asynchronous scope validation. Same-project tasks
  remain independent.
- Only an unread terminal result with the same turn ID and a terminal timestamp
  no later than receipt arrival can be cleared. A short, bounded 15-second
  receipt cache accommodates a delayed completion projection; viewing active
  work does not acknowledge its later result.
- Genuine permission/input requests are never cleared by viewing. A newer turn,
  newer unread event, changed/invalid scope, disconnect or shutdown invalidates
  the corresponding pending evidence.
- File polling still requires an observed unread-to-read transition and the
  same completed turn/timestamp on both samples. It never treats startup
  absence as acknowledgement.
- Reads that happened before the observer started cannot be reconstructed.
  If no supported native read event or file transition exists, use HUD's
  explicit read action. Viewing a project/sidebar heading alone is not evidence
  that an individual result was read.

Regression tests cover HUD-only retained results, rapid reads missed by persistence, same-project task
isolation, completion/projection races, newer turns, real approvals/input,
scope boundaries, expiry/disconnect/stop, malformed/large/split IPC frames,
targeted broadcasts and refusal of native task ownership requests.

Runtime acceptance: after the observer is connected, view a naturally completed
task in the native client. Its completion highlight should clear promptly,
without affecting other tasks. Connection and acknowledgement-count diagnostics
contain no task/account content. Do not inject fake results into live sessions
or navigate users' tasks automatically to manufacture acceptance evidence.
