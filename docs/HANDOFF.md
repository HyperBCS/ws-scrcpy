# ws-scrcpy fork — handoff

Context for an AI agent picking this repo up cold. Sections 1–6 describe the current architecture;
§7 preserves the original hardware observations, and §9 records the September 2026 review and
audio/mobile follow-up, including the scope and limits of current hardware validation.

---

## 1. What this is

A fork of [NetrisTV/ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy): a Node server that talks to
Android devices over adb (and iOS over pymobiledevice3), and a browser client that mirrors and controls
them.

**The primary use case is driving a remote device from a phone browser.** Not a desktop. When
weighing a trade-off — bundle size, touch target size, layout — the phone wins. Several bugs in
this codebase existed precisely because desktop-shaped code was left in place.

Branch: `new_scrcpy`. Upstream `master` is far behind; do not assume upstream docs apply.

### The most important structural fact

This fork runs the **stock scrcpy server**, not NetrisTV's patched one. The original project
depended on a forked scrcpy with a WebSocket server and extra control messages baked in. This fork
dropped that, so:

- There is **no "change stream parameters" control message**. Changing bitrate/codec/size means
  killing and relaunching the scrcpy server process (see §5).
- The server-side `src/common/Broadcast.ts` parses the raw scrcpy stream itself and fans it out to
  multiple browser viewers.
- `WebsocketProxy` **synthesises** the `scrcpy_initial` packet the client expects, because stock
  scrcpy never sends one.

Anything in upstream ws-scrcpy docs about live video-setting changes is false here.

---

## 2. Architecture

```
Android device                     Node server                        Browser
──────────────                     ───────────                        ───────
scrcpy-server.jar  ──unix socket──▶ Broadcast (parses stream)
  (v4.1, vendored)                    │  fans out frames
                                      ▼
                                  WebsocketProxy  ──WebSocket──▶  StreamReceiver
                                      ▲                                │
                                      └──── control messages ──────────┘

iOS device  ──usbmuxd──▶ pymobiledevice3 `serve-web` ──loopback HTTP──▶ CoreDeviceProxy
  (iOS 27,     (RSD tunnel, CoreDevice display + HID)      ──WebSocket──▶  CoreDeviceReceiver
   no signing)                                                             ──▶ WebCodecsHevcPlayer
```

### Server (`src/server/`)

| Path | Role |
| --- | --- |
| `goog-device/Device.ts` | Per-device state, adb shell helpers, `startServer()`, runtime-state poll |
| `goog-device/ScrcpyServer.ts` | Pushes + launches the jar, `list_encoders` |
| `goog-device/StreamConfig.ts` | Per-device `ScrcpyServerConfig`, JSON-persisted |
| `goog-device/LockState.ts` | Filtered keyguard/trust diagnostics; current-user lock state with explicit unknown values |
| `goog-device/services/ControlCenter.ts` | Device tracking (adb), command dispatch |
| `goog-device/mw/WebsocketProxyOverAdb.ts` | **Ensures the scrcpy server is running on connect** |
| `goog-device/mw/FileListing.ts` | Files channel: adb sync listing/transfer plus validated mkdir/move/copy/delete |
| `mw/WebsocketProxy.ts` | Platform-agnostic stream proxy; synthesises `scrcpy_initial` |
| `appl-device/services/PyMobileDevice.ts` | Locates and spawns the `pymobiledevice3` CLI (venv → PATH); one-shot JSON calls |
| `appl-device/services/CoreDeviceRunner.ts` | One `serve-web` process per iPhone: DDI mount, readiness poll, viewer holds, 15 s grace |
| `appl-device/services/ControlCenter.ts` (appl) | `usbmux list` polling, `lockdown info`, Developer Mode status/enable |
| `appl-device/mw/CoreDeviceProxy.ts` | `?action=proxy-coredevice`: HEVC frames → binary ws, JSON commands → loopback POSTs |

### Shared (`src/common/`)

- `Broadcast.ts` — **the critical file.** Parses separate scrcpy video/audio streams, caches video
  config plus a bounded sequence from the latest keyframe and audio metadata/config, reads device
  messages off the control socket,
  and fans everything out. Audio capture/parser failures leave video and control running.
- `BroadcastManager.ts` — opens the unix sockets in scrcpy's expected order.
- `Constants.ts` — `SERVER_VERSION`, `ScrcpyServerConfig`, `buildScrcpyArgs()`.
- `AudioProtocol.ts` — shared browser audio envelope, codec/source types, and fixed capture profile.

### Client (`src/app/`)

Preact + `@preact/signals`. **View layer only** — the protocol/transport classes are original and
should generally be left alone.

| Path | Role |
| --- | --- |
| `state/` | `router.ts` (hash router), `devices.ts` (merged device store), `stream.ts`, `deviceStatus.ts`, `settingsSheet.ts`, `audio.ts` (active playback session/status) |
| `views/` | `App`, `DeviceList`, `DeviceCard`, `StreamView`, `ToolView`, `FloatingToolbar`, `SettingsSheet`, `ActionsSheet`, `DeviceSwitcherSheet`, `SleepOverlay`, `LiveTextOverlay` |
| `googDevice/client/StreamClientScrcpy.ts` | Owns the stream lifecycle; builds some DOM imperatively |
| `googDevice/UhidKeyboard.ts` | Virtual HID keyboard |
| `googDevice/client/FileListingClient.ts` | The file explorer: navigation, views, selection, transfers, folder operations |
| `googDevice/client/fileTypes.ts` | File kind/icon/size/permission formatting for the explorer |
| `player/AudioPlayer.ts` | PCM Web Audio playback, optional Opus WebCodecs decode, buffering and browser unlock |
| `ui/BottomSheet.tsx`, `ui/viewport.ts` | Shared dialog focus/viewport behavior and remote-control PWA gesture handling |
| `controlMessage/` | Wire formats — **be extremely careful here, see §4** |
| `interactionHandler/` | Touch/mouse → control messages. Multi-touch already works; don't rewrite |

Do **not** reintroduce a framework-free DOM layer; and do not rewrite `InteractionHandler`,
`Multiplexer`, `StreamReceiver`, or the players without a specific reason.

---

## 3. scrcpy 4.1 protocol — hard-won details

The vendored jar is **scrcpy v4.1** (`vendor/Genymobile/scrcpy/scrcpy-server.jar`,
`SERVER_VERSION = '4.1'`). Upgrading from 3.1 required two breaking changes. If you ever bump the
version again, **re-verify both**.

### Video stream header: 16 bytes (was 12)

```
3.1:  codecId(4)  width(4)   height(4)
4.x:  codecId(4)  meta(4)    width(4)   height(4)
```

scrcpy 4.0 added a session-metadata field (Genymobile/scrcpy#6159). See `CODEC_HEADER_SIZE` in
`Broadcast.ts`.

### Joining an idle video stream

`WebsocketProxy` primes each viewer with codec config, the latest keyframe, and **every following
dependent frame** through the current picture. Sending only the keyframe produces an old picture
and leaves subsequent live frames referencing pictures the new decoder never received.
`Broadcast` caps this cache at 16 MiB/1,024 frames. If an encoder exceeds that cap without a new
keyframe, it retains a decodable prefix for an idle preview; that joining viewer skips live
deltas until a fresh keyframe restores continuity. Existing viewers continue uninterrupted.
New codec config invalidates the prior cache. Audio/config/control traffic remains independent.

The installed `h264-converter` also buffers the last Annex-B NAL until another start code arrives.
An idle stream may never supply that next packet, so a complete scrcpy packet needs an explicit
boundary in the MSE adapter. This is a decoder framing issue, not evidence the device is asleep.

### Packet flag bits shifted down one

```
3.1:  CONFIG = bit 63,  KEY_FRAME = bit 62
4.x:  CONFIG = bit 62,  KEY_FRAME = bit 61
```

**This one is nasty.** With only the header fixed, framing parses perfectly and everything looks
healthy — but the config packet (SPS/PPS) is never recognised, `lastConfigframe` stays null, newly
attached clients are never primed, and **every decoder shows a black screen with no error**. Source
of truth: `app/src/demuxer.c` in the scrcpy repo.

### Control messages (client → device)

Type numbering is **unchanged** from 3.x (new types appended at 18+). Verified formats:

| Type | Name | Wire format | Status |
| --- | --- | --- | --- |
| 0 | INJECT_KEYCODE | type, action, keycode(4), repeat(4), meta(4) | works |
| 1 | INJECT_TEXT | type, len(u32), utf8 | works |
| 2 | INJECT_TOUCH | type, action, pointerId(8), x(4), y(4), w(2), h(2), pressure(2), actionButton(4), buttons(4) = 32B | works |
| 5/6/7 | EXPAND/COLLAPSE PANELS | type only (1 byte) | works |
| 8 | GET_CLIPBOARD | type, **copyKey(1)** | works |
| 9 | SET_CLIPBOARD | type, **sequence(u64)**, paste(1), len(u32), text | works |
| 10 | SET_DISPLAY_POWER | type, on(1) | no effect on MIUI |
| 11 | ROTATE_DEVICE | type only | no effect on MIUI |
| 12 | UHID_CREATE | type, id(2), vendorId(2), productId(2), nameLen(1), name, descLen(2), desc | works |
| 13 | UHID_INPUT | type, id(2), size(2), data | works |
| 14 | UHID_DESTROY | type, id(2) | works; scoped to the closing viewer |

**Two fields were historically missing** and silently broke clipboard entirely: the `copyKey` byte
on GET, and the 8-byte `sequence` on SET. A short message doesn't error — the server just waits or
misreads, so it looks like "the device doesn't support it".

**`pressure` is 16-bit fixed point**, where `0xFFFF` = 1.0. A literal `1` means pressure ≈
0.000015, which Android treats as *no contact* — touches send fine and do nothing.

### Device messages (device → client)

`Broadcast` reads these off the **control** socket and re-emits them wrapped in the magic bytes
`scrcpy_message`. Formats: clipboard `type + len(u32) + utf8`, ack-clipboard `type + u64`,
uhid-output `type + id(u16) + size(u16) + data`.

`scrcpy_initial`, `scrcpy_message`, current `scrcpy_audio_2`, and legacy `scrcpy_audio_1` are all
**14 bytes** — the client's discriminator depends on that. Keep any new magic the same length.

### Audio stream and browser envelope

Audio has a **4-byte codec header**, not video's 16-byte header. The codec IDs are `0x00726177`
for raw PCM and `0x6f707573` for Opus; `0` means capture disabled and `1` means configuration
failure. Each device audio packet then has `pts/flags(u64 BE) + payloadLength(u32 BE) + payload`.
CONFIG is bit 62, KEY_FRAME is bit 61, and the timestamp uses the lower 61 bits in microseconds.
The bit-63 video session marker is invalid for audio.

The stock capture profile is **48,000 Hz, stereo**. Raw PCM is interleaved signed 16-bit
little-endian, about **1.536 Mbps** before framing. Stock scrcpy already strips Android's
`AOPUSHDR` wrapper: its Opus config packet contains bare `OpusHead` bytes.

`Broadcast` wraps audio for browsers as:

```
scrcpy_audio_2(14 bytes) + kind(u8) + timestampUs(u64 BE) + payload
kind 0: sample; kind 1: codec config; kind 2: UTF-8 JSON AudioMetadata
AudioMetadata: status(pending|ready|disabled|error), codec(raw|opus), sampleRate, channels, message?
```

`codec` is optional until capture is ready. Every joining viewer receives current audio metadata
and the cached Opus config, when present; old audio samples are never replayed. `StreamReceiver`
retains legacy `scrcpy_audio_1` support, clears audio state on disconnect, and keeps malformed
audio out of the video decoder.

Verify future protocol changes against official v4.1 sources:
[demuxer.c](https://github.com/Genymobile/scrcpy/blob/v4.1/app/src/demuxer.c),
[Streamer.java](https://github.com/Genymobile/scrcpy/blob/v4.1/server/src/main/java/com/genymobile/scrcpy/device/Streamer.java),
and [AudioConfig.java](https://github.com/Genymobile/scrcpy/blob/v4.1/server/src/main/java/com/genymobile/scrcpy/audio/AudioConfig.java).

### Socket ordering

scrcpy opens **video → audio (only if enabled) → control**. `BroadcastManager` opens 2 or 3
connections accordingly. Get this wrong and the socket you think is control is actually audio:
input silently goes nowhere.

---

## 4. Landmines

Ordered by how much time they cost.

1. **The scrcpy server exits when its last viewer disconnects.** It used to never restart —
   closing the last tab left a device unstreamable until ws-scrcpy itself was restarted.
   `WebsocketProxyOverAdb.connect()` now calls `startServer()` first. If you see "nothing works",
   **check `adb shell pidof app_process` before debugging anything else.** A dead server is
   indistinguishable from a dead feature, and it invalidated an entire round of my conclusions.
2. **MIUI wipes `/data/local/tmp`.** The jar disappears mid-session; `CLASSPATH` then points at
   nothing and you get `ClassNotFoundException`, which looks like a renamed class. ws-scrcpy
   re-pushes on start so it self-heals in normal use, but manual testing needs a re-push.
3. **nodemon does not reliably restart on server-bundle changes.** `dist/index.js` updates on disk
   while the running process keeps stale code. If a server change seems not to apply, restart
   `npm run dev`.
4. **`Util.parseBoolean(params, name, required)`** — the third argument is `required`, **not** a
   default. Passing `true` makes the parameter mandatory and throws on every URL lacking it.
5. **`pkill -f <pattern>`** in a shell whose own command line contains the pattern kills the shell.
6. Don't conclude "the device doesn't support X" from one failed test. Of the commands I first
   declared inert, most were a dead server or a malformed message.

---

## 5. Notable behaviours

- **Stream quality changes restart the scrcpy server.** `UPDATE_STREAM_CONFIG` kills the pid,
  stops the broadcast, relaunches with new args. Every viewer of that device reconnects
  (`StreamReceiver` has backoff). Starts, stops, and restarts share one per-device queue, so
  reconnects and simultaneous Applies cannot launch competing servers.
- **`video_encoder` defaults to unset** so scrcpy picks hardware. It used to be hardcoded to
  `OMX.google.h264.encoder` — a *software* encoder — on every device.
- **Keyboard capture is on by default**, using UHID: the device sees a real keyboard, applies its
  own layout, and stops raising its on-screen keyboard. Settings offers keycode injection for
  older devices (Android &lt; 11 can't open `/dev/uhid`). Capture leaves the app's own controls and
  dialogs alone. Each active proxy owns a distinct ID in 1–65535; its release destroys only its
  own keyboard. Reconnecting recreates the keyboard after `scrcpy_initial` supplies the new ID.
- **Connected means the scrcpy handshake completed**, not merely that the WebSocket opened.
  Initial setup waits for `scrcpy_initial`; user input during an outage is not replayed later.
- **Sleep detection** polls `dumpsys` every 10s while a device list is open, 60s idle. On Android
  16 `Display Power: state=` does not exist — `mScreenState=` from `dumpsys display` is primary.
  `mWakefulness` is authoritative for awake/asleep and only reports "not awake" on positive
  evidence, so a parse miss degrades to "awake" rather than a stuck badge.
- **The client is code-split.** `tsconfig` sets `module: commonjs` for the server, which would
  downlevel `import()` to `require()` and defeat splitting, so the frontend webpack config
  overrides ts-loader with `module: esnext`. Initial JS is ~65 KiB gzipped after the UX review;
  the terminal and file-explorer chunks are fetched only on their own routes.
- **Sheets are mutually exclusive** via `openSheet()`. They used to stack, and an open sheet's
  panel covered the toolbar so every button under it was dead. Opening a sheet now collapses the
  FAB panel. Shared sheets contain keyboard focus, close on Escape, restore focus, and follow the
  visual viewport when a phone keyboard appears.
- **Android controls follow the input device.** `FloatingToolbar.tsx` uses a draggable FAB for
  `(hover: none) and (pointer: coarse)` browsers, including tablets. Mouse/trackpad browsers get a
  persistent sidebar, including narrow desktop windows. Both layouts adopt the same protocol
  toolbox and show labeled controls. Mobile FAB position persists in `localStorage`, clamps to
  safe areas and the visual viewport, and opens a scrollable grid when space is limited. A media
  query change updates layout and stream sizing. The stream header keeps device identity,
  connection status, return navigation, and switching accessible. iOS streaming shares the
  same chrome through `ToolbarClient.getControlButtonsElement()`.
- **The remote-control PWA keeps its shell fixed.** The device list and sheet bodies scroll
  internally; opening a sheet preserves the list position and locks its background scroller.
  Browser pinch zoom is suppressed so multi-touch belongs to the remote screen. Safari gesture
  cancellation does not stop propagation to the remote input handler. Safe-area padding, dynamic
  viewport sizing, and 16px form inputs protect phone layouts and text entry.
- **Settings loads the device's current configuration** from `LIST_ENCODERS`, with quality
  presets and advanced options. Apply sends only changed fields; request IDs prevent stale replies
  from updating another request. Source/format changes also require a stream restart.
- **Audio is enabled in the build and defaults** (`USE_AUDIO: true`, `audio: true`,
  `audioCodec: 'raw'`, `audioSource: 'output'`). An explicitly saved `audio: false` stays off.
  Each browser starts muted; Sound/Listen must run in a user gesture to unlock playback. PCM uses
  Web Audio directly, including browsers on insecure LAN HTTP. Optional Opus needs `AudioDecoder`
  support in a secure context. Mute, backgrounding, disconnect, and decoder resets discard queued
  sound; playback buffering is bounded near live instead of accumulating old conversation.
- **Device media and incoming call audio are separate sources.** `output` captures device media
  such as videos/games; `voice-call-downlink` requests only the far side of a phone call. There is
  no browser microphone forwarding and no uplink capture. Android 11 needs the screen unlocked
  at capture startup; audio requires Android 11 or later. Call capture can be rejected or silent
  under device/Android restrictions. `output` uses REMOTE_SUBMIX and excludes notification,
  alarm, and ringtone streams; it also redirects captured playback away from the device speaker.
  Source support comes from [scrcpy audio documentation](https://github.com/Genymobile/scrcpy/blob/v4.1/doc/audio.md)
  and [Android AudioSource](https://developer.android.com/reference/android/media/MediaRecorder.AudioSource#VOICE_DOWNLINK).
- **Audio failure recovery does not overwrite desired settings.** Audio socket/parser failures
  publish disabled/error status while video/control continue. If stock scrcpy exits fatally after
  an audio startup error, the next normal reconnect launches video-only using a runtime override.
  Saved audio/source/format remain unchanged; an explicit Apply or Retry clears the override.
  Generation checks prevent shutdown errors from an old launch disabling its replacement.

---

## 6. Testing

`npm test` runs deterministic regressions without hardware: 38 server tests in
`scripts/test-server-regressions.js`, seven stream/UHID tests in `scripts/test-stream-lifecycle.js`,
tracker lifecycle checks in `scripts/test-client-lifecycle.js`, nine backend audio tests in
`scripts/test-audio-protocol.js`, and browser-audio checks in `scripts/test-audio-player.js`.
`scripts/test-video-bootstrap.js` covers complete late-join replay, config invalidation, and both
byte/frame-count cache overflow paths without device input.
Audio coverage includes fragmented headers, timestamp flags, late-join codec config, capture
failure isolation and fallback, PCM conversion, unlock/mute/background/reconnect, bounded
buffering, and stale decoder output cleanup. The player tests mock browser APIs; they do not
prove audible playback on hardware.
`scripts/test-passcode.js` covers input framing, fresh lock checks, source binding, cancellation,
timeouts, and refusal to send credentials to an unknown, unlocked, or occluded screen.

`npm run test:ux` runs `scripts/e2e-ux.js` in Playwright against a running server and an attached
device. It covers the device list, sheets, keyboard focus, stream startup, touch-target sizes,
viewport changes, and return navigation. **Keep browser and device-state checks** — they catch
bugs that typecheck and lint cleanly. The older focused hardware scripts below remain useful,
but some assume the previous DOM; reopen the mobile FAB after closing a sheet and check selectors.

`npm run test:pwa` checks the fixed mobile shell, internal scrolling, sheet scroll/focus behavior,
zoom suppression, and outgoing remote multi-touch using intercepted stream sockets. It reads
device list/settings from a running server; it does not send its simulated remote gestures to
hardware. `npm run test:audio` is the hardware media fixture/output-meter check. Serve
`scripts/fixtures/audio.html` over HTTP to the Android device and set `TONE_URL` to its URL;
`SERIAL` is required and `AUDIO_CODEC` defaults to `raw` (use `opus` with a suitable browser
origin). The test opens the fixture, plays its 440 Hz tone, and verifies actual browser output,
mute/unmute, late viewers, and reloads. `DESKTOP=1` checks that Sound is visible in a 1280×600
mouse sidebar. The output check also measures sine-wave continuity over 30 analyser windows
and asserts incoming buffers have no scheduling gaps or overlaps. Its result and the limits of
that evidence belong in §9.
Neither synthetic playback tests nor an accepted call source prove incoming-call audibility.

`npm run test:sheets` uses mocked sockets and native touch gestures to cover mobile header
drag/dismiss/snapback, the larger Close action, background scrolling/focus restoration, and
the Apply dismissal lock. It also protects the imperative video canvas while notices appear
and disappear, and verifies that popup gestures cannot become remote device touches.
`npm run test:audio-availability` checks usable Sound recovery controls when Web Audio or the
audio module is unavailable and when the device's Android version is not yet known.
`npm run test:switcher` exercises native scrolling, searching, and selecting devices below the
fold with 28 mocked devices. `npm run test:unlock` uses only fixture credentials and intercepted
sockets to verify masked local typing, one explicit submission, confirmed unlock/relock,
cancellation, disconnected/unknown states, and no automatic retry or credential persistence.

```bash
npm test                         # deterministic lifecycle and audio regressions
npm run dev                      # webpack --watch + nodemon, serves :8000
BASE=http://127.0.0.1:8000 SERIAL=<udid> E2E_OUT=/tmp/ws-scrcpy-ux npm run test:ux
BASE=http://127.0.0.1:8000 SERIAL=<udid> npm run test:pwa
BASE=http://127.0.0.1:8000 npm run test:files           # explorer UI against socket fixtures
BASE=http://127.0.0.1:8000 SERIAL=<udid> npm run test:files-device  # real listings + scratch folder
BASE=http://127.0.0.1:8000 SERIAL=<udid> TONE_URL=http://<host>:8099/audio.html npm run test:audio
./scripts/serve-testpage.sh &    # test page on :8099 (tap target + text field)
SERIAL=<udid> node scripts/e2e-touch.js          # targets ≥44px, hit-test, touch msgs
SERIAL=<udid> node scripts/e2e-touch-device.js   # tap in browser → device tap counter
BASE=http://127.0.0.1:8000 SERIAL=<udid> node scripts/e2e-reconnect-keyboard.js # typing after restart / viewer close
SERIAL=<udid> node scripts/e2e-toolbar.js        # every toolbar button opens its sheet
SERIAL=<udid> node scripts/e2e-actions.js        # Actions buttons change device state
SERIAL=<udid> node scripts/e2e-keyboard.js       # UHID typing lands in a device field
SERIAL=<udid> node scripts/e2e-typetext.js       # Type-text overlay
BASE=http://127.0.0.1:8000 npm run test:ios-typing  # iOS Type text overlay against fixture sockets
SERIAL=<udid> node scripts/e2e-deeplink.js       # reload a stream URL directly
node scripts/e2e-decode-touch.js                 # decode outgoing touch bytes
```

Testing principles that mattered here:

- **Assert on device state, not on messages sent.** "A control message left the page" is not
  "the device did something".
- **Use a deterministic target.** Tapping a system app and checking whether the foreground
  activity changed produces false failures that look exactly like product bugs. The test page has
  a big button and a counter for this reason.
- **Check `document.elementFromPoint`** to find what is actually on top of the video. That is how
  the overlay-swallowing-touches bug was found.
- **Wake and unlock first** (`keyevent 224`, then `82`): a woken-but-locked device shows systemui
  and nothing works.
- **Scope to a `SERIAL`.** With several devices attached, `.first()` may open a sleeping one.
- `scripts/e2e-*.js` hook `WebSocket.prototype.send` globally, so the tracker's multiplexer frames
  appear too. A 9-byte frame starting with `4` is `MessageType.CreateChannel`, **not**
  `BACK_OR_SCREEN_ON`.

Also run: `npx tsc --noEmit -p tsconfig.json`, `npm run lint` (0 errors; ~46 pre-existing
`no-explicit-any` warnings are the baseline), `npm run dist:prod`.

---

## 7. Original hardware observations (historical)

**Original hardware verification** on a Xiaomi POCO (Android 16) with scrcpy 4.1: video on both players, touch
incl. coordinate accuracy, UHID keyboard, text injection, clipboard read/write round-trip,
notification/quick-settings panels, sleep/wake detection and battery, encoder enumeration,
stream-config restart, device switching, deep-link reload, the FAB (drag, persist, expand).
Current architecture is in §§2–6; current-review validation is listed separately in §9. The
historical audio-disabled state below describes the original refactor, not today's defaults.

**Not verified during the original refactor:**

- **The entire iOS path.** The original go-ios/WDA/MJPEG stack never touched a physical iPhone
  and was replaced in September 2026 by the CoreDevice path (see §9, *iOS route 2*), which is
  in the same position: built against a simulated `pymobiledevice3`, not a phone.
- **Audio was inert** (`USE_AUDIO: false`, `audio: false`). Its original Opus 48kHz/stereo profile
  had not been verified. The September follow-up verified the stock protocol/profile, added PCM,
  enabled audio defaults, and isolated capture failures; see §§3, 5, and 9 for the current state.
- Multi-device behaviour beyond basic listing; a Pixel 8 was attached but barely exercised.
- Real-phone layout (safe areas, IME, rotation) — tested at phone viewport in Chromium only.

**Known limitations still applicable:**

- **Drag-and-drop APK push over the stream is explicitly blocked.** A drop displays a notice
  directing the user to **Files** on the device list, whose uploads use adb
  (`AdbkitFilePushStream`). Do not reattach `ScrcpyFilePushStream`: its control type `102` is a
  NetrisTV extension that stock scrcpy misparses, potentially killing all input.
- `ROTATE_DEVICE` and `SET_DISPLAY_POWER` do nothing on MIUI; omitted from the UI rather than
  shipped as dead buttons.
- **No authentication of any kind.** Anyone who can reach the port gets full shell and screen
  control of every attached device. Deliberate — the owner keeps it behind a VPN/reverse proxy.
  Do not assume otherwise if you expose anything new.

---

## 8. Conventions

4-space indent, single quotes, semicolons, trailing commas; `npm run format` is prettier + eslint
`--fix`. Comments explain **why**, not what — this codebase documents non-obvious decisions and
protocol quirks inline, and that is deliberate: most of §3 and §4 exists as comments at the call
sites too. When you discover something the hard way, leave it in the code.

---

## 9. September 2026 review

### Bugs fixed

- **Android startup/restart races:** serialize process operations; wait for jar transfer completion;
  retain each launch's audio/socket configuration; scope old adb close callbacks to their own
  broadcast. Closed proxies cannot attach late listeners, and stopped broadcasts report unready.
- **Server validation and cleanup:** reject invalid command/config values before persistence or
  restart; return current settings with encoder enumeration; correct tracker announcement flags
  and symlink recursion depth. iOS initialization and WDA launches honor cancellation, allocate
  ports before spawning, drain child output, and invalidate failed forwards. Nodemon `SIGUSR2`
  cleanup is handled. iOS lifecycle cancellation has deterministic coverage; physical-iPhone
  validation is still absent.
- **Client lifecycle:** stop closes connecting sockets and cancels reconnects; late messages cannot
  revive disposed streams/trackers or stale device cards. The scrcpy handshake gates connection
  state and UHID registration. Keyboard capture respects local UI; toolbox pointer and keyboard
  activation send paired key events.
- **Simultaneous viewers:** each proxy assigns a unique 16-bit keyboard ID. Closing a viewer
  releases its own keyboard, including when the browser disappears without sending cleanup.
  Reconnecting viewers wait for their new ID before registering again.
- **View state:** same-device stream changes no longer duplicate toolbar controls; stream changes
  clear stale sheets/clipboard/sleep state. Disconnect returns to the list. Invalid player links
  show recovery UI. Clipboard reads/copies report timeouts and permission failures; live typing
  handles paste, deletion, Enter, and IME commit deduplication.

### UX changes

- Direct device list and searchable switcher, clearer empty/reconnect states, prominent stream
  actions, and expandable connection/tools details. The home-screen search and availability
  filters were removed in the later Settings/iOS follow-up at the user's request.
- Compact stream header; labeled controls with at least 44px targets; mobile draggable FAB with
  keyboard access and viewport-aware positioning, desktop sidebar; connecting/reconnecting
  recovery and dismissible notices.
- Mobile sheets and text entry respect safe areas and the visual viewport; 16px text inputs avoid
  Safari focus zoom. Desktop dialogs, focus restoration, Escape dismissal, reduced-motion support,
  multiline clipboard editing, and quality presets make the same flows usable on larger screens.
- Terminal and file-explorer implementations load only when their routes are opened.
  Settings offers H.264, the codec both current players decode; saved unsupported codecs have
  recovery guidance.

### Original September review validation (before audio follow-up)

- All 20 automated regressions, TypeScript, lint (0 errors; 46 existing warnings), and the
  production build passed during review.
- Full Playwright integration checks passed across phone portrait, landscape, small-phone, and
  desktop layouts. A separate mocked-stream browser pass covered FAB dragging/keyboard access,
  text and IME events, same-device remounts, invalid-player and slow-connection recovery, and both
  light/dark presentation, with no page errors.
- **Xiaomi Android 16:** browser tap incremented the device test-page counter; keyboard text
  arrived before and after a quality restart and after closing a second viewer; settings readback
  matched the applied preset and the original quality was restored. Physical phone-browser safe
  areas/IME/rotation, iOS hardware, and audio were not verified in this pass.

### Audio and mobile follow-up

- Corrected the audio parser's codec header, packet flag/timestamp handling, and Opus config
  forwarding; introduced the shared `scrcpy_audio_2` metadata/sample envelope and late-join cache.
- Added compatible PCM playback, optional Opus, explicit browser unlock and status, live bounded
  buffering, and mute/background/disconnect cleanup. Settings exposes media/downlink sources,
  format choice, and retry after capture errors or refusal. No microphone or uplink forwarding.
- Capture failures now preserve video/control, including a video-only reconnect after fatal
  device audio startup errors. Saved desired settings remain available for an explicit retry.
- Restored persistent desktop controls while retaining the mobile FAB; the layout follows input
  capabilities rather than viewport width. Fixed the PWA shell with independent list/sheet
  scrolling and preserved remote multi-touch.
- Corrected the large blue focus outline after touching the stream: pointer-origin canvas focus
  does not show the outline, while keyboard navigation retains a visible focus indicator.
- Corrected idle late-join video replay to include all dependent pictures since the cached
  keyframe, with bounded memory and a decodable overflow preview. MSE now flushes complete
  access units immediately with an AUD boundary, resets stale queues on restart, and uses
  inline video playback on mobile.
- All **39 automated regressions**, TypeScript, full lint (0 errors; 46 existing warnings), and
  production compilation passed. Integrated UX and PWA scripts passed against the final build.
- **Idle video:** `npm run test:idle` sends a valid config and exactly one IDR, then stays silent.
  The old MSE build failed this check; the final production build rendered the picture in 38 ms
  (MSE) / 19 ms (WebCodecs). Fresh real Xiaomi viewers displayed pixels in 22 ms / 48 ms after
  connection, with keyboard capture disabled and no touches or keystrokes used to provoke frames.
- **Desktop controls:** browser mocks passed five viewport sizes and dynamic pointer changes,
  video/touch centering, and focus restoration, with no page errors.
- **PWA:** the isolated production browser pass verified native pinch remains at scale 1,
  document pan/pull gestures do not move the shell, internal list/sheet scrolling works, and
  sheet dismissal restores exact list position and focus. Both remote touch IDs emitted complete
  down/move/up sequences through mocked sockets; no simulated gestures reached hardware.
- **Hardware media audio, Xiaomi Android 16:** PCM over insecure LAN HTTP without `AudioDecoder`
  and actual Opus capture/decoding on localhost both delivered the device fixture's 440 Hz tone
  to the browser output graph. The analyser measured RMS around 0.0015 at the device's low media
  volume. Mute/unmute, late viewers, and reload passed; tests asserted the actual wire codec.
- **Incoming-call source initialization, same device:** `voice-call-downlink` with raw PCM
  reported ready at 48 kHz/stereo and produced 132 sample packets over three seconds while video
  stayed Connected. No call was placed or received: **actual remote-party voice remains
  unverified**. The test restored device media/raw afterwards. Physical phone-browser
  Safari/Chrome behavior and physical iOS streaming also remain unverified.

### Settings layout and iOS Silent mode follow-up

- Removed the home-screen search field and All/Available filters; every device remains visible,
  with available devices sorted first. The device switcher retains its own search.
- Settings uses constrained grid columns and explicit vertical-only sheet scrolling. Phone
  dropdowns stack below their labels, quality presets become readable rows, and text, gutters,
  section gaps, and touch targets have more room. Long encoder names and error messages wrap
  without widening the sheet. The sticky action area covers its bottom gutter; short landscape
  screens scroll it normally so feedback and buttons stay reachable.
- `PlaybackAudioSession.ts` requests `navigator.audioSession.type = 'playback'` directly in the
  Listen gesture, before starting Web Audio. WebKit recommends this to play through the iPhone
  Silent switch on iOS 17 and later: [WebKit guidance](https://bugs.webkit.org/show_bug.cgi?id=237322#c6).
  Optional/throwing APIs cannot break ordinary playback. Shared ownership preserves overlapping
  players, restores the previous category on final mute/stop, and respects later category changes.
  Failed startup releases the claim; stale resume rejections cannot cancel a newer Listen action.
- **Validation:** all 39 automated tests passed, including playback-category ownership, fallback,
  property failures and resume races. TypeScript, full lint (0 errors; 46 existing warnings),
  production build, UX and PWA regressions passed. `npm run test:settings` passed 16 layout
  checks at 320/390px, landscape and desktop, including expanded sections, horizontal gestures,
  long labels and audio/Apply errors; the sheet had no horizontal content overflow or scroll.
  Real Android PCM playback, mute/unmute, late viewers and
  reload passed on the updated client without the iOS API. Physical iPhone Silent-switch output
  remains unverified; older browsers without the API may still require Silent mode to be off.
- **Development environment:** seven stale `npm run dev` trees were writing competing bundles,
  some with a cached `USE_AUDIO=false`. They were replaced with one fresh watcher. Keep one
  development watcher per checkout and restart it when build flags change; a production build
  can otherwise be overwritten by an older watcher's next emission.

### Desktop Sound, popup gestures, and audio static follow-up

- The exact Pixel 8 link on insecure LAN HTTP had working PCM support in a fresh Chrome page,
  but Sound was at y=621–677 in a 600px-tall desktop window. Sound is now the fourth sidebar
  action and remains visible even if browser audio fails to load; Settings explains the actual
  reason and offers Reload. Browser support and Android version are checked separately. Capture
  can still be switched off if browser playback is unavailable, and blocked autoplay offers a
  direct Listen retry instead of requiring a device stream restart.
- **Static diagnosis:** 350 raw Pixel packets showed presentation-timestamp jitter from
  −2.241 to +2.243 ms relative to the preceding packet's sample count; 201 of 349 boundaries
  differed by more than 100 µs. The old player scheduled each chunk by that timestamp, creating
  tiny gaps or overlaps in an otherwise continuous sample stream. PCM and decoded Opus now
  schedule from the preceding buffer's exact end. Timestamps detect substantial discontinuities;
  underruns and excessive bursts still recover near live within the 200 ms queue bound.
- A deterministic continuous-tone regression with the measured jitter fails the old scheduling
  and renders without sample discontinuities with the correction. The live desktop PCM test on
  Xiaomi Android 16 passed over insecure LAN HTTP: 59 chunks had no scheduling gaps/overlaps,
  and the maximum normalized sine-recurrence residual across 30 output windows was 0.0074
  (test limit 0.02). Mute/unmute, late viewers and reload also passed. The Pixel was PIN-locked
  when the controlled tone was attempted; its passive timestamp measurement above used silence.
  These checks do not establish physical speaker quality or actual incoming-call audibility.
- Mobile popups have a labeled 48px Close target with a centered 24px icon. Dragging the header
  or handle downward moves and dismisses the sheet; short, horizontal, canceled and resized
  gestures reset. The content still scrolls vertically. Touch tablets retain the functional
  sheet; mouse desktop dialogs omit the handle. Pending Apply blocks all dismissal paths.
- An audio error notice could cause Preact to reuse the unkeyed stream-stage node, removing
  the imperatively mounted video canvas. Stable stage/notice keys preserve that canvas across
  notice insertion and dismissal. Long notice text wraps without pushing Dismiss offscreen.
- **Final validation:** all 39 deterministic tests, TypeScript, lint (0 errors; 46 existing
  warnings), and production compilation passed. Against the final production bundle, UX/PWA,
  all 16 Settings geometry states, all five popup layouts (including real native touch and
  remote-touch positive controls), all four browser audio-availability recovery cases, and the
  desktop hardware PCM/output-quality test passed.

### Lock detection, passcode entry, and device switcher follow-up

- Android descriptors now include `device.locked`, `keyguard.showing`, and `keyguard.occluded`,
  each `true`, `false`, or `'unknown'`. Authentication-required state comes from the active user's
  TrustManager summary; a swipe-only lock is different from a PIN/password lock. Keyguard's
  logical showing state includes an occluding call/camera and a powered-off display. See
  [Android KeyguardManager semantics](https://developer.android.com/reference/android/app/KeyguardManager).
  This detects a lock, not the reason for every black or DRM-protected picture.
- The server reads bounded, filtered policy/trust summaries, strips user names before transfer,
  checks active-user identity before/after, and preserves unknown on missing/conflicting data.
  Lock polling runs every 2 seconds while a tracker is active (60 seconds idle), independently
  of the heavier battery/power poll. Disconnects, timeout, stale reads, and tracker shutdown
  cannot restore old positive lock claims or leave polling loops running.
- `GET_LOCK_STATE` returns fresh lock/showing/occlusion/screen-power information. Passcode
  submission checks before waking/opening the keypad and immediately before typing. It requires
  an awake, confirmed, unoccluded authentication screen and a live control connection. A unique
  matching serial **and stream socket** binds the lookup to its tracker; duplicate serials across
  hosts, ambiguous/custom endpoints, changed routes, and replaced clients cannot borrow another
  device's lock state.
- The stream shows a compact dismissible lock notice and Unlock action; Actions retains Unlock
  after the notice is dismissed. The lock notice stays above the sleep dimmer and remains
  readable while asleep. Unlock actions stay visible when the phone keyboard shrinks the
  viewport, with independent scrolling for the focused input and remaining content.
  A masked field accepts PINs or printable-ASCII passwords up to
  128 characters. Typing stays local. The explicit submission clears partial device entry, sends
  the entered text once, then Enter through the existing stock control socket, without clipboard
  or shell commands containing credentials. This path never queues setup input or replays it
  after reconnect. Unsupported characters are rejected before sending; visible pattern locks
  can still be drawn on the remote screen.
- Input is cleared on submission/close/disconnect/device change. Aborting either fresh-state
  check cancels pending input. Success requires confirmed unlocked telemetry; timeout gives
  an unconfirmed result and never automatically resends or claims the PIN was incorrect.
  Relocking resets success. A related text-framing bug now uses UTF-8 **byte** length instead
  of JavaScript string length, preventing non-ASCII text from corrupting the next control frame.
- Switch now has a bounded vertical list scroller with its search/header kept visible. Long
  names wrap; the last offline rows and below-fold device selections remain reachable. Its
  gestures neither move the background nor send device touches.
- **Validation:** all 58 deterministic tests, TypeScript, lint (0 errors; 46 existing warnings),
  and production compilation passed. Existing UX/PWA/Settings/popup regressions passed. The
  production bundle passed the new unlock fixture and all five switcher layouts. Simulated
  phone-keyboard checks at 350/320/250px visual viewport heights kept both the input and Send PIN
  visible and hit-testable, with working native touch scrolling. Awake/asleep lock-banner
  screenshots were identical, and Unlock remained clickable through the sleep overlay.
  Read-only hardware checks matched Pixel locked and Xiaomi unlocked states; the live Pixel showed the
  lock notice and opened a masked, empty PIN field while video remained Connected. No real
  passcode was entered by the agent: actual device unlock still needs the owner's verification.

### Unified tools and stream-service status

- Home and Switch share `ui/DeviceIcon.tsx` and its avatar styles. Switch search resets its list
  in a layout effect, before filtered rows paint; this avoids retained scroll offsets in landscape.
- Shell and Files mount under `ToolView` through the same hash router as Screen. Local tool links
  stay in the app. Each page has the screen-style header, Back, device Switch, service indicator,
  and Files/Shell navigation (see the Files explorer section below: DevTools and the Screen tab
  were later removed). Tool implementations remain lazy chunks; starting a tool does not start a
  screen stream.
- Each tool accepts an optional mount and exposes idempotent `stop()` cleanup. Route or device
  changes close its socket/channel and release owned DOM, terminal observers, polling/reconnect
  timers, and file transfers. File path-only changes reuse the active Files client. Cancelling
  a still-connecting manager also closes the connection. Failed tool loads/connections have an
  explicit retry action; Shell sessions are never silently recreated with previous commands.
- Shell resizes its visible terminal with its container and the phone keyboard, provides native
  keyboard focus plus Esc/Tab/Ctrl+C/history buttons, and avoids opening the phone keyboard on
  entry. Files has a native multiple-file upload picker, compact folder shortcuts, responsive
  rows, empty/error states, downloads, and scoped upload cleanup. The Files section below
  replaces that first implementation.
- `ui/StreamServiceStatus` is shown on Android home cards and Screen/tool headers. It describes
  the process on the device independently of browser connection, lock, and sleep. PID > 0 means
  Running, -1 means confirmed Stopped, and 0 means Unknown; offline/unauthorized and optimistic
  Starting have explicit labels. A tool's serial **and server address/path** must match its
  tracker, so identical serials on different hosts cannot borrow service telemetry.
- Read-only PID checks share the existing 10s active/60s idle runtime poll. They exclude scrcpy
  `list_*` helper JVMs, do not kill older versions, and preserve Unknown on failed diagnostics.
  Owned process exit invalidates cached status and requests a fresh observation; old process
  callbacks and reads cannot overwrite a replacement or disconnected device.
- New fixture commands: `npm run test:tools` and `npm run test:files` (`BASE` selects the app
  URL). They intercept all sockets and exercise the actual production UI, mobile/desktop geometry,
  tool navigation/cleanup, terminal key framing, service transitions, and upload/download bytes
  without changing a real device. See the later Files section for `npm run test:files-device`.
- Recent mobile control details to preserve: the FAB starts with Back/Home/Overview on one row
  and Volume down/Mute device/Volume up on the next. Mute device sends Android volume-mute
  key 164; Sound still controls browser playback independently. The panel Close icon is a
  centered 24px SVG inside its 44px button. Coarse-pointer controls suppress text selection and
  long-press callouts while inputs and useful text remain selectable. Quality resolution/FPS
  labels stay on one line; audio-source choices are exactly Device media and Call audio.
- Empty-file uploads now create a real zero-byte transfer. The server waits for successful
  device-side completion before reporting success and lets normal EOF drain. Closing a channel
  during asynchronous upload setup cancels the late transfer, and disposed callbacks cannot
  revive it. This is covered by deterministic fake-transfer tests, including non-empty files.
- **Validation:** all 66 deterministic tests, TypeScript, and lint (0 errors; 45 existing
  warnings) passed. Production compilation passed with the three existing webpack bundle-size
  warnings. Production fixtures passed for Tools/Shell and Files at 320/390px, landscape, and
  desktop; and Switch/popups at all five existing layouts. The live
  PWA regression also passed pinch prevention, internal scrolling, sheet isolation, and mocked
  remote multitouch. Tests cover
  real input/copy/upload/download framing against simulated sockets; no real file upload or
  shell command was sent to a device by these fixtures. Read-only live checks matched the
  Running indicator to actual scrcpy processes on both attached Android devices and confirmed
  all three tool links are present. Physical iPhone keyboard behavior still needs owner testing.
- The development app was restarted with the updated default feature flags. It remains on port
  8000; current development output is logged at `/tmp/ws-scrcpy-review/tools-dev.log`.
  Refresh open browser pages to load the new UI.

### File explorer, DevTools removal, and compact chrome

- **DevTools is gone**, at the owner's request: `DevtoolsClient`, `RemoteDevtools`, the
  `RemoteDevtools*` types, `devtools.css`, `AdbUtils`' devtools/HTTP helpers, `ACTION.DEVTOOLS`,
  `INCLUDE_DEV_TOOLS`, `docs/Devtools.md` and `scripts/e2e-devtools.js` were all deleted. Nothing
  in `src/` mentions devtools any more. Removing the flag also removed the last user of
  `AdbUtils.createHttpRequest`/`getDeviceName`.
- **The tools navigation is Files and Shell only.** The Screen tab was removed: a stream needs an
  interface and a player, which the device list already chooses, and the tool header's Back button
  returns there. `ToolView` no longer imports `StreamClientScrcpy`, so the tool routes never pull
  the player chunks.
- **Files is a real file explorer** (`FileListingClient.ts` plus `fileTypes.ts`): history
  Back/Forward/Up/Refresh, a clickable breadcrumb that collapses to `…` on a phone, a typed
  address bar, quick access (a sidebar at >=900px, the Places menu below that), Details/List/Tiles
  views, sortable Name/Size/Type/Modified columns, a local filter, a hidden-items toggle,
  multi-select, a context menu, Properties, and drag-and-drop or picker uploads. View, sort
  direction and hidden items persist in `localStorage` behind try/catch.
- **Opening follows the input device.** On a coarse pointer a tap opens; with a mouse one click
  selects and a double click opens, as in Explorer. Ctrl/Cmd+click toggles, Shift+click extends,
  a long press starts touch multi-select, and the keyboard has arrows, type-ahead, Enter, Space,
  Home/End, Ctrl+A, Backspace, F2, F5, Delete and Ctrl+X/C/V.
- **Selection repaints; it does not re-render.** Rebuilding the rows on selection destroyed the
  row between the two clicks of a double click, so `dblclick` never fired and mouse users could
  not open anything. `paintSelection()` updates classes, `aria-selected` and the checkboxes in
  place; `renderItems()` is only for listing, view, sort, filter and transfer changes. Row
  rendering is coalesced with `requestAnimationFrame` so a large folder stays responsive, and
  download progress lives in a map keyed by path so it survives a re-render.
- **Folder operations are shell commands, not adb sync.** Stock adb sync has no mkdir/rename/
  copy/delete, so `FileCommand` adds `MKDR`, `MOVE`, `COPY` and `DELE` to the Files channel and
  the server runs them through `AdbUtils`. Every argument is single-quoted, every path must be
  absolute, control characters are rejected (a newline would also break the exit-status marker),
  paths are normalised, and `/` can never be the target. `AdbUtils.shellExec` appends
  `2>&1; echo "__rc=$?"`: **a missing marker counts as failure**, because adb exits 0 even when
  the command inside it failed, and reporting success there would claim a delete happened when
  nothing did. File operations get a 120s timeout; a refused operation still refreshes the
  listing, so its message is held in `operationError` and reported after the refresh instead of
  being overwritten by the item count.
- **`/sdcard` is a symlink** and stock `STAT` describes the link, not its target, so the explorer
  refused to open internal storage ("not a regular file or folder"). `pipeStatToStream` now
  resolves through `AdbUtils.stats()` and frames the resolved mode itself. This was found on
  hardware, not by any mocked test.
- **`data-listing` on the explorer root is `loading`, `ready` or `error`.** "No rows yet" and
  "this folder is empty" are indistinguishable from the outside, which is exactly how a fixture
  reads a half-loaded folder as an empty one. Wait for `[data-listing="ready"]`.
- **Phone chrome (owner follow-up).** Below 700px the address bar takes a whole line (a home
  icon for the root, since a bold `/` next to the `/` separators read as two different slashes;
  separators share the mono face), the next line is Back/Forward/Up/Quick access on the left and
  Filter/Actions on the right, and the filter field is a third line that exists only while
  filtering. Every toolbar command lives in the **Actions** menu (`actionsMenuItems()`), whose
  "View options…" swaps the menu contents for the View items with a Back row: menus are built
  from a stored builder (`menuBuilder`/`refreshMenu`) so a setting change re-renders in place.
  Refresh is in that menu rather than the icon row so five 44px buttons still fit 320px. The
  whole row is the tap target on touch (the name link no longer needs 44px of its own), rows
  dropped from 66px to ~45px, the click that trails a long press is ignored so it cannot
  toggle the row straight back out of multi-select, `contextmenu` on touch only suppresses the
  callout, and the tool mount is edge-to-edge (`ToolView.css`, `max-width: 700px`). Menu check
  marks are a masked shape, not a `✓` character: generated text joins the accessible name
  ("✓ Select items") and breaks both screen readers and role queries.
- **Second phone follow-up.** The home button moved out of the address box into the navigation
  row (it yields its slot below 360px; the `/` crumb still reaches the root), the root crumb is a
  `/` in the same mono face as every separator, and the full path is always shown -- the `…`
  collapse hid where the user actually was, so the bar scrolls to its end with a fade instead.
  The pencil swaps the crumbs for a field holding the whole path, selected with
  `setSelectionRange` (iOS ignores `select()`), `enterkeyhint="go"`, no clear button; tapping
  empty space in the bar opens it too. **`.file-explorer [hidden] { display: none !important }`
  exists because the flex `display` rules beat the `hidden` attribute**, which put the editor
  next to the crumbs instead of in their place. A folder switch no longer blanks the list:
  `list()` marks the wrapper `fx-loading` (old rows dimmed and inert) and the first render of the
  new listing replaces them, so nothing flashes. The shell's Ctrl+C button is now a **Ctrl
  toggle**: `ShellClient` drops the attach addon and routes `term.onData` through `withControl()`
  (letters and `@[\\]^_?` become their control codes) while the toggle is on, and writes socket
  output itself in `onSocketMessage`.
- **Folder changes use `pushRoute()` (`history.pushState`), not `location.hash =`.** The owner
  reported the whole screen flashing on every folder change and Back/Forward doing nothing on
  the iPhone, neither of which Chromium emulation reproduces. Assigning `location.hash` is a
  fragment *navigation* in WebKit; `pushState` is not, and the router's `hashchange` listener
  still tracks the browser's own Back/Forward between those entries. The explorer's history
  stacks are also kept in `sessionStorage` per device, so they survive a page reload. Playwright
  WebKit is installed but needs `sudo npx playwright install-deps webkit` (libevent/libavif) to
  launch on this machine; run the Files fixture under it once that is possible.
- **iOS full-control investigation** lives in `docs/IOS-CONTROL-INVESTIGATION.md` (Sept 2026):
  DeviceKit/streaming-WDA agent route (iOS 16+, needs signing) versus Apple's CoreDevice display
  + HID services (iOS 27, no signing, HEVC smearing and single-touch caveats), both over USB.
  Route 2 was chosen and built; see the section below.
- **Compact chrome.** The tool page dropped its title/hint block and carries connection state in
  the navigation row. `ToolView.css` scopes its 44px button rule to `.tool-navigation`,
  `.tool-error` and `.shell-shortcuts`: `.tool-view button` also matched every button a mounted
  tool renders, which forced 44px rows and 12px padding onto the explorer and squashed its 20px
  icons to 4px. The explorer sizes itself from `--fx-control`, 30px on a mouse and 44px on a
  coarse pointer. The device list lost its eyebrow/tagline/footer, the serial moved onto the meta
  line, and card padding, gaps and the stream header all shrank.
- **Testing.** `npm test` is 71 deterministic tests, including quoting/exit-status/path-validation
  coverage for all four folder operations and the symlink STAT fix. `npm run test:files` drives
  the production UI against socket fixtures at 320px, iPhone 17 Pro Max portrait and landscape,
  desktop and 1600px, covering views, sorting, filtering, history, the address bar, every folder
  operation, refusals, cancellation, multi-select, Properties, transfers and unmount cleanup.
  The fixture drives the toolbar on a desktop and the Actions menu on a phone through one
  `command()` helper, and checks that a phone hides the command bar, gives the address bar the
  full width, and draws every separator in one face.
  `npm run test:files-device` is the only Files test that touches hardware: it compares listings
  against `adb ls` and confines every mutation to one uniquely named scratch folder under
  `/data/local/tmp`, refuses to run if that folder already exists, and deletes it at the end.
- **Fixture viewports are now iPhone 17 Pro Max** (440x956 CSS px, both orientations) in place of
  the old 390x844/844x390 pair, across the files, tools, sheets, settings, switcher, ux and pwa
  scripts. The sheets fixture clones device cards until the list actually scrolls, because the
  compact multi-column cards no longer overflow a desktop window at a fixed filler count.
- **Validation:** 71 deterministic tests, TypeScript, lint (0 errors, 44 warnings -- the baseline
  dropped from 45 with `DevtoolsClient`), and the production build all pass. Against that build:
  files (5 layouts), tools (4), sheets (5), settings (16 states), switcher (5),
  audio-availability (4), unlock, idle-video, and the hardware ux/pwa scripts all pass.
  On the Xiaomi (Android 16) the explorer's listings matched `adb ls` for `/data/local/tmp` and
  `/sdcard`, and New folder, Rename, Upload, Download, Properties and Delete were each confirmed
  against the device afterwards. Physical iPhone Safari behaviour is still unverified: the
  440x956 runs are Chromium emulation, not a real phone.

### Orphaned scrcpy servers after a ws-scrcpy restart (September 2026)

`pkill`-ing (or otherwise killing) ws-scrcpy does not reliably stop the scrcpy servers it
launched on the phones. The next instance's `Device.startServerNow()` then found a pid,
returned it as "already running", and -- owning no broadcast for that process -- closed every
viewer with `4008 No active stream for this device yet`, for ever, with nothing in the log.
The symptom on the bench was the `ux`/`deeplink` fixtures timing out on "Connected" after a
server restart while `adb shell ps` looked innocent (the process is `app_process`, not
"scrcpy"). `startServerNow()` now treats "pid but no broadcast" as an orphan: it kills the
phone-side process and launches a fresh one (`test-server-regressions.js`: "a scrcpy server
left behind by a previous ws-scrcpy process is replaced, not reused").

### iOS route 2: CoreDevice screen + HID (September 2026, verified on an iPhone 13 Pro Max / iOS 27.0)

The go-ios / WebDriverAgent / MJPEG stack is gone (`GoIosRunner`, `WDARunner`, `HttpUtil`,
`WebDriverAgentProxy`, `MjpegProxyFactory`, `StreamClientMJPEG`, `WdaProxyClient`, `MjpegPlayer`,
`WDAMethod`, `WdaStatus`, the `go-ios` npm dependency and `USE_WDA_MJPEG_SERVER`). It was
replaced by the second route from `docs/IOS-CONTROL-INVESTIGATION.md`: Apple's own CoreDevice
developer services, reached through `pymobiledevice3` (11.12.x, Python venv under `python/venv`,
`npm run setup:ios`). Nothing is installed or signed on the phone; the phone needs **iOS 27**,
Trust, and Developer Mode. Built first against a simulated `pymobiledevice3`, then validated
on the bench iPhone (iPhone14,3, iOS 27.0, USB, no passcode) on 2026-09-16 -- see *Hardware
validation* below for what was observed and what had to change.

- **Process model.** `CoreDeviceRunner` spawns one
  `pymobiledevice3 developer core-device display serve-web --udid U --bind 127.0.0.1 --http-port P --no-audio`
  per iPhone, after `mounter auto-mount --udid U` (the DDI hosts the display/HID daemons and
  does not survive a reboot). `serve-web` owns the userspace RSD tunnel (no root), the
  RTP/HEVC display stream and the HID surfaces, and exposes them on loopback HTTP: `/codec`
  (`{codec, description}` = WebCodecs string + base64 hvcC), `/stream.bin` (chunked
  `[4B BE len][1B type 0=key 1=delta 2=reset-key][length-prefixed NALUs]`), `/touch`
  (`{type: contact|release|tap, x, y}` in 0..65535), `/key` (`{usages}` — a 240-bit keyboard
  report), `/button` (`{name, state}`), `/clipboard` GET/POST, `/rotate`, `/pli`, `/restart`.
  Readiness is `GET /codec` answering 200 (503 until the first keyframe); `READY_TIMEOUT_MS`
  is 120 s because the first mount personalises and downloads the DDI. Sessions are held per
  viewer, outlive the last viewer by 15 s, and a failed start is not sticky (the failed session
  stays registered with its message so the card can show it; the next viewer retries). The
  loopback server has no auth, hence `--bind 127.0.0.1` and never a LAN bind.
  `serve-web` gets `--userspace` (the CLI otherwise expects a root `tunneld`; `IOS_TUNNEL=tunneld`
  switches to `--tunnel <udid>`); `mounter auto-mount` runs over plain usbmux/lockdown. The
  CLI's `--motion-idr` default (a keyframe about once a second while the screen moves) is what
  fights the encoder's resolution collapse under motion; its `--compensate` option is a
  feature of pymobiledevice3's *own* viewer page, so `/stream.bin` consumers such as ours see
  the raw, briefly shrunk frames -- a per-frame content-rectangle stretch in
  `WebCodecsHevcPlayer` is the follow-up if it is visible in practice.
- **Wire to the browser.** `CoreDeviceProxy` (`?action=proxy-coredevice&udid=`) sends JSON
  `status`/`codec`/`clipboard`/`result` and one binary message per access unit (`[type][AU]`,
  reassembled by `splitStreamFrames`). Backpressure: above 4 MiB of `bufferedAmount` it drops
  deltas and asks `/pli` for a fresh keyframe. Browser→server messages are the
  `CoreDeviceClientMessage` union in `src/common/CoreDeviceProtocol.ts`; unknown buttons and
  out-of-range HID usages are dropped server-side (`clampHid`, `isCoreDeviceButton`).
- **Browser.** `WebCodecsHevcPlayer` decodes with `VideoDecoder` in hvcC mode (parameter sets
  out of band — Chrome's Annex-B path tears under motion), drops deltas until a keyframe,
  rebuilds the decoder on a reset-key or a decode error, and takes `ScreenInfo` from the first
  decoded frame. Chrome needs hardware HEVC; Safari always decodes it. `StreamClientCoreDevice`
  mirrors `StreamClientScrcpy`'s surface (`getControlButtonsElement`, `getDeviceName`, `stop`)
  so `FloatingToolbar`, sheets and the switcher are shared; `ApplActionsSheet` and
  `ApplLiveTextOverlay` are its Actions/Type-text sheets. Keys are translated from
  `KeyboardEvent.code` to HID usages (`hidKeyboard.ts`, US layout; `keyboardReportsForText`
  types ASCII and reports what it skipped). Touch is single-contact by protocol
  (`CoreDeviceInteractionHandler` follows the first pointer only, rAF-coalesced).
- **Tracking.** The appl `ControlCenter` polls `usbmux list --simple --usb` every 3 s. A new
  UDID is `unauthorized`/`paired:false` until `lockdown info` answers (that is what an
  un-Trusted phone looks like); then `amfi developer-mode-status` fills `developerMode`. The
  card offers **Enable** (`amfi enable-developer-mode`, which reboots the phone) and mirrors the
  runner's session state (`stopped`/`starting`/`ready`/`error` + message).
- **Tests.** `npm run test:ios` (`scripts/test-coredevice.js`, part of `npm test`) drives the
  runner, proxy and tracker against `scripts/fixtures/fake-pymobiledevice3.js`, which speaks
  the same routes and framing (503-until-ready, frames split across chunks, mount/serve
  failures via `FAKE_*` env), plus browser-side units for frame splitting, HID mapping, the
  receiver and the HEVC player against mocked WebCodecs. The tracker tests in
  `test-server-regressions.js` mock `PyMobileDevice.runJson`.
- **Hardware validation (2026-09-16).** Tracker: the phone appeared as *Unauthorized* before
  Trust and as `iPhone / iOS 27.0 / iPhone14,3 / paired / developerMode: true` after.
  `mounter auto-mount` over plain usbmux answers "DeveloperDiskImage already mounted" (exit 0).
  `serve-web --userspace` reaches `/codec` 200 about 1.5 s after acquire; codec string
  `hev1.1.6.L150.B0`, 133-byte hvcC, 1296x2816 HEVC at ~19 fps idle (~290 KB/s), key frames
  about once a second (the CLI's `--motion-idr` default), one reset-key at start. Frames were
  decoded on the NUC with the system ffmpeg after re-framing to Annex-B (VPS/SPS/PPS from the
  hvcC arrays at offset 22, then each AU's 4-byte-length NALUs behind `00 00 00 01`). Verified
  through our proxy: `touch tap` opened Spotlight, `contact` drags swiped home-screen pages,
  `/key` typed into Spotlight, Home/Volume/Siri/Lock, clipboard set+get round trip, `/rotate`
  answers with the orientation dict, `/pli` yields a key frame within ~1 s. The Chromium page
  (toolbar, Actions sheet, clipboard read, rotate, keyboard toggle) sends exactly the expected
  JSON.
- **Things the phone taught us** (all fixed in code):
  1. `serve-web` has **no `--udid`**; the tunnel target comes from `PYMOBILEDEVICE3_UDID`
     (`CoreDeviceRunner` sets it in the child's env). The other commands take `--udid`.
  2. `--no-color` is a *global* option and must precede the subcommand (it does).
  3. Typer's rich error box (`╭─ Error ─╮ │ … │ ╰─╯`) made `explain()` show a border line; it
     now strips the box and prefers the `ERROR`/exception line.
  4. **Shift in the same report as the key types the key unshifted and latches Shift** for the
     following keys ("Hello" came out "hELLO"). `keyboardReportsForText` now sends `[Shift]`,
     `[Shift, key]`, `[Shift]`, `[]`; live typing already does this because the browser emits
     the Shift keydown first.
  5. **`lock` with `state: press` opens Siri**: pymobiledevice3 holds the side button 0.5 s for
     `lock`, which is a long press on a Face ID phone. `CoreDeviceProxy` sends `lock` presses
     as `down`, 120 ms, `up`; a real hold from the toolbox still produces down/up and therefore
     Siri, like the physical button.
  6. `DeviceSwitcherSheet` built adb interface options for every entry and threw on the iOS
     descriptor (no `interfaces`); it now skips iOS entries and marks the active CoreDevice
     stream as current.
  7. While the phone is locked the encoder keeps running but emits almost nothing (a black
     picture, ~1 fps); Home wakes it. The mirroring indicator (blue pill) shows on the phone
     for the whole session.
- **First real-browser round (2026-09-16, user's iPhone Safari + desktop Chrome).** Safari on the
  phone showed the stream but could not control it: `CoreDeviceInteractionHandler.position()`
  spread the `Touch`/`MouseEvent` into a plain object (`{ ...event }`), which copies nothing
  because event coordinates are prototype getters, so every point was NaN and silently dropped.
  Coordinates are now read explicitly and mapped by `applDevice/touchMath.ts`
  (`clientPointToVideo`, unit-tested, clamps onto the picture instead of dropping). Desktop
  Chrome said "This browser has no WebCodecs video decoder": Chrome/Edge expose WebCodecs only
  on secure origins, and the page was `http://<nuc>:8000`. `npm run setup:https` generates a
  self-signed cert with the host's IPs as SANs plus `config.https.yaml` (8000 + 8443);
  `npm run start:https` serves both. **On the NUC 8443 is already taken by another service**
  (the script now refuses a busy port), so it runs on **8444**: `https://10.10.10.5:8444/`.
  Verified in Chromium: over http the page reports the HTTPS requirement, over https
  `isSecureContext` is true, `VideoDecoder` exists, the wss proxy connects, and only the HEVC
  codec is missing (Playwright's Chromium has no HEVC; a real Chrome with hardware HEVC should
  decode). The error message now names the HTTPS requirement when
  `window.isSecureContext` is false.
- **MSE fallback and the sticky mouse (2026-09-16).** The user confirmed WebCodecs decodes
  over https on the desktop but did not want a transcode, so the http case is now served by
  `player/MseHevcPlayer.ts`: the untouched access units are remuxed into one-sample fMP4
  fragments (`player/hevcFmp4.ts`: `ftyp/moov` around the verbatim hvcC with the picture size
  parsed from the SPS, `moof/mdat` per AU, `sequence` mode with wall-clock inter-arrival
  durations, live-edge chasing at 250 ms, 8 s history trim, re-init on reset keys / decode
  errors). `StreamClientCoreDevice.chooseDecoder` picks WebCodecs when
  `VideoDecoder.isConfigSupported` says yes, else MSE when `MediaSource.isTypeSupported` admits
  `hev1.…` or `hvc1.…` (the sample entry follows whichever spelling the browser accepted), else
  the notice; `?player=mse|hevc` forces one. The player is created when `/codec` arrives, so
  `getPlayer()` is optional until then. The muxer output was validated against ffprobe/ffmpeg
  with frames captured from the phone (both spellings: `hevc, 1296x2816`, decodes). Real-browser
  MSE playback still needs a look on the user's desktop over `http://10.10.10.5:8000`.
  The sticky mouse: `CoreDeviceInteractionHandler` only received `mousemove`/`mouseup` targeted
  at the canvas, so a release outside it was never seen and the contact stayed down until the
  next click. A held button is now followed on `window` (capture) until `mouseup` anywhere;
  off-canvas positions clamp to the picture edge. Unit-tested with a queued-rAF mock.
- **Wedged CoreDevice display daemon (2026-09-16).** After many sessions the phone reached a state
  where a fresh `serve-web` connected and the RSD tunnel + SpringBoard services answered
  (`springboard orientation` returned 1), but the display service accepted the session and never
  started video: `/codec` stayed 503, serve-web logged "eager video start failed -> TimeoutError".
  A phone reboot cleared it (DDI is re-mounted automatically; Developer Mode survives). The host
  teardown is not the cause -- SIGTERM to serve-web logs a clean "shutdown complete". To stop the
  page hanging on "Starting..." for the full 120 s mount budget, `CoreDeviceRunner` now watches for
  the signature "HTTP up but /codec still 503" and, 25 s after serve-web first answers, errors with
  "reboot the phone" (`DISPLAY_WEDGED_TIMEOUT_MS`, overridable via `IOS_DISPLAY_WEDGED_TIMEOUT_MS`
  for tests; covered by test-coredevice.js). The long budget still covers the pre-HTTP cold-mount.
- **What actually wedges the display daemon, measured (2026-09-16).** The earlier entry says the
  host teardown is not the cause. That was half right: a *clean* teardown is not, but SIGKILL is,
  and the instrument for seeing it is `pymobiledevice3 developer core-device display
  get-media-stream-server-status --userspace` (`PYMOBILEDEVICE3_UDID` set), which reports the
  daemon's `running` flag and its **active sessions**. Measured on the bench phone:
  - Idle, nothing attached: `running: false, sessions: []`.
  - SIGKILL a `serve-web`: the phone still reports `running: true` with **two** live sessions
    (video *and* audio — serve-web starts both even with `--no-audio`) pushing RTP into a tunnel
    that no longer exists. They are reclaimed ~20 s later by the RTCP timeout
    (`RTCPTimeoutInterval: 20.0`), not by anything the host does.
  - A clean SIGTERM logs `shutdown complete` and leaves `sessions: []` immediately.
  - Things that turned out **not** to wedge it, each tried once: a restart 2 s after a SIGKILL
    (recovered in 3 s), two `serve-web` processes streaming the same phone at once (both served
    `/codec` 200), and opening HID against a blanked screen -- which does *not* wedge the
    display daemon, though it does silently kill touch for that process (see the HID auth gate
    below; a `lock` press still works because buttons are a different service, which is what made
    this look harmless at first).
  - What did wedge it: **six display sessions started and torn down inside ~4 minutes**, two of
    them by SIGKILL and two of them concurrent, interleaved with `--userspace` CLI queries. After
    that, `display get-media-stream-server-status` and `get-media-support-info` time out in ~4 s,
    every time, indefinitely — while the **same tunnel** still serves `core-device
    list-processes` and `get-device-info` fine, and lockdown (`usbmux list`, `diagnostics
    ioregistry`) is untouched. So the wedge is `com.apple.coredevice.displayservice` alone, not
    the tunnel, not RSD, not the device. It does not self-heal (checked over 4 minutes); reboot.
  - Diagnosis order when the stream will not start: lockdown → tunnel (`list-processes`) →
    display (`get-media-stream-server-status`). If only the last fails, it is this, and only a
    reboot fixes it. On a passcode phone that reboot then needs one physical unlock.
  - Fix applied: `CoreDeviceRunner`'s SIGTERM→SIGKILL grace was **3 s**, but serve-web's orderly
    shutdown bounds four cleanup steps at 3 s each, so a slow phone could legitimately need ~15 s
    and got SIGKILLed mid-`mediastreamstop` — exactly when the phone is already struggling, which
    is when it matters. `SIGKILL_GRACE_MS` is 15 s now; `close` cancels it, so a healthy shutdown
    still costs nothing.
  - **The habit to drop.** The trigger is a burst of short-lived display sessions, and that is an
    agent-shaped thing to do, not a user-shaped one: standalone `serve-web` / `start-video-stream`
    / `start-audio-stream` runs for hardware tests, several in a few minutes, torn down with
    `kill -9`. A previous session already guessed this ("likely provoked by the extra standalone
    `start-audio-stream` sessions used for the captures"); it is now measured. When testing
    against the phone: reuse one session, stop it with **SIGTERM and wait for `shutdown
    complete`** in its log, leave ~30 s between sessions so the RTCP timeout can reclaim anything
    left, and check `get-media-stream-server-status` is back to `sessions: []` before starting
    another. Never `kill -9` serve-web, and never `pkill -f <pattern>` — it matches the invoking
    shell's own command line and kills it mid-sequence (exit 144; documented above, and walked
    into again this session).
- **Reboot test (2026-09-16).** `pymobiledevice3 diagnostics restart --udid` was run with a live
  session open. Observed: frames stop, the tracker sees the UDID leave usbmux and reports
  `session stopped "Device disconnected"`, the phone returns to usbmux after ~38 s, and a retrying
  viewer gets `ready` again ~27 s later (DDI is re-mounted automatically, Developer Mode survives).
  The user's own browser tab recovered with no reload. So reboot recovery needs no intervention.
  Two things the test exposed:
  1. **A proxy whose `init()` failed left its WebSocket open** (it only sent an error status).
     `CoreDeviceReceiver` retries on *close*, so such a viewer was stranded on the error forever --
     and the still-registered proxy kept relaying *another* viewer's session events to it, which is
     how a stranded socket showed a `ready` that was not its own. `CoreDeviceProxy.failSession()`
     now sends the status, closes with 4009 "Stream unavailable", and releases. Verified live: a
     bad udid yields the error then `CLOSE 4009`.
  2. **`pgrep -x node` does not match this server**: Node reports its comm as `MainThread`, so
     `pgrep -x node` / `pkill -x node` find nothing and a stale instance keeps port 8000 while the
     new one dies with EADDRINUSE (its crash only shows in the log, so the stale build keeps
     answering and tests silently run against old code). Kill by cmdline (`pkill -f '^node index.js'`)
     or by the PID from `ss -ltnp`, and check the log says "Listening" after a restart.
     Note `pkill -f <pattern>` also matches the invoking shell's own command line -- it will kill
     the shell running it (seen twice, exit 144); prefer the PID from `ss`.
- **Clipboard, power actions, lock-state behaviour (2026-09-16).** Reported: "copy from clipboard
  doesn't work". Three separate causes, all fixed:
  1. **`navigator.clipboard` does not exist on a plain-http origin**, so the sheet's "Copy here"
     could never work over `http://<nuc>:8000` -- it fell into its own catch and blamed the
     browser. `app/ui/copyText.ts` now falls back to a hidden textarea + `execCommand('copy')`,
     which works on http. Verified in Chromium on the http origin
     (`navigator.clipboard: undefined`) -> "Copied to this browser."
  2. **A `clipboard get` carries no `id`**, so when the request failed the proxy's catch only
     reached `console.error` and the viewer was never told anything -- it sat on "Reading..." and
     then the UI's own 8 s timeout blamed the lock screen. The catch now answers a failed
     clipboard message with `{type:'clipboard', text:null, error}` (and a `result` when it has an
     id), and clipboard requests use their own `CLIPBOARD_TIMEOUT_MS` (8 s) instead of the 15 s
     default.
  3. **Superseded -- this reading was wrong; see "The clipboard's real fault: `dtpasteboardd`"
     at the end of this file.** What was seen: **a long-lived `serve-web` appears to wedge only its
     pasteboard channel**: video and HID kept
     working and `/codec` answered 200, but `GET /clipboard` hung indefinitely (30 s curl, no
     response) while `developer core-device paste` over a *separate* tunnel returned the value
     immediately -- so the device service was healthy and serve-web's per-request channel was not.
     Killing serve-web fixed it instantly (0.1 s responses), so the error text names the cure:
     "Use Restart stream, then try again."
- **Power actions (2026-09-16).** `ControlCenterCommand.REBOOT_DEVICE` / `SHUTDOWN_DEVICE` run
  `diagnostics restart|shutdown` in the appl `ControlCenter`, stopping the screen session first so
  the viewer reads "Device is rebooting" rather than a mid-shutdown stream error. They go through
  the **tracker** channel, not the stream socket, so they still work when no session is up (the
  wedged-display case). The Actions sheet's Reboot/Shut down each need a second press to confirm
  (verified: the first press only arms it and sends nothing). End-to-end on hardware: press ->
  session stopped -> retries report the real reason and close 4009 -> `ready` again **45 s** after
  the press (faster than the 82 s manual reboot, since the personalised DDI is cached).
- **Lock screen (tested, no passcode set).** Capture continues while the phone is locked but the
  encoder throttles hard: ~4 fps locked vs ~31 fps unlocked. Clipboard get *and* set both work
  while locked (0.1 s). An HID swipe up from the bottom unlocks a phone with no passcode.
  A retrying viewer is now reported as `starting` instead of replaying the previous attempt's
  error, which had made every retry look like an instant fresh failure.
- **Two phones, and a stale error that looked like a broken one (2026-09-16).** Everything
  validated in this session ran against **iPhone14,3** (udid `00008110-...801E`, the bench phone).
  The user's own **"BCS iPhone" is iPhone18,2** (udid `00008150-...401C`) and was only briefly
  attached. When it was unplugged the card kept reporting
  `session: error / "Could not mount the Developer Disk Image: Device not found"`, because any
  viewer still on its page keeps retrying and each failed acquire was mirrored onto the
  descriptor -- so a phone that was merely unplugged read as broken ("it says unavailable").
  The appl `ControlCenter` now clears `sessionMessage` on disconnect and ignores runner status for
  a descriptor already in `DISCONNECTED` (covered in `test-server-regressions.js`). To tell an
  unplugged phone from a wedged one, check `/sys/bus/usb/devices/*/serial` for `idVendor 05ac`:
  only physically attached phones appear there, and the serial is the udid without dashes.
- **Passcode: tested on hardware (2026-09-16, throwaway passcode `000000` on iPhone14,3).** The
  two cases behave completely differently:
  1. **Screen-locked after being unlocked once since boot: HID unlock WORKS.** Locked, capture
     throttles to ~1 fps (3 frames in 3 s); typing the passcode restored ~29 fps and the home
     screen (confirmed from decoded frames). Two details that matter: the screen must be awake,
     and **the first keypress is consumed opening the passcode field** -- sending exactly six
     digits at the clock-face lock screen left *five* dots filled and submitted nothing. So
     `StreamClientCoreDevice.unlockWithPasscode()` wakes the phone, opens the field with a
     **swipe up** (screen-normalised touch, no video size needed) and only then types the digits.
     A priming *digit* was rejected as the opener: if it ever stopped being swallowed, a
     four-digit device would submit a wrong passcode and burn a real attempt.
  2. **Freshly rebooted with a passcode: impossible, and not a bug we can fix.** After
     `diagnostics restart` the phone **never came back to USB at all** -- 12 probes over 143 s,
     `usbmux list` empty the whole time, and `lsusb`/sysfs showed **no `05ac` device whatsoever**
     (without a passcode the same phone was back on usbmux in 38 s). With no USB data connection
     there is no RSD tunnel, no DDI and no HID, so HID unlock cannot bootstrap itself. A
     passcode-protected phone therefore needs one physical unlock after every reboot before
     ws-scrcpy can see it; the Reboot action's unattended recovery only holds for a phone with no
     passcode. The Actions sheet's *Lock screen* row says so, and the passcode is never persisted.
- **Input died while video kept flowing (2026-09-16).** Reported as "I unlocked the device but I
  can't control it anymore". The tracker read `Connected / session ready`, frames were arriving at
  ~30 fps, and serve-web answered `/touch`, `/key` and `/button` with **200 ok** -- but a tap on
  the Spotlight pill changed nothing on the decoded frames. Cause is device-side and documented in
  pymobiledevice3's own source (`hid_service.py`, "Authentication gate"): `dtuhidd` publishes the
  HID surfaces as `authenticated: NO ... eventSource: externalAccessory` unless a media stream is
  running when they are opened, and backboardd then *silently* drops every event. serve-web opens
  those surfaces **lazily on the first input request**, so the flags are decided once and stick for
  the life of that process. Killing serve-web and letting the next viewer respawn it restored
  control immediately (verified: the same tap then opened Spotlight).
  Two changes: `CoreDeviceProxy` now **withholds `touch`/`key`/`button` until `/stream.bin` is
  attached**, so a viewer that taps during "Starting..." can no longer open the HID surfaces
  before the gate is up (the most likely trigger; dropped, not queued, since stale input aimed at
  an old frame is worse than none), and the Actions sheet's Restart hint now names dead input as
  the symptom it fixes. This is the third face of one pattern -- a long-lived serve-web losing a
  device service channel while video survives (wedged display, hung pasteboard, dead HID) -- and
  in all three **Restart stream is the cure**.
- **"Restart stream" was the wrong cure; and so was the replacement (2026-09-16).** Everything in
  this bullet about *why* the clipboard wedges, and about `restart-session` curing it, was
  disproved later the same day -- the fault is the phone's `dtpasteboardd`, and no restart on this
  side touches it. See the last section of this file. The rest (serialising clipboard requests, the
  *Restart picture* / *Restart session* split, a deliberate stop no longer surfacing as
  `error "aborted"`) stands. What was believed at the time: the clipboard
  wedged again in normal use, and the diagnosis sharpened: the pasteboard **operation succeeds and
  the channel teardown hangs**. Proof -- while serve-web's `/clipboard` was dead, the CLI
  `developer core-device copy` appeared to hang for 45 s yet *had* written the value, and the next
  fresh serve-web read that exact value back in 0.1 s. Lock state is irrelevant: reads failed
  awake, locked and after unlocking alike. What matters is the serve-web *process*.
  The important correction: the sheet's old "Restart stream" only POSTs `/restart`, which restarts
  the **video inside the same process** (confirmed in screen_stream.py) -- it can never clear a
  wedged pasteboard or HID channel, so the advice that error text gave was useless. Added
  `{type: 'restart-session'}`: the proxy calls `runner.stopSession()`, the socket closes and the
  viewer reconnects into a **fresh serve-web**. The sheet now shows *Restart picture* (video) and
  *Restart session* (everything), and the clipboard error points at the latter. Verified on
  hardware: read ok -> restart-session -> reconnect -> read ok.
  Clipboard requests are also **serialised** now (one in flight, one may queue, a third is
  refused): concurrent requests against a wedged channel only multiply abandoned channels. Note
  this makes reply *ordering across different command types* non-deterministic -- replies are
  matched by `id`, and two tests that assumed a global order were fixed, not the behaviour.
  Finally, a deliberate stop no longer surfaces as `error "aborted"`: the stream read aborts as a
  *consequence* of the stop, and that raw message used to replace the reason the viewer had just
  been shown ("Restarting the phone session", "Device is rebooting").
- **Debug / service controls (2026-09-16).** The recovery actions were only reachable from a
  working stream page, which is precisely what a wedged session does not give you. There is now a
  collapsible **Debug** group in two places, driven by the **tracker** channel so it works with no
  stream at all: on the iOS device card (`DeviceCard.tsx`) and in the stream page's Actions sheet.
  Each shows a small readout (session state, paired, Developer Mode; the sheet also shows the
  decoder actually in use and the socket state) and three buttons, ordered by how much they throw
  away: **Restart services** (`RESTART_SESSION` -> `stopSession`, kills serve-web so the next
  viewer gets a fresh process -- the cure for dead HID/clipboard), **Remount developer image**
  (`REMOUNT_DDI` -> stops the session first, since it holds the image open, then
  `mounter auto-mount`) and **Refresh info**. Command replies carry the CLI's own words back to the
  card, so "DeveloperDiskImage already mounted" is what the user sees.
  `RESTART_SESSION` exists separately from `KILL_SERVER` because the latter's validation requires a
  `pid` (the card's "Stop stream" passes a dummy `1`); a debug action should not have to lie about
  one. Verified on hardware: baseline stream -> Restart services -> fresh session ready in 1.5 s
  and streaming -> Remount developer image ("already mounted") -> still streaming.
- **Not verifiable on the NUC.** WebCodecs HEVC decoding: Playwright's Chromium has no HEVC
  (`VideoDecoder.isConfigSupported` is false; the page shows the "cannot decode" notice and the
  toolbar still works). `WebCodecsHevcPlayer` therefore has unit coverage and a verified byte
  stream but has not been watched in Safari or a hardware-HEVC Chrome yet -- that is the first
  thing to look at from a real browser. Audio is unused (`serve-web` still starts its audio
  stream and logs an AAC-ELD/AudioToolbox traceback on Linux; harmless).

### iOS text entry from a phone browser (2026-09-16)

- **The iOS Type text sheet was unstyled and batch-only.** `ApplLiveTextOverlay` used class
  names (`live-text-panel`, `live-text-header`, ...) that `LiveTextOverlay.css` never defined,
  so it rendered as bare elements with no backdrop or panel; it collected a string and typed it
  on a "Type" press; its Enter/Delete buttons took focus (closing the phone keyboard); and it
  ignored the visual viewport, so the phone keyboard covered it. It is gone. Both platforms now
  render the one `views/LiveTextOverlay.tsx`, parameterised by a `LiveTextTarget`
  (`googDevice/liveTextTarget.ts` injects text and Android key events; `applDevice/liveTextTarget.ts`
  types through the HID queue). The overlay therefore behaves identically on both: live
  per-commit typing, `beforeinput`/IME/paste handling, visual-viewport tracking, focus trap and
  restore, `pointerdown` prevention on the key buttons, 16px input. It gained ← → keys (DPAD on
  Android, HID arrows on iOS) and forwards physical Delete/arrows from an empty field.
- **Smart Punctuation.** An iPhone keyboard commits ’ for ', “ ” for ", — for -- and … for ...
  as you type, and `keyboardReportsForText` skipped all of them, so an apostrophe typed from a
  phone browser silently vanished on the iOS device. `asciiEquivalent()` folds those (and nbsp,
  minus, bullet) back to the key that produces them. Accented letters are still reported rather
  than folded: "cafe" for "café" would look like success while changing the text. The overlay
  shows "Sent, except é (no key for these)" for what could not be typed.
- **Key order on the wire.** `CoreDeviceProxy` handled every browser message concurrently and
  `CoreDeviceRunner.request` uses a keep-alive agent with 8 sockets, so nothing guaranteed that a
  key's release reached serve-web after its press, or Shift's release after the shifted key
  (which latches Shift, cf. "hELLO" above), or a touch release after its last move. Touch, key
  and button messages now go through one ordered queue per viewer (`queueInput`), with a 4 s
  per-request timeout (`INPUT_TIMEOUT_MS`; a healthy HID post answers in milliseconds, and typed
  characters must not queue behind 15 s timeouts) and a 512-message cap that drops new input
  rather than growing a backlog against a wedged channel. The HID auth-gate check (`!this.stream`)
  moved to enqueue time; behaviour is unchanged. The browser side queues the overlay's key
  presses on the same promise chain as `typeText` (`pressKey`/`enqueueReports`), so a tap on
  Enter cannot overtake the characters committed just before it, and a rejected step no longer
  poisons the chain. Clipboard/rotate/pli are not in the input queue.
- **Tests.** `test-coredevice.js` covers the smart-punctuation fold, the new editing usages
  (Delete 0x4c, Home/End/PageUp/PageDown/Insert/NumpadEnter) and, with the fake's new
  `FAKE_SLOW_KEY_MS`, that the proxy posts the second report only after the first is answered and
  keeps key/touch order. `npm run test:ios-typing` (`scripts/e2e-ios-typing.js`) drives the real
  production overlay in Playwright against a fixture `proxy-coredevice` socket, phone (390px,
  touch) and desktop: focus on open, geometry (inside the viewport, no horizontal overflow, ≥44px
  controls, 16px field), live typing order for "Hi", Backspace from the empty field, ’ typed as ',
  é reported, Enter/→ buttons keeping focus, paste, no touch leakage from the sheet, Escape/Done
  dismissal and focus return to the FAB. Nothing reaches a phone.
- **Still unverified on hardware.** Whether iPhone Safari opens its keyboard on the overlay's
  programmatic `focus()` (it runs after a signal-triggered re-render, not synchronously in the
  tap handler; the same code path serves Android and has not been reported broken) and whether
  iOS hides its own on-screen keyboard once the virtual HID keyboard has been used in a session,
  which would make the overlay the only way to type until the session restarts. Both need a
  look from the user's phone.

### iOS device audio (2026-09-16)

- **What the phone gives us.** The CoreDevice display session negotiates a paired audio session
  (Xcode does the same; iOS throttles a lone video client). The phone pushes its system audio as
  RTP payload type 101, **AAC-ELD, 48 kHz stereo, one 480-sample frame every 10 ms**, ~380 bytes
  a frame while sound plays and a 4-byte frame while silent. It keeps sending while silent;
  serve-web answers the RTCP that keeps the session alive. `--no-audio` only changes the helper's
  own page default; the audio session runs regardless.
- **Why a patch.** serve-web's `/audio.bin` decodes with macOS AudioToolbox and answers 503 on
  any other host. `python/patches/pymobiledevice3-raw-audio.py` (run by `npm run setup:ios`,
  also `npm run patch:ios`, idempotent, pinned to the 11.12.5 source) makes the receive loop pass
  the undecoded access units through when the decoder cannot be created and adds an
  `X-Audio-Codec: pcm|aac-eld` response header. Unpatched, the browser's Sound button reports
  "helper is unpatched for audio" with the setup command; video is unaffected.
- **Decoding: three things ffmpeg taught us.** (1) ffmpeg's native `aac` decoder handles ELD,
  but **only with the AudioSpecificConfig as codec extradata**: the same frames fed through
  LOAS/LATM mis-parse (the LATM path reads the ELD config with a 2-bit `epConfig` the spec puts
  after the extension terminator; even with that fixed it output "invalid frame"). So
  `CoreDeviceAudioRelay` remuxes each frame into **fragmented MP4** (`audioInitSegment` with an
  `mp4a`/`esds` track plus `mvex`, then one `moof`+`mdat` per frame, `tfdt` in samples) on
  ffmpeg's stdin: `-fflags +nobuffer -flags low_delay -probesize 32 -analyzeduration 0
  -max_error_rate 1 -f mp4 -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1`. Output tracks input to
  within one frame (measured: 0.98 s of PCM after 1.0 s of frames). (2) **Apple's magic cookie
  `f8e64000` says 512-sample frames** (frameLengthFlag 0) although the stream is 480 samples a
  frame; pymobiledevice3 pins AudioToolbox to 480 for the same reason. With the cookie as-is
  ffmpeg reports "invalid band type" on most frames and decodes 1 s of a 12 s capture; with bit 19
  set (`f8e65000`) it decodes every frame, the 4-byte silence frames included. (3) Real frames
  were needed to see any of this: silence-only captures fail in ways that look like container
  bugs. `scripts/fixtures/iphone-aac-eld.bin` is 2 s (200 frames) of real device audio in the
  `/audio.bin` framing for exactly that reason.
- **Server.** `CoreDeviceRunner.audio(udid)` creates one `CoreDeviceAudioRelay` per ready
  session (stopped with the session; `IOS_AUDIO=0` disables). The relay opens `/audio.bin`,
  decodes once (or passes PCM through on a macOS host), cuts the PCM into 20 ms
  `scrcpy_audio_2` raw packets with sample-count timestamps, and fans them out; a subscriber
  gets the current metadata packet immediately (pending -> ready/disabled/error). `CoreDeviceProxy`
  subscribes after `/stream.bin` is attached and forwards each packet as a binary
  `[3][packet]` message (`COREDEVICE_FRAME_AUDIO`), dropped under the same 4 MiB backpressure as
  video. `IOS_AUDIO_DECODER` swaps ffmpeg for another command reading the same fMP4 stdin
  (tests use `scripts/fixtures/fake-audio-decoder.js`). The decoder child is `unref`'d so a
  failed test or a shutdown never waits on it.
- **Browser.** `client/audioPacket.ts` now holds the envelope parser (extracted from
  `StreamReceiver`, which keeps its state logic). `CoreDeviceReceiver` routes type-3 frames to
  `audio`/`audioMetadata` events and exposes `getAudioMetadata`/`getAudioConfig`;
  `state/audio.ts` takes any `AudioSource` (Android `StreamReceiver` or iOS `CoreDeviceReceiver`)
  so the one `AudioPlayer` factory in `index.tsx` serves both. `StreamClientCoreDevice` creates the
  session and `ApplToolBox` shows the shared Sound button (`toolbox/soundButton.ts`, also used by
  `GoogToolBox`); with no Settings sheet on iOS, an unavailable state goes to the stream notice.
- **Tests** (`test-coredevice.js`): fMP4 box structure and the 480 config; relay packetisation,
  timestamps and late-viewer metadata with the stand-in decoder; the unpatched helper's 503 ->
  disabled with the setup hint; `IOS_AUDIO=0`; the receiver's audio routing and malformed-packet
  degradation; and, when ffmpeg is installed, **real decoding of the fixture** (asserts ≥ 1.2 s of
  PCM with RMS > 500). The fake helper serves the fixture on `/audio.bin` at 100 frames/s
  (`FAKE_AUDIO=unpatched` for the 503).
- **Hardware.** ffmpeg decoded a 12 s YouTube capture from the bench iPhone 13 Pro Max (iOS 27)
  offline, RMS 800-7500 per second, no decoder errors. Live playback through the proxy was
  attempted right after; the phone's display service was wedged at that point ("accepted the
  session but never started sending video", the state §9 documents; likely provoked by the
  extra standalone `start-audio-stream` sessions used for the captures), so end-to-end browser
  playback still needs a pass once the phone has been rebooted. Not yet known: whether iOS mutes
  the phone's own speaker while mirroring audio, whether DRM-protected apps deliver silence, and
  the end-to-end latency in a browser.
- **Static, and the volume slider (2026-09-16, after the owner heard it play).** Reported: audio
  plays with some static, at full volume. Measured at the proxy *and* directly on serve-web's
  `/audio.bin`: frames arrive 1 ms apart in bursts of ~4 with 75-85 ms pauses (p50 1 ms, p90 75,
  p99 81) -- the phone/tunnel delivers RTP in ~80 ms bursts; ffmpeg itself outputs one frame per
  10 ms when fed in real time. `AudioPlayer` schedules from the previous buffer's end with a
  40 ms target, so each burst period ran the queue dry and restarted near live: a gap every
  burst, heard as static. The player now takes an `AudioBufferProfile` (target/max seconds),
  `AudioSource.getAudioBufferProfile()` supplies it, and `CoreDeviceReceiver` asks for
  160 ms / 500 ms; Android keeps 40 / 200. `getStats().underruns` counts such restarts. Checked
  with a simulated 82 ms burst delivery in `test-audio-player.js`: the default underruns, the
  iOS profile does not. The 4-byte frames were also suspected and cleared: they form one
  contiguous run with continuous RTP sequence/timestamps and decode to silence next to silence.
  Volume: `AudioPlayer.setVolume/getVolume` (0..1, `localStorage` key `ws_scrcpy_audio_volume`,
  ramped with `setTargetAtTime` to avoid clicks, independent of mute; an unset key must not read
  as 0 -- `Number(null)` did, caught by the test). `toolbox/ToolBoxVolume.ts` +
  `createVolumeSlider()` put a full-width 44px slider under Sound in both toolboxes, hidden when
  sound is unsupported/disabled. Not verified by ear from here: whether 160 ms clears the static
  entirely on the owner's network; `underruns` in the stats is the number to look at if not.
- **Sheets redesign (2026-09-16).** The owner found the toolbar volume slider ugly on the desktop
  sidebar and asked for every setting's explanation to sit with its control. `ui/SheetControls.tsx`
  (+ `style/ui/SheetControls.css`) is now the one layout both Actions sheets use and Settings
  follows: `SheetGroup` (sentence-case title, optional hint, bordered card), `SheetRow` (title +
  description left, control right; `layout="stack"` puts wide controls under the text,
  `"pair"` does so for two-button rows below 480px), `SheetToggleRow` (the switch),
  `SheetStatus` (an outcome line inside the group that produced it), `VolumeSlider` and
  `SoundRows` (Listen/Mute with the player status as its description, then Volume). The toolbar
  slider (`ToolBoxVolume`, `createVolumeSlider`) is gone; volume lives in the iOS Actions sheet's
  Sound group and in Android Settings' Sound section next to Listen. Android Actions gained a
  "Sound and stream quality" row that opens Settings. The uppercase `.sheet-section-title` is no
  longer used by these sheets. Feedback is per group (`screenNote`/`lockNote`/`clipboardNote`
  on iOS; `pending` carries its kind so a rotate reply cannot land under the clipboard). The
  Type text overlay's keys are one non-wrapping four-column row with the feedback line above;
  the Device controls panel lost its own Close button (the FAB's × already closes it). Fixture
  runs after the change: `test:ios-typing`, `test:settings` (16 geometry states), `test:sheets`
  (5 layouts), `test:audio-availability` all pass; selectors the tests rely on
  (`.settings-audio [data-audio-state]`, `Reload page`, `.settings-sheet-row`, `.sheet-button`)
  were kept.

### iOS app switcher and screen/lock state (2026-09-16, verified on the iPhone 13 Pro Max / iOS 27)

- **Ask.** A toolbar button that opens the iOS app switcher, and Asleep/Locked detection like
  Android's. iOS has neither a switcher button nor a "lock state" API over USB, so both are
  assembled from what the phone does expose.
- **App switcher.** `CoreDeviceButton` gained the pseudo button `app-switcher`. `ApplToolBox`
  shows it with the OVERVIEW icon in the navigation row (Home, App switcher, Lock); Siri moved
  to the third row with a new MIC icon (`public/images/buttons/mic.svg`). It never reaches
  serve-web: `CoreDeviceProxy.openAppSwitcher()` does the home-indicator gesture on Face ID
  devices, or two Home presses 150 ms apart on Home-button models.
  `common/AppleModels.hasHomeButton(productType)` decides; `ControlCenter` now stores
  `productType` on the descriptor for that; `IOS_APP_SWITCHER=home|gesture` overrides. See the
  next entry for the gesture's shape and the state of its verification.
- **REMOVED (2026-09-16, after hardware testing).** The app switcher button is gone from
  `ApplToolBox`, `app-switcher` is gone from `CoreDeviceButton`/`COREDEVICE_BUTTONS`,
  `openAppSwitcher`/`appSwitcherMethod` and the `IOS_APP_SWITCHER*` knobs are gone from
  `CoreDeviceProxy`, and `common/AppleModels.ts` (the Home-button model table, which existed only
  to choose between the two methods) is deleted. **There is no way to open the app switcher on a
  Face ID phone from this path.** Ten gesture shapes and a Home double-press were tried against
  the bench iPhone with the frames read back; every one produced Home or was swallowed by the
  foreground app. The entries below record what was measured, and are kept as the evidence for
  why the feature is not coming back without a new mechanism.
- **The Home button, fixed in the same session.** `/button {"name":"home"}` was doing nothing at
  all, because serve-web's `press` holds the Consumer 0x0C/0x40 ("Menu") usage for **50 ms** and
  iOS 27 discards that as debounce noise. Measured on the iPhone 13 Pro Max: 50 ms fails, **100 ms
  works**, 150/200/300 ms all work (300 ms: 4/4 from inside an app). `CoreDeviceProxy` now sends
  its own `down` / hold / `up` pair for Home exactly as it already did for Lock, with
  `HOME_PRESS_MS = 250` for margin, released in a `finally` so a failure cannot leave the button
  stuck down. This is why Lock had a special case and Home did not -- the same root cause, found
  four months apart.
- **Do not replace Home with the edge gesture.** It looked like the obvious fix (a fast no-dwell
  edge swipe *does* go Home) but it is not dependable: it worked several times in one serve-web
  session and then failed **0/13** across four parameter sets in the next, with taps verified
  working throughout (a tap navigated Settings mid-run). The button at a 250 ms hold is
  deterministic; the gesture is not.
- **The gesture, and why the first shape of it did nothing (2026-09-16, still unverified).** The
  first version was reported as doing nothing at all on the bench phone. The plumbing was not at
  fault -- button → `pressButton('app-switcher','press')` → `queueInput` → `openAppSwitcher` →
  `/touch` is the same path a working finger-drag takes, and the running `dist/` matched source --
  so the shape of the touch stream is what was wrong, and it was wrong in ways a finger never is:
  the contact landed 14.5 pt above the bottom edge rather than on the home indicator, travelled at
  a constant 34 pt per sample (a flick, not a swipe easing to rest), reported at 40 Hz and then at
  **10 Hz** through the pause, and repeated a bit-identical coordinate while it paused. iOS tells
  the switcher from the Home swipe by the finger's velocity *at lift*, and a Home swipe from the
  Home screen is invisible -- which is exactly "nothing at all". It is now: contact at y=0xfe00
  (7 pt from the bottom), an ease-out `1-(1-t)²` over 320 ms to y=0x9000 (44% up, last five
  samples covering 17 pt), a 650 ms dwell that keeps reporting with a unit of jitter, then
  release. Samples are placed by the clock at `APP_SWITCHER_SAMPLE_MS` (16 ms ≈ 60 Hz), so a slow
  loopback widens the gaps rather than stretching the gesture. Every number is overridable as
  `IOS_APP_SWITCHER_{START_Y,END_Y,SWIPE_MS,HOLD_MS,SAMPLE_MS}` — what counts as a pause is the
  phone's judgement, so tune against the device rather than rebuilding. `openAppSwitcher` also
  lifts in a `finally` now: a `/touch` that never answers used to abandon the swipe with the
  contact still down, and every later touch dragged from wherever it died.
  **Tested on hardware and it does not work (2026-09-16, passcode removed, iOS 27).** Driven
  through one serve-web with the decoded frames read back as screenshots. An injected edge swipe
  has exactly two outcomes:
  - **Commits → Home.** Instantly, with no interactive transition: the app card never shrinks on
    the way, the next frame is just the Home screen. Verified repeatedly from Settings.
  - **Stops before lifting → the foreground app gets the whole stroke.** Settings scrolled and
    rubber-banded; SpringBoard never took it.

  The dwell that distinguishes the switcher from Home on real hardware is exactly what makes iOS
  hand the touch back to the app. Shapes tried, all landing on Home or on the app: dwell
  150/300/400/650 ms; ends at 44/56/62/69/75/80 % up; fast (200 ms) and slow (500 ms) travel;
  ease-out and linear; a pause that keeps drifting ~17 pt; overshoot to 80 % then pull back to
  50 %; a 200 ms pre-hold on the indicator before dragging. The control is decisive: the *same*
  stroke (0xfe00→0x3333, 250 ms) goes Home with no dwell and is swallowed by the app with a
  400 ms dwell. Since the card never shrinks even mid-drag, SpringBoard is not tracking these
  touches live at all, which is why the switcher's interactive state is unreachable.
  **Open question, not a solved one.** The knobs are kept for a future sweep. Note the side
  effect: on a scrollable screen the failed gesture scrolls the app.
- **Two more things the same hardware session established (2026-09-16).**
  - **The `home` button does nothing on a Face ID phone.** `/button {"name":"home"}` is Consumer
    usage 0x0C/0x40 ("Menu") held 50 ms by serve-web, and on iOS 27 / iPhone14,3 it has no effect
    at all: controlled before/after frames show Settings > Battery unchanged across the press. So
    `ApplToolBox`'s **Home button is broken too**, independently of the switcher. The Home
    *gesture* does work (a fast edge swipe up, no dwell), so routing Home through
    `openAppSwitcher`-style touch injection instead of `/button` is the available fix.
  - **The HID auth gate is real and easy to trip.** serve-web opens its HID surfaces lazily on the
    first input POST, and if that happens while the screen is blanked, the **touchscreen** stays
    unauthenticated for the life of the process while **buttons keep working** (Indigo is a
    separate service) -- so a `lock` press wakes the phone but no touch ever lands. The cure needs
    no new process: `POST /restart` restarts the video stream, which calls `_stop_hid()`, and the
    next `/touch` reopens the surfaces against the live stream. Confirmed: touches dead before the
    restart, unlocking the phone immediately after.
  - **The video frame is padded.** `get-display-info` reports 1284x2778 while the encoded frame is
    1296x2816, so image coordinates are ~1.4 % short of digitizer coordinates vertically. Big
    targets tolerate it; anything edge-critical should not assume frame fraction == digitizer
    fraction.
- **What was tried for lock state, and failed.** CoreDevice's
  `com.apple.coredevice.feature.getlockstate` (`developer core-device get-lockstate`) answers
  "Action ... is not implemented" on iOS 27. `notification observe` relays
  `com.apple.springboard.hasBlankedScreen` (seen on every blank and wake) and is expected to
  relay `lockstate`/`lockcomplete`, but a notification carries no payload, so it says *that*
  something changed, not *what*. The AX audit daemon's `deviceElement:valueForAttribute:` returned
  null for every attribute name guessed, `deviceFetchElementAtNormalizedDeviceCoordinate:`
  wants an NSValue CGPoint that DTX cannot encode from Python, `deviceRunningApplications`
  returned `[]`. `hostAppStateChanged:` events only show the lock-screen poster extension
  going foreground on wake.
- **What works: `DeviceStateMonitor`** (`server/appl-device/services/DeviceStateMonitor.ts`).
  - Screen: `diagnostics ioregistry --ioclass AppleARMBacklight` over lockdown (no tunnel,
    ~0.6 s). `IODisplayParameters.brightness.value` is 1 awake in a dark room and **0 while
    blanked** (the only key that flips besides the framebuffer losing its timing elements).
  - Lock: `developer accessibility list-items --userspace` (~1.5 s incl. tunnel) walks the
    focusable elements; the lock screen has a padlock captioned **"Locked"** or "Unlocked", the
    keypad **"Enter Passcode"**. Works with the screen off too (it reports the lock screen
    underneath). English captions only; `IOS_LOCKED_CAPTIONS` extends them and the phone's
    `Language` (lockdown `com.apple.international`) makes an unmatched non-English screen read
    'unknown' rather than unlocked. The unlocked reading is by absence of those captions and was
    **not observed** (no passcode to hand); "Unlocked" (Face ID recognised, not swiped) is
    handled but likewise unobserved.
  - Triggers: one long-lived `notification observe hasBlankedScreen lockstate lockcomplete`
    per device (respawned with backoff), 400 ms debounce; `pokeButton` after Lock/Home/switcher
    presses and `pokeInput` after a key release or touch release while locked/dark (so a
    passcode typed through the stream is followed by a re-read without polling on every tap of
    an unlocked phone); screen poll 15 s idle / 4 s while a session is active, lock re-read every
    60 s while active.
  - Live run against the phone (`scratch monitor-live.js`): initial state 1.8 s after watch;
    `screen.power: off` 2.6 s after a Lock tap; `on` 2.3 s after the wake tap; `device.locked:
    true` throughout, as it was.
- **Descriptor and UI.** `ApplDeviceDescriptor` gained `productType`, `'screen.power'` and
  `'device.locked'` (Android's names, so `deviceStatus.ts` derives Asleep/Locked the same way;
  Streaming still wins over Asleep like Android). `SleepOverlay` is platform-neutral now
  (`sessionKey`, `screenOff`, `onWake`); `StreamView` passes the WAKEUP key, `CoreDeviceStreamView`
  a Lock tap, and also renders `LockScreenNotice` whose Unlock opens the Actions sheet (its
  "Lock screen" group has the passcode field). The iOS device card shows the asleep banner (no
  Wake button: HID needs a running screen session). The Actions sheet's Troubleshooting facts
  list Screen and Lock. `GET_LOCK_STATE` is answered for iOS too (current state + a refresh).
- **serve-web behaviour worth knowing.** With the screen blanked it emits **no access units at
  all** (0 in 15 s; ~20 fps on a static lock screen otherwise) and its stall watchdog restarts
  the stream up to 3 times, then stops; after 70 s dark the picture resumed ~3 s after waking
  without any client action. It also holds an IOPMAssertion so auto-lock does not fire during
  a session -- the phone only sleeps when someone presses Lock.
- **Tests** (`test-coredevice.js`, 32 pass): the Home-button table; backlight/caption parsing
  incl. foreign captions and `IOS_LOCKED_CAPTIONS`; the monitor end to end against the fake CLI
  (initial probe, notification-triggered re-probe, refresh, unwatch kills the observer, the
  `IOS_STATE_PROBE=0` / `IOS_LOCK_PROBE=0` switches); the gesture's touch sequence and the Home
  double press through the proxy. The fake gained `diagnostics ioregistry`, `accessibility
  list-items` (FAKE_LOCK scenes), `lockdown get` and a long-lived `notification observe`.

### The lock probe's green highlight boxes (2026-09-16, follow-up)

The owner reported the phone "putting a green box around stuff" once lock detection shipped. That
is the accessibility inspector's on-device overlay: `pymobiledevice3 developer accessibility
list-items` walks the screen by moving the inspector's focus (`deviceInspectorMoveWithOptions:`),
and it never turns the overlay off, so each visited element is highlighted. It also enables
foreground-app monitoring, which attaches the daemon to whatever app is open. At a 60 s poll while
streaming, that is a light show on a phone somebody is using.

Fixed in two directions:

- **A quieter probe.** `python/probes/lockstate.py` replaces the CLI call. It sends
  `deviceInspectorShowVisuals: 0` and `deviceEnableHighlight: 0` before the first focus move,
  never calls `deviceSetAppMonitoringEnabled:` (verified on iOS 27 that focus events still
  arrive without it -- the walk returned `{"captions": ["Locked"]}` in one move), and stops at
  the first decisive caption instead of walking the whole screen. 1.3 s per probe against the
  bench phone, versus ~1.5 s and a full walk before. It prints one JSON line
  (`{"locked", "captions", "monitored"}`) and degrades to `locked: null` rather than failing.
  It uses a few private members of `AccessibilityAudit` (pinned to 11.12.5, like
  `python/patches/`), because the public `iter_elements()` is the thing whose side effects are
  the problem. `PyMobileDevice.probeCommand()/runProbeJson()` resolve and run it (venv python
  next to the resolved CLI, else `python3`); `IOS_PROBE_CMD`/`IOS_PROBE_ARGS` are the test seam,
  and the fake CLI answers `lockstate` in the script's place.
- **Far less probing.** The 60 s lock timer is gone. `shouldProbeLock()` skips the probe whenever
  the phone is awake and known unlocked, so during normal use of an unlocked phone the only lock
  probes left are real SpringBoard lock transitions, the screen blanking or lighting up, input
  sent while locked or dark, and an explicit refresh (the Unlock button, `GET_LOCK_STATE`). A
  phone that locks does so by blanking its screen, which the notification observer already
  catches, so nothing is missed by the guard.

**Not verified visually, and why.** Reproducing the highlight from here was not possible: the
bench phone stayed locked (passcode unknown) and the inspector appears to draw nothing on a lock
screen, so probing with the overlay deliberately *enabled* produced no visible change either.
`developer dvt screenshot` does not capture that layer at all (0 green pixels with the overlay on),
and the browser check was measuring nothing, because headless Chrome has no HEVC decoder and never
rendered a canvas. So the fix rests on the documented meaning of `deviceInspectorShowVisuals:`
("Toggle the on-device visual overlay highlighting inspected elements") plus the cadence cut.
If boxes still appear, `IOS_LOCK_PROBE=0` disables the lock half outright.

Tests added: the monitor uses `lockstate` and never `list-items`; no lock probe fires while awake
and unlocked though the screen keeps being polled, while an explicit refresh and input on a locked
phone still probe; a failing probe reports the lock as unknown and leaves the screen reading alone.

### `npm run dev` never restarted the server on a rebuild (2026-09-16)

Twice in one session a change looked "not applied": the first time because `dist/` had not been
rebuilt at all, the second because dev mode rebuilt `dist/index.js` but kept running the previous
process for another fifteen minutes. The cause is `nodemon.json` at the repo root, which belongs
to a different workflow (`watch: [src]`, `ext: "ts,css"`, `exec: npm start`). The dev script
overrode `--watch`, `--ignore` and `--exec` on the command line but not `ext`, so nodemon reported
`watching extensions: ts,css` and a rebuilt `dist/index.js` matched nothing it watched. Server-side
edits therefore compiled and were silently ignored, which is indistinguishable from "the feature
does not work".

Fixed with `nodemon.dev.json` (watch `dist`, `ext: js,json`, ignore the maps and the client
bundle) and `--config nodemon.dev.json` in the dev script. `--config` replaces the local
`nodemon.json` outright rather than merging with it (`lib/config/load.js`:
`options.configFile || path.join(dir, 'nodemon.json')`), so dev runs are now isolated from that
file. Verified: `watching extensions: js,json`, and a real source edit produces a new server pid
whose start time matches the new `dist/index.js`.

Two measurement traps worth remembering, both of which produced wrong conclusions here before
being caught: `pgrep -f "node --enable-source-maps dist/index.js"` also matches nodemon itself
(its `--exec` argument contains that string) and the `sh -c` wrappers, so comparing "the pid"
across restarts shows a pid that never changes -- compare `/proc/<pid>/cmdline` exactly instead.
And a comment-only source edit can leave the emitted bundle byte-identical, in which case webpack
skips the write (`output.compareBeforeEmit`) and nodemon is right not to restart; test restart
behaviour with a change that actually alters the output.

### The clipboard's real fault: `dtpasteboardd`, not serve-web (2026-09-16, verified on the iPhone 13 Pro Max / iOS 27)

Reported again as "reading from the phone's clipboard is still unreliable". Everything this file
previously said about that was wrong, so start by discarding it: serve-web was never the problem,
its per-request pasteboard channel was never the problem, and *Restart session* -- the cure the
error text recommended -- cannot fix it.

**What was measured.** A brand-new session, the first read ever made through it, failed twelve
times out of twelve while video ran at ~60 fps. Going under serve-web entirely (own tunnel, own
`PasteboardService`) the connect took 9 ms and the PULL never came back. Watching raw HTTP/2
frames: after a well-formed PULL the phone sends **nothing at all** for 12 s, while a deliberately
malformed one is refused in **6 ms** on the same channel. So the channel, the tunnel and the
request shape were all fine and the device simply never answered.

The phone's own log named the process: `dtpasteboardd` (`/System/Developer/usr/libexec/`, the
Developer-Disk-Image daemon behind `com.apple.coredevice.pasteboardservice`) logs `Pasteboard peer
connected`, then `Received command: <private>`, then nothing until the client gives up. It never
even reaches `pasted`, the system pasteboard daemon.

**What was ruled out, each on hardware:** serve-web's age and a fresh serve-web; the screen session
entirely; lock and sleep state (failed asleep, awake and unlocked alike); the pasteboard's
contents, including a freshly typed local item copied on the phone itself with Cmd+C; `pasted`,
which was killed and came back with the clipboard intact and still nothing worked; the data
inclusion policy (`allResolved`, `allPromised`, `matchSource`, `promiseSecondary` all hang
identically); iCloud (the phone is signed out, so no Universal Clipboard); and a "Paste" consent
prompt (a screenshot taken mid-read shows no alert). The phone's own copy/paste kept working the
whole time -- Cmd+C then Cmd+V in Spotlight round-trips text while every read over USB hangs.

**The cure is to kill the daemon.** `send-signal-to-process <pid> 9`; launchd starts a new one on
the next connection and it answers in ~40 ms with the clipboard's contents intact (they live in
`pasted`). After that: 20 reads out of 20 at a p50 of 36 ms, writes of unicode and 2 KB strings
round-tripping, and no failures.

`python/probes/pasteboard_restart.py` does exactly that in 0.8 s, and `CoreDeviceProxy` runs it
when a clipboard request fails, then asks the phone once more. Both faces of the failure trigger
it: the request hanging (the wedge above) and serve-web answering `500 clipboard error:` with an
empty message, which is what it reports when the daemon is not answering its socket. A 1.2 s
settle before the retry is not optional -- retrying immediately after the kill fails the same way,
because launchd has not finished starting the replacement. Verified end to end against the phone:
with the daemon stopped mid-session, the viewer's read returned the right text after 5.0 s with no
error shown, a new daemon pid in place, and the next read at 56 ms.

**What still is not known: what wedges it in the first place.** Deliberately abandoning a request
mid-flight, two concurrent reads, writes (including unicode and 2 KB), a client dying with no FIN
at four different moments, and bare connect/close cycles were all tried against a healthy daemon
and none of them wedged it. Since the recovery is automatic and costs ~10 s once, this is now a
latency problem rather than a broken feature; if it needs chasing further, a `sysdiagnose` taken
while the daemon is stuck would show where its handler is blocked.

**Timeouts worth keeping straight.** A warm read is 20-100 ms, but the first read after the daemon
has to be launched was measured at 3.9 s, so the 8 s bound before declaring a wedge is deliberate:
under it, a merely slow phone would have its daemon killed out from under a request that was going
to succeed. The browser side waits 25 s (past the server's worst case of ~18 s) and says what is
happening at 9 s instead of leaving "Reading…" on screen in silence.

**Note for testing.** `pymobiledevice3 developer core-device screen-capture screenshot --userspace
<file>` takes a real PNG screenshot over USB with no display session at all -- much easier than
decoding `/stream.bin`, and it does not touch the display service that the burst-of-sessions wedge
(§9) affects. `syslog live` and `send-signal-to-process` are the other two tools that cracked this.
