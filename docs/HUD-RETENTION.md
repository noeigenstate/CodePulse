# Desktop HUD card retention

The HUD retains inactive or acknowledged cards for its configured interval:
10, 30, 60, 120 or 240 minutes, with a default of **30 minutes**. Running tasks
are not removed by this quiet-card timer. Unread completed, failed, timed-out
and usage-limited results remain visible until acknowledged, explicitly
dismissed or superseded by new task activity.

The interval starts at the last terminal transition, or last activity when
there is no terminal timestamp. Acknowledgement does not restart the clock.
Thus a result read after its interval has elapsed can disappear immediately;
a result read earlier remains for the rest of that interval. This matches the
original HUD behavior. Closing a CLI session alone is not acknowledgement of
an unread result. Idle and cancelled sessions still have bounded retention.
Long-abandoned waiting states can become unread timeout results through the
existing watchdog, rather than silently disappearing.

## Unified host integration

Previously, the host's five-minute idle/completion cleanup and ten-minute error
cleanup removed or hid the canonical row before the HUD could apply its own
retention. Quota-bearing rows also lost their unread flag. The HUD's longer
setting could not recover data it no longer received.

The HUD now registers a source-retention policy with the shared StatusHub.
Rows still needed by the HUD remain in that same store. The ordinary snapshot
continues to omit expired tasks, or expose only their hidden quota rows; the
HUD reads the complete source and applies its own dismissal and retention.
There is no second collector or snapshot cache, and this complete source is
not a new network endpoint. Only the HUD surface receives it.

The setting updates immediately through the existing HUD settings IPC. The
watchdog periodically releases rows that no surface needs. Quota-only polls
do not extend a card's activity deadline or clear its unread result. New task
activity restores the ordinary view as well as the HUD. Acknowledgement maps
the displayed HUD project back to its source sessions, including rows already
expired from the ordinary view.

The desktop layout, provider/project order and stable session-to-project
bindings are unchanged. Device retention, refresh scheduling, layout and
waveform parameters are unchanged; no firmware update is required.

## Verification

`tests/hud-retention.test.ts` exercises the real StatusHub and HudProjection
with an injected clock: all five durations across quiet/result states, unread
results after 24 hours and CLI closure, acknowledgement before/after expiry,
quota-only updates, renewed activity, explicit dismissal, auxiliary exclusion,
waiting timeouts, unsupported providers and changes to the retention setting.
It also checks that the ordinary/device view keeps its existing expiry.

These are deterministic time-boundary tests, not a claim that the application
was observed for 24 hours. Previously removed in-memory cards are not restored
by changing this setting alone; startup/native session recovery or fresh
activity supplies available task data through the existing collection path.
