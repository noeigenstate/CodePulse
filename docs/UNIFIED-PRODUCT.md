# Unified product experimental branch

`codex/unified-product` targets `noeigenstate/CodePulse`. It starts from upstream
1.4.11 plus the unified-host fixes and incorporates the existing HUD presentation
and unpublished product navigation/desk-content work. No merge to main is implied.

## Ownership and build

| Area | Responsibility |
| --- | --- |
| apps/desktop/src/main | One Electron process, StatusHub, native session reads, collectors, hooks, device service and windows |
| apps/desktop/src/renderer | Standard desktop and independent screen workbench |
| apps/hud/src/renderer | Existing HUD appearance, task cards, ordering and acknowledgement controls |
| apps/hud/src/preload | HUD IPC bridge to the same host; no second server or collector |
| packages | Shared model, adapters, local server, storage and hooks |
| Both device-preview directories | Identical committed firmware renderer assets, checked before every build |

Install with `pnpm install --frozen-lockfile`, build with `pnpm build`, and launch
with `pnpm start`. The root build includes HUD automatically. `pnpm dist:win`
also includes it in the installer; other upstream package targets are retained.
On Windows `scripts/start-desktop.ps1 -Build -DeviceServer` additionally enables
the optional device service. No sibling source checkout is required.

The accepted standard client provides Control and Multimedia, with Usage and
global Settings in the rail footer. Control offers connected desktop/HUD/e-paper
cards with their existing configuration options. Focus mode collapses the console
to the original work dashboard and has an explicit return control. HUD can coexist with the standard window; the screen
workbench remains independent. All three use the same host and saved device
configuration. Existing native task/session identities, manual/automatic approval
distinction, retained result read receipts and stable HUD card order are kept.

## Verification without disturbing active tasks

Run `pnpm typecheck`, `pnpm test`, `pnpm build`, then `pnpm test:surfaces`.
The last command uses an isolated test profile, synthetic task data and the real
built renderers/preloads/IPC. It never starts live collectors, edits CLI hooks,
reads native task state or claims production ports. It writes results/screenshots
only under `.tmpshots`. Native SQLite checks use a disposable database.

Node tests rebuild better-sqlite3 for Node. `pnpm start` / the Windows launcher
restore the Electron ABI before starting the application. Use an independent
dependency directory for validation while another checkout is running.

## Existing split checkouts

The old HUD and standard-host working trees can remain in place for rollback;
this branch replaces their *build dependency*, not their local files or history.
Keep unpublished changes in those trees until their transfer has been reviewed.
Use this branch for future desktop/HUD work. Do not run the old HUD backend
alongside this host. Stop only CodePulse via its tray before switching builds.

The app identity and userData path remain those of standard CodePulse; HUD keeps
its existing `persist:codepulse-hud-surface` partition. No database, read-state,
theme, task ordering, ambient credentials or device configuration reset is done.
Developers can retain the old worktrees without affecting this build.

## Firmware and private data

Firmware remains separately versioned and is not bundled as source or flash
images here. No flashing or waveform/refresh-policy change is performed by this
integration. The desktop uses the checked-in C/Wasm renderer, with font notices
included in packaged resources. To deliberately regenerate it, supply the
firmware source path and Zig to `scripts/sync-device-preview.ps1`; both previews
are updated together. Optional source-hash validation uses the explicit
`CODEPULSE_FIRMWARE_SOURCE` environment variable.

Do not commit local logs, credentials, device tokens, Wi-Fi settings, native
session data, recovery/feedback archives or private handoff documents. Keep them
in ignored local storage. Experimental residual-ghosting work remains a firmware
concern; the desktop preview shows target pixels, not physical refresh completion.

## Workstation update — 2026-10-27

The approved workstation source was reconciled file by file onto the unified
checkout, preserving the in-repository HUD paths and existing main-process
integration. Device protocol and production renderer assets are unchanged.

- Type checks, 649 regression tests, full build and isolated surface checks passed.
- Surface checks cover focus return with drafts, target availability, large e-paper
  preview, original HUD rendering/coexistence, independent workbench, settings
  shortcuts, attention routing and unchanged canonical task state.
- Both preview asset directories remain identical; all 38 manifest source hashes
  match the separately inspected firmware source. This is source/preview evidence,
  not evidence of a flashed device or acceptable physical refresh behavior.
- Electron native dependencies were restored before launching the user instance.
  Manual visual acceptance, live X access and current physical-device validation
  remain pending. This update has not repeated installer/clean-clone validation;
  those results below describe the earlier baseline only.

Local check results are under ignored `.tmpshots/native-workstation-migration/`
and `.tmpshots/surface-smoke/`. Hidden-window captures may be stale and must not
be treated as visual acceptance; renderer/IPC assertions and pixel comparisons
are reported separately. No firmware flash, release or main merge was performed.

## Verified baseline — 2026-10-24

Integration source commit: `7eb6457`. The prior standard-host baseline was
`2dbed0b`; the HUD presentation came from `ed71121` plus the preserved local
product navigation/desk-content changes.

- 645 Node regression tests passed, including native read receipts, automatic
  approval routing, independent task cards, retention, stable ordering and device
  projection. All workspace and test TypeScript checks passed.
- Root build compiled both presentations. Production Wasm frames matched for
  work/usage modes at 3, 6 and 9 tasks; the rendered workbench canvas also matched
  the production renderer pixel-for-pixel.
- Windows application directory packaging passed. An isolated Electron harness
  loaded the standard, HUD and screen assets directly from the packaged app.asar.
  It exercised all five destinations, form switching, independent workbench
  lifetime, draft preservation, settings shortcuts and attention routing.
- A separate single-branch clone, with no sibling firmware/HUD checkout and no
  ancestor node_modules, passed frozen-lockfile installation, type checks, build,
  Electron native dependency setup and the same surface smoke checks.
- Original working-tree file hashes were unchanged. No production application,
  Codex process, CLI hook, account database or firmware was restarted or altered
  by this validation. All sample content was synthetic, under a disposable profile.

This local run was Windows x64 / Node 22 / pnpm 10.19.0. Linux and macOS runtime
behavior has not been revalidated locally; upstream packaging targets remain.
The experimental branch has a Windows/Linux verification workflow and does not
trigger the tag-based release workflow on an ordinary branch push. No installer
release, firmware flash or main-branch merge is part of this integration.

## Preview sizing verification — 2026-10-27

The current Antigravity navigation and HUD/e-paper configuration were retained.
Only the preview/container layout and related type cleanup were adjusted. Device
pixels, fonts, protocol, stored settings and firmware assets were not changed.

Type checks and builds passed. The isolated surface harness now uses software
offscreen rendering for fresh captures and follows the consolidated navigation.
It verifies unchanged 400×300 size across four typical window sizes, no page or
preview overflow, visible Apply controls, identical bitmap data in the 2×
inspector, keyboard return/Escape, draft retention, HUD coexistence and independent
workbench pixel equivalence. Small stacked windows are also checked for horizontal
overflow. These checks do not establish physical e-paper optical quality.

## Commit readiness — 2026-10-27

The current 37-file workstation change passed all 654 regression tests and the
complete workspace/test type checks. Regression tests used Electron's Node
runtime with temporary databases, preserving the native dependencies used by
the running client. The full desktop build and the final HUD main-process
build passed; both device-preview asset directories remain byte-identical.

Surface checks cover immediate target selection under a delayed save, rapid
selection, failed-save rollback, retained drafts, paused hidden previews, event
coalescing, fixed-size preview inspection, HUD coexistence and explicit HUD
reveal/recovery on the client's display. The user has accepted the current
desktop experience. Windows can still refuse the independent workbench's native
pin request; the latest isolated run observed that refusal, so pin reliability
is not claimed. Installer/clean-clone checks, live X access and physical e-paper
quality have not been revalidated for this change. Firmware and device protocol
are unchanged.
