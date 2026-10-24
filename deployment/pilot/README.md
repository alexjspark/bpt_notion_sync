# One-colleague pilot activation plan — NOT activated

This is a reviewable plan, not an instruction to start production resources. Existing personal compose, keys, profiles, DB and port4310 stay separate. Do not run the physical Mock harness as a production service.

## Exact pilot scope

The first proposed real write is ONE existing, uniquely UID-linked member in the colleague's own validated Notion DB. Only empty phone, email, birth date, gender and explicit UID fields may be filled from explicit company data. The user checks the member, target page, target DB and field names in a fresh preview and confirms a temporary editing pause. General writes and scheduling remain OFF. No page creation, template copying/personalization, survey, memo, first-training-date, status or schedule mutation is part of this pilot writer. The unfinished phase-one flows remain unfinished; Google Calendar is not implemented.

## Approval gates (all pending)

1. Named Windows operator identity and separate pilot DB, initial operator service account, new production AES/HMAC keys and their continuing use/storage. No existing personal key may be copied. Account recovery and protected-key backup policy must be agreed.
2. Pin web/runtime/browser images, review build provenance, permit the existing reviewed Playwright seccomp profile for new pilot browsers, tenant-internal network/worker/gateway/egress topology and host runner access. Docker socket is absent from web/worker. No live topology has been created in this turn.
3. Select the colleague email and deliver ONE24-hour invitation privately after verifying the recipient. No email service or invite sending is implemented. The email match is an invitation-recipient check, not independent mailbox verification. The colleague chooses their own service password in the UI.
4. The colleague directly signs in to their own company account in their server-owned browser, completes MFA, and confirms stable account/trainer identity. A personal Chrome login is not transferred. Then they create/approve their own Notion internal integration and enter it into the masked UI, selecting their own DB/data source/template. Each provider grant requires that person's approval.
5. Activate private HTTPS access only after the exact tailnet/operator/colleague/device/ACL/domain/cost is approved. No public tunnel/Funnel/port-forwarding or OS firewall change has occurred.
6. Run real-company/read-only Notion checks, compare the selected member and destination, and obtain the final one-member write approval. TEAM_PILOT_WRITE_APPROVED is a separate gate and is not enabled by enabling preview.

## Protected key delivery prepared in source

- scripts/team-windows-key-store.ps1, explicit OperatorApproved: creates a fresh64-byte pair only at %LOCALAPPDATA%/TrainerSync/team-pilot/operator-keys.dpapi, encrypted with Windows DPAPI CurrentUser, a new restricted directory ACL and create-new semantics. It refuses an existing store/directory; it does not rotate or overwrite a key.
- scripts/team-windows-secret-inject.ts, explicit TEAM_SECRET_HANDOFF_APPROVED: reads only that NEW dedicated protected store under the same approved Windows identity. It does not inspect historical personal key files. The plaintext crosses internal binary pipes and docker exec stdin only, never process arguments, environment, logs or a host plaintext file.
- The target is pinned by exact container ID, immutable image, service name and labels. The installer verifies a fresh container tmpfs at /run/team-secrets; writes mode0400 master.hex/preview.hex owned by UID1000, with a0700 directory. Linux runtime loaders reject symlinks, hardlinks, wrong owner/mode/path/length and ambiguous inline+file values. Missing keys fail closed.
- Web target: trainer-sync-pilot-web / managed pilot-web-v1. Worker: trainer-sync-team-worker / managed phase2-worker-v1. Both also require trainer-sync.pilot=one-colleague-v1. No Docker socket is mounted. A role guard permits only the worker's exact tmpfs secret mount on tenant networks, never a host bind.
- These are source/unit-tested boundaries. Real DPAPI create/unseal, Windows ACL behavior, container tmpfs handoff, restart/restore and operational image UID have NOT been executed/verified. They require the approval in item1 plus a synthetic-only physical rehearsal before real tokens.
- Losing the approved Windows identity/DPAPI material can make encrypted tokens unrecoverable. No automatic recovery/rotation service exists. Do not treat copying the ciphertext alone as a tested recovery strategy.

## Proposed private Windows hosting: Tailscale Serve

Use a separate team-only same-origin ingress bound to loopback, then Tailscale Serve HTTPS inside a dedicated tailnet. The colleague uses Tailscale on Mac or Windows plus their separate TrainerSync service login. Domain: https://<neutral-server-name>.<tailnet>.ts.net. Do not expose the existing personal4310 service.

Use an explicit grant for the named operator and colleague to exactly the pilot server TCP443. Remove default allow-all. Explicitly remove any default Funnel capability/grant and verify Serve-only configuration; do not enable Funnel, exit-node, subnet routing or router port-forwarding. This requires installing/enrolling the two devices, a persistent background service/adapter, MagicDNS/HTTPS/certificate material and Serve listener/ACL changes. Device and account metadata goes to Tailscale; traffic is WireGuard encrypted device-to-device, possibly relayed as ciphertext over DERP. TLS terminates on the Windows server. The neutral device/domain name is visible in certificate transparency records.

Current official business Standard price: $8/user/month, so two users approximately$16/month before tax;14-day trial and billing terms must be confirmed at activation. Personal free is for noncommercial use and must not be assumed for company use.

Official sources checked2026-10-24:
- https://tailscale.com/docs/features/tailscale-serve
- https://tailscale.com/pricing
- https://tailscale.com/docs/reference/examples/grants
- https://tailscale.com/docs/how-to/set-up-https-certificates
- https://tailscale.com/docs/reference/faq/firewall-ports
- https://tailscale.com/security

No Tailscale account, package, device, grant, Serve listener, certificate or firewall rule has been created. The selected tailnet and neutral host name are still unknown.

## Runtime file / deployment contract (prepare only)

The intended separate stack contains pilot DB, web, gateway, readonly+pilot worker, company-only egress and same-origin ingress; the existing Windows privileged runner is separate. Gateway/worker/egress keep fixed names required by the existing driver, and must not coexist with the physical-test peers of the same names. Ingress routes /team/browser/<session>/ HTTP+WS only to trainer-sync-team-gateway:4315 and other allowed team routes only to trainer-sync-pilot-web:3000. It enforces the exact public Host and WS Origin and strips forwarded/proxy and Tailscale identity/capability headers; application session authentication alone selects the tenant. No arbitrary upstream or CDP input exists.

scripts/team-pilot-start.ts now waits up to120seconds for the two protected files and requires migration013 before launching web/worker; it never migrates/seeds/creates a key.

The checked-in runtime contract JSON is deliberately non-launchable: it has no actual DB credential, production image digest, origin, device ACL or enabled flag. A complete reviewed compose/startup manifest still needs the approved secret/DB/image/network choices. Do not claim production deployment is ready from this template.

Database migration013 must be applied ONLY to the new approved pilot DB; never implicitly migrate the personal DB. Runtime flags stay false by default. Initial operator provisioning exists as an internal library boundary, not public registration. A loopback-only one-use safe-input handler is prepared in team-operator-bootstrap.ts, with fake-provision regression tests. It is not mounted in the public app; the approved temporary local listener and actual operator provisioning still need activation approval. Account reset/MFA UI is not implemented.

## Failure behavior / limits

A fresh successful preview and exact connection revision/session/user/tenant are required. Prepared plans are encrypted, expire and show no raw field values in receipts. Local cancellation/expiry/logout/reconnection prevents dispatch. A durable consumed marker precedes the one allowed exact-page/field PATCH; retries cannot repeat it. Existing values or source/target/schema drift are held. The final readback verifies selected fields and protected properties.

Notion offers no implemented atomic compare-and-set here. Rechecks do not close the last race with a person editing in Notion. Acknowledged editing pause is mandatory; do not call it an atomic concurrency fix. An uncertain acknowledgement or failed readback is marked uncertain and blocks another pilot; no automatic re-send or operator release endpoint is implemented. Resolve by read-only review before designing any next action. No original errors/PII/tokens are logged.

## Rollback / preservation

Before activation, record new IDs/labels and operating service identities. Stop only the new pilot stack/runner and revoke only its future access grant. Do not stop the personal company browser or delete profiles/DB volumes; do not prune or run a global down -v. Preserve the protected store and pilot DB until the operator chooses an approved retention/recovery policy. Reverting code does not undo already approved provider writes.
