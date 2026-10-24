# Pilot preparation verification — 2026-10-24

No real colleague account/invitation, company/Notion grant, production key, member write, schedule, external access or existing-service deployment was performed.

## Verified

- Isolated PostgreSQL A/B integration:37/37 passed. Includes invitation recipient/single-use/race/expiry/revocation; encrypted member plans; cross-user access denial; editing-pause acknowledgement; consumed-once result; connection/logout/cancel/expiry revocation; uncertain acknowledgement held; API Origin and tenant injection rejection; sanitized trace. Providers are Mock. This is not live-company/Notion E2E.
- Docker integration run1d6154c4-e027-40fa-a38f-494f45cb1baf used only two new cached-image test containers and one internal test network, no published ports or persistent volume. Exact created IDs/labels were checked before removal. All removed; operating container identities unchanged. Metadata-only evidence stays ignored under .runtime/team-physical-test/.
- Pilot UI: one real Next+fresh Windows Chrome scenario with9 checks; API/provider responses intercepted with synthetic fixtures. Invitation password/code reset, login, selected member/DB/fields, write-disabled button, explicitly enabled one-time approval, terminal result and logout were observed. Actual running Chrome sandbox arguments were checked. No real API account creation/write occurred. The localhost4316 server and owned client were closed.
-31/31 selected unit/native HTTP+WS contracts passed; root/web TypeScript checks and production Next build passed. They include exact peer/Host/Origin routing and the worker-only tmpfs exception. These do not prove real production Tailscale routing or DPAPI behavior.

## Failures found and corrected

An initial audit fixture used the wrong sink shape and then a synthetic key shorter than the existing32-character minimum, so no event reached its sink. Corrected the fixture;37/37 then passed. A Host rejection test using fetch was normalized by the client and was replaced by an actual raw HTTP Host request; the rejection passed. UI static typing of an unknown result was corrected. Review also tightened issuer locks, invite scrypt admission, single-colleague issuance, target/field PATCH scope, final write/readback checks and local logout/poll races.

## Remaining activation checks

Real DPAPI create/unseal+ACL+restart/restore, tmpfs injection with production images/UID, initial operator safe-input listener, pinned browser seccomp, dedicated DB credentials/migration, company MFA/account binding, own Notion schema/template permission, counted live coverage, private HTTPS/WS route, real selected-member preview and its final approval remain pending. No mocked result authorizes or proves these steps. The current deployment contract deliberately cannot be launched as production.

First pilot writes only blank phone/email/birth-date/gender/UID on a uniquely matched existing member. New-member creation/template/survey/memo/full schedule flows remain incomplete and are not declared finished. Notion CAS remains unavailable; editing-pause consent is necessary. An uncertain consumed run blocks further pilot execution pending manual read-only review; no automatic retry/release endpoint exists.

Initial safe-input bootstrap and bounded startup are now prepared/tested as modules, with concurrent-operator creation guarded in PostgreSQL. They have not provisioned an actual operator or started an approved bootstrap listener.
