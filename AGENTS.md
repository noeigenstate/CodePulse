# CodePulse unified product

Read docs/DEVELOPMENT-OWNERSHIP.md, docs/WORKSPACE.md and docs/UNIFIED-PRODUCT.md before changing entry points.

- This branch builds from one checkout: apps/desktop owns the only Electron main process; apps/hud contains only its HUD renderer/preload.
- Use pnpm build then pnpm start, or scripts/start-desktop.ps1 -Build -DeviceServer on Windows. Never run a second backend against port 17888.
- Share one StatusHub, CLI hooks, collection services and device API. Presentation-specific theme, layout, ordering and dismissal must not mutate another surface's canonical data.
- Both desktop previews use the checked-in production 400×300 C/Wasm renderer. Keep their assets byte-identical. Firmware is maintained in a separate repository and is not needed to build or run the desktop.
- Preserve existing user changes. The experimental integration branch is codex/unified-product; publish only when explicitly authorized, never merge to main without approval.
- Node tests may rebuild better-sqlite3. Restore the Electron ABI before launching (pnpm start does this). Keep tests, profiles and logs in .tmpshots; never stop or reconfigure running Codex tasks for validation.
- Product/design work owns desktop features; embedded work owns the independent firmware, physical rendering and device validation. Coordinate protocol and preview-asset changes using docs/DEVELOPMENT-OWNERSHIP.md. Verify remote URLs before pushing: this checkout may still name the legacy HUD remote origin.
