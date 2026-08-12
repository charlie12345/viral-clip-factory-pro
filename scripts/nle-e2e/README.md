# NLE timeline end-to-end tests

Browser-driven regression tests for the long-form editor's timeline tools.
They drive real pointer drags in headless Chromium and assert against the
sequence state the server actually persisted, so they catch the class of bug
that unit tests miss: a drag that looks right but never reaches the save path.

## Covered

| Tool | Asserted behaviour |
|---|---|
| Slip | Source window moves; timeline position, clip duration and neighbours unchanged |
| Slide | Clip moves; source untouched; neighbours absorb the change; sequence length fixed |
| Rate stretch | Timeline duration changes; source range unchanged; `speed.rate` compensates |
| Type | Clicking a track lane creates a title at that time |
| Trim (Selection) | Drag survives leaving the 6px handle; neighbours untouched |
| Ripple | Following clips shift by exactly the trim delta, keeping their durations |
| Rolling | Shared edit point moves; total sequence length stays fixed |

## Running

Playwright is not a project dependency — install it wherever convenient:

```bash
npm install playwright && npx playwright install chromium
```

Start the dashboard, then run the suite against it:

```bash
PORT=3199 node dashboard/server.js &
node scripts/nle-e2e/timeline-tools.test.mjs
```

Override the target with `NLE_BASE` (default `http://127.0.0.1:3199`) and the
project it borrows a source video from with `NLE_SOURCE`.

## Test data

The suite builds its own throwaway project (`longform_nletest_1900000000`) by
hardlinking an existing long-form source — no disk cost — seeds three adjacent
clips on the `v1` track, and deletes both files on exit. Your real projects are
never written to.
