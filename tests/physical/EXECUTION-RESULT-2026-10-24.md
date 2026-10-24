# Local physical test attempt - 2026-10-24

Outcome: PARTIAL. The full A/B browser isolation test did not pass. Chromium failed before a usable browser was available. Do not treat the independent authorization checks as a completed physical-isolation or live-account E2E result.

## Actual execution

- Source: prepared harness at commit 0b5cce7, unchanged application sources.
- Two test images were built from already cached immutable base IDs, using the legacy Docker builder with --pull=false and --network=none. No dependency install or image pull was performed.
- Six services started on a new internal control network and an isolated tmpfs database named trainer_sync_team_physical_test.
- Two synthetic users were provisioned. All Notion credentials, destinations and company bindings were public test fixtures. No operating master key or real company/Notion transport was used.
- Only A's dedicated browser was requested. It exited with code 1 and an allowlisted diagnostic: No usable sandbox. The runner made four bounded attempts, then set manual_review / RUNNER_UNAVAILABLE. B's browser was not requested after this failure.
- Runtime resources created: seven containers (six services plus A browser), two internal networks (control plus A), and one new test profile volume. This is less than the maximum approved eight containers / three networks / two volumes.

## Observed localhost publication issue

HostConfig contained the intended 127.0.0.1:4316 and 127.0.0.1:15436 bindings, but Docker Desktop returned empty actual port mappings for the internal network. Direct host access failed.

The bounded test used temporary Windows loopback listeners on those same two ports. They forwarded opaque TCP over non-TTY Docker exec stdio into exact journal-recorded test container IDs. Targets and ports were fixed, ownership labels were rechecked per connection, connections and lifetime were bounded, and payloads / stderr were not logged. No additional network, external listener, Docker socket mount or permission was added.

This verifies a loopback-to-exec test transport, not successful Docker port publication. It is not an implemented production ingress deployment.

## Independent actual checks

A separate fresh browser context per synthetic user exercised the TEST page with the real team API handlers. Twenty checks passed:

- A/B UI login; anonymous API rejection; client tenant override rejection; invalid Origin rejection.
- Own fake Notion destination accepted and the other user's fake destination rejected for both A and B.
- Stale connection revisions rejected for both users.
- Writes, scheduling and full-sync-complete flags remained false.
- UI preview failed closed for both unready company connections; no preview jobs were queued.
- Two tenant-scoped fake secret envelopes were stored without their public fake plaintext tokens.
- Cross-user and anonymous browser HTTP access was denied.
- UI cancellation caused the runner to remove A's failed browser.
- UI logout revoked the synthetic user's authentication.

These are actual isolated UI/API/DB checks. They do not establish a successful company read, Notion write, noVNC session, worker preview completion or Next UI E2E.

## Browser configuration diagnosis

Both the operating company browser and test browser used pwuser, privileged=false and no added Linux capabilities. The test image was derived from the same cached operating browser base, changing only the test startup to about:blank.

The operating browser used a custom seccomp profile whose parsed content matched docker/playwright-seccomp.json. The test browser had no custom seccomp setting. The local reviewed profile allows clone / setns / unshare for browser user namespaces. The missing profile is the strongest observed configuration difference associated with No usable sandbox; host kernel / AppArmor causes were not independently ruled out.

No --no-sandbox flag, unconfined profile, added capability or security-setting change was applied. A next attempt needs explicit approval to apply the existing reviewed profile to newly created test browsers only, with fixed profile validation in the runner. It does not require changing the existing operating browser or obtaining a new profile download.

## Not executed / not established

- Successful noVNC HTTP/WS session or open-WS invalidation after revision/logout/expiry.
- Raw A-to-B browser VNC/CDP and browser-to-control TCP isolation, since usable A/B browsers were absent.
- Successful button-to-queue-to-worker preview with a ready synthetic company browser.
- Actual external DNS blocking. No external DNS lookup or Internet dial was attempted.
- Real company/Notion authentication, member writes, colleague onboarding or production master-key storage.
- Production network/HTTPS ingress deployment.

## Cleanup and preservation

The host runner and loopback listeners were stopped first. The final host state recorded zero active sockets and relays. Cleanup used the test journal's exact IDs and run/ownership labels, and only explicit stop/rm/network-rm/volume-rm commands.

All ten recorded runtime resources were confirmed removed. A separate label-filtered inventory found zero remaining containers, networks or volumes for the run. No listener remained on 4316 or 15436.

The operating service baseline retained identical container IDs, image IDs, start timestamps and running states. The existing web, company browser and database remained healthy. This is service-metadata/health verification, not a complete comparison of all operating database contents. No test code connected to the operating database or real providers.

Two cached test images were retained; no image prune or shared-base removal was performed. Metadata-only local execution evidence remains under ignored .runtime/team-physical-test/.

## Git result

The approved remote is https://github.com/alexjspark/bpt_notion_sync.git. Windows GCM listed only luahana; the GitHub CLI used the same account and repository permissions reported pull=true, push=false. Push was not attempted with that known insufficient permission. No new login, token grant, account switch or permission change was initiated. Repository authentication remains a separate pending user step.
