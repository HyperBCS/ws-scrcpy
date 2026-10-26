# Repository review fixes — 26 October 2026

This document records the repository review fixes, the owner’s chosen access behavior, and the device-card and notification-action UI changes.

## Review findings

| Finding | Change | Verification |
| --- | --- | --- |
| Unauthenticated WebSockets | Application authentication was removed at the owner’s request. HTTP APIs, downloads and WebSockets open directly. Browser origin validation remains separate from identity. | Real HTTP/WS tests use no credentials, reject cross-origin browser requests, and verify the login endpoint is gone. |
| File operations overwrite destinations | Copy and move use Android no-clobber options, reject existing files, folders and dangling symlinks, and return a conflict instead of silently succeeding. | Shell regression cases plus real Android Toybox checks in an isolated temporary directory. Successful file copy, move, and empty-folder copy also verified. |
| Downloads outlive closed channels | A download owns its ADB pull from opening through completion. Closing cancels and destroys it, and late errors are contained. WebSocket backpressure pauses reads with a bounded timeout. | Pending-open cancellation, empty files, late errors, saturation, DONE, and listener cleanup tests. The real-device HTTP check also caught and removed a legacy `readable` listener that prevented streaming pipelines from flowing. |
| Malformed iOS messages crash the server | Validate parsed JSON and each supported message shape before accessing fields or queuing input. | Null, arrays, primitives, truncated JSON and malformed input messages cannot escape the handler. |
| Compressed request-body crash | Upgrade Express and lock body-parser 1.20.9; validate browser origins before parsing and disable compressed JSON bodies. | Malformed compressed requests are rejected; subsequent requests still succeed. |
| Concurrent iOS session startup | Reserve the session in the map synchronously, before selecting a port or starting subprocesses. | Concurrent cold opens share one port, startup and reference-counted session. |
| Slow video clients | Android disconnects saturated viewers for a fresh bootstrap. iOS drops dependent frames until a keyframe, then tells the decoder to reset. Multiplexed channels report their underlying socket's buffer size. | Saturation and keyframe recovery tests, alongside the existing bootstrap/decoder tests. |
| Stale queued notifications | Queue notification identities and rebuild eligibility, previews, and unread counts before every delivery/retry. Remove global generation invalidation. Receiver edits no longer discard other receivers' queues. | Read, dismissal, phone removal, source removal, receiver removal, current privacy policy, unrelated receivers and shutdown-during-retry tests. |
| Android initial discovery does not recover | Initial failures enter the existing retry loop; backoff is capped and shutdown prevents further retries. | Failed first initialization recovers; shutdown cancels retries. |
| Slow notification polls never finish | Routine polls join an outstanding request. Explicit refreshes cancel superseded requests. Shared fetch handling bounds requests to ten seconds and cancels on navigation. | Browser fixture with six-second responses updates successfully despite the five-second polling interval. |
| Controlled disclosure reversal | Compare the controlled value with the animation's desired state, not the temporary native `open` attribute. | Browser check reverses a closing pairing section and verifies it remains open. |
| Remote proxy regression | Restore a separate upstream WebSocket proxy for configured remote hosts, including multiplexed binary channels. No upstream credentials are required. | Real upstream text/binary round trips, and configured host/path restrictions. |
| Unawaited service startup | Await services in dependency order, register middleware before opening connections, and retain partially started instances for reverse-order cleanup. Close viewer sockets during shutdown and clean up late startup completion. | Failure and shutdown-during-startup tests; production container restart. |

## Simplification and UI

- Removed the unused `ProcessRunner`, MJPEG proxy dependency and terminal attach addon.
- Separated notification persistence and push delivery from the collector/API service. Browser/server DTOs now live in `src/common/Notification.ts`.
- Extracted download resource ownership from the file browser. At most two small download buffers or pending Blob URLs are retained. Files over 16 MiB, additional simultaneous files, and files that grow past the bound stream through HTTP to the browser's download manager. Configured remote hosts are supported too.
- Shared dialog focus cycling/restoration across sheets, and focus cycling with file dialogs. Kept platform-specific gesture and input handling where their behavior differs.
- Shared stream-container resize observation and teardown between Android and iOS clients.
- Android and iOS cards share a header, status treatment, “Open screen” action and “Connection & tools” disclosure. Both platforms share one device grid per host; a single host needs no tracker headings. Serial numbers and recovery details sit inside the disclosure. Platform-specific actions remain available.
- “Open screen” is a compact button beside notification search. Navigation actions use the same button surface, spacing, focus and press feedback.
- Production images use `npm ci`, cache dependency layers, prune development packages, and copy runtime assets rather than the whole repository. Node runs directly as the container process, with a 25-second shutdown grace period.
- Added one local/CI verification workflow and an isolated browser-fixture server. Browser checks cover both Chromium and WebKit without sending commands to real phones.

## Access and release

LAN HTTP remains available at `http://10.10.10.5:8000`, and the configured private Tailscale Serve URL still routes to the app. The owner requested complete removal of application authentication: there is no login screen, setup-key endpoint, browser session, trusted-subnet rule or remote-host credential.

Obsolete setup keys are removed from the persisted store and disk on startup. Notification sources, history, receiver subscriptions, and Web Push encryption/signing keys are preserved.

## Validation

- `npm run check`: TypeScript, ESLint, 223 JavaScript tests, 29 notification Python tests, 15 patch Python tests, and the production build.
- Chromium fixtures: review regressions and visual checks, notifications, motion, settings, sheets, device switcher, unlock, tools, files, iOS typing and audio availability.
- WebKit fixtures: review regressions and visual checks, notifications and motion.
- Existing 40 lint warnings and three webpack asset-size warnings remain; there are no lint/type/build errors.
- Real Android file-operation checks use a dedicated temporary directory and remove it afterwards.
- Live LAN checks cover automatic access in a fresh browser, Android discovery, notification API access and downloads without credentials. Direct access also works outside the former subnet allowlist; cross-origin browser requests are rejected.
- The deployment host does not resolve its private MagicDNS hostname through its normal resolver. The existing Tailscale Serve mapping was checked, and direct HTTP/WS access was tested. An external tailnet-client check was not available in this environment.

## Remaining upstream advisory

`npm audit` still reports two high-severity package entries for one unpatched `node-forge` advisory: the dependency itself and its `@dead50f7/adbkit` parent. The latest published forge version available during this release was 1.4.0, and npm reports no fix. The affected RSA signature verification is used by adbkit's TCP-USB bridge; this application does not call `createTcpUsbBridge` or start that bridge. Device communication goes through the host ADB daemon. This is a scoped dependency assessment, not a claim that the package is generally safe. Track [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) for an upstream patch.

Other audited advisories with available compatible updates were resolved. `concurrently` was updated for its patched shell-quote dependency; development now requires Node 22 or newer, matching the Docker and CI runtime.
