# Phase 2: coworker isolation — local implementation

Status: implemented local authentication/connection/preview boundaries; NOT deployed or enabled on the existing personal service.

## Preserved operating scope

- Existing personal service, configuration, stored keys, company profile and member data were not used or changed by these tests.
- PHASE2_ENABLED defaults to false. When enabled, /team and /api/team use new tenant authentication; original sensitive APIs are blocked rather than falling back to ACTIVE_TRAINER_ID.
- No member write endpoint exists in phase 2. Schedules and writes remain OFF.
- Phase 1 general memo/survey/template/calendar synchronization remains incomplete. Phase 2 does not mark it complete.
- No Git push, real coworker provisioning, key generation/input, browser launch, external port, domain, TLS, paid service or permission grant occurred.

## Modules and implemented contracts

- team-auth.ts: one service user per tenant in this initial version; asynchronous bounded scrypt, exact passwords, opaque random sessions stored only as SHA-256, expiry/revocation/auth-version and active tenant/user checks; five failed logins trigger a 15-minute per-login throttle. No public registration. Provisioning is an internal function, not a public API.
- team-vault.ts: injected 32-byte AES-256-GCM master; authenticated tenant/connection/secret revision/purpose; random nonce, versioned envelope. Missing master blocks input/storage before reading the secret request body. No automatic key generation, plaintext fallback or reuse of existing personal keys.
- team-connections.ts: server-resolved tenant, authenticated actor capability, transaction ownership checks, connection revision CAS, destination validation before persistence, stale queued/running run invalidation, own browser session lifecycle.
- team-providers.ts: company session and preview provider contracts; official read-only Notion DB → data source → available template validation; per-tenant/connection/revision bounded runtime cache.
- team-adapter-preview.ts: fresh per-run adapter factory reuses the existing company completeness, exact UID, unresolved Notion identity and withdrawal planner. It exposes read-only ports and returns counts only. Unknown identity rows hold duplicate-prone creates; no name matching.
- team-preview.ts: tenant-scoped dedupe, active-run uniqueness, connection/session/destination/secret revision pinning, worker lease, account recheck before collection, guards during read, final revision fencing. Interrupted expired reads are held; no blind replay. A worker dispatcher must supply the tenant from trusted server state.
- team-api.ts / team-boundary.ts / proxy.ts: auth and strict origin checks, bounded JSON bodies, reject unexpected scope fields/query, HTTPOnly SameSite cookie, HTTPS requirement except explicit localhost, fixed safe errors, legacy API boundary.
- /team: login, connection status, masked Notion key form, own company session actions, preview status/reason. Unconfigured providers/master are accurately shown as unavailable.
- 011_team_tenants.sql: new isolated tables and composite ownership FKs; provider handle and Notion data-source uniqueness; no operating DB migration was run.
- Existing audit-log.ts sanitizes phase 2 queue/claim/collect/plan/completion with correlation IDs. Own-run log endpoint checks tenant ownership. It never returns raw provider errors, tokens, source records or personal values.

## Verification actually completed

- 11 new unit tests: auth/vault, actor forgery, cache, official destination contract, legacy boundary, existing planner adapter scope and unknown identities.
- 5 related pre-existing audit unit regressions also pass (16 combined).
- 13 PostgreSQL integration tests on a dedicated database whose name ends in _test: real handlers/auth/SQL/queue/worker with synthetic A/B users and injected fake providers. Includes cross-run/log/session/destination denial, encrypted storage, queued/running invalidation, account change, throttle, revocation and lease expiry.
- One actual Next + Chromium UI scenario, with 10 checks, in an ephemeral container without host ports. A/B login and settings readiness are exercised; blocked real providers are intentional. This is not a real company/Notion E2E.
- Root/web type checks and production web build pass.
- An initial adapter unit fixture missed partial-inventory contract fields; corrected the fixture and reran the failing tests successfully.
- Read-only independent review found a nested replay transaction that could exhaust the pool; replay now uses the existing transaction client.

Reproducible local commands:

    node --import tsx --test packages/engine/test/team-security.test.ts packages/engine/test/team-adapter-preview.test.ts apps/web/test/team-boundary.test.ts packages/engine/test/audit-log.test.ts
    npm run typecheck
    npm run build:web

PG integration and tests/team-ui.e2e.ts must run only against a dedicated TEST_DATABASE_URL ending in _test, with synthetic data. The UI test starts Next on container loopback, not a host-published port. Do not run the legacy worker/check:docker to test this feature; those commands can start the existing personal runtime.

## Not yet connected / remaining implementation

- Production company and preview providers deliberately remain Unconfigured. There is no production per-tenant Docker launcher, authenticated remote browser HTTP/WebSocket gateway, or automatic dispatcher in this change. The lifecycle and isolated adapter/queue contracts are implemented and exercised with injected providers.
- Existing single-user browser gateway and global companyPage worker are NOT reused for coworkers.
- No real account binding, MFA/expired login recovery, company pagination, real Notion permissions/schema/member values or coworker data access were verified.
- Notion validation checks API access, DB/data-source parentage, title schema and template membership. It does not prove that every row belongs to the user, nor validate every phase 1 member/calendar mapping.
- Per-login throttling is not an internet-edge abuse protection system. Account recovery, operator account-management UI, password reset/MFA and shared-tenant multi-user roles remain outside this local milestone.
- Runtime cache primitive is isolated/tested; real providers are not wired, so there is no claim that current production adapters/caches are multi-tenant.
- Connection/setup/auth events are not yet all persisted to a tenant audit trail. The run trace and owned run-log API are implemented; no claim of logging every event.
- Existing-page atomic concurrent-edit protection remains unavailable. No phase 2 writes are enabled, and old one-time authorizations are not imported.
- No deployment or physical browser/container/volume isolation validation has occurred.

## Next approvals and work

Independent code can continue on the production browser provider/gateway/dispatcher before any real connection. Real activation additionally requires separate approval for: an operator master credential generation/storage procedure, service user provisioning, each coworker's company session/login and own Notion key/page access, and any future HTTPS/network deployment. The master must not be placed in Git or reused from preview/audit/personal secrets. Until approved and implemented, the UI stays fail-closed.

Initial coworker flow after those prerequisites: own service login → open own server-hosted company browser and sign in directly → verify stable account binding → enter own Notion internal connection key and select own DB/data source/template → read-only validation/preview. Personal Chrome login is not transferred to the server. Public Notion OAuth is a later productization option, not implemented by this milestone.
