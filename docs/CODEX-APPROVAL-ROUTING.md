# Codex approval status

`PermissionRequest` is emitted before Codex chooses the approval reviewer. It
does not by itself mean the user needs to act. In **Approve for me**, the policy
can still be `on-request`, while `approvals_reviewer` is `auto_review`. Showing
every such hook as `WAITING_PERMISSION` caused orange HUD interruptions during
otherwise continuous work.

The unified host now acknowledges a confirmed automatic sandbox approval
without ingesting a human-attention event. This preserves the current activity,
tool count, task ordering and the shared desktop/device projection. Normal tool
completion and real manual approvals retain their existing behavior. No delay,
layout change, firmware change or automatic approval is added by CodePulse.

Routing evidence comes from the hook's exact native session file and latest
matching `turn_context`, with both session and turn identifiers checked. Any newer native `thread_settings_applied` must agree on the automatic reviewer and policy. Only
`on-request` + `auto_review` for known command/file tools is suppressed. The
reader is read-only and confined to the native sessions directory. It verifies
a 1 MiB session header, then walks backward in 256 KiB chunks until the latest
turn context is found. Memory stays bounded even across large image/tool rows;
a 512 MiB scan budget preserves a visible fallback for unsupported extremes. It does not read global defaults, another chat's
settings or store transcript contents. Hook-supplied permission mode alone is
not sufficient evidence.

Missing/unsupported metadata, mismatched identifiers, unknown tools and other
approval policies keep the normal attention signal. App-level computer-use
permissions and requests for user input must not be hidden by this rule. The
native transcript format is not a stable API; an unsupported format therefore
fails visibly, rather than hiding a potentially necessary prompt. Oversized or incomplete metadata also preserves the attention signal.

The former fixed 8 MiB tail missed valid automatic reviewer settings in long
running turns with large image/tool outputs. This caused intermittent orange
permission cards even though the client was still reviewing automatically.
The backward reader handles both legacy JSONL and ordinal-bearing native rows.

Regression coverage: HTTP acknowledgement without orange state/notifications;
manual reviewer and untrusted hook fields; session/turn isolation; latest mode
changes; unknown/app tools; missing, malformed and large rollouts. Runtime visual
acceptance still requires the rebuilt unified host to be restarted and observed
during a genuine automatic approval and a genuine manual approval.

References:

- [Permission modes](https://learn.chatgpt.com/docs/permission-modes)
- [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
- [Hook lifecycle and payloads](https://learn.chatgpt.com/docs/hooks)
