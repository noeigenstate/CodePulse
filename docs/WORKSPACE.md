# CodePulse unified development

CodePulse is a desk information terminal with desktop and e-paper forms. The
desktop has a standard client and a compact HUD; both share one local service.
The independent screen workbench uses the same 400×300 renderer and target data
as the supported e-paper firmware. Work status, account allowances and occasional
desk content are capabilities of the product, not separate applications.

产品功能与嵌入式会话的分工、仓库边界和跨端交接规则见
[DEVELOPMENT-OWNERSHIP.md](DEVELOPMENT-OWNERSHIP.md)。

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

## Product navigation and surfaces (2026-10-27)

The accepted workstation revision places **控制 / 多媒体玩法** in the main rail,
with **用量统计 / 设置** at the bottom. Control includes the existing CodePulse
work panels and live account allowances. Focus mode opens that same work view.
Usage remains the separate historical token ledger; multimedia retains the
existing bounded X/meme sources and rules.

Control selects the desktop, HUD or e-paper through three connected cards; it
has no duplicate target bar. The preview is paired with **更改配置** and
**立即应用**. The desktop supports work, historical usage or a stacked board;
HUD exposes its existing appearance options, and e-paper offers the saved
fixed/cycle content plan. Unsupported content choices remain disabled. Settings
is global. The consolidated navigation and control options preserve the accepted
Antigravity revision.

The device preview never stretches with the window: each of the 400×300 device
pixels covers a whole number k of physical screen pixels (nearest to the display
scale, or the largest that fits, never below 1:1; the toolbar shows 1:k), so at
150% scaling it is about 533×400 CSS pixels (k=2) or 267×200 (k=1) when space
is short. **2 倍检查** opens an independent inspection view of the same bitmap
at no less than 2 physical pixels per device pixel; closing it or pressing
Escape returns focus to its trigger. It never
applies device settings. Control has bounded preview/configuration columns and
a persistent Apply footer. Less-used flags expand on demand; density sample buttons stay visible.
Typical 1000×720, 1120×780, 1366×900 and 1600×1000 windows fit the primary controls
without page or preview scrolling. Very narrow windows use a stacked layout;
expanded details and large inspection canvases may scroll within their own areas.

**进入专注模式** collapses the standard window to the existing work dashboard.
**返回控制台** is always available; returning restores the console and its
unsaved drafts. Focus state, target and desktop layout are stored with navigation
in `userData/product-shell.json`; legacy overview/screen destinations are
normalized. Other account, hook, read-state, ordering, device and content data
remain at their existing paths without reset or bulk migration.

Selecting the HUD card only selects its preview. **开启 HUD** opens the original
HUD alongside the standard client; hiding it does not hide the console or change
the client entry point. Startup and the tray's **打开 CodePulse** always open
Control, including profiles that previously remembered HUD-only startup. The tray
has no presentation selectors; HUD and device controls belong in the client.
The independent screen workbench remains available from the client, with native pin, full-screen (Escape exits) and
focus-display controls. All windows share one host, StatusHub and saved device
configuration. Switching views does not acknowledge tasks or apply device drafts.

The screen's **当前画面** is the saved target, including an eligible X/meme overlay;
**显示配置** is a separate draft. **立即应用** saves that draft. Other windows
follow saved changes unless they have an unsaved draft, which is retained with
a notice. Unvisited connection panels do not start USB scans; scanning is shared,
and closing a view cannot cancel another view's provisioning operation. Hidden
screen pages pause live preview reads and retain their drafts.

The workbench works without physical hardware. Discovery, host availability and
physical display completion are separate facts: there is no display-completion
receipt or sensor telemetry upload, so the UI does not claim that the physical
screen matches the preview. This workstation update changes the desktop shell,
not the production device renderer, protocol or low-flicker policy.

Validation on 2026-10-27: type checks, 654 regression tests, the full build and
isolated Electron surface checks passed. The checks cover focus/console return,
capability availability, HUD coexistence, preview size, independent workbench,
draft retention, settings shortcuts, attention routing and canonical state
preservation. The workbench canvas matches the production Wasm pixels. Synthetic
X content is explicitly labeled as a fixture; this does not verify live X access.
Actual user visual acceptance and physical device validation remain separate.
See [UNIFIED-PRODUCT.md](UNIFIED-PRODUCT.md) for the earlier packaging baseline.

## Local tasks, reminders and voice (local 0.0.27 candidate)

The **待办与助手** destination adds local todos, scheduled reminders, reviewed AI
suggestions, scene/memory settings and explicit microphone/speech controls. The
same Electron main process owns these services; no Python server, cloud gateway
or additional production port is needed. Existing work/usage databases and
StatusHub are unchanged. The assistant stores its own `assistant.sqlite` under
Electron userData. Credentials use the OS encrypted store and are never returned
to renderers. AI and speech require the user's own configured provider access;
ordinary todos and explicit numeric relative reminders also work offline.

In **控制 → 墨水屏**, **待办与提醒** participates in the existing fixed/cycle plan.
The assistant's **显示到墨水屏** is a temporary 15-minute override. A later explicit
image/note display replaces it; urgent work remains higher priority. Todo pages
contain at most six rows, use the production C/Wasm renderer, and change only
with task data or deadline milestones, without a ticking countdown. Audio is
disabled on old firmware builds; new-board pins and microphone must be verified
before enabling it. No always-listening or wake-word models are included.

See [LumaDesk integration](LUMADESK-INTEGRATION.md) for provider setup, provenance,
hardware conflicts, privacy, protocol additions and precise verification limits.

## Device configuration and preview

In 控制 → 墨水屏, or the independent workbench's 显示配置, work and usage
modes are drafts until **立即应用** saves them. The device reads the saved configuration.
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

The paired 0.0.26 preview keeps active work detail stable while preserving shared
HUD/task semantics. Device quota/environment pacing and the optional narrow-window
trial belong to firmware; the preview does not simulate their timing or ghosting.
See [the 0.0.26 display record](QUIET-DISPLAY-2026-10-28.md) for versions,
synthetic 400×300 examples and the limits of current physical validation.

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

Control card selection paints immediately while its preference is saved. Preview
reads pause when hidden and coalesce bursts of task updates; content uses its own
change events. Drafts and the last rendered bitmap remain available on return.

Manually opening HUD places it on the standard client's display and brings it
forward. A minimized or off-screen HUD is restored into that display's work
area; a valid dragged position there is retained. The Control state follows
native window visibility/minimization, not just a window creation request.

See [shared work presentation handoff](WORK-PRESENTATION-HANDOFF.md) and [Antigravity integration](ANTIGRAVITY.md) for the current post-baseline changes and remaining device validation.
