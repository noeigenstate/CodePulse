# CodePulse unified development

CodePulse is a desk information terminal with desktop and e-paper forms. The
desktop has a standard client and a compact HUD; both share one local service.
The independent screen workbench uses the same 400×300 renderer and target data
as the supported e-paper firmware. Work status, account allowances and occasional
desk content are capabilities of the product, not separate applications.

## One checkout

This experimental branch integrates the standard desktop, HUD and screen
configuration preview. Firmware remains an independent repository and is optional.

```powershell
git clone --branch codex/unified-product --single-branch https://github.com/noeigenstate/CodePulse.git CodePulse
cd CodePulse
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Use Node.js 22 and pnpm 10.19.0. See [UNIFIED-PRODUCT.md](UNIFIED-PRODUCT.md)
for source ownership, verification and the earlier split-checkout migration.
No additional HUD checkout or firmware toolchain is required.

## Build and run

The root build compiles shared packages and both presentations. The standard host
ships the HUD under `apps/desktop/out/hud`; installers include those same assets.
`pnpm dev` builds HUD then starts the standard renderer development server.
After editing HUD, rebuild with `pnpm --filter @codepulse/hud build` and reopen it.

On Windows, enable the optional LAN device service with:

```powershell
.\scripts\start-desktop.ps1 -Build -DeviceServer
```

Start **one** Electron host. Quit an existing CodePulse instance from its tray
before starting another build, without stopping Codex. CLI hooks use port 17888;
the opt-in LAN device service uses 17889. The launcher refuses a conflicting
listener. Shared state, hooks, collection and device APIs belong to this host;
themes, layouts and dismissal remain presentation concerns.

## Product navigation and surfaces (2026-10-24)

The standard client has five first-class destinations: **总览 / 工作 / 用量 /
桌边内容 / 屏幕**. Work retains the existing task panels and acknowledgement
actions. Usage contains account allowances and the existing historical ledger.
Desk content contains the X/meme sources, candidates and rules. Screen is the
workbench for the live target, draft layout, content rules and device connection.
General settings retain appearance, visible tools, notifications, login and
updates, with shortcuts to the new workspaces.

The desktop-form selector switches between standard and HUD, hides only the
other main form and remembers the choice for the next launch. Tray actions can
also open an additional HUD or the screen workbench without changing that
startup choice. HUD exposes a direct return to standard and a screen shortcut.
The workbench is a separate native window with pin, full-screen (Escape exits)
and focus-display controls. It continues to share the host when the main window
is hidden or closed. Quitting the tray app still stops the common service.

Only the new `userData/product-shell.json` stores the startup form and standard
client's last destination. Existing database, account credentials, agent hooks,
read states, desktop/HUD appearance, project order, device configuration and
ambient settings/history stay at their existing paths. There is no migration
or reset of those files. Switching windows never acknowledges a task, changes a
device mode, or starts a second collector/server.

The screen's **当前画面** is the saved target, including an eligible X/meme
overlay; **显示配置** is a separate layout draft. Apply commits that draft to the
existing display configuration. Other windows follow saved changes unless they
have their own unsaved draft, which is retained with a notice. Unvisited device
connection panels do not start USB scans; scanning is shared across open views,
and closing one view cannot cancel another view's provisioning operation.
Hidden screen pages pause live preview reads, preserving their settings drafts.

The workbench works without physical hardware. Device discovery, host service
availability and actual display completion are separate facts: the current
protocol has no display-completion receipt or sensor telemetry upload, so the
UI does not claim the physical screen matches the preview. Firmware rendering,
refresh policy and device protocol are unchanged by this product-shell refactor.

Product-shell validation on 2026-10-24: 387 HUD tests and 536 unified-host
tests pass, along with both workspace type checks and desktop builds. A separate
Electron profile exercised the production renderers, preloads, shell IPC and
Wasm display: all five destinations, standard/HUD switching, preference
persistence, independent screen lifetime, native pin state, settings shortcuts,
cross-window draft retention, project-order isolation and attention routing.
Opening a view or switching form leaves canonical task state unchanged. The X
card in this integration test was explicitly labeled fixture content; this run
does not establish live X account access. Native pinning was intermittently
rejected by Windows, including in a minimal independent Electron probe; the
final run applied it successfully, and the UI now reports refusal accurately.
Test captures and logs are in `.tmpshots/product-shell/` in the HUD checkout.
The running user instance was not restarted; quit it from the tray and use the
unified launcher to load the rebuilt application. No firmware was flashed.

## Device configuration and preview

In 屏幕 → 显示配置, work and usage modes are drafts until
**Apply configuration** saves them. The device reads the saved configuration.
The preview shows the latest target picture, not a receipt from the device.
There is no telemetry upload: temperature, humidity, battery and connection
appear unknown in the desktop preview when unavailable there.

The shipped WebAssembly renderer is a display-only asset. It has no filesystem,
network, serial or credential access. Its hashes and third-party notices are
checked during build. Without the optional firmware checkout, the committed
asset is sufficient to build the desktop. To additionally verify source hashes, explicitly set
`CODEPULSE_FIRMWARE_SOURCE` to a configured firmware checkout.

After editing firmware layout/fonts/parser, regenerate **both** previews using
`scripts/sync-device-preview.ps1 -Firmware <firmware-path> -Zig <path-to-Zig-0.13.0> -Python <python>`.
The firmware dependency checkout must first be configured. Verify native C and
Wasm pixels before accepting a rendering change. The main desktop and HUD UI
remain independent of this device renderer.

Layout rules: three rows; 1–3 tasks in one column, 4–6 in two, 7–9 in three.
Cards fill down each column. Titles have priority; dense cards hide detail and
move quotas to the account footer. Attention uses its own conspicuous status
area. Density examples are renderer-only and cannot be applied to the device.

Task names come from native session metadata, with workspace fallback. Known
internal helper sessions are excluded; different user sessions in the same
project remain distinct. Device order follows project/provider priority and
first appearance, with stable session-to-project bindings. State, title and
transient execution-directory changes do not reorder existing same-rank tasks.
See the ordering implementation in `packages/core/src/aggregate/device-thread-order.ts`.

## Synchronization and limitations

The host supports bounded, authenticated conditional status reads, woken by
status or saved-configuration changes. Current firmware no longer imposes the
historical three-minute task-state delay. A running panel operation finishes
before the device consumes the newest snapshot. Small environmental changes
do not independently refresh the screen. See [protocol](device-api-v1.md).

The low-flicker prototype remains experimental: rapid consecutive updates can
leave visible traces. Pixel equivalence and software tests do not establish
optical quality, panel lifetime or performance across hardware batches.

## Validation and local data

Run `pnpm typecheck`, `pnpm test` and `pnpm build` in this checkout. The unified host uses
better-sqlite3: Node tests may rebuild it for Node. Before launching afterward,
run `pnpm --filter @codepulse/desktop rebuild:electron`.
Never rebuild native dependencies while relying on a running application's ABI.

Keep test logs, captures and temporary tooling under ignored `.tmpshots/`.
Do not commit credentials, native session logs, local account databases,
provisioning payloads, Wi-Fi passwords or device flash/NVS dumps. Private
hardware history and machine-transfer instructions belong outside this public
repository. Push only when requested; never push changes to upstream by default.

Native client viewing can acknowledge the matching completed task in the shared
Hub. See [read-state compatibility and limits](NATIVE-READ-STATE.md) and
[automatic approval routing](CODEX-APPROVAL-ROUTING.md).
