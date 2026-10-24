# Browser-only coworker access proposal — 2026-10-24

Status: SOURCE PREPARED, NOT INSTALLED OR PUBLISHED. The user selected browser-only access. A Tailscale client on the colleague's device is excluded. Windows Docker hosting stays in place.

## Proposed minimum

Colleague browser → HTTPS on one neutral owned subdomain → Cloudflare Access email OTP → Cloudflare Tunnel → Windows loopback pilot ingress → TrainerSync login → that user's isolated company login browser / Notion connection. Only the Windows server installs cloudflared. A named tunnel is proposed; Quick Tunnels and raw VNC/CDP publication are excluded. Access and TrainerSync are two separate login checks, not completed SSO or automatic identity/account binding. A colleague's personal Chrome company login is not transferred to the server.

Cloudflare currently advertises Access Free at $0 for teams under50 users. This two-person pilot is sized for that tier, subject to account onboarding and terms; paid upgrades/add-ons are not authorized. Domain registration/renewal and Windows hosting remain separate costs. No domain purchase or subscription has been made. [Official Access pricing](https://www.cloudflare.com/sase/products/access/).

The locally-managed named tunnel path requires a domain added to Cloudflare and Cloudflare DNS nameservers. Use an existing eligible domain only after reviewing all current DNS records, including mail; do not change nameservers on assumption. The application uses one subdomain; the cloudflareaccess.com team login domain is not a replacement for it. [Official prerequisites](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/).

## Prepared code and controls

- Cloudflare-specific required input: team name, Access application audience, tunnel UUID and exactly two explicit emails. Real values remain in ignored local-config; no credential goes into the input. Examples contain nulls and are rejected until complete.
- Generator emits a review-only cloudflared.yml alongside compose/runner/access plans. Exact hostname and loopback target only; Access JWT validation is on the hostname ingress rule, then catch-all404. Windows credential path is separate from old personal keys. TCP HTTP/2 is selected; no UDP requirement. No command creates a tunnel, route or credential. [Origin validation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/).
- Operational ingress requires explicit TEAM_WEB_ACCESS_APPROVED=true, a Cloudflare provider and valid settings before listening. Otherwise it stops. Generic/device plans remain historical compatibility artifacts; the current operational entrypoint requires the selected Cloudflare guard.
- HTTP and WS both verify RS256 signature, fixed issuer/AUD, lifetime and exact email allowlist before connecting to a fixed internal peer. Public JWKS comes only from the configured team HTTPS endpoint, with3-second request/body timeout,64KiB/16-key bounds,5-minute cache and30-second refresh cooldown. Unknown keys, stale cache/load errors and malformed tokens fail closed. No token/claims/body are logged. [Official JWT guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
- CF identity headers/cookies are removed after validation. Existing TrainerSync Secure/HttpOnly/SameSite=Strict session selects tenant; no provider header chooses it. Provider-only authentication does not bypass service ownership. WebSocket Origin and service authorization remain enforced. Active or pending WS closes at Access expiry or15minutes, whichever comes first. Cloudflare policy revocation is not immediately introspected; application logout/revision is checked by the gateway, and operator shutdown remains available.

## Cookies, WebSocket and data transit

Access should cover the ENTIRE hostname/all paths, including static assets and noVNC upgrade. Allow only the operator and named colleague by exact email via OTP; no Everyone, domain-wide allow, Bypass or Service Auth policy. OTP relies on mailbox control and is not a claim of MFA. PINs are single-use and expire after10minutes. The service invitation is still required. [OTP documentation](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).

Configure the Access application session to1hour to match the local maximum. Use HttpOnly and SameSite=Lax for the Access cookie to support browser redirects; keep the separate service cookie Strict. The same HTTPS origin hosts noVNC assets and wss. First navigate/login over HTTPS; an expired WS cannot perform an interactive redirect and must be reopened after login. [Cookie controls](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/).

Cloudflare supports proxied WebSockets on all plans. That establishes transport feasibility, not a certification or completed live noVNC test. Edge restarts/idle limits may disconnect it. No auto-resume of a write follows reconnection. WAF evaluates the opening upgrade, not subsequent frames. Before real company login, test actual canvas/keyboard/WS, expiry, wrong-email denial and disconnect handling. [WebSocket documentation](https://developers.cloudflare.com/network/websockets/).

Cloudflare terminates browser TLS and carries the tunnel traffic. From that documented proxy architecture we infer it can process plaintext HTTP/WS content at the edge: service passwords, Notion key input, member previews and remote company screen/keystroke traffic may traverse it. This is not end-to-end confidentiality from Cloudflare. The Windows→company/Notion provider requests remain direct server traffic, but their screen/results shown through this UI traverse the proxy. Account/email/IP/request metadata is also involved. Free Access logs retain24hours; admin logs longer. Disable hostname caching, analytics injection and content transformations. Do not log token bodies/headers. DNS/certificate hostname can become public. [TLS connections](https://developers.cloudflare.com/ssl/concepts/) · [Log retention](https://developers.cloudflare.com/cloudflare-one/insights/logs/).

## Information needed in one reply

1. Colleague email and operator email to permit (no passwords/keys in chat).
2. Owned domain, desired neutral subdomain, DNS-change authority, and whether its DNS already uses Cloudflare. If none, report that fact; purchasing is a separate decision.
3. Whether the owner already has a usable Cloudflare account/Zero Trust organization and will approve the named-domain/Access setup. Never request account credentials in chat.

## Exact activation actions still awaiting approval

- Obtain a reviewed Windows cloudflared binary/version/hash; initially run only the new pilot connector in the foreground under the chosen operator identity. Persistent Windows service/registry installation is a separate later action; no colleague installation.
- Create only the dedicated named tunnel credential and privately protect its proposed C:/ProgramData/TrainerSync/team-pilot/cloudflared/<tunnelUUID>.json file. No existing Notion key is reused. Its actual ACL, recovery and connector read behavior remain unverified. Tunnel creation/login can create account-management credentials; handle those only under a separately reviewed official flow.
- Add/review the active DNS zone if necessary, ONE subdomain route, edge TLS and one self-hosted Access application/policy. Configure and verify Access before the published route. No real company or Notion login until unauthorized HTTP/WS tests pass.
- Permit only required outbound DNS through the existing resolver, TCP7844 for the chosen tunnel transport and HTTPS443 for setup/JWKS. No inbound firewall rule, router port forwarding or public DB/VNC/CDP port. Cloudflared metrics binds loopback with an ephemeral port. Actual firewall changes are pending and might be unnecessary if current egress permits them. [Required tunnel connectivity](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/).
- Separately approve the already documented pilot images/DB volume/networks/loopback ports/DPAPI stores/operator bootstrap. None were activated by this adapter work. Configure no-cache and WS support, verify pre-login denial then one approved colleague invitation and personal provider consent. No actual invite was sent.

Rollback stops only the recorded new connector/pilot resources and removes/revokes only their route/application/grant/credential after review; preserve existing DNS, personal containers, keys, profiles and databases. No global prune or down-v.

First pilot storage remains ONE existing exact-UID member's blank basic fields after fresh preview and editing-pause approval. New member creation, complete memo/survey/template personalization and schedule automation remain unfinished. Google Calendar is absent. Schedules and member writes remain OFF.
