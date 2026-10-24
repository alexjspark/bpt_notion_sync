# Phase 2: coworker authentication and isolated browser runtime

Status: local code and isolated tests completed. NOT enabled or deployed on the existing personal service. No real coworker/Notion/company account or physical tenant topology has been verified.

## Scope preserved

The existing personal service, saved keys, company profile, member pages and calendar were not used or modified by these tests. Phase 2 defaults OFF. Enabling its route boundary blocks legacy sensitive APIs rather than falling back to a fixed tenant. Member writes and scheduled synchronization remain OFF. General phase 1 memo/survey/template/calendar synchronization is still incomplete.

No company browser container, production network, external port, account grant, credential/master generation or Git push occurred. Ephemeral test containers and synthetic _test databases were used.

## Implemented modules

- team-auth / team-vault: bounded asynchronous scrypt; hashed opaque sessions; user/tenant/auth-version/session-expiry checks; operator-injected AES-256-GCM master with tenant/connection/revision/purpose AAD. No plaintext fallback or reuse of personal keys.
- team-connections / team-browser-store: authenticated server-derived tenant; exact connection revision; browser owner user and authentication-session binding; DB outbox for allocate/probe/stop; expiry/revocation/cancellation detaches the pointer, invalidates reads and queues cleanup. The confirmed stable company account survives relogin and cannot silently switch.
- team-browser-driver / team-browser-network: runner-only injected Docker commands, pinned image IDs, exact labels/names/profile volume, no client Docker URL/CDP/host/path/flags. A browser belongs to one tenant-internal network, with no host ports, bind/socket mounts, extra capabilities or privileged/host namespace. Only image/role-verified gateway/worker/egress peers may join. Trusted peers must also have no mounted host resources or published ports.
- team-company-egress: HTTPS CONNECT only to admin.biz-pt.com:443. DNS must resolve entirely to public IPv4; the selected IP is used directly, with private/reserved IP, arbitrary target and redirect-based proxying absent. DNS, tunnel lifetime and concurrent slots are bounded. No traffic/body/header dump.
- team-browser-runner: privileged allocation/stop consumer separate from web and worker. Exact tenant+session is the reconciliation key, including uncertain acknowledgements. Stop precedes allocation, previous cleanup gates profile reuse, leases fence completion, retries/backoff stop at four attempts for manual review. Profiles/networks are preserved rather than forcibly deleted.
- team-browser-gateway: owner-authenticated HTTP and WS, configured Host/Origin, CSRF boundary, fixed server-derived VNC host:6080, no client upstream or cookie forwarding. Asset realpath boundary, bounded authorization timeout, two streams per owner/session, periodic reauthorization, revision/revocation/expiry shutdown and 15-minute stream ceiling. It creates handlers without listening on import.
- team-owned-browser / team-readonly-runtime / team-notion-inventory: trusted worker derives only its owned CDP endpoint, opens a fresh scoped lease and reuses normal company account proof and counted UI coverage checks. Exact Notion destination/schema/admin URL/optional explicit UID are verified. Unknown URL identities hold duplicate-prone creation; no names are used for identity. Read-only planner returns counts and preserves calendar policy.
- team-worker-dispatch / team-preview: server DB selects job tenant, not HTTP input. Queue pins connection, destination, browser, token revision and authentication session. Guards surround reads; final SQL locks/checks current authority and lease. Own-run cancellation discards stale results. Interrupted or uncertain work is held; no blind replay.
- /team and team API: connection/lifecycle state, masked key input, readiness, owned login-screen link, reconnect/cancel and preview cancellation. Heartbeat and route configuration are required before real readiness. Missing master/provider stays blocked.
- Existing safe audit trace is reused for preview and browser-operation IDs, phases, outcome/reason and pseudonymous tenant/account references. DB operation records carry attempt/lease/reason/state. Raw source values, keys, cookies and original errors are omitted. This does not claim that every setup/auth event has an audit entry.

## Runtime separation and defaults

Web imports only the DB outbox provider. It has no Docker CLI adapter or socket. The privileged Windows runner is scripts/team-browser-runner.ts and consumes allocate/stop only. The trusted container worker is scripts/team-preview-worker.ts and consumes probe/read-only preview only. Separate scripts start gateway and egress. All entrypoints require explicit runtime approval flags, an existing 012 schema and configured resources; none performs automatic migrations or creates secrets. Network listeners additionally require a Linux Docker container and are not started by module import.

The dedicated browser's CDP announcement uses its own generated internal hostname. Its fixed company proxy setting applies only to newly configured team browsers; the old personal browser defaults are preserved.

Intended future topology:

    authenticated web/ingress -> gateway
    privileged runner -> Docker metadata/lifecycle only
    tenant A internal bridge: A browser + trusted gateway/worker/egress
    tenant B internal bridge: B browser + trusted gateway/worker/egress
    egress proxy -> company HTTPS only
    worker -> own Notion token/destination through normal read API

An initial shared-network plan was rejected during code review because VNC/CDP are unauthenticated inside a browser container. It was replaced with the tenant-internal network contract above before any launch. A read-only reviewer confirmed that the identified common-bridge path is removed in code. Physical Docker routing/firewall behavior remains untested.

## Verification completed

- 27 related unit/contract tests: 11 foundation cases, 11 new runtime/network/gateway/egress/Notion cases and 5 existing audit regressions.
- 23 isolated PostgreSQL integration tests: 13 foundation/API cases plus 10 lifecycle/dispatcher cases. Synthetic A/B users, fake destinations, Mock driver/inspector only.
- One real Next + Chromium UI scenario with 10 checks: A/B login, readiness/disabled controls, logout and legacy API boundary. It is not a real company login or live Notion E2E.
- Root/web type checks and production web build pass.
- Later trusted-peer/listener guard refinement passed type checks and its affected Docker contract tests.
- Commit privacy allowlist inspection is required before the local commit; no secrets, personal bindings, artifacts or profiles are allowed.

Important failure cases found and fixed: replay pool exhaustion, actor lifetime beyond logout, late allocation after cancel, expired pointer blocking relogin, final-result authority race, shared browser network, SQL parameter type ambiguity, and concurrent egress cap reservation. One gateway test used an incorrect Host and was corrected; no security check was relaxed.

Tests never launch a real company browser or invoke the Docker CLI driver. Gateway/egress tests use loopback Mock upstreams inside an ephemeral test container. PG tests require TEST_DATABASE_URL ending in _test. The legacy worker/check:docker command must not be used to test this feature.

## Still unverified / activation prerequisites

These are pending operating validation, not completed account connections:

- Pinned images, trusted peers, tenant bridge routing, DNS/VNC/CDP reachability, Docker Desktop behavior and actual cleanup reconciliation.
- Same-origin TLS ingress must route /team/browser/<session>/ HTTP and WS to the gateway. It is not configured here. TEAM_BROWSER_ROUTE_CONFIGURED remains unset by default.
- Real company login/MFA/expiry and whether required resources use additional domains. Only the company host is permitted; additional hosts require evidence and approval.
- Real Notion scopes/schema/template, pagination and member values. The read mapper recognizes exact expected property names/types; arbitrary coworker schemas are not auto-guessed.
- Real gateway rendering of noVNC assets, live account binding and full live preview.
- Operator provisioning, account recovery/reset/MFA UI and shared-tenant roles are not implemented. Initial accounts have separate tenants. No public registration exists.
- Existing-page atomic concurrent-edit protection and general member/calendar writes remain unavailable/off. Prior one-time approvals are not copied into phase 2.
- Diagnostic retention relies on the existing bounded audit store/pruner; operations/idempotency records are retained for reconciliation rather than pruned automatically.

Before activation, request explicit approval for the operator master and a separate preview HMAC secret generation/storage, pinned runtime images, the tenant network/egress topology and Docker runner access, same-origin deployment, each coworker's service account/company login and own Notion connection. No secret has been generated or configured here. No existing personal key/profile is a fallback.

After those approved prerequisites: own service login -> prepare owned browser -> open server login screen and sign in directly -> confirm stable company identity -> enter own Notion key/destination -> read-only validation/preview. Personal Chrome login is never copied to the server.

A manual_review cleanup is intentionally not force-replayed through the web. An operator must reconcile the exact owned resource before any future retry. Disconnect stops access; persistent tenant profiles are not permanently deleted by this implementation.

## Physical test harness preparation (not activated)

The test-only bundle under tests/physical/ adds about:blank images, fake company/Notion providers, unconditional deny-all egress, fixed localhost HTTP/WS ingress, strict test DSN/marker guards, and test-run resource ID/label journaling and cleanup planning. tests/team-physical-plan.test.ts uses only virtual executors and in-memory Request/Response objects. No physical Docker/DB/listener/account or image build was performed during this preparation. The TEST web surface reuses real API handlers but is separate from the existing Next UI. Operational master protected storage remains unimplemented. See tests/physical/README.md for activation prerequisites and resource scope; actual activation requires separate human authorization.

## Approved synthetic physical follow-up (2026-10-24)

The Windows Docker follow-up verified tenant-network negative TCP probes and corrected sandbox-client HTTP/WS, rendered noVNC and lifecycle cleanup. Selected checks:38 unit/native gateway cases plus root/web typechecks. See [execution result](../tests/physical/EXECUTION-RESULT-2026-10-24.md). Initial Windows Playwright default sandbox-disable evidence was discarded and rerun with explicit sandbox and actual-argument guards.

Operating services and real member data were preserved. The temporary loopback-to-Docker-stdio test transport is not production ingress. Operational master storage, real colleague accounts/provider grants, remote HTTPS deployment and the unfinished phase-one full sync are still separate work; writes/scheduling were not enabled.
