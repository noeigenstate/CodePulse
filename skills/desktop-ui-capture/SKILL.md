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
  `apps/desktop/src/main/window-chrome.ts`, not CSS, and must equal the `.app-shell.native-workstation`
  `--canvas` / `--ink` tokens (light and dark) in `components/product-shell.css`.
  `tests/window-chrome.test.ts` enforces this. When you change those tokens, change both.
- CDP screenshots do not include that overlay. Check it with a `PrintWindow` capture and compare pixel values.
  `PrintWindow` returns false while the session is locked, so retry later.
- The overlay cannot draw borders. A title-bar separator belongs on the frame below it, otherwise it stops
  short under the buttons.

## Rules
- Never kill browsers or Electron by image name: the user's own windows die too. Stop only the PID you started.
- Keep captures in `.tmpshots/` (gitignored). Usage pages can show prompt text, so never paste their raw text into a commit, issue or skill.
