# Native client acknowledgement

The shared local server observes the desktop client's persisted local unread
list once per second. When a task is removed from that list, CodePulse clears
only the matching completed result's `unread` flag. HUD, desktop and device
projection all consume that same acknowledgement. Card identity, order, title,
layout, terminal time and device refresh policy do not change.

The compatibility source is `CODEX_HOME/.codex-global-state.json`, key
`electron-thread-read-state-v1`, version 1. The installed client stores separate
account identity and execution-host scopes. This integration supports exactly
one identity and one local host in that file; remote/durable hosts are ignored.
Ambiguous accounts/hosts and unsupported formats keep the existing HUD read
button as the fallback. No auth file is read and nothing is written to the
native client. This is a local compatibility adapter, not a stable public API.

Safety of the acknowledgement is based on an observed transition, not a guessed
foreground window or project directory:

- The exact native session must be unread in one sample and read in the next.
- CodePulse must already have observed the same completed turn and terminal
  timestamp in the earlier sample. New prompts, newer results, active work,
  pending approvals and requests for user input are never acknowledged by it.
- Startup absence from the unread list proves nothing. Already-read tasks from
  before the monitor started are not cleared retrospectively. A task completed
  while already being viewed may have no unread transition; use HUD's read
  action in that case. A transition faster than the sampling interval may also
  be missed. We prefer a remaining reminder over hiding an unseen result.
- File errors, partial writes, logout and scope changes reset the baseline.
- Stop/disposal cancels in-flight reads. No poll owns a chat, task or process.

Regression coverage includes same-project task isolation, generation races,
manual approvals, malformed/partial files, account/host boundaries, startup and
shutdown. Native runtime acceptance should open a naturally completed task in
the client after the monitor has observed it as unread; the corresponding HUD
completion highlight should clear within the next poll. Do not inject fake
completion/permission events into a live user's session to test this.
