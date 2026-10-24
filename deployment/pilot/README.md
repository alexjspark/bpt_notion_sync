# One-colleague pilot — prepared code, NOT activated

The preparation code can now produce a concrete deployment manifest after all required public inputs are supplied and validated. Missing access choice/origin/image digests/ports/source revision are rejected. No running services, credentials, colleague invites or external access have been created by this preparation.

## Scope

First real pilot write: ONE existing, uniquely UID-linked member in the colleague's own validated Notion DB; blank phone/email/birth-date/gender/UID only. The user checks member, DB, page and field names in a fresh preview and acknowledges an editing pause. Notion atomic CAS is unavailable. Body/status/dates/schedules/existing values stay preserved. New member creation, general template personalization, surveys, memo/date mapping and schedule completion remain separate unfinished work. Google Calendar is absent. Uncertain consumed writes require manual read-only review; automatic retry/release is not implemented.

## Prepared entrypoints

- packages/engine/src/pilot-deployment.ts: required-input validation, source/image contracts, six-service Compose plan, separate device/web access adapters, Windows runner variables and offline image build commands.
- scripts/prepare-pilot-deployment.ts: requires a clean Git checkout, exact current source revision, already present pinned images with expected UID/contract/source labels, free explicit ports, and no existing same-name containers/network/volume. It writes create-new compose.json/runner.json/access.json only under ignored .runtime/pilot-plan/<deploymentId>. It never runs build/up or installs a provider.
- deployment/pilot/input.example.json is an intentionally incomplete INPUT EXAMPLE. It is not the deployment manifest. Fill a private local-config/pilot-deployment.json after choices/approvals; never put credentials in it. Unknown fields are rejected. Ports4310/4312 and trial4316/15436 are reserved and rejected.
- Dockerfile.runtime retains cached noVNC sources/licenses, generates the bundled login client, and builds Next with network-none RUN steps. Dockerfile.browser pins a reviewed cached browser base and copies the current company startup/shutdown source. pilotImageBuildPlan requires immutable cached base IDs and source revision; missing cache is a stop, not permission to pull or download. No image was built in this turn.
- scripts/team-pilot-start.ts: explicit approved runtime gate, Docker/Linux guard, bounded secret-file wait, schema013 check, then the exact web/worker/gateway/egress entry. Web never calls the old mock start-web/migrate/seed path. Ingress starts separately without DB/key access.
- scripts/team-browser-runner.ts: Windows-only operational DB configuration, explicit runner/seccomp approval, fixed SHA256 profile, create-only seccomp insertion and effective JSON verification before starting or re-adopting a dedicated browser. An owned bad-profile container may be stopped without being re-adopted. No personal Chrome/CDP route exists.
- scripts/team-pilot-migrate.ts: separate explicit migration approval and only an empty trainer_sync_pilot DB. It does not seed; nonempty DB or uncertain completion requires review rather than automatic retry.
- scripts/team-operator-bootstrap.ts: separate explicit operator approval; requires the dedicated DB/schema and no operator. It binds127.0.0.1 only, displays a safe password form, validates original Host/Origin/CSRF/body/time limits, rejects Upgrade/CONNECT, allows one atomic provisioning attempt and closes after the terminal response or10-minute lifetime. No public registration route is mounted.

## Secret preparation and delivery — approval required before use

No existing personal key is a fallback. These commands are CODE ONLY at this stage:

1. team-windows-key-store.ps1 creates a fresh AES/HMAC pair at %LOCALAPPDATA%/TrainerSync/team-pilot/operator-keys.dpapi after OperatorApproved. Windows DPAPI CurrentUser protects it; only a fresh or verified restricted own directory is accepted. A newly created file's owner is set/rechecked. No overwrite/rotation exists.
2. team-windows-database-store.ps1 accepts a separate pilot DB password through a masked terminal prompt after OperatorApproved, stores database-password.dpapi with separate DPAPI entropy, and never prints the password. Actual input/credential creation is pending explicit approval.
3. team-windows-secret-inject.ts requires approved handoff/database gates plus role, immutable image and exact deploymentId. It validates exact container ID/name/image/managed/pilot/deployment labels BEFORE unsealing. Password and key bytes travel in internal process pipes and Docker exec stdin, never arguments, Docker config environment or host plaintext files.
4. DB uses only the password. Web/worker receive DB URL + AES/HMAC. Gateway/egress receive only DB URL. Each container has its own exact /run/team-secrets tmpfs; files0400 with UID1000, directory0700. The DB installer writes a private pending file, verifies length/mode/owner, then atomic-renames the final password file; initialization cannot see a partial input. PostgreSQL base must be the reviewed UID999 image contract.
5. Linux loaders reject wrong path/owner/mode/link/size and ambiguous inline+file configuration. Pilot DB URLs are fixed to trainer-sync-pilot-db:5432/trainer_sync_pilot. Windows runner/bootstrap unseal only the new DB store into process memory and use the approved loopback DB port. Audit and application DB pools share the loader. Existing nonpilot DATABASE_URL behavior remains compatible.
6. Application startup requires completed injection. A handoff with an uncertain outcome is not automatically retried; inspect exact target/file metadata and reconcile first. Runtime strings may exist in process memory; buffer wiping is best effort and is not a claim of complete heap erasure.

Operational DPAPI file/ACL behavior, Docker tmpfs delivery, actual restart and backup restoration still require approved physical activation/rehearsal. The synthetic process-restart test is described in VERIFICATION.md. A different Windows user, lost Windows identity or machine restore is NOT covered. Recovery policy must be agreed before real tokens are stored.

## Manifest topology and approvals

Six static containers: dedicated DB, web, worker, gateway, company-egress, ingress. Tenant browsers are dynamically allocated by the separate privileged Windows runner. No Docker socket or host bind is mounted into web/worker/gateway/egress.

Three initial bridges: control is internal; providers is non-internal for web/worker Notion API and company-egress HTTPS; hostlink is non-internal for reliable Docker Desktop loopback publication of ingress and DB. Only exact loopback ingress/DB ports are published. Each tenant browser belongs to ONE separate tenant-internal network; gateway/worker/egress are verified trusted peers. Only the company HTTPS host is allowed through the company CONNECT proxy. These outbound bridges/port bindings require approval and were not created here.

All actual runtime/runner/seccomp/key/database/operator/migration approval flags are absent or OFF in generated runner metadata. Compose uses an explicit required runtime-approval interpolation, and member writes stay false. Generating/parsing the plan is not authorization to execute it. Do not run compose directly before the approved deployment review. Existing names/ports/resources are blocked rather than adopted.

Activation requires: chosen Windows identity and backup policy; separate DB password and master pair generation/storage/use; exact cached base and built image IDs; new volume/networks/loopback ports and runner permissions; source revision and deploymentId; initial operator input; named colleague email; each person's company/MFA and own Notion integration/DB/template consent; real read-only preview; final selected-member write approval. Schedules remain OFF.

## Selected browser-only access — activation pending

The user selected no colleague installation. The proposed provider adapter is Cloudflare Tunnel + Access, installed only on Windows, with exact-email OTP followed by the existing TrainerSync login. It is prepared in source and OFF by default. No Cloudflare account, tunnel, DNS/TLS rule, credential, binary, subscription or external route was created. Prior device access code is retained only for compatibility; Tailscale is excluded from the pilot proposal.

See [web-only proposal, official evidence, data-transit review and exact required inputs/approvals](WEB-ACCESS.md). The input example now requires Cloudflare team/AUD/tunnel UUID and the operator+colleague emails in private configuration. The generator emits a review-only cloudflared.yml. Production ingress refuses to listen without the explicit web-access gate; both HTTP and WS validate Access before fixed-peer routing. This is not SSO, an active deployment, or live provider/noVNC validation.

## Rollback

Record created IDs/labels before actual activation. Stop only the new pilot stack/runner and revoke only its future access grant. Preserve existing personal service4310, keys, company profile, member pages and DB. No prune/global down-v/force or old-volume deletion. A code rollback does not undo an explicitly approved Notion write. Reusing a previous deployment requires reconciliation rather than generating a fresh manifest over it.
