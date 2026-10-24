# Physical isolation harness — prepared, NOT activated

A limited approved execution was attempted after preparation. It stopped at Chromium sandbox startup; independent checks and resource cleanup completed. See [execution result](./EXECUTION-RESULT-2026-10-24.md) for the exact pass / blocked / unverified scope.

This directory is test-only source. Importing its modules does not create resources. The preparation turn ran only pure in-memory tests and TypeScript checks. No Docker command, image build, DB connection, server listener, account creation or credential generation was executed.

## Fixed scope

- Origin: http://localhost:4316 (different hostname from the existing 127.0.0.1 service).
- Database: trainer_sync_team_physical_test on the new trainer-sync-team-test-db:5432; host runner alone uses 127.0.0.1:15436.
- Six new services: DB, separate test web surface, ingress, fixed-name gateway/worker/egress; two browsers are allocated dynamically.
- One internal control network plus tenant-internal networks. No existing private/company-egress network, external egress network or Docker socket mount.
- Only ingress and test DB publish ports, both explicitly 127.0.0.1. VNC/CDP/gateway/egress stay internal.
- DB uses tmpfs. Browser volumes are newly named test-tenant volumes. Existing DB/profile volumes are never copied or mounted.
- Images must be recorded local immutable IDs. Dockerfile preparation has no install/download step; the base tags must be inspected and already cached before an approved offline build. Missing cache is a stop condition, not permission to pull.

## Explicitly synthetic

browser-start.mjs starts about:blank with a fixed local proxy. The worker reads/stamps only the synthetic about:blank ownership marker. No company session endpoint is called. Notion validation and read inventories are injected fake providers. Egress rejects every CONNECT without DNS or dialing. The browser build does not alter the production startup source.

The web surface is intentionally a separate TEST page using the real auth/connection/queue API handlers. It is not a full Next UI E2E. Existing Next UI checks remain separate.

All A/B passwords, Notion tokens and encryption/HMAC values in this harness are public synthetic fixtures. They protect no real data. Production key/token environment variables are rejected. Random login session tokens will be generated only when an approved activation actually signs in; the DB stores their hashes.

Docker environment/configuration is not RAM-only storage. Never inject an operational master or a real Notion key here. A protected persistent master loader is still unimplemented and must be designed/approved before real account activation.

## Required activation gate (not granted by this source)

TEAM_PHYSICAL_TEST_ONLY=true and TEAM_PHYSICAL_TEST_APPROVED=true, a fresh run UUID, exact test DSN, exact localhost origin and existing test-run DB marker are required. main.ts must be a fresh standalone entry process. Linux listeners additionally require a Docker container. The Windows runner also needs the explicit Docker-runner approval flag.

The compose plan sets test gates for the future test stack. Generating that plan is not permission to apply it. No image was built and no compose file/manifest was written to .runtime during preparation.

## After explicit approval only

1. Recheck candidate ports, fixed peer-name conflicts, cached base images and the unchanged operating services.
2. Prepare offline images from the already-inspected cache; record resulting IDs. Use no pull/download fallback.
3. Choose a fresh run UUID. Write plannedPhysicalJournal before any create. Keep generated compose and the non-secret journal under ignored .runtime/team-physical-test/.
4. Create only the planned stack. Inspect every static resource's name/type/test-run/managed labels and record its actual ID before starting the privileged runner. No name-only adoption.
5. The test web seeds only the new test DB and A/B service accounts. Other roles wait for the health gate. Start the Windows runner with physicalRunnerEnvironment and the same immutable image IDs.
6. In separate fresh test browser contexts, exercise A/B login, browser allocation, same-origin noVNC/WS, fake preview, cross-owner denial, revision change, expiry, cancel and cleanup. Separately measure raw TCP isolation between the new tenant browsers and the new control DB; do not infer physical isolation from proxy rejection alone.
7. Stop the runner before final teardown. Reconcile uncertain outcomes by exact names, labels and recorded IDs. Driver-deleted resources require confirmed absence. cleanupPlan returns only explicit stop/rm/network-rm/volume-rm operations; no force, prune, wildcard or operating compose down -v.
8. Remove only resources created by this test run. Persistent browser volumes/network state are retained by the normal driver, so include their recorded test IDs in final cleanup. Image cache can remain; never prune shared bases.

## Preparation checks

    node --import tsx --test tests/team-physical-plan.test.ts
    npm run typecheck

These checks use injected in-memory executors and HTTP Request/Response objects. They do not listen on ports, connect to a DB, call Docker, hash/provision an actual account or generate secrets.

The initial preparation did not execute Docker resources. The later partial execution report above supersedes that initial execution status. Full physical isolation and live company/Notion synchronization remain unverified.
