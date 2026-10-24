# Approved synthetic physical test result - 2026-10-24

The approved local test completed, including a rendered authenticated noVNC screen. This establishes synthetic component and corrected sandbox-client checks. It does not activate real colleague accounts or establish a production company/Notion E2E.

## Verified scope

| Area | Evidence |
| --- | --- |
| Docker browser sandbox | New test browsers used pwuser, privileged=false, no added capabilities, and the exact reviewed Playwright seccomp profile. No Docker browser used --no-sandbox. |
| Tenant physical separation | Actual TCP probes from both A and B could not reach the other browser's VNC6080/CDP9222 or the control DB5432/web3000. The trusted gateway4315 positive control succeeded. Each browser had one tenant-internal network and no published ports. |
| Account and destination boundaries | Synthetic A/B service logins, other-owner/anonymous browser rejection, invalid Origin rejection, own fake Notion destination acceptance and other destination rejection were exercised. No name-based member matching was added. |
| Corrected Windows sandbox client | chromiumSandbox:true is explicit. A runtime guard inspected only the Chrome process owned by the test process; checkedProcesses=1, sandboxDisabled=false. |
| Authenticated WS | Corrected clients received RFB data; other-user and anonymous requests produced actual403 responses. Timeouts were not counted as authorization denials. A10-second idle connection remained open. |
| Lifecycle | Corrected-client runs verified UI cancellation, controlled synthetic expiry, profile reuse after cancellation/expiry, and logout. Logout was checked as action completion401, WS closure, then runner-confirmed browser removal. |
| Full browser-to-VNC protocol | The sandboxed Windows client completed the gateway path through RFB ServerInit:1600x1000, security type1(None), no error. The direct internal server probe produced the same dimensions. |
| Visible noVNC screen | With the offline bundle, document.readyState=complete, canvas1600x1000 and no pending assets were observed. The synthetic TEST TrainerSync A screen was visually inspected. |
| Egress | The test proxy rejected CONNECT before DNS/dial. Only test-internal IPs were used for TCP probes. No Internet DNS/dial test was performed. |
| Selected automated checks |38 related unit/native HTTP/WS checks passed, plus root and web TypeScript checks. This is not the entire repository test suite or a real provider E2E. |

The TEST surface uses the real team authentication, connection and queue handlers, with injected synthetic company/Notion providers. It is separate from the Next production UI.

## Sandbox correction and discarded evidence

Playwright's default would add --no-sandbox when chromiumSandbox is unspecified. This was initially missed for the temporary Windows UI client. The identified owned test Chrome process was stopped; the user's Chrome and the Docker company browser were not stopped.

The source now explicitly enables the client sandbox and checks the actual running command line. Regression tests reject implicit/explicit sandbox-disable flags and unavailable argument evidence. Earlier unprotected Windows-client passes are historical only and are excluded from the final sandbox UI evidence above.

The Docker browser sandbox and raw Docker-network probes were separate component measurements; those browsers always used the approved sandbox profile. Historical mock preview completion is not presented as a corrected sandbox UI E2E.

## Changes made

- Pinned the existing reviewed seccomp file and hash for new test browser creation only. Arbitrary profile paths, privilege/capability overrides and duplicate security options fail closed.
- Made Chromium exit before its display processes are torn down, with a bounded6-second wait and a fixed forced-shutdown diagnostic. Successful profile reuse was exercised; exit0 alone is not treated as proof of clean profile release.
- Removed the temporary relay's3-minute DB lifetime mismatch, preserved stdout/socket buffers on normal closure, and kept fixed targets, exact resource ownership checks, connection limits and bounded lifetimes.
- Cleared HTTP request timers after authenticated WS upgrade while preserving gateway authorization rechecks and its maximum lifetime.
- Used only cached esbuild0.28.2 and cached noVNC sources to build a151245-byte first-party client bundle. Authentication, Host/Origin rules and CSP were not relaxed.
- Added bundle size/path checks and a bounded development fallback to the original fixed client source. Generated vendor artifacts are excluded from Git and Docker input context.

## File-loading diagnosis

The same unbundled core/rfb.js was read over Windows loopback->ingress->gateway and directly inside Docker. Both returned HTTP200 and105544 complete bytes, without timeout. This excluded loss of that individual file.

The multi-module browser path had about25 pending module requests. Bundling removed this fan-out: the final page had no pending assets. An initial10-second observation saw a zero-sized canvas; the bounded45-second observation subsequently verified the full1600x1000 rendered screen. The relay's concurrency delay was not independently characterized as a production network defect.

## Test transport and retained limitations

Docker Desktop recorded the requested127.0.0.1 port bindings but exposed empty actual mappings on the internal test network. Direct Docker port publication therefore did not pass.

The approved test used temporary Windows listeners only on127.0.0.1:4316 and127.0.0.1:15436, forwarding opaque traffic through non-TTY Docker CLI stdio to exact journal-owned test IDs. No Docker socket was mounted into web/worker, no external bridge/network/port was added, and no payload/cookie/token was logged.

This is a test transport workaround. Production same-origin ingress, external HTTPS access, remote Mac/Windows operation and deployment performance remain unverified.

## Cleanup and operating-service preservation

Each attempt stayed within the concurrent budget of8 runtime containers,3 internal networks and2 new synthetic profile volumes. Test instances could be replaced sequentially while diagnosing failures; each resource was recorded by ID/run/managed labels.

All recorded runtime resources from the attempts were removed using only explicit owned-ID stop/rm/network-rm/volume-rm operations. Final label-filtered container/network/volume inventory was empty. No listener remained on4316 or15436; final host metadata recorded zero active sockets and relays.

The final cleanup reported allResourcesRemoved=true and operatingBaselineUnchanged=true. Existing operating container IDs, image IDs, start timestamps and running states matched the baseline; web, company browser and DB remained healthy. This is metadata/health evidence, not a full comparison of operating database contents.

Cached test images were retained. No shared image prune, generic down-v, existing volume deletion or operating-service restart was performed. Metadata and synthetic screenshots remain under ignored .runtime/team-physical-test/. No screenshot, profile, personal setting, actual member identifier or private audit record was committed.

## Git result

Official GCM browser authentication registered alexjspark. The native Computer Use read was stopped because it could not confidently determine the GitHub window URL; no alternate UI-control path was used. GCM itself completed, and normal Git receive-pack authorization and push succeeded using alexjspark for the exact approved remote:

https://github.com/alexjspark/bpt_notion_sync.git

The source commits through6a6735610dfc3ef5140b133dbf8302caa594d2d2 were verified equal between local HEAD and origin/main. No force push, visibility change, new repository, global Git setting change or luahana repository permission grant was made. The final report commit is verified separately at task completion.

## Still outside this result

- No real company/Notion login, colleague connection, member write or operational key generation occurred.
- A protected persistent operational master loader is still unimplemented. Public test keys are not an operational secret-storage solution.
- Real company login-cookie persistence across browser replacement was not tested; the reused profile was synthetic.
- First-phase general memo/survey/template/calendar flow remains incomplete and was not completed by this test.
- General risky writes and scheduling were not enabled.
