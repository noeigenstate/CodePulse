# Stable desktop HUD project cards

The unified host projects each native session onto its first observed nonempty
HUD workspace. A tool's execution directory, native metadata refresh, state,
task title, quota and input-array order cannot move that session between project
cards. File URIs and ordinary paths normalize to the same project. Provider
priority, same-project grouping and the renderer's persisted first-seen order
are unchanged.

This is separate from the device ordering fix. The classic desktop and device
API still receive the canonical StatusHub snapshot; their source data is not
rewritten to keep HUD cards in place.

## Identity and actions

- Session keys include provider and native session ID. Path-only legacy rows
  continue to use their normalized workspace identity.
- Unknown-path sessions adopt the first nonempty path. A different native
  session can establish a new project. Moving an existing session deliberately
  is not inferred from a tool cwd change.
- Local `hud-workspaces.json` persists bindings under Electron's userData
  directory. It contains hashed identities and workspace paths, not prompts,
  tokens or raw session IDs. Treat it as machine-local data, not repository data.
- Absent bindings survive temporary disappearance and restarts. Old absent
  entries are pruned above 2,048; live bindings are retained. Failed saves keep
  working in memory. Malformed history is rebuilt from current observations.
- Bootstrap history is not observed until a HUD surface exists. This avoids
  binding cards to intermediate historical cwd during startup replay.
- Dismissal follows the session. Quota or cwd changes alone cannot undo it;
  new activity still makes the task visible again.
- A HUD acknowledgement resolves the displayed project back to its canonical
  sessions. It does not acknowledge a different project's session simply because
  both currently execute in the same directory. Nested-card grouping and generic
  container boundaries are respected. Pathless "read all" remains provider-wide.

## Regression evidence

Before the fix, a 45-second local capture contained 141 snapshots, 16 workspace
path changes and 14 changes to the HUD card/group sequence. Replaying the same
snapshots through the corrected projection and unchanged HUD grouping/order
functions produced zero sequence changes. Raw captures remain private.

`tests/hud-workspaces.test.ts` covers repeated cwd/state/title changes, path
formats, provider separation, missing paths, temporary absence, restart and
storage failure, bounded history, dismissal, scoped acknowledgement and generic
container boundaries. Existing HUD renderer/provider ordering is unchanged.

No firmware, display layout, font, refresh interval or waveform is changed by
this desktop fix. Optical ghosting on the prototype remains a separate issue.
