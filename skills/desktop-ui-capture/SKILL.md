---
name: desktop-ui-capture
description: Use when you need screenshots or measurements of the running CodePulse desktop window (UI review, acceptance, before/after) without moving the user's mouse or opening a second backend.
---

# Capturing the running desktop UI

## Start it so it can be driven

- Port 17888 must be free: one backend only. If CodePulse is already running and you did not start it, ask before restarting it.
- On Windows PowerShell 5.1, `scripts/start-desktop.ps1` aborts as soon as pnpm writes to stderr. Run the same steps yourself:
  1. In Bash: `pnpm build`, then `pnpm --filter @codepulse/desktop rebuild:electron`.
  2. Launch `node_modules/electron/dist/electron.exe --remote-debugging-port=9333 "<repo>/apps/desktop"` with `CODEPULSE_DISABLE_UPDATE_CHECKS=1`, `CODEPULSE_DEVICE_SERVER_ENABLED=1` and no `ELECTRON_RUN_AS_NODE`. Send logs to `.tmpshots/`.
- The debugging port only listens on 127.0.0.1. It closes when the app restarts normally.

## Drive and capture over CDP (Node 22+ has a global WebSocket)

- Find the page in `http://127.0.0.1:9333/json` whose title is `CodePulse`, then connect to its `webSocketDebuggerUrl`.
- Before capturing, send `Page.enable`, `Page.bringToFront`, `Emulation.setFocusEmulationEnabled {enabled:true}` and `Page.setWebLifecycleState {state:'active'}`. Without them, `Page.captureScreenshot` hangs when another window covers the app.
- Size the view with `Emulation.setDeviceMetricsOverride`, and clear it afterwards.
  - The override shrinks the page inside the real, visible window and leaves the rest of it blank, so it looks broken to the user. Use it only on a window you started for the capture; for the user's open dev window, take width and theme matrices from the offscreen surface harness instead (`CODEPULSE_SMOKE_CAPTURE_ALL=1 pnpm test:surfaces`).
  - The main window defaults to 1120×780 and its minimum is 720×480. 390×844 does not apply.
  - Capture 1440×900, 1024×768 and 720×480.
- Navigate with `button[data-view=<control|ambient|assistant|usage|settings>]`.
  - Visible text is ambiguous: 「多媒体玩法」 is both a nav item and a preview tab.
  - Hidden pages keep their buttons in the DOM, so filter to visible elements.
- Measure with `Runtime.evaluate` and computed styles: font sizes and weights, radii, button heights, solid primaries, and `scrollWidth > clientWidth` overflow.
- Selecting a surface card persists `shell.target`. Restore the user's selection (for example `#endpoint-ink`) when done.

## Window screenshots without CDP

- GDI `PrintWindow` crops the window unless the capturing process first calls `SetProcessDPIAware()`.
- A full-screen `CopyFromScreen` captures whatever window is on top. Avoid it.

## Theme colours that live outside CSS

- The Windows caption buttons (minimize/maximize/close) are a native overlay. Their colours come from
  `apps/desktop/src/main/window-chrome.ts`, not CSS. There is no separate title bar: the content area runs
  to the window top, so `overlayColor` must equal `--surface-muted`, `symbolColor` `--ink`, and
  `backgroundColor` `--canvas` (light and dark) in `components/product-shell.css`.
  `tests/window-chrome.test.ts` enforces this. When you change those tokens, change both.
- CDP screenshots do not include that overlay. `PrintWindow` can return a stale frame (old theme, or only the
  frame and buttons), so do not judge colours from it. Read the computed background under
  `navigator.windowControlsOverlay.getTitlebarAreaRect()` instead; the overlay colour comes from the palette.
  `PrintWindow` returns false while the session is locked.
- The overlay cannot draw borders, and the user asked for no line along the window top: keep the top edge borderless.

## Display scale (dpr) differences

- This machine runs at 150 % scale; CI runs at 100 % (dpr 1). A 1:1 device preview is 400 CSS px wide at dpr 1 but about 267 at 1.5, so a layout that fits locally can clip on CI (`assertCanvasPure` fails with pixels outside white/black/red).
- Reproduce dpr 1 locally: copy `scripts/test-surfaces.mjs`, change `spawnSync(electron, [bundle]` to `spawnSync(electron, ['--force-device-scale-factor=1', bundle]`, run the copy, then delete it. Run the normal `pnpm test:surfaces` too.
- Prefer layouts that react to the preview's real width (e.g. a wrapping flex row with `min-width: min-content` on the preview column) over viewport breakpoints tuned at one scale.

## Compact HUD styles (island, pills, edge, orb)

- Run `pnpm build`, then `node scripts/hud-style-capture.mjs [--force-device-scale-factor=1]`. It uses the production HUD renderer with synthetic tasks, a disposable profile and no backend. Set `CODEPULSE_CAPTURE_OUT` to keep runs apart. Shots are transparent, so composite them on a backdrop before judging.
- It also checks settled sizes from the DOM, samples the morph in a shown window, and checks click-through with `WindowFromPoint`, which never moves the mouse. A synthetic `mousemove` drives the hit test, so real forwarded mouse moves still need a person.
- `capturePage` on a hidden window returns its previous frame first. Discard one capture and wait, or the shot shows a morph midway. Waiting for transitions alone does not fix this.
- Windows with animation effects off reports `prefers-reduced-motion: reduce` to Chromium (`HKCU\Control Panel\Desktop\WindowMetrics\MinAnimate` = 0). Check this before concluding a transition or spinner is broken.
- Controls in a `<fieldset disabled>` match `.product-frame button:disabled` and fade to 40%. A preview that must stay legible uses `inert`.

## Rules

- Never kill browsers or Electron by image name: the user's own windows die too. Stop only the PID you started.
- Keep captures in `.tmpshots/` (gitignored). Usage pages can show prompt text, so never paste their raw text into a commit, issue or skill.
