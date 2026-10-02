# GUNGNIR Conversation Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved conversation-linked minimalist complex battle map as working software and a reviewed PR.

**Architecture:** Add a separate zero-runtime-dependency dashboard package. A strictly read-only SQLite projection feeds browser SVG views; a loopback server and a DSH webServer adapter share the same handler. Conversation providers read an explicitly selected session and never execute agent actions.

**Tech Stack:** Node >=22.13, node:sqlite, node:http, ES modules, browser DOM/SVG; existing node:test and Playwright for browser validation.

**Spec:** `docs/dashboard/design.md`

## Global Constraints

- Node >=22.13. No added runtime dependencies; existing CLI, tool schemas, presets and accepted ADRs remain compatible.
- Database access is `readOnly: true`; never initialize/migrate data or instantiate Broker/adapter for UI reads. Never query secret_store/secret_grants.
- DTO fields and signatures are defined in the Spec. Missing, ambiguous or unavailable data must remain explicit; demo is opt-in.
- Node identity is `(adapter_instance, entity_type, source_id)`; no guessed attack edges. Inferred reference edges have a separate label/style.
- Lease, egress, task state, historical proof and current validity are independent; stale/expired/cancel_requested/unknown cannot become verified/stopped.
- Four route notes and global anomalies survive focus/fold. Render external text with textContent; no credentials or browser-visible host tokens.
- Work only in this feature checkout and assigned files; no production changes or extra agents from workers. Main controller owns commits/review orchestration and final PR.

## Review Focus

- Equal source IDs across adapters/types and unresolved typed references: preserve identity and report ambiguity.
- Shared jump host with two routes, released lease or stale pass: bind checks to exact route and validity.
- Cyclic, disconnected and large graphs: preserve all represented nodes/edges, terminate focus traversal and expose truncation.
- Engagement/session changes and in-flight refreshes: clear prior selection/data and reject stale responses.
- Malicious labels and unavailable sources: safe text rendering and visible errors, no false live/demo fallback.

---

### Task 1: Read-only snapshot and demonstration model

**Files:**
- Create: `packages/warroom-dashboard/package.json`
- Create: `packages/warroom-dashboard/src/model.js`
- Create: `packages/warroom-dashboard/src/snapshot.js`
- Create: `packages/warroom-dashboard/src/demo.js`
- Test: `test/dashboard-snapshot.test.js`

**Interfaces:**
- Consumes: existing fact.db/global.db schemas; Spec DTO.
- Produces: `readDashboardSnapshot({ home, engagementId, now? })`, `listDashboardEngagements({ home })`, `createDemoSnapshot()`. Snapshot errors have a stable `code`, missing engagement is E_DASHBOARD_NOT_FOUND, bad path E_DASHBOARD_PATH, bad database E_DASHBOARD_DATABASE. Pure projection may be exported for tests.

- [ ] Write meaningful failing tests with real temporary SQLite stores: hash/watermark unchanged, non-existent home not created, cross-adapter/type IDs, explicit/ref edges, ambiguity, exact-route pass, expired/released lease, stale route, cancellation and unknown state, isolated/empty and malformed rows.
- [ ] Run `node --test test/dashboard-snapshot.test.js` and record the expected missing-module/behavior failure.
- [ ] Implement whitelisted projections, read transactions and close all connections; bind egress to route/lease lifecycle. Expose all warnings and counts. A route branch can only connect when fact/task data gives its exact reference.
- [ ] Add an in-memory demo with four jump hosts and explicit fork/merge/shared dependencies plus route notes; no writes or network calls.
- [ ] Run targeted tests and return report with files, commands, pass count, unresolved items and schema example. Controller reviews before the next dependent task.

### Task 2: Minimalist browser map and conversation navigation

**Files:**
- Create: `packages/warroom-dashboard/public/index.html`
- Create: `packages/warroom-dashboard/public/styles.css`
- Create: `packages/warroom-dashboard/public/app.js`
- Create: `packages/warroom-dashboard/public/graph.js`
- Test: `test/dashboard-graph.test.js`

**Interfaces:**
- Consumes: Task 1 DTO; `/api/engagements`, `/api/snapshot?engagement=<id>&session=<id>`, `/api/sessions`, `/api/demo`. The demo endpoint is explicitly selected.
- Produces: `layoutGraph(snapshot, options)` and `focusedSubgraph(snapshot, selectedId)` from graph.js. CSS/JS use relative assets so the DSH registered page's base path works.

- [ ] Write failing graph tests for forks/merges, stable IDs/coordinates, cycle-safe focus, disconnected nodes, orthogonal paths and collapse preserving risky route summaries.
- [ ] Run `node --test test/dashboard-graph.test.js` and retain the expected failure evidence.
- [ ] Implement deterministic five-rank layout, fine SVG wires, compact nodes and route-note bands. Shared dependencies retain all route IDs; cycles stay visible. Large graphs scroll/zoom instead of silently dropping nodes.
- [ ] Implement desktop left dialogue plus upper global/lower drilldown, complete full-map mode, selection tethers, exact-ID search, node↔conversation linking and route-aware highlight.
- [ ] Implement pan/zoom/fit, label details, explicit refresh, retained selection only for the same engagement, race-safe fetches and honest empty/error/stale states. Narrow screen stacks panels; focusable SVG nodes and buttons support keyboard selection.
- [ ] Keep route notes/aggregate anomalies visible when evidence kinds are collapsed or focus changes. Add state legend; selected blue/mint outline must not overwrite amber/red verification status.
- [ ] Run graph tests and return a report. Controller runs actual browser scenarios after Task 3 provides the server.

### Task 3: Local/DSH delivery, conversation provider and documented validation

**Files:**
- Create: `packages/warroom-dashboard/src/server.js`
- Create: `packages/warroom-dashboard/src/dsh-entry.mjs`
- Create: `bin/dashboard.mjs`
- Test: `test/dashboard-server.test.js`
- Modify: root `package.json` (workspace and dashboard scripts), `README.md`, `docs/ACCEPTANCE.md`
- Create: `docs/dashboard/usage.md`

**Interfaces:**
- Consumes: Task 1 reader/demo and Task 2 static assets.
- Produces: `createDashboardHandler({ home, conversationProvider? })`, `startDashboardServer({ home, port=0, host='127.0.0.1', conversationProvider? })`, optional DSH plugin apply with verified host interfaces. Handler returns only whitelisted API data, supports GET/HEAD, rejects writes and unexpected Host/Origin; server closes on dispose/signals.
- Conversation provider contract: `{ listSessions(): Promise<Array<{id,title}>>, readMessages(sessionId): Promise<Array<{id,role,text,created_at,node_ids?,route_ids?,task_ids?}>> }`; no provider yields unavailable, never fake transcript. Exact-ID matching only to uniquely resolvable IDs in the current snapshot.

- [ ] Write failing server tests for live/demo distinction, write rejection, Host/Origin/path containment, secret non-exposure, source failures, provider absence/failure, message↔node linking and unambiguous session choice. No proxy URL or shell command input from browser.
- [ ] Run `node --test test/dashboard-server.test.js` and record the missing behavior.
- [ ] Implement loopback-only Node delivery and mounted handler; build DSH adapter against actual public webServer/sessionController signatures, then test with faithful contract doubles. Do not change/ restart the user's running host.
- [ ] Add CLI `node bin/dashboard.mjs --home <dir> --port <port>`; no home must display an empty state without creating a directory. Expose demo as opt-in UI. Configuration/help and fatal errors must return appropriate exits.
- [ ] Document real-data startup, DSH mount config, conversation limits, demo mode and validation commands; sync ACCEPTANCE without treating local proof as HOST_VERIFIED.
- [ ] Run relevant tests, full six gates and meaningful Playwright desktop/mobile interactions; retain actual screenshots. Update test-count references with existing script after the final added tests.
- [ ] Deliver report and reviewer package. After approved review, controller commits, pushes the feature branch, opens a PR and attaches it to this chat.
