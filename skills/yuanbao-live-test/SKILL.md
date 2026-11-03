---
name: yuanbao-live-test
description: Use when testing the 元宝搜索 (Tencent WSA SearchPro) desk cards against the real API with the user's key, or when a Yuanbao card shows wrong, missing or unreadable content on the e-ink preview.
---

# Live-testing 元宝搜索 cards

## Ground rules

- The user types the key into 桌边内容 › 元宝搜索设置 themselves. Never ask for it in chat, never read any `.env`.
- Inspect state through CDP (`window.codepulse.getAmbient()` → `yuanbao`, `cards`). That status never contains keys.
  Do not print `config` wholesale.
- Before changing the user's settings for a test, save the originals (e.g. in renderer `localStorage`) and restore
  them afterwards. Tell the user what you changed. The daily request limit is theirs; report how many requests you used.

## Why nothing is requested

Scheduled requests need ALL of the following:

- a saved key;
- `config.yuanbao.enabled` and the feature flag;
- desk content in the playlist (`config.enabled`), with today's display cap not reached;
- outside quiet hours (default 23–8);
- for gold/stock, inside trading time (CN workdays from the holiday table; HK/A-share sessions; gold night session; US in
  America/New_York);
- the job is due: a check older than its cadence, or never checked.

`测试连接` (testYuanbao) bypasses switches and quiet hours, but only fetches weather.

To force a job now: stop the app, delete its key from `checks` in `<userData>/yuanbao-cache.json`
(`gold:`, `stock:<code>.<mkt>`, `tools:<name>`, …), and restart. That file holds request times and cards, no keys.

## Seeing raw responses

Start the app with `CODEPULSE_YUANBAO_DEBUG=1`. Each sanitized response is then written to
`<userData>/yuanbao-debug/<topic>.json`.

- A response without `Pages` means the query hit no vertical card. That is a query-wording problem, not a connection
  problem.
- Proven queries: 「今日金价」, 「<CODE>股价」 (e.g. AAPL股价, 00700股价), 「<城市>今天天气」.
- Long queries such as 「今日金价 国内现货黄金」 or 「aapl.us 股票行情 股价」 return nothing.

## The e-ink font

The screen draws only the 7,752 code points in `firmware/fonts/sources/noto-hierarchy.json`. Card text must go through
`deviceText` / `deviceSupports` (apps/desktop/src/main/device-text.ts).

- Traditional characters and U+FF64 「､」 show up as replacement glyphs otherwise.
- After a font change, run `node scripts/generate-device-charset.mjs`. `tests/device-charset.test.ts` fails until you do.
- X, HN and meme titles do not use this filter yet.

## After a fix

Turn trimmed, credential-free live responses into fixtures in `tests/fixtures/yuanbao/live-*.json` with parser tests.
Check the card on the preview: 桌边内容 › category › click the item.
