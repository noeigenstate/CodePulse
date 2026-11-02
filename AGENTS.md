# CodePulse unified product

Read docs/DEVELOPMENT-OWNERSHIP.md, docs/WORKSPACE.md and docs/UNIFIED-PRODUCT.md before changing entry points.

- This branch builds from one checkout: apps/desktop owns the only Electron main process; apps/hud contains only its HUD renderer/preload.
- Use pnpm build then pnpm start, or scripts/start-desktop.ps1 -Build -DeviceServer on Windows. Never run a second backend against port 17888.
- Share one StatusHub, CLI hooks, collection services and device API. Presentation-specific theme, layout, ordering and dismissal must not mutate another surface's canonical data.
- Both desktop previews use the checked-in production 400×300 C/Wasm renderer. Keep their assets byte-identical. Firmware is ordinary source under firmware/ in this root Git repository; its ESP-IDF toolchain is not needed to build or run the desktop.
- Preserve existing user changes. The product integration target is protected main. Push authorized changes to the existing product branch (currently codex/unified-product), then use a PR and the required checks/reviews to merge. The user chose to retain protection on 2026-11-02: never weaken or bypass it, force-push main, or overwrite a legacy HUD local main.
- Node tests may rebuild better-sqlite3. Restore the Electron ABI before launching (pnpm start does this). Keep tests, profiles and logs in .tmpshots; never stop or reconfigure running Codex tasks for validation.
- Product/design work owns desktop features; embedded work owns firmware/, physical rendering and device validation; hardware contributors own hardware/<board>/<revision>. Coordinate protocol and preview-asset changes using docs/DEVELOPMENT-OWNERSHIP.md. Verify remote URLs before pushing: this checkout may still name the legacy HUD remote origin.

- Read docs/REPOSITORY.md for the monorepo introduced 2026-11-01. The old separate-firmware direct-main push rule is retired; all components use the root product main. No submodules, old GitLab pushes, automatic releases or automatic flashes.
- For firmware/rendering changes run node scripts/check-firmware-preview.mjs and the relevant firmware checks. Keep original font/component notices. Hardware sources and their license are uploaded separately by the hardware contributor.
