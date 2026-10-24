# CodePulse unified development

CodePulse Desktop and CodePulse HUD are two presentations of one local status
service. The device configuration panel is a third presentation: its 400×300
preview uses the same renderer as the supported e-paper firmware.

## Checkouts

Keep these siblings in a directory of your choice:

| Directory                                         | Branch / role                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `CodePulse`                                       | `main` in CodePulse-HUD; HUD renderer, preload and unified launcher    |
| `CodePulse-Desktop`                               | `codex/unified-desktop`; unified host based on upstream Desktop 1.4.11 |
| `firmware` (optional, separate repository/access) | Device firmware and preview renderer source                            |

The two desktop branches share a Git repository, not their working-tree files.
Do not merge one presentation over the other. From a new empty parent directory:

```powershell
git clone https://github.com/LBW-C137/CodePulse-HUD.git CodePulse
git -C CodePulse worktree add ../CodePulse-Desktop codex/unified-desktop
pnpm --dir CodePulse install --frozen-lockfile
pnpm --dir CodePulse-Desktop install --frozen-lockfile
```

Use Node.js 22 and pnpm 10.19.0. Existing directories must be inspected first;
never reset or replace an existing checkout to follow this example. Firmware
access and hardware-specific recovery are maintained separately.

## Build and run

Build both checkouts with `pnpm build`. From `CodePulse` run:

```powershell
.\scripts\start-desktop.ps1 -Build -DeviceServer
```

The launcher starts **one** Electron host and loads the HUD renderer/preload
from its sibling checkout. The tray opens either desktop presentation. Quit an
existing instance from the tray first. Do not start an additional HUD backend:
the shared local hook service owns port 17888; the optional LAN device service
uses 17889. The launcher refuses a conflicting listener.

Shared state, CLI hooks, account collection and the device API belong to this
host. Themes, layout, temporary dismissal and device ordering remain presentation
concerns; do not rewrite another surface's canonical state to implement them.

The unified host now keeps desktop HUD session-to-project bindings stable across
execution-directory changes and restarts. See [HUD project identity](HUD-STABLE-PROJECTS.md)
for grouping and acknowledgement boundaries. See [card retention](HUD-RETENTION.md) for the HUD timeout and unread-result rules.

## Device configuration and preview

In Settings → device display configuration, HUD and usage modes are drafts until
**Apply configuration** saves them. The device reads the saved configuration.
The preview shows the latest target picture, not a receipt from the device.
There is no telemetry upload: temperature, humidity, battery and connection
appear unknown in the desktop preview when unavailable there.

The shipped WebAssembly renderer is a display-only asset. It has no filesystem,
network, serial or credential access. Its hashes and third-party notices are
checked during build. Without the optional firmware checkout, the committed
asset is sufficient to build the desktop. With firmware sources present, source
hash verification also checks for stale preview assets.

After editing firmware layout/fonts/parser, regenerate **both** previews using
`scripts/sync-device-preview.ps1 -Zig <path-to-Zig-0.13.0> -Python <python>`.
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

Run `pnpm typecheck` and `pnpm test` in each checkout. The unified host uses
better-sqlite3: Node tests may rebuild it for Node. Before launching afterward,
run `pnpm --dir ../CodePulse-Desktop --filter @codepulse/desktop rebuild:electron`.
Never rebuild native dependencies while relying on a running application's ABI.

Keep test logs, captures and temporary tooling under ignored `.tmpshots/`.
Do not commit credentials, native session logs, local account databases,
provisioning payloads, Wi-Fi passwords or device flash/NVS dumps. Private
hardware history and machine-transfer instructions belong outside this public
repository. Push only when requested; never push changes to upstream by default.

Native client viewing can acknowledge the matching completed task in the shared
Hub. See [read-state compatibility and limits](NATIVE-READ-STATE.md) and
[automatic approval routing](CODEX-APPROVAL-ROUTING.md).
