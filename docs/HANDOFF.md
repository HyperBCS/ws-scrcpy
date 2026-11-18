# ws-scrcpy fork — handoff

Sections 1–6 describe the current implementation on `redesign`, updated 2026-11-13.
Sections 7 and 9 preserve dated observations, old UI names, checks and reasons. Their
"not deployed", pending-work and command descriptions apply to their own date; they
are not current instructions. Use the current brief and sections below before acting.
The [step 6c record](#redesign-step-6c-current-documentation-2026-11-13) identifies the
latest confirmed deployment and its limits. [README](../README.md) covers operation,
all server environment names and storage. The owner alone merges and pushes upstream.

---

## 1. What this is

One owner's app for viewing and controlling their Android phones and iPhones, with an
iPhone notification inbox and Web Push relay. A phone browser, the installed web app and
a desktop browser count equally. The root page is **Phones**. Android has Screen, Files
and Shell; iPhone has Screen only. Settings is one sheet available from cards and screens.
The branch is `redesign`; upstream ws-scrcpy instructions do not describe this app.

This fork runs the stock **scrcpy 4.1** server, without the older WebSocket patch.
`src/common/Broadcast.ts` parses its streams and fans them out to browser viewers.
`WebsocketProxy` synthesises `scrcpy_initial` for the client. There is no phone control
message that changes quality in place: changing Android capture settings restarts the
shared scrcpy process when watched. An unwatched change saves without starting it.

The iPhone uses CoreDevice through the pinned/patched pymobiledevice3 helper. It requires
iOS 27 screen/input services, USB trust, Developer Mode and a Developer Disk Image.
Nothing is signed or installed on the phone. HEVC decoding is the browser's job; a ready
session and a usable picture are separate states. No picture still allows commands and
Type text, while new contacts require a usable picture.

## 2. Architecture

```text
Android phone -> host adb daemon -> loopback TCP forward -> Broadcast
  stock scrcpy 4.1 localabstract socket                   -> WebsocketProxy
                                                         -> browser StreamReceiver

 iPhone -> host usbmuxd -> pymobiledevice3 serve-web on loopback HTTP
                       -> CoreDeviceProxy -> browser CoreDeviceReceiver -> HEVC player
```

Node opens TCP connections to `127.0.0.1:<forwarded port>`, not Unix sockets. The adb
forward reaches scrcpy's localabstract socket on Android. Video, optional audio and
control use separate connections through that one forward, in that order. Host
networking in Compose keeps the app in the host adb forward's network namespace.

### Server (`src/server/`)

| Path | Role |
| --- | --- |
| `Settings.ts`, `Config.ts`, `EnvName.ts`, `dataDir.ts` | Frozen startup settings, safe parsing/validation/reporting, run config and canonical data directory with legacy alias |
| `goog-device/Device.ts` | Thin phone facade: descriptor, events and update throttle |
| `goog-device/AdbShell.ts` | Configured adbkit shell/Files reads and uploads, cancellation and timeouts |
| `goog-device/DeviceStatePoller.ts` | One due-time scheduler for info, runtime, lock and PID; rejects stale results |
| `goog-device/ScrcpySession.ts` | Viewers, 30 s grace, serial start/stop/settings queue and per-launch resources |
| `goog-device/AdbUtils.ts`, `ScrcpyServer.ts`, `adb/index.ts` | Forward leases, completed jar uploads, own-scid process handling and owned adbkit connections |
| `goog-device/StreamConfig.ts`, `ScrcpyInstance.ts`, `LockState.ts` | Stored stream values, per-port scrcpy identity and lock diagnostics |
| `goog-device/services/ControlCenter.ts` | adb tracking and command dispatch |
| `goog-device/mw/WebsocketProxyOverAdb.ts` | Starts/reuses scrcpy for a viewer and releases that viewer |
| `goog-device/mw/FileListing.ts`, `filePush/HttpDownload.ts` | Files channel and streamed HTTP downloads |
| `mw/WebsocketProxy.ts` | scrcpy bootstrap, packet fanout and per-viewer held-input/UHID cleanup |
| `appl-device/services/PyMobileDevice.ts` | Resolves the patched venv/PATH CLI, probes and filtered child environments |
| `appl-device/services/CoreDeviceRunner.ts` | One helper per iPhone, readiness, holds, 15 s grace and orderly shutdown |
| `appl-device/services/StartBudget.ts` | Persistent per-phone display-start limit |
| `appl-device/services/ControlCenter.ts` | USB tracking, phone info and Developer Mode |
| `appl-device/services/IosSettingsStore.ts`, `UnlockScheduler.ts`, `UnlockDriver.ts` | Encrypted passcode store, twice-daily schedule and guarded unlock sequence |
| `appl-device/mw/CoreDeviceProxy.ts` | Helper framing and JSON input/clipboard commands over loopback HTTP |
| `notifications/NotificationService.ts` | Domain state and notification coordination |
| `notifications/CollectorProcess.ts` | Collector process, bounded line framing, writes, generation checks and restart backoff |
| `notifications/NotificationRoutes.ts`, `NotificationSchema.ts` | 18 ordered notification routes and request validation |
| `notifications/NotificationFeed.ts`, `NotificationStorage.ts`, `PushDelivery.ts` | Feed/filter/counts, private persistence and push delivery |
| `requestOrigin.ts`, `mw/RemoteWebsocketProxy.ts` | Host/Origin/CSP checks and configured remote proxy boundary |

The Android diagnostic and stream shell paths use adbkit, rather than spawning the adb
CLI. RemoteShell still uses the adb executable for the interactive terminal. The host
adb server must already answer; this app must not start another daemon or server.

### Shared (`src/common/`)

- `Broadcast.ts` parses video/audio separately, caches a bounded decodable video sequence
  and audio config/metadata, and reads phone messages from control. Audio errors leave
  video/control running. Session packets update the picture size mid-stream (section 3).
- `BroadcastManager.ts` owns the ordered TCP connections and exact Broadcast identity.
  Startup cancellation closes pending connections without affecting a replacement.
- `Constants.ts` holds `SERVER_VERSION`, defaults and `buildScrcpyArgs()`.
- `AudioProtocol.ts` defines the common browser audio envelope and capture profile.
- `CoreDeviceProtocol.ts` defines the iPhone browser framing and command types.

### Client (`src/app/`)

Preact and signals draw the UI. Stream clients and players retain their own transport
and decoder lifetimes. Do not rewrite those lifetimes to restyle the page.

| Path | Role |
| --- | --- |
| `state/router.ts`, `state/routes.ts`, `ui/overlayHistory.ts` | Route/history ownership, old-link conversion and Back closing overlays |
| `state/phoneStatus.ts`, `copy.ts`, `state/capabilities.ts` | One phone-status model, its words and platform capabilities |
| `views/DevicePage.tsx`, `ScreenView.tsx`, `screen/android.tsx`, `screen/iphone.tsx` | Tab hosting, one screen layout and per-platform stream effects |
| `views/PhoneHeader.tsx` | Shared Screen/Files/Shell header; tool connection stays in the tab strip |
| `controls/` | Data-defined controls, held buttons, mouse rail and touch panel |
| `views/SettingsSheet.tsx`, `views/settings/` | One sheet and its ordered sections |
| `views/actions/PhoneActionsSheet.tsx` | Shared Actions groups; platform wrappers supply adapters |
| `views/UnlockSheet.tsx`, `state/unlockDevice.ts` | Shared Unlock flow with platform adapters |
| `views/LiveTextOverlay.tsx` | Modeless live text/paste/IME field and typing lifecycle |
| `state/keyboardCapture.ts`, `ui/KeyboardChip.tsx` | One capture target, reserved chords and guarded clipboard work |
| `googDevice/client/StreamClientScrcpy.ts`, `applDevice/client/StreamClientCoreDevice.ts` | Android and iPhone stream lifetimes |
| `client/audioPacket.ts`, `input/pointMapper.ts`, `input/mouseContract.ts` | Shared audio framing and picture input contract |
| `googDevice/client/FileListingClient.ts`, `googDevice/files/` | Kept Files view and extracted service/render helpers |
| `googDevice/client/ShellClient.ts`, `views/shell/` | Terminal and touch extra-key row |
| `views/NotificationsView.tsx`, `NotificationHistory.tsx`, `views/notifications/` | Inbox, combined/source scope and Setup |
| `ui/`, `src/style/kit/`, `src/style/tokens.css` | Shared kit, role tokens, motion, sheets and focus rules |

Production builds exclude the kit demo route. Dedicated browser-fixture builds put demo
assets in runner-owned temporary directories, outside dist. Normal requests to
`#!action=kit` show Phones and start no stream.

---

## 3. scrcpy 4.1 protocol

The vendored jar is **scrcpy v4.1** (`vendor/Genymobile/scrcpy/scrcpy-server.jar`,
`SERVER_VERSION = '4.1'`). Upgrading from 3.1 required two breaking changes. If you ever bump the
version again, **re-verify both**.

The framing below follows Broadcast and the control-message writers. The table's
"works" entries retain earlier observations; they are not fresh hardware checks of the
redesign. Current deployment limits are in section 6 and the dated step 6c record.

### Video stream header: codec id, then session packets

```
3.1:  codecId(4)  width(4)   height(4)
4.x:  codecId(4)  then 12-byte packets: session packets and media packets
session packet:  flags(4, bit 31 set)  width(4)  height(4)      no payload
media packet:    pts+flags(8)          size(4)   payload(size)
```

scrcpy 4.0 moved the size out of the header into a **session packet** (Genymobile/scrcpy#6159,
`doc/develop.md`). One is sent before the first frame and another every time the capture session
changes: on rotation, when a landscape video goes full screen, and after `RESET_VIDEO`. It is told
apart from a media packet by the top bit of its first byte.

An earlier note here described a fixed 16-byte header with a `meta` field. That was the codec id
plus the first session packet. It parsed the start correctly and then read every later session
packet as a frame header whose size was the new height, which lost framing and restarted the
stream on each rotation (2026-11-10 review, C-server-core-2).

`Broadcast.processFrames` now handles a session packet anywhere in the stream: it updates the
size, drops the cached config and pictures of the old session, and notifies listeners with the
kind `session`. `WebsocketProxy` answers that by sending the viewer a new `scrcpy_initial`, which
is the only place the client takes the picture size from. The new session's config packet and
keyframe follow. `whenReady()` resolves on the first session packet, not on the codec id.

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

Fixing only the header leaves config packets (SPS/PPS) unrecognised. `lastConfigframe` stays
null, so newly attached clients receive no decoder configuration and show a black screen
without an error. Verify the flag positions against `app/src/demuxer.c` in the scrcpy repo.

### Control messages (client → device)

Type numbering is **unchanged** from 3.x (new types appended at 18+). Verified formats:

| Type | Name | Wire format | Status |
| --- | --- | --- | --- |
| 0 | INJECT_KEYCODE | type, action, keycode(4), repeat(4), meta(4) | works |
| 1 | INJECT_TEXT | type, len(u32), utf8 | works |
| 2 | INJECT_TOUCH | type, action, pointerId(8), x(4), y(4), w(2), h(2), pressure(2), actionButton(4), buttons(4) = 32B | works |
| 3 | INJECT_SCROLL | type, x(4), y(4), w(2), h(2), hscroll(2), vscroll(2), buttons(4) = 21B | scroll values are notches / 16 as i16 fixed point (the server multiplies by 16); not checked on a device since that fix |
| 5/6/7 | EXPAND/COLLAPSE PANELS | type only (1 byte) | works |
| 8 | GET_CLIPBOARD | type, **copyKey(1)** | works |
| 9 | SET_CLIPBOARD | type, **sequence(u64)**, paste(1), len(u32), text | works |
| 10 | SET_DISPLAY_POWER | type, on(1) | no effect on MIUI |
| 11 | ROTATE_DEVICE | type only | no effect on MIUI |
| 12 | UHID_CREATE | type, id(2), vendorId(2), productId(2), nameLen(1), name, descLen(2), desc | works |
| 13 | UHID_INPUT | type, id(2), size(2), data | works |
| 14 | UHID_DESTROY | type, id(2) | works; scoped to the closing viewer |
| 17 | RESET_VIDEO | type only | restarts the encoder for every viewer; sent for decoder recovery, not checked on a device |

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

Audio has a **4-byte codec header** like video, but no session packets. The codec IDs are `0x00726177`
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

## 4. Rules for current work

Read the current external brief and repository AGENTS.md before commands. They control
what may be tested or deployed. Dated examples below do not authorise hardware actions.

1. **Keep one mount per screen open.** ScreenView's mount node and each adapter's effect
   must not move or gain a new key. Sheets, notices, headers and resizing must retain the
   same element and stream socket. A second iPhone mount can start another phone session.
2. **Protect the iPhone.** No failed-start retry or burst of short sessions. Never
   `kill -9` or `pkill -f`; signal only owned PIDs with SIGTERM and await shutdown.
   A real screen visit requires the current deploy procedure and one owner of the phone.
   Tests use the fake helper. An unlock needs the owner's permission. A command answering
   password protected means stop and tell the owner; do not try more phone commands.
3. **Protect the live server.** A restart/build follows the deploy brief with a rollback
   tag first, outside the scheduled-unlock exclusion window, with no helper running.
   Never save live settings during checks or copy live data out. Never print passcodes,
   settings ciphertext or key files. No second Android-enabled server.
4. **Preserve resource ownership.** ScrcpySession serialises start/stop/settings work;
   old callbacks cannot act on a successor. Each launch owns its shell, forward lease,
   Broadcast and deadline. Uncertain/lost-ACK forwards are left alone. The phone-side
   jar is pushed before launching; MIUI may clear its temporary location.
5. **Preserve input isolation.** `localKeyboardTarget.ts` must match
   `dialog.kit-sheet[open]`, including docked and modeless sheets, rather than only
   `:modal`. Do not replay input from an outage. Release held contacts/keys on departure.
6. **Keep the two reconnect policies.** Android retries all closes except owner Stop
   4012 and stop(), at 1 s × 1.5^n capped at 8 s, reset by scrcpy_initial. iPhone uses
   1 s × 2^n capped at 60 s, stops on 4011 or three failed-start 4009 closes, and does not
   count 4010 as a start failure. Codec/Retry resets its delay/count. These are deliberate.
7. **Use the kit and shared facts.** Build with src/app/ui, style/kit and tokens. Status
   comes from phoneStatus.ts, words from copy.ts and platform rows from capabilities.ts.
   The phone and desktop layouts need equal care. UI text says phone.
8. **Keep the work bounded.** No push or dependency install/change. Workers use assigned
   worktrees; one main writer and one build/Node/browser reservation at a time. The
   tracked build override is exactly `{}` plus newline and must be restored after builds.

## 5. Current behavior and reasons

**Navigation and list.** The router owns history. List-to-phone opens a visit; tabs,
phone switching and inbox filters replace it. Back closes the top overlay, then leaves
the phone page. Files/Shell keep their local view on tab changes; leaving Screen stops
its browser stream immediately. Cards keep last reported status during a reconnect,
with unavailable phone actions disabled. Stale entries expire after 30 s unless updated;
fresh individual reports remain. With multiple servers, only the affected group warns.
Switcher stale rows keep their status and Viewing marker and say Reconnecting….

**Android service.** Attachment starts nothing. First viewer starts/reuses scrcpy;
last departure keeps 30 s grace. A return within grace reuses it. Owner Stop closes
viewers with 4012 and they wait for Start again. Instance scid limits process ownership.
Watched settings changes restart through the same queue; unwatched changes start no
stream. Wake on an idle card also starts no stream. Connected means the scrcpy handshake
completed, rather than only a WebSocket open.

**iPhone service.** A ready helper is held for viewers and unlock work, with 15 s viewer
grace. The three-start/five-minute budget persists across server restarts. A failed
session holds off new starts for 30 s. Keep the patches and orderly stop budget. HEVC picture failure does not erase
session readiness or disable commands/Type text; new touches remain blocked without a
picture. This difference is why No picture is a valid header in headless checks.

**Header and controls.** PhoneHeader draws identity, service/status, bell and Switch on
Screen, Files and Shell. Only Screen owns the fine-pointer keyboard chip; tools retain
local keyboard targets and their connection in the tab strip. A data definition supplies
ControlRail/ControlPanel, without toolbox classes or label matching. Mouse rail follows
the picture at every width. Touch controls use an edge tab, stored per browser and half
opaque while idle. Successful migration removes the old position key after writing the
new one; blocked storage does not discard the remembered place.

**Sheets and focus.** One Settings sheet is mounted in App and opens for either platform
from a card or screen. Stream, Sound, Keyboard, Unlock, About and troubleshooting stay
in that order; iPhone omits Stream. Disabled rows explain their requirement. From 1024 px
Actions, Settings and Type text dock beside a mounted ScreenView. From the list or tool
pages Settings is a centred dialog. Docked panels slide horizontally; picture and rail
stay clear even though the stage deliberately contains the dock host. Actions/Settings
remain modal. Type text is modeless, sends each committed text/paste once and keeps the
picture active to choose another phone field. Closed retained panels may be inert; the
open Type text input/stage must not be. Sheet gives children a component boundary without
another DOM box; confirmation labels use stable IDs across render roots.

**Settings apply at once.** StreamConfigSession sends only changed values and shows the
result by the group. Quality arrows/Home/End move focus without applying; Enter/Space
applies once, pointer choice immediately. A watched capture change restarts all viewers;
a screen reporting other viewers asks first. No Apply bar remains. The sheet stays open
while applying. AutoHeight returns to natural layout after motion rather than keeping a
stale measured gap. Audio/source/format are Android capture settings; Listen and volume
are this browser's playback choices.

**Keyboard and clipboard.** Capture defaults on. One KeyboardCapture owns preference,
actual target, deferred modifiers and cancellation. The fine-pointer chip shows phone
or this page; focusing a local control/sheet keeps the capture preference but directs keys
locally. Chip and Settings > Keyboard change the same state. Ctrl+Alt+K releases or
recaptures (Ctrl+Option+K on Mac); Ctrl+Alt plus S/H/B/O/T/P/C means Switch/Home/Back/
Overview/Type text/Screenshot/Copy from phone, omitting Back/Overview on iPhone. Chords
send no modifiers to the phone. Ctrl/Cmd+K opens Switch after release when unconsumed.
Native Ctrl/Cmd+V while captured pastes through Android clipboard-and-paste or iPhone
clipboard-write acknowledgment followed by Cmd+V. Local fields keep native paste.
Clipboard work is limited, rejects overlap and is cancelled on target change/drop.
Keyboard capture respects every open dialog.kit-sheet, including Type text and docks.
Android UHID is attached on physical input; touch/local controls let it go so the phone
keyboard can return. iPhone Type text ends its temporary keyboard after pending text.

**Input.** Both use the same point mapper. A drag starts on the picture and continues
clamped to its edge; blur/page departure lifts held input. Android wheel scrolls and
right-click is Back; iPhone wheel is a short swipe and right-click does nothing.
Ctrl+drag pinches around the picture centre; Shift+Ctrl uses the pressed point. Physical
input, Mac Ctrl+drag and actual picture alignment remain subject to hardware limits.

**Audio.** USE_AUDIO and Android capture default on, raw 48 kHz stereo PCM, output source;
Opus is optional. Each browser begins muted and Listen needs a user gesture. iPhone sends
AAC-ELD, decoded with ffmpeg to the same PCM browser path. No browser microphone uplink.
Capture failures leave desired settings intact and video/control usable; a fatal Android
audio-start error can fall back to video-only on reconnect. Sound source support and call
audibility depend on phone restrictions. Tests do not prove real audible playback.

**Notifications.** Unscoped inbox combines linked iPhones; old/source push links stay
scoped. Switch, Search and Setup share the header. Inbox/Unread have counts, Archive is
alongside them and Mark all read is direct. Cards have day groups, conversation stacks,
mouse quick actions/menu and touch swipes/Undo. Expand/click or opening the phone marks
one read; an expanded unread item stays until collapsed. Bulk archive snapshots keys per
source and can undo partial success. Clear all on iPhone needs a chosen source and a
frozen confirmation set; an accepted command is not a phone result. Setup changes apply
at once. Apps is a mute list; old allow-lists keep working as Only these apps. New muted
notifications are dropped before storage/push; history stays and Undo cannot recover a
dropped event. NotificationFeed is the single filtering policy; CollectorProcess owns
supervision and line protocol, Routes/Schema own 18 endpoints. This extraction changes
no stored format. A current pipe write does not establish phone action acceptance.

**Data and access.** Settings.ts parses startup env once; old names remain aliases.
WS_DATA_DIR wins over WS_NOTIFICATION_DATA. Bundled default data is outside dist;
nonempty old dist/data requires an explicit choice before startup. Stream config can
read its former cwd path; next save uses the new path without changing the former file.
Compose supplies both data aliases for rollback. The iPhone encryption key is consumed
separately, omitted from the general snapshot/log and removed from child environments.
No login exists. Host checks apply to every request/upgrade; Origin checks cover socket
upgrades, notification API and downloads, while absent Origin is permitted. Configured
public origin supports the existing trusted proxy. CSP forbids framing and limits page
connections. Remote proxies require configured origin/path. These do not replace trusted
network access. The README has the complete environment, key/storage and HTTPS guidance.

## 6. Current checks and limits

Before a merge, the assigned integrator runs these serially from the repository root:

```sh
npm run check
node scripts/test-browser.js
```

The first runs typecheck, lint, deterministic Node tests, Python suites and the normal
production build. The second runs all registered default suites on isolated fixture
servers, including the atlas. Pass suite names to run a focused fixture suite. Do not
run e2e scripts directly or use the older test:* browser shortcuts: they can target live.
Unit tests bind fixed ports; never overlap npm test/check or replace dist during browsers.
No new test is needed for prose. New unit/default browser registration belongs to the
integrator; docs changes require no dependency or script registration edit.

Keep assertions for one stream socket per requested open, the same mount through sheets,
no stream from list/Back and instant close on leaving Screen. Use fake pymobiledevice3
and isolated data selected before imports. Fixture text/key values must not come from
host secrets. Atlas comparisons retain raw files and explain every difference. They do
not establish hardware, decoded-picture or browser-platform results.

The latest implementation integration and its check counts remain in the dated followup
section. The current deployment's bounded real observations and skipped work are recorded
in the final step 6c section below. Historical scripts/checklists here record what was
asked or seen at that date. They are not a reason to start another phone session.
Physical Android rotation, USB replug and one owner-operated stream-setting restart are
explicitly DEFERRED; do not ask again or claim pass. Other picture/input/browser/notification
limits remain. The dark focus-ring contrast decision (2.74:1 against the sunken track),
server mute-drop policy, 50% idle controls and rail attachment at every mouse width remain
open owner points.

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
  directing the user to **Files** on the device list, whose uploads use adb (the upload of
  `googDevice/files/FileService.ts` since step 6a; `AdbkitFilePushStream` is gone). Do not bring back a push over the stream's control socket (the
  deleted `ScrcpyFilePushStream`): its control type `102` is a NetrisTV extension that stock
  scrcpy misparses, potentially killing all input.
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

The entries below continue through November 2026. They are dated history. Old toolbox,
Stream settings, Scheduled unlock sheet and Apply descriptions record the UI then;
sections 1–6 describe their current replacements. Old commands and checklists are not
current authorisation to run them.

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
- Each tool takes the mount element `ToolView` gives it and exposes idempotent `stop()` cleanup. Route or device
  changes close its socket/channel and release owned DOM, terminal observers, polling/reconnect
  timers, and file transfers. File path-only changes reuse the active Files client. Cancelling
  a still-connecting manager also closes the connection. Failed tool loads have an explicit retry
  action. Since the 2026-11-10 review a lost connection is retried by `ToolView` (1 s, 2 s, 4 s,
  then one banner with Reconnect; the chip reads "Reconnecting…" meanwhile). Shell reconnects in
  its own terminal (`ShellClient.reconnect()`, scrollback kept, modes reset by
  `NEW_SESSION_RESET`); Files has no in-place reconnect and is mounted again for each attempt,
  with the count kept in `retryRef`. A shell that exits is different: the server closes only
  the channel, `sessionEnded()` is true, and nothing restarts it until "New session" is pressed.
  No session ever replays earlier commands. Neither tool prints its own lost-connection text.
- Shell resizes its visible terminal with its container and the phone keyboard and tells the
  device (a `resize` message, debounced; after `start`, text frames are typed input and
  messages are JSON in binary frames, so input can never be parsed as a message). The server
  refuses a start or resize outside 1 to 500 columns or rows, so `terminalSize()` in
  `shellInput.ts` caps what the browser reports; a very tall window would otherwise get no
  shell at all. It provides
  native keyboard focus plus Esc/Tab/Ctrl/history buttons, and avoids opening the phone keyboard on
  entry. (Step 6a replaced those buttons with the Extra keys row, on touch screens only.) Files has a native multiple-file upload picker, compact folder shortcuts, responsive
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
  download progress lives in a map keyed by path so it survives a re-render. (Step 6a: rows are
  kept per item, a listing renders at most every 250 ms, and a list of more than 200 items shows
  only the rows near the view.)
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
  key**: `ShellClient` drops the attach addon and routes `term.onData` through `applyControl()`
  in `shellInput.ts` (letters and `@[\\]^_?` become their control codes), and writes socket
  output itself in `onSocketMessage`. It was a toggle at first; since the 2026-11-10 review it is
  **one-shot**: it changes the next single character and releases itself, because a forgotten
  toggle turned `ls` and Enter into `^L ^S` (clear, then XOFF) and rewrote arrow keys and pastes.
  A multi-character chunk passes unchanged and leaves Ctrl waiting.
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
left behind by a previous ws-scrcpy process is replaced, not reused"). Since November 2026 only
a process with this server's `scid` can be an orphan; before that, a server on port 8010 killed
the main server's scrcpy this way.

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
  types ASCII and reports what it skipped). Touches go as `touch-frame` contacts, up to five
  fingers, rAF-coalesced; a mouse drag uses the single-contact `touch` messages and Ctrl+drag
  two contacts (step 5c).
- **Tracking.** The appl `ControlCenter` polls `usbmux list --simple --usb` every 3 s (since
  2026-11-11 only where usbmuxd's event feed is not available; see "Fewer Python processes"). A new
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
  Coordinates are now read explicitly and mapped by `applDevice/touchMath.ts`, since step 5c
  `input/pointMapper.ts` (`clientPointToVideo`, unit-tested, clamps onto the picture instead of
  dropping). Desktop
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
     passcode. The Actions sheet's *Lock screen* row says so. (The passcode was not persisted
     then. Since 2026-11-04 the server stores it encrypted for the scheduled unlock, and since
     2026-11-10 the browser never holds an iPhone passcode; see the last two entries.)
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

### Scheduled unlock: driver, scheduler, monitor helpers and failure push (2026-11-04, fixture-tested only)

The server can now unlock an iPhone once a day and lock it again, so iOS does not restart it
after 72 hours without an unlock. This entry covers the server-side mechanics
(`UnlockDriver.ts`, `UnlockScheduler.ts`, two `DeviceStateMonitor` methods,
`CoreDeviceProxy.hasInputOwner`, `NotificationService.notifySystem`). The store and the
commands are in `IosSettingsStore.ts` and `ControlCenter.ts`; the panel is
`ApplSettingsSheet.tsx`. Nothing here has run against hardware yet; every claim below comes from
`scripts/test-ios-unlock.js` against `scripts/fixtures/fake-pymobiledevice3.js`.

**Driver (`UnlockDriver.run`).** The sequence is `StreamClientCoreDevice.unlockWithPasscode`
replayed through serve-web's loopback HTTP, with the session held through
`CoreDeviceRunner.acquire` and released through `runner.release`, never by signal. In order:
back off 30 s up to three times while `CoreDeviceProxy.hasInputOwner` says a viewer is typing;
`acquire` (a failure is `failed-session` with the CLI's reason); `/restart` plus 1.5 s only when
the session was already `ready`, because an input POST that reached that process while the
screen was dark left its touch surface unauthenticated; Home down/up (250 ms), 1.2 s,
`readScreen` (a failed read, `unknown`, is read once more after 1.2 s; Lock is not pressed for it,
since it would put an awake phone to sleep); if `off`, Lock down/up (300 ms), 1.2 s, `readScreen`
again; anything but `on` is `failed-wake` and nothing is ever touched. Then twelve `/touch contact` reports from
`(0x8000, 0xf800)` upwards in `0x0ccc` steps 25 ms apart and one `release`, 1.2 s, the digits
as `/key {usages:[u]}` 120 ms `/key {usages:[]}` 180 ms each, `/keyboard/detach`,
`waitForLock(udid, false, 8 s)` (`false` is `unlocked` with `verifiedAt`, `true` is
`failed-still-locked`, `'unknown'` is `unverified`), 2 s, Lock down/up, and
`waitForLock(udid, true, 5 s)` only to append "Locked again" (after an unlock) or "Lock not
confirmed" (after any outcome) to the message. `finally` posts the all-fingers-up frame if a touch went out, detaches the keyboard if
it is still attached, and releases the hold; the runner's 15 s grace and SIGTERM path stop
serve-web. The passcode is read from the thunk the scheduler passes, once, immediately before
the digit step, converted to usages in a block that ends with the typing; nothing else sees it.
Logs are step names only. A thunk that throws (key file missing) types nothing, still presses
Lock, and reports `failed-still-locked` with "Passcode not entered: <reason>".

**Scheduler (`UnlockScheduler`).** `start` loads the store, subscribes to monitor `state`
events, and ticks every 60 s (unref'd; first after 5 s). A tick runs a device when its retry is
due, or when today's slot has passed, is less than two hours old and `lastSlotAt` is older than
it; `lastSlotAt` is written before the run starts. Runs go through one promise chain for the
whole process, so two phones never hold display sessions at once and a manual run during a
scheduled one waits; `running` is set from the moment a run is queued. Skip order: disabled
(manual ignores), no passcode, not connected (`skipped-disconnected`), recent (manual
ignores), `device.locked === false` in the monitor's cache (`already-unlocked`, records
`lastUnlockedAt`). A scheduled run ending `failed-*`, `unverified` or `skipped-disconnected` is
pushed to every subscription (`notifySystem`, tag `ios-unlock-<udid>`) and retried once ten
minutes later; the retry is not retried, and a retry older than two hours (server was down) is
dropped like a missed slot. `lastUnlockedAt` is also recorded on a monitor `true -> false`
transition; `unknown -> false` does not count because at server start the phone may have been
unlocked days ago.

**The 24 h rule is measured as 22 h.** Yesterday's own scheduled unlock finished a few seconds
after its slot, which is 23 h 59 m before today's tick; a literal "unlocked in the last 24 hours"
check would therefore skip every other night. `RECENT_WINDOW_MS` is `UNLOCK_RECENT_MS -
UNLOCK_SLOT_WINDOW_MS`: an unlock more than two hours after yesterday's slot is the user's own
and counts, the schedule's own never does. The panel, the outcome text and README say
22 hours, so a phone unlocked by hand an hour after yesterday's slot being unlocked again tonight
matches what the user reads. At integration the `unlocked` outcome text also became "Unlocked":
the message carries "Locked again" or "Lock not confirmed", and the old "Unlocked and locked
again" contradicted the second.

**Monitor helpers.** `readScreen` is one `probeScreen` call outside the queue that leaves the
cached state alone. `waitForLock` cannot rely on `state` events alone, because `update` only
emits on a change and a reading that confirms the current value makes no event; it watches the
requested probe to completion (no timer, not running, no pending lock flag) and resolves then if
the value matches or is `'unknown'`, resolves early on a matching `state` event, and otherwise
returns the latest known value at the timeout.

**Testing notes.** `IOS_UNLOCK_FAST=1` makes every driver pause 5 ms, so the whole sequence runs
in ~0.6 s against the fake. The one slow test waits out the runner's real 15 s grace to prove the
session reaches `stopped` with a single serve-web. `FAKE_TOUCH_DROP_AFTER` costs two 4 s HID
timeouts (the swipe and the cleanup frame) in the mid-swipe failure test. The scheduler tests use
an in-memory `UnlockSettingsStore`, a scripted driver that asserts runs never overlap, a fake
monitor and an injected clock; the slot tests derive their times from `lastUnlockSlotAt('03:00',
Date.now())` so they pass in any time zone and across DST.

**Not verified on hardware.** Whether Home wakes a dark, locked Face ID phone (the Lock fallback
covers it), whether the swipe-then-digits path works from the server the way it does from a
browser (same requests, same timings), and whether a Face ID unlock resets the iOS inactivity
timer. The integrator's hardware sequence is in the plan; the first real run should be a manual
one with someone watching the phone.

### iPhone session lifecycle: the wedge paths (2026-11-10, fixture-tested only)

The September entry "What actually wedges the display daemon" names the trigger: a burst of short
display sessions, worse with SIGKILL and with two at once. The 2026-11-10 review found the code
paths that produce such a burst without anyone doing anything unusual. This is what changed and
why. None of it has been run against a phone.

**Holds name their session.** `CoreDeviceRunner.acquire()` returns a `SessionHold` (`udid`,
`port`, `token`); `release(udid, hold)` and `stopSession(udid, message, hold)` do nothing when
the phone's session has been replaced since. Before, both acted on whatever session the map held,
so a viewer finishing a slow teardown (a 10 s `/keyboard/detach` timeout, a `close` event that
lagged) could stop or un-hold the session another viewer had just started. The tracker's own
stops (unplug, reboot, Restart services) pass no hold on purpose: they mean "whatever is running".
A viewer that leaves while the session is still starting used to leak its hold, because
`release()` ran before `acquire()` resolved; serve-web then ran for ever and its keep-awake
assertion kept the phone from locking. The proxy now gives the hold back when `acquire()`
resolves. It does not cut the start short: see the next point.

**No SIGTERM before serve-web can handle it.** serve-web (11.44.0) starts the phone's video and
audio in a preflight of up to 25 s, binds HTTP, and only then installs its SIGTERM handler. A
SIGTERM before that ends the process with no `stop_all_streams`, which is a SIGKILL as far as the
phone is concerned. `kill()` therefore waits until the process is known to handle the signal:
its "Open http://" log line, or any HTTP reply (the handlers are installed between the bind and
the first served request). The wait ends 35 s after the spawn at the latest
(`SIGNAL_READY_TIMEOUT_MS`). `python/patches/pymobiledevice3-serve-signals.py` (run by
`npm run patch:ios`) installs the handlers at the top of `serve()` instead: a SIGTERM during the
preflight then sets the stop event, the preflight finishes, and the normal shutdown in `serve()`'s
`finally` returns the phone's sessions. `python/patches/test_serve_signals_patch.py` runs the
patched and the stock `serve()` against stubs with a real SIGTERM. Not yet run against the phone.
The runner's wait stays for a venv without the patch. With the patch, the SIGTERM that the exit
hook sends when Node exits is safe during the preflight as well.

**One serve-web per phone at a time.** `stopSession()` used to forget the child as soon as it had
signalled it, and the next `acquire()` mounted and spawned while the old process was still in its
orderly shutdown (bounded steps of 2+2+3+3+3+6 s). The runner now keeps a per-phone promise that
resolves on the old child's `close`, and a new session waits for it ("Waiting for the previous
session to stop"). `SIGKILL_GRACE_MS` went from 15 s to 30 s to cover the 19 s worst case, and
`stop_grace_period` in docker-compose.yml from 25 s to 40 s, and then to 80 s: a stop that lands
inside a slow preflight waits up to 35 s for the signal handler before the 30 s grace starts, so
the server's own budget (`CoreDeviceRunner.shutdownBudgetMs()`) is 70 s. The compose value is that
plus 10 s, and `scripts/test-web-security.js` fails if it drops below.

**Ports are reserved, not just probed.** serve-web binds after its preflight, so for up to 25 s a
free-port probe says the port is free. A second phone opened in that window got the same port; its
serve-web then failed to bind and left `serve()` before its cleanup. Ports stay in
`CoreDeviceRunner.ports` from allocation until the child's `close`. Two probes at the very same
moment never collided (portfinder holds the port while it tests it); the staggered case did, and
that is the one the test covers. Needs two iPhones to see for real.

**Start budget and cooldown.** `StartBudget` allows three serve-web starts per phone in five
minutes and persists the times in `ios-session-starts.json` in the data directory, so a crash
loop or a run of dev rebuilds does not reset it. Only a spawned serve-web counts; a mount failure
does not. After a session fails once serve-web has run, the next start for that phone is held off
for 30 s (`ERROR_COOLDOWN_MS`): a start that fails on "camera in use" exits before its cleanup and
the phone needs the ~20 s RTCP timeout to reclaim what it started. Both refuse with
`StartRefusedError` before anything is spawned. Three per five minutes is deliberately tight. It
also limits ordinary use: leaving the stream page for more than the 15 s grace and coming back is
a new start, and the fourth such visit inside five minutes is refused with the time to wait.
`IOS_SESSION_START_LIMIT`, `IOS_SESSION_START_WINDOW_MS` and `IOS_SESSION_COOLDOWN_MS` change the
numbers; the measured wedge was six sessions in about four minutes, two by SIGKILL and two at
once. The proxy's `restart` (video restart inside serve-web) reaches the phone at most once per
30 s per phone. `acquire()` also refuses a udid the tracker does not list as attached; the check
is installed in `src/server/index.ts` and lets everything through until the tracker has seen at
least one phone, so a tracker that failed its first poll cannot lock every phone out.

**The viewer's half.** The proxy closes with 4009 when serve-web was started and the session
failed, 4010 when nothing was started on the phone and asking again is fine (cooldown, phone not
attached, or a failure before serve-web ran, such as the mount), and 4011 when the budget is used
up. A failed mount is a 4010 so that a page left open on a rebooting or replugged phone still comes
back without Retry, as the September reboot test recorded; it puts no display session on the
phone. The tracker now reads a replugged phone again at once instead of at its next regular
refresh (up to a minute later), because `acquire()` refuses a phone it reports as disconnected. `CoreDeviceReceiver` used to reset its retry counter on socket open, and the
server opens every socket before it starts the session, so the delay was always 1 s. The counter
now resets when the codec arrives; the delay doubles to 60 s; three 4009 closes in a row, or one
4011, stop the retries until someone presses Retry. Retry used to send `restart` down a socket
that had already closed, and it was hidden under a dismissible copy of the same message; the
copy is gone and Retry reconnects.

**Crashes and exits.** Node runs `exit` handlers after an uncaught exception, and the runner's
handler sent SIGKILL to every serve-web. `src/server/Shutdown.ts` now handles
`uncaughtException` and `unhandledRejection`: it logs the stack, stops the services as SIGTERM
does, waits for the serve-web processes to close (bounded by `shutdownBudgetMs()`), and exits
with 1. A second SIGINT or SIGTERM no longer exits at once while a serve-web is still shutting
down. The SIGUSR2 that nodemon sends is passed on only after they have closed, so the next dev
server does not start a session on top of the old one. The runner's `exit` hook remains for the
cases nothing else covers and sends SIGTERM, not SIGKILL. In Docker Node is PID 1 and its exit
kills everything in the container, which is why the waiting has to happen before the exit.

**The fake can now show these.** `FAKE_PREFLIGHT_MS` (a SIGTERM inside it is logged as "killed in
preflight"), `FAKE_SHUTDOWN_MS` (logs "sigterm" and "shutdown complete"), `FAKE_MEDIA_IN_USE` and
`FAKE_BUTTON_MS` (the reply waits, as the patched helper's does). `scripts/fixtures/
shutdown-harness.js` runs one fake session under the real `Shutdown` so the crash, signal and
exit paths can be tested in a child process. test-coredevice.js turns the budget and the cooldown
off for its other tests and uses port base 18300, clear of a server running on the same machine.

**Still open.** A hardware check of the early-signal patch.

**Patch check (2026-11-11, phase 2).** `python/patches/check_patches.py` lists the marker every
patch leaves and compares the two copied modules with their source. The server runs it with the
venv's interpreter before a session's mount (`PyMobileDevice.helperProblem()`, called from
`CoreDeviceRunner.bringUp`) and fails the start with "missing patches: ... Run npm run patch:ios".
That is a failure before serve-web ran, so the viewer gets 4010 and keeps asking; a stale answer is
not cached, so patching is noticed without a server restart. A check that cannot be run (no venv
next to the CLI, the script missing, `IOS_PATCH_CHECK=0`, a Python error, or a `python` next to the
CLI that has no pymobiledevice3 of its own) allows the session.
`python/patches/test_check_patches.py` fails when `python/venv` is behind `python/patches`, and
ties the marker list to the patch scripts. A patch that changes an already patched file needs a new
marker in both places. `npm run dev` runs `patch:ios` first when the venv exists; if that fails
it says so and starts anyway, so Android keeps working and iPhone sessions are refused. The same phase
added a patch step ("ws-scrcpy input queue bound": `/touch` and `/key` answer 503 once 512 reports
are queued), so a venv patched before it needs `npm run patch:ios` again. Dependencies of
pymobiledevice3 are still not pinned.

**Fewer Python processes (2026-11-11, phase 2, fixture-tested only).** One idle iPhone used to
cost about 43,000 `pymobiledevice3` launches a day: `usbmux list` every 3 s, and the backlight
plus (27.2+) `notification get-state` every 15 s, or every 4 s while streaming, where each
get-state brought up a userspace tunnel beside serve-web's. Two changes:

- `UsbmuxListener` holds one connection to usbmuxd's socket with a `Listen` request. Its
  messages are only a signal: on any of them the tracker runs `usbmux list` at once (150 ms
  debounce). While the feed is up the regular poll is every 60 s, not 3 s, except while an
  attached phone has not answered lockdown yet (untrusted, or still booting): usbmuxd sends
  nothing when "Trust This Computer" is accepted, so that phone keeps the 3 s poll and its
  lockdown retry every 10 s until it answers. The list itself still
  comes from the CLI, so a feed that misbehaves can only make an attach or detach show up to a
  minute late; it cannot hide a phone. No socket, a refused `Listen` or `IOS_USBMUX_LISTEN=0`
  leave the 3 s poll in place. The framing is written from the usbmuxd protocol and tested
  against a fake socket only. First thing to check on hardware: the log has no
  "[UsbmuxListener] ... polling for iPhones instead" line, and a replug shows within a second.
- `DeviceStateMonitor` trusts the observer once it has stayed up for 10 s (`entry.observed`). From
  then the screen is read on the timer every 5 minutes when idle (4 s while a session is up, as
  before: that read is lockdown only, no tunnel), and the 27.2+ lock is read on the timer at
  most every 3 minutes. Events, button and input pokes, `refresh` and `waitForLock` still read
  at once, except that a button press on 27.2+ no longer forces a get-state while the observer
  is running and the phone is known unlocked and awake. When the observer exits, or was never
  started (`IOS_STATE_NOTIFICATIONS=0`), the old cadence returns. This rests on the observer
  delivering `lockstate` with `State` on 27.2+, which the September notes record; a deaf observer
  now means a badge that is up to 5 minutes stale, where it was 15 s.

`ControlCenter.refreshDetails` also re-checks after each read that the tracker is still running
and the phone still attached, so a release during a read no longer recreates the monitor.

**iPhone client requests and failure states (2026-11-11, phase 2).**

- Every tracker command from the iPhone card, the Actions sheet and the settings panel goes
  through `sendTrackerCommand` (`src/app/client/trackerCommand.ts`). It matches the reply on udid
  and request id and always settles: refused at once when the tracker socket is closed
  (`BaseDeviceTracker.sendCommand` sends nothing then and does not throw), when the socket closes
  while waiting (`onceClosed`; the server answers only on the socket the command came in on),
  after a per-command limit (`serviceCommandTimeoutMs`), or when the view goes away. Before, a
  server restart during Remount left all three Troubleshooting buttons disabled.
- Run now also ends when a device update shows a run that finished after the click (`lastRun.at`
  differs and `running` is false). The reply is lost when the tracker reconnects mid-run.
- Stream-socket requests (rotate, Send to phone, Restart video) carry an id, have a time limit
  and end when the stream socket drops. `restart` is now answered: done, or "The video was
  restarted a moment ago. Try again in N s." when the 30 s limit refuses it.
- `streamConnected` means the socket is open, the session is `ready` and this browser has a
  decoder. It used to mean "socket open", so the header said Connected and the hardware buttons
  were live over a stopped session or a stream the browser could not decode. Failed, stopped and
  no-decoder are one card on the stage (`.stream-start-error`, the card "Unable to start this
  stream" already used) with the reason, Retry where it can help, and Back to devices. The card
  stays up between automatic retries and says "Trying again". The progress notice is only for a
  first start.
- The iPhone settings panel opens from the stream controls and the Actions sheet as well as the
  card, and from the card of a disconnected phone. The sheets are titled "Scheduled unlock" and
  "Stream settings" (the integration kept the p2-sheets name; p2-ios-misc had "iPhone settings").

### Scheduled unlock and passcode handling after the 2026-11-10 review (fixture-tested only)

Findings C-ios-unlock-1 to -10, C-client-ui-1/-4/-5 and U-settings-3/-5. Nothing below has run
against a phone; the first real run of each path should be watched. Tests:
`scripts/test-ios-unlock.js`, `test-ios-settings-store.js`, `test-passcode.js`, and the
`ios-settings`, `unlock` and `ios-typing` browser suites.

**One code path types an iPhone passcode: `UnlockDriver`.** `StreamClientCoreDevice.unlockWithPasscode`
is gone. The stream page's Unlock sheet (`ApplUnlockSheet`) sends `RUN_UNLOCK_NOW` with
`keepUnlocked: true`; the driver then skips the viewer wait and does not press Lock. With no
stored passcode, or a rejected one, the sheet leads to Settings.

**Driver.** After the swipe it calls `waitForLock(udid, true, 5 s)` and types only on `true`;
`false` ends the run as `already-unlocked` (no Lock press: someone is using the phone),
`'unknown'` as `unverified` with nothing typed. That means a server with `IOS_LOCK_PROBE=0`, or a
phone the monitor does not watch, never gets a passcode typed. A viewer who still owns input
after the three 30 s waits ends the run as `skipped-viewer` before a session is opened. Once the
fresh reading said locked, the run ends with a Lock press whatever happens after it, including a
failed `/key`, `/keyboard/detach` or verify. Lock is pressed once more, after 2 s (two presses
close together are a double-click), only if the press itself failed or the phone still reads
unlocked; an `'unknown'` reading gets no second press because that would wake a phone that did
lock. `left-unlocked` is the outcome when the phone was unlocked and does not read locked
afterwards. Still locked after the digits is now `failed-rejected`; `failed-still-locked` is only
"the passcode could not be read, nothing typed". The result carries `typed` (every digit sent)
and `openedSession` (false for a reused session).

**Scheduler.** A run that typed is never retried. `failed-rejected` sets `passcodeRejectedAt` in
the store; from then on every run, scheduled or manual, ends as `skipped-rejected` without the
driver until `setPasscode` or `clearPasscode` clears the mark. Two typed runs in a row without a
confirmed unlock (`unverified`, or `failed-session` after the digits) are treated the same way
(`unconfirmedAttempts`). Whether iOS counts a repeated wrong passcode is unknown and assumed.
`runNow('manual')` returns the promise of a run already queued or running for that phone, and
rejects with "Try again in N s" for 2 minutes after a session-opening run, or when 3 such runs
ended in the last 5 minutes; skipped runs and runs on a shared session do not count.
`updateSchedule` and `setPasscode` mark the slot that has already passed as used and drop a
pending retry, so the first run is the one the panel shows as Next run. A schedule that is on
without a usable passcode still gets its slot, which ends as `skipped-no-passcode` or
`skipped-rejected` and is pushed. `checkDeadline`: one push when `lastUnlockedAt` is 36 h old
(once per value, `deadlineWarnedFor`), and between 48 h and 72 h a run outside the slot window
at most every 2 h, only when connected, usable and not read as unlocked. The first tick pushes
`store.getProblems()`: an unreadable settings file (now renamed to `ios-settings.json.bad`
instead of being overwritten) or an enabled schedule whose key is missing.

**Time zone.** The panel sends `Intl.DateTimeFormat().resolvedOptions().timeZone` with a time
change and when the schedule is turned on without a zone. The store keeps it as `timeZone`;
`nextUnlockRunAt` and `lastUnlockSlotAt` take it and do the calendar arithmetic with
`Intl.DateTimeFormat` (no dependency). A record without a zone is still server local time, and
the status then carries `serverTimeZone` so the panel can say so and offer "Use <browser zone>".
No `TZ` was added to the Dockerfile or docker-compose.

**Browser passcodes.** `savedPasscode.ts` moved to the key prefix
`ws-scrcpy:remembered-passcode:` and deletes every `ws-scrcpy:passcode:*` key when the app loads
(those were written before any unlock was confirmed). The Android sheet writes a passcode only
when "Remember in this browser" is ticked and the descriptor confirmed the unlock, and removes
the saved copy when a send ends unconfirmed.

**Panel.** The time field keeps a draft and saves on Enter or blur (on a coarse pointer also on
`change`, because a phone's picker hands over one finished value); it is not disabled by its
own save. Headless Chromium's time field is 12-hour whatever the locale, so the browser test
types `0430`. The passcode is entered twice. The group opens with a summary row; failed runs and
a paused or blocked schedule use the error tone there, in Last run and on the device card.

**Review follow-up (same day).** Four changes after review of the above. (1) `typed` is set when
the last digit's key-down is sent, not after the loop: a post that fails or times out may still
have reached the phone, and that digit submits the passcode, so such a run is not retried. A
failure on an earlier digit submits nothing and is still retried. (2) The two-hour spacing of the
runs past 48 hours is stored as `lastTimerRunAt` with the run state, before the run starts. It
was in memory, so a server that kept restarting (a crash during a run, Docker restarting it)
opened a display session at every first tick. (3) The stream page's Unlock (`keepUnlocked`) is
refused, not joined, while a run that will press Lock is queued or running for the phone; joining
it reported "Unlocked" to a viewer looking at a relocked phone. A plain Run now still joins either
kind. (4) On load, a stored `lastRun` of `failed-still-locked` whose message does not start with
"Passcode not entered" was written by the old driver for typed digits that left the phone
locked. It is read as `failed-rejected` and marks the passcode rejected, so a server upgraded
after such a night stays paused until the passcode is saved again.

### Phase 1 integration of the 2026-11-10 review (fixture-tested only)

The five phase 1 packages were merged into `review-fixes`. Points that only show once they are
together:

**Scheduled unlock and the session rules.** `UnlockDriver` takes its session through
`CoreDeviceRunner.acquire()`, so the start budget, the cooldown after a failed session and the
attached-phone check apply to it as to a viewer. A refused start, or one that failed before
serve-web ran, ends the run as `failed-session` with the runner's reason and does not count toward
the Run now cooldown, since nothing reached the phone. A scheduled run refused this way gets its
one retry ten minutes later, after the five-minute budget window. Runs are serialised and share a
viewer's session through the per-session hold, so the scheduler cannot start a second serve-web.
The driver's `/restart` on a viewer's session now shares the per-phone 30 s spacing with the
viewers' Restart picture (`CoreDeviceRunner.videoRestartWaitMs` and `noteVideoRestart`): the
driver waits out a recent restart, because it needs one for input to work, and a Restart picture
pressed straight after an unlock run is dropped. Remount developer image now waits for the stopping
serve-web to close before it mounts (`CoreDeviceRunner.whenStopped`), as a new session does.

**Uploads land under a hidden name first.** `FilePushReader` pushes to `.partial-<hex>` in the
target folder and renames it into place after adb reports success (`mv -nT`, or `mv -fT` when the
owner chose Replace). A crash mid-upload can leave such a file; it shows with Hidden items on.
Needs a check on a phone: toybox `mv -fT` and `cp -T`, the rename on FUSE `/sdcard` (DCIM,
Pictures), and adbd removing a cancelled partial file.

**One confirm rule.** The Files dialogs follow the shared prompt's rule: the destructive answer
(Delete, Replace) is red and ignores presses for `CONFIRM_GUARD_MS`, and focus starts on the
answer that loses nothing. The iPhone card shows one scheduled-unlock line, from
`unlockCardLine()`; the separate "has no passcode" warning from p1-confirm was folded into it.

### Android stream client after the 2026-11-10 review (tested without a device)

**Rotation.** See §3: session packets are read, and `WebsocketProxy` sends a second
`scrcpy_initial` when the size changes. `StreamClientScrcpy.onDisplayInfo` gives the new
`ScreenInfo` to the player. The MSE player restarts its converter on it; the WebCodecs player
also takes the size from the new SPS. Needs a check on a phone: rotate, and open a landscape
video full screen, with both players.

**Decoder errors.** `WebCodecsPlayer` keeps the last SPS and PPS. After a decoder error it builds
a new decoder, configures it from that copy and resumes at the next keyframe; the canvas keeps
the last picture meanwhile. Non-keyframe slices before a keyframe are dropped, not buffered, and
new parameter sets replace the cached copy in the buffer. If no keyframe arrives within 2 s the
player emits `keyframe-request` and `StreamClientScrcpy` sends `RESET_VIDEO`, at most three times
in five minutes because it restarts the encoder for every viewer. Nothing is requested or reported
while the player is paused by a disconnect: the next connection brings parameter sets and a
keyframe. More than three errors in 5 s pause decoding for 5 s with a stream notice; the player is
no longer stopped for good. `MsePlayer` reports a media element error the same way and starts
again at the next SPS. Both iPhone players emit `decoder-error` and the client answers with a
`pli`. Whether `RESET_VIDEO` brings a keyframe on the owner's phones is not verified.

**Scroll.** One wheel notch is one scrcpy notch. `FeaturedInteractionHandler` converts the wheel
delta (100 px or 3 lines per notch), adds up what arrives within the 30 ms throttle and clamps to
16 notches. Horizontal scroll used to be mirrored: `AXIS_HSCROLL` is positive to the right, like
the browser's `deltaX`, so only the vertical axis is negated now. How either feels on a device has
not been judged by hand. On an iPhone, which takes no scroll message, a wheel gesture is one short
swipe since step 5c (`input/wheelSwipe.ts`).

**Touches beside the picture.** The touch layer is still the size of the picture. A touch that
starts on the `.video` band next to it is now accepted on both platforms, held back until it
moves onto the picture, then sent as a touch-down on the nearest edge followed by the move. A tap
on the band sends nothing. Android maps points with `clientPointToVideo` like the iPhone handler,
so a finger sliding off the picture rides the edge instead of lifting. The iPhone section above
records that injected edge swipes were unreliable on the bench phone; a swipe made by hand
through this path has not been tried on either platform.

**Held keys and buttons.** `HeldButtons` (`toolbox/heldButtons.ts`) releases a toolbar button
that is still down when the window loses focus or the page is hidden. On a disconnect the clients
only forget their holds: an Android `UP` sent at that moment would be queued and replayed on the
next connection. The servers do the release. `WebsocketProxy` tracks single-message
`INJECT_KEYCODE` frames per viewer and writes `UP` for what is still down when the viewer goes.
`CoreDeviceProxy` tracks `down` buttons and posts `up` in `release()` before the session hold is
returned. The iPhone client releases its keyboard keys when a key event lands on a local control.

**Removed.** The Fit screen toggle, the `fitToScreen` link parameter and the per-window-size
video settings in localStorage: CSS always fits the picture, so none of it had an effect. Stale
`MseDecoder:` and `WebCodecsPlayer:` keys are deleted on the first stream start. `BasePlayer`
still has `setBounds()`, which only the iPhone client calls and nothing reads.

### Phase 2 integration choices (2026-11-11)

Where two packages changed the same thing, the merge kept one behaviour:

- A device card shows the Notifications bell only for an iPhone that sends its notifications to
  this server (p2-home). p2-notif-page's "Set up notifications" card button is not kept; setup is
  reached from Notifications in the page header, and a link that names an unlinked iPhone still
  opens the add section with that iPhone chosen.
- The iPhone screen header uses p2-home's `NotificationsLink`, the same control as on Devices and
  the tool pages. p2-notif-page's `StreamNotificationsLink` is removed.
- The iPhone sheet is "Scheduled unlock"; the iPhone Actions rows are "Restart video" and
  "Reconnect"; the card Settings button stays on a disconnected iPhone (p2-ios-misc).
- `Toast` has one error tone (`tone="error"`, class `toast-error`), used by Files and the inbox.
- A tool page whose lazy chunk fails to download (a tab left open across a deploy) offers Reload
  instead of Reconnect.

### Scheduled unlock every 12 hours, and the 24-hour lockout (2026-11-11, fixture-tested only)

This section replaces the daily slot, the 22-hour skip, the two-hour slot window, the single
retry and the 36 h / 48 h deadline logic described in the three scheduled-unlock sections above.
The driver sequence, the pause after a rejected passcode, the fresh lock reading before typing,
Lock after a failed step, the start budget and the session holds are unchanged. Nothing below has
run against a phone. Tests: `scripts/test-ios-unlock.js`, `test-ios-settings-store.js`,
`test-passcode.js`, and the `ios-settings` browser suite (`lockoutFlow`).

**What happened.** On the live server the 03:00 UTC run of 2026-11-11 failed twice with
"Device is password protected. Please unlock and retry." The phone (iOS 27.2) had not restarted.
It refuses every new service connection (mount, the CoreDevice tunnel, diagnostics, syslog) once
about 24 hours have passed since its passcode was last entered: serve-web was spawned 24 h and
0.14 s after the last server-typed unlock and was refused, while a session 21.4 h after it had
worked. A lockdown connection opened before the mark (`notification observe`) stayed open after
it. This is inferred from that one event. In this state nothing remote works, the unlock
included; the passcode has to be entered on the phone. The run fired from a 60 s `setInterval`
whose phase was set when the process started, so a container restart moved it a few seconds
later, past the mark. iOS still restarts a phone that has not been unlocked for 72 hours, but the
24-hour limit comes first, so nothing in the code waits for the 72 hours any more.

**Two slots a day.** The stored schedule keeps its single `time`. `nextUnlockRunAt` and
`lastUnlockSlotAt` (`src/common/IosUnlockSchedule.ts`) now work on a list of slots: `time` on
each calendar day in the schedule's zone (server local time without one), and one slot halfway
to the next day's `time`. That is 12 hours later on every day but the two with a clock change,
where the 23 or 25 hours are split evenly (11 h 30 min, 12 h 30 min). A second slot at a fixed
12 hours or at a fixed clock time leaves one 13-hour gap in autumn, which the skip rule below
has no margin for. The panel's switch and the card line's title name the second slot by its
clock time (`secondUnlockTime`, "03:00 and 15:00"). The panel's summary and the card line show
the next run from `nextRunAt` ("next 15:00"): the next of the two slots, or a retry before it.
On the two days with a clock change that is the real moment, half an hour off the named time.
The interval is `UNLOCK_INTERVAL_MS`, a constant.

**Start by the clock.** `UnlockScheduler.armTick` arms one timer for the next whole minute of
the clock and re-arms it each time, so a run starts within a second of its slot whatever second
the process started at. A timer that fires early leaves a short remainder and is armed again
for it. The tick five seconds after start stays, and a minute that falls inside those five
seconds is left to it: the tracker has not listed the phones yet, and a run would end as
`skipped-disconnected`. So a server restarted within five seconds of a slot starts that run up
to five seconds late; any earlier restart does not move it. For the first two minutes after a
start (`START_WAIT_MS`), a run that is due also waits until the tracker lists the phone and the
monitor has a lock reading, so a restart after a slot neither ends the run as not connected
(with a push) nor starts it on a phone in use. After two minutes it runs either way.

**A slot owes a run until it is settled** (`tickDevice`, `settleSlot`). When a slot arrives,
`lastSlotAt` is written and `retryAt` is set to the slot: "a run is owed, not before this time".
The run starts at the first tick where `retryAt` has passed, no run is in progress and the phone
is not in use. Before it starts, `retryAt` is moved an hour on, so a server that crashes during
runs does not open a session at every restart. The result then decides:
- worked, skipped for a final reason, typed the passcode, or the lockout below: `retryAt` is
  removed;
- a failure that typed nothing (`RETRIED_OUTCOMES`): `retryAt` is ten minutes on after the first
  failure and an hour on after each later one (`slotAttempts` counts them). A retry that fails
  with the same outcome and message as the run before is not pushed again;
- `already-unlocked`: the slot stays owed (see "Phone in use").
Saving the time or zone, turning the schedule on, or saving the passcode still marks the slot
that has just passed as used, as in the 2026-11-10 section, except when the next slot would come
23 hours or more after `lastTypedUnlockAt`: then the passed slot's run is owed at once. Without
that, a time moved at 14:59 to 02:59 left the next run 23 h 58 min after the last typed unlock.
The next slot replaces whatever the one before still owed. There is no slot window any more: a
slot the server was down for runs when the server is back, because waiting for the next slot
can pass the 24 hours. Every start still goes through `CoreDeviceRunner.acquire`, so the start
budget applies to the retries.

**Skip rule.** `skipped-recent` now means: the server typed the passcode, and saw the phone
unlock, less than `UNLOCK_SKIP_WINDOW_MS` (11 h) before the slot: 24 hours, less the 12 to the
next slot, less 1 of margin, derived from those three constants. It is measured from the slot,
not from the time the run starts. The store has a new `lastTypedUnlockAt`, written only when a
run ends `unlocked`, or `left-unlocked` after typing. `lastUnlockedAt` is still any unlock that
was seen and no longer skips anything: it may have been Face ID. In normal operation every slot
runs, since the unlock 12 hours earlier is outside the window; the rule only skips a slot after
Run now, the stream page's Unlock, or a late run.

**Phone in use.** If the monitor's cached `device.locked` is `false` when a run is due, nothing
is started: no session, no passcode, no Lock press, no recorded run. `retryAt` stays in the past
and the run starts at the first tick where the phone no longer reads unlocked, any time before
the next slot. The status carries `waitingForLock` meanwhile (broadcast once), which the panel
shows as "Runs when the phone is next locked". If the driver's own fresh reading finds the phone
unlocked after a session was opened, the slot stays owed and is looked at again ten minutes
later. An unknown lock state does not wait, except in the first two minutes after a start:
the driver decides, and types only on a fresh locked reading.

**The lockout.** `isPasscodeLockout` (`IosUnlockSchedule.ts`) is the one place the refusal is
matched: pymobiledevice3 11.44.0's `PasswordRequiredError` text ("Device is password protected.
Please unlock and retry."), its start-service wording ("The device is protected with a passcode.
Unlock it and try again."), the lockdown code `PasswordProtected`, and the plain sentence below.
`CoreDeviceRunner` checks the mount's stderr and serve-web's stderr tail with it and fails the
session with `UNLOCK_BY_HAND_MESSAGE`: "The iPhone stopped accepting connections. Enter the
passcode on the phone." That is what the device card's session line and the stream page show to
a viewer (`CoreDeviceStreamView` titles the card "Unlock the iPhone by hand" and drops the retry
count the receiver appends). A refused mount spawns nothing and uses no start budget; a refused
serve-web counts one start and sets the usual 30 s cooldown. `UnlockDriver` turns such a failed
`acquire` into the new outcome `needs-manual-unlock`. The scheduler then: sets `lockedOutAt` in
the store (status `needsManualUnlock`), pushes the sentence at once for a scheduled run (tag
`ios-unlock-<udid>`), does not retry, does not touch `passcodeRejectedAt` or
`unconfirmedAttempts`, and marks the 20-hour warning as sent. The next slot tries again and
pushes again if it is still refused. `lockedOutAt` is removed when a run gets a session
(`REACHED_OUTCOMES`), when the monitor reports `device.locked: false`, or when `screen.power`
becomes known after `unknown`: the screen is read over a new diagnostics connection each time,
so a reading means the phone accepts connections. A lock reading alone does not count, because
the observer's old connection keeps delivering them.

**Checking a phone that refuses connections.** At 04:50 UTC the owner entered the passcode on
the phone and it accepted connections again, but the live server did not notice: its
`notification observe` process was the one started before the lockout, and it delivered nothing
after it. So while `lockedOutAt` is set, `UnlockScheduler.checkLockout` asks the monitor every
five minutes (`LOCKOUT_CHECK_MS`, from the minute tick) for `DeviceStateMonitor.reconnect`: the
observer is stopped and started again, and the backlight is read once over a new diagnostics
connection. A reading clears the state at once. No display session is opened, nothing runs
while a run for the phone is in progress, and a phone the monitor does not watch is not
checked. A new observer the phone refuses exits and is retried by the monitor's usual backoff
(5 s doubling to 60 s), as before. Long-lived screen sessions are left alone: a viewer may be
using one. `isUnlockProblem` is false for the new
outcome; the panel and the card show the problem from `needsManualUnlock`, so a cleared state
leaves only the Last run row.

**Warning.** `checkWarning` replaces `checkDeadline`: with the schedule on, one push (tag
`ios-unlock-deadline-<udid>`) when `lastTypedUnlockAt` is 20 hours old (`UNLOCK_WARN_MS`), or
`lastUnlockedAt` when the store has no typed time, with the hours left to 24. It is sent once
per value (`warnedFor`), and not while `lockedOutAt` is set. It is sent while the phone reads
unlocked: a Face ID unlock does not restart the 24 hours, and a phone in use holds back the run
that would; when a slot is waiting for the phone to be locked, the push says so. Past 24 hours
it says the phone has probably stopped accepting connections. The runs outside the
slot window past 48 hours are gone, with `lastTimerRunAt`.

**Existing data.** `sanitizeUnlock` reads a stored `lastRun` of `failed-session` whose message
matches `isPasscodeLockout` as `needs-manual-unlock` and sets `lockedOutAt` from its time, so
the live file (schedule on, 03:00, no zone, that last run) loads and shows the hand-unlock
state. On the live server the first screen reading after the upgrade removes it if the passcode
has been entered since. `lastSlotAt` in that file is the 03:00 slot, so the first run is the
next slot. Fields the new code does not know (`deadlineWarnedFor`, `lastTimerRunAt`) are
dropped on load.

**Fixture.** `FAKE_PASSCODE_LOCKOUT=mount` or `serve-web` makes that step fail with the
`PasswordRequiredError` line. `all` refuses every command that needs a new service connection
(mount, serve-web, diagnostics, notifications, the lock probe), while an observer started
before keeps running and relays nothing.

**Not verified on hardware.** That the limit is 24 hours from the passcode entry on every
iOS version; whether a Face ID unlock moves it; whether a phone that is unlocked and in use at
the 24-hour mark still refuses connections; that `diagnostics ioregistry` is refused in the
same way as the mount (the clearing rule depends on it); and how serve-web words the refusal
when the tunnel, not the mount, is refused (only the bare message from the live log is known).

### Redesign step 3a: addresses, history and dead code (2026-11-11, fixture-tested only)

Packages p0-dead-code and p3-foundation, merged into `redesign`. The plan is
`docs/REDESIGN-PLAN.md`. Nothing below has run on a phone or in WebKit.

**Addresses.** `state/routes.ts` defines three pages: the list (`#!`; push alerts use
`#!action=`), one phone (`#!action=device&udid=..&view=screen|files|shell`) and Notifications
(`#!action=notifications...`, unchanged, so delivered push links still open it). On a phone page
every other key is kept: `path`, `player`, `ws`, `title` and the proxied-host keys. `parseRoute`
reads both forms. `canonicalRoute` turns an older `action=stream`, `stream-coredevice` or `shell`
address into the new form. Files keeps `action=list-files`, because `FileListingClient` reads that
action from `location.hash` (`routeParams`, `identityOf`); a new-form Files address is turned into
the older one. `KEEPS_OLD_ADDRESS` in `routes.ts` is the one switch to flip when Files reads the
new form. (Step 3b flipped it and removed the switch; Files now has the new address.) `clientParams` gives the stream and tool clients the older action, which they parse and
open their sockets with. `deviceHref` and `followLink` (`state/links.ts`) build a phone link
without `player` or `ws` and follow it through the router; no view uses them yet. The service
worker needed only a comment: it leaves alone a window whose address has a `udid`, and both forms
have one.

**The rewrite comes before any view.** `state/router.ts` rewrites an older address with
`replaceState` when the module loads, before the `route` signal exists, then on every
`hashchange` before `route` is set, and inside the verbs. `route` never holds an older phone
address, so a stream view mounts once per open. The new address does not say which platform a
phone is. The router keeps the platform an older screen link named in `localStorage`
(`ws-scrcpy.phones`, at most 50 phones), and `DevicePage` adds the platform and name of a phone
it shows while the phone is listed. It does not record every phone in the list.

**One page per phone.** `views/DevicePage.tsx` mounts exactly one of `StreamView`,
`CoreDeviceStreamView` and `ToolRoute`, so leaving the screen for Files or Shell stops the
stream. It picks the platform once per phone shown: from the list, else from the browser's
memory, and keeps that choice for the visit whatever the list says later. If it knows neither, it
waits 1.5 s and then shows "This phone is not connected" under an `AppBar` with a "Phones"
button; when the phone is listed after that, its screen opens. For an Android screen it picks the
player (webcodecs, else the first one registered) and the socket (this server, or the proxied host
the address names) once per address, so a list update does not restart the stream. `player` and
`ws` in the address override them; `StreamReceiverScrcpy` still refuses a socket on another
server.

**History.** `router.ts` is the only module that writes history. The verbs are `openRoute` (push),
`switchRoute` (replace) and `goUp`. Each entry carries `history.state.nav = {index, below}`, where
`below` is the nearest list entry under it. `goUp` steps back to that entry with `history.go`;
when there is none, it goes back to the first entry the app has in the tab and makes it the
list. So the list is the root, and Back from it leaves the app. `goUp` is wider than a plain
`history.back()` on purpose: until step 3b the switcher and the tool tabs still push, and one
step back from phone B would show phone A's stream again. `navigate`, `goToDeviceList`,
`pushRoute` and `replaceRoute` remain as shims; `goToDeviceList` no longer pushes. `history.go`
finishes in a later task, so the router records the entry it is heading for and holds every
other write until `popstate` reports it, with a one-second fallback. A write that stays on the
page it was asked from (a Files folder or corrected path, a filter, another player) is dropped if
that step has left the page by then, so it cannot show the page again over the list. A refused
leave (uploads in Files) returns to the page's entry instead of pushing a copy of it.

**Overlays.** `ui/overlayHistory.ts` (`useOverlayHistory`, and `openOverlay` for code outside
Preact) gives an open sheet, dialog or menu an entry under the page's address, marked
`nav.overlay`. Back closes the top overlay and leaves the route alone. An overlay that closes any
other way steps back over its entry and closes the overlays opened on top of it. An overlay entry
without its overlay (after a reload, or reached by Forward) is skipped. A change of address closes
every overlay and is written on the page's own entry; that includes a replace that stays on the
page, such as a corrected Files path, because the page entry is under the overlay's. No view uses
the hook yet. Until they do, `App.tsx` closes the signal sheets (`closeAllSheets`) through
`onPageChange`, which fires when another page is shown and not for a change within the page. A
link or button inside an overlay must go through the router (`openRoute`, `switchRoute`, `goUp`,
`followLink`): a plain `href` or an assigned `location.hash` does not wait for the overlay's entry
to be left, and the step back would undo it.

**Header components.** `ui/AppBar.tsx` (back, title, one status slot, actions) and
`ui/TabStrip.tsx` are the stream header and the tool tabs under their own names, with the same
class names. The back control defaults to `goUp` and is labelled `LIST_PAGE_NAME` ("Phones",
owner decision D1); `DEVICE_TABS` in `routes.ts` holds the tabs of decision D2. Only the "not
connected" state uses `AppBar` so far. The header rules moved unchanged to `style/ui/AppBar.css`,
which `AppBar.tsx` imports. (Step 4a removed the `@import` of that file from
`views/StreamView.css`; it changed nothing in the bundle.) `App.tsx` keeps side-effect imports of
`ToolRoute`, `StreamView` and `CoreDeviceStreamView` to keep the order of rules in `main.css`.
Step 4a kept them: layers decide only between layers, and inside one layer that order still
decides rules of equal weight (see the step 4a section). The tab rules are still in
`views/ToolView.css`, which `TabStrip.tsx` imports.

**Unread count.** `startNotificationSummary` refreshed on `hashchange`. `pushState` and
`replaceState` fire none, so it now refreshes through `onPageChange`.

**Dead code removed** (p0-dead-code). Five files nothing imported (`MediaFormat.ts`,
`SimpleInteractionHandler.ts`, `ToolBoxCheckbox.ts`, `ScrcpyFilePushStream.ts`,
`DragAndPushLogger.ts`), the appium and `node-mjpeg-proxy` typings, `ReplyFileListing.d.ts` and
`MessageFileListing.d.ts`, seven unused toolbar icons with their SVG files, and the uncalled
`MsePlayer.jumpToEnd`, `CommandControlMessage.createSetVideoSettingsCommand` and
`createSetScreenPowerModeCommand`, and `ControlBarLayout.trackControlBarInset`. The `Icon` enum
in `ui/SvgImage.ts` renumbered; nothing stores the numbers. `lastFrameAt` and its per-frame
writes in both stream clients are gone: `streamConnected` is the only liveness signal, and its
comment says why frame timing is not one. `FileListingClient.start` and `ShellClient.start` now
require a mount. The CSS half (`style/morebox.css`, unused classes and tokens,
`body.file-listing-page`, the `--control-bar-*` variables that no script sets) is left for
p4-close.

**Tests.** `scripts/test-routes.js` (in `npm test`) drives the router and routes in a fake
session history. The `navigation` browser suite (`scripts/e2e-navigation.js`, in the default
list) counts stream sockets per open, follows older and delivered links, checks Back after the
in-app back control on both widths, and drives the overlay entries in Chromium's own history.

**Not verified.** Back and `history.go` in WebKit and in the installed app; one iPhone session
per open and per Back on a real iPhone; an older Android link on a real phone. History entries
made by the app before this deploy have no `nav`; the first Back onto one tags it as if it were
ahead of the page, so `goUp` can aim at the wrong entry for that tab, and once leave the app if
another site comes before it. Closing and reopening the tab or the installed app clears this.

### Redesign step 3b: one page per phone, Back closes overlays, Notifications in its address (2026-11-11, fixture-tested only)

Packages p3-overlays, p3-tools-nav, p3-device-page and p3-notifications-nav, merged into
`redesign` in that order. The plan is `docs/REDESIGN-PLAN.md`. Each package had a worker branch
`work/<key>` and a review branch `review/<key>`. They are not named `redesign/<key>`: git keeps a
branch as a file path, so a branch `redesign/<key>` cannot exist next to the branch `redesign`.
Nothing below has run on a phone, in WebKit or in the installed app.

**Overlays and Back** (p3-overlays). Every sheet built on `ui/BottomSheet.tsx`, the controls
panel on a phone (`FloatingToolbar.tsx`), Type text (`LiveTextOverlay.tsx`) and
`NotificationActionSheet.tsx` call `useOverlayHistory`; every Files menu and dialog calls
`openOverlay`. Each has a history entry while it is open. The browser's Back closes the top one
and leaves the page and its stream socket alone. Opening or closing an overlay does not change
the `route` signal, so no stream view mounts again. The close button, the backdrop and Escape
step back over the entry. In a sheet, Back does what Escape does: it cancels a confirm prompt
first, and it leaves Stream settings open while Apply runs (the `stays` option: the router steps
forward to the sheet's entry again with `history.go(1)` and pushes nothing).
`NotificationActionSheet` is a native modal `<dialog>`. Chrome on Android sends Back to it as a
close request (a `cancel` event), and its `onCancel` also cancels a prompt first.

**Entries are counted, not owned.** `router.ts` keeps the overlay entries on top of the page equal
in number to the open overlays that have one (`settleOverlays`, run in a microtask). A sheet that
takes the place of another in the same pass keeps the entry, with no history call. `release()`
removes only the overlay released; overlays above it stay open. `pushOverlay` makes its entry in a
microtask, not at once. `shown` follows the entry the tab is on, overlay entries included.

**The press gate.** `ui/overlayHistory.ts` gives an overlay an entry only if the owner has pressed
something (a trusted `keydown` other than Escape, `mousedown`, `pointerup` or `touchend`) since the
page loaded and since the last step through history, the router's own steps included. Chrome skips
an entry that a page added without a press, and the page under it with it. An overlay without an
entry closes with its page, as every sheet did before. What follows from it: an overlay opened
from `page.evaluate`, after `setInputFiles` or after a dropped file gets no entry unless a press
came first; an overlay opened in a later task than the one that closed before it gets none; the
upload question asked after the browser's Back has none, so a second Back is refused like the first
and the question stays.

**Changes within the page.** A replace that stays on the page (`switchRoute` or `replaceRoute`: a
corrected Files path, a Notifications filter or search, another player) is written at once on the
entry the tab is on and leaves the overlays open. On an overlay's entry it is marked `nav.moved`,
and the entry below takes the address and state when the overlay's entry is left (`carryDown`,
also after a reload). A push within the page (a Files folder step, which Files writes when the
folder's STAT arrives) and a change to another page close every overlay first. So a sheet opened
while a folder step is still being checked closes when the step arrives.

**Fixed while integrating.** (1) After Switch, the switcher's entry stays ahead of the page with
the earlier phone's address. Forward reached it, and its `hashchange` showed that phone for a
moment: its stream started and stopped. The router now ignores the `hashchange` of an overlay
entry it steps over on the way back to the page that is shown (`passing` in `router.ts`). (2)
Files released a question's entry before the next question opened. The step back over it cleared
the press that answered, so the next question got no entry and Back left Files. A closed question
now gives up its entry a task later (`dialogRelease` in `FileListingClient.ts`), unless the next
question has taken it over by then. (3) The bell (`ui/NotificationsLink.tsx`) was a plain link. A
Files menu closes on the tap outside it and steps back over its entry, and that step undid the
link. The bell now follows its link through the router (`followLink`), which waits for the step.

**One phone page** (p3-device-page). `DevicePage` builds the tab strip of an Android phone (Screen,
Files, Shell: `DEVICE_TABS` filtered by the tools in the build) and hands it to the views; an
iPhone has none. The stream view is mounted only while `view=screen`, so the stream stops at once
on another tab. Files and Shell are each mounted the first time their tab is shown (one
`ToolRoute` per tool, keyed by phone and server) and stay, hidden, until the page is left for
another phone, the list or Notifications. A hidden tool is `main.tool-view[hidden]`: fixed,
`visibility: hidden`, not `display: none`, so a modal dialog it opens is still shown. It keeps its
workspace at the offset the header and tabs had, so Shell is not refitted and the phone's
terminal is not resized by a tab change. A tab change is
`switchRoute(deviceRoute(udid, view, the rest of the address without ws and path))`, so a player
chosen in Settings survives it. The Files tab link carries the default folder only while Files is
not mounted. `ToolView` tells a tool `setActive(false)` and `setActive(true)` through `MountedTool`,
calls `navigate(path)` on an address change only when the address names a folder, and does not
retry a hidden tool's lost connection until its tab is shown. The header stays inside each view
(`AppBar`), because the typing layout, the tool view's keyboard height and the `.tool-view` rules
need it as a child.

**Tool clients** (p3-tools-nav). A hidden Shell keeps its session and output, gives up focus,
drops a waiting size message and is not fitted. Shown again it is fitted, sends a size the phone
does not have yet, and takes focus on a desktop. A hidden Files keeps its folder, connection and
uploads, closes its menu and dialog, handles no keys and writes no address or history. Shown again
it writes its folder into the address with a replace when the address names none, tags the entry
with its place, shows a result or failure it held while hidden, and lists the folder again unless
a selection, a filter, a listing or an upload is under way. (Step 6a: an upload no longer holds
the relist back; uploads no longer block the explorer.) The upload leave guard compares the
phone (udid and the proxied-host keys), not the view: a tab change asks nothing, and leaving the
phone's page asks from whichever tab is shown. The question ("Leaving this phone stops the upload,
and the file is not saved on it.") opens from a holder on `document.body` with the class
`file-explorer`, so `.file-explorer` matches two elements while it is open.

**Addresses and links.** Files has the phone page's address,
`#!action=device&udid=..&view=files&path=..`; `KEEPS_OLD_ADDRESS` is gone, and an older
`action=list-files` link is rewritten in place. `clientParams` still gives the clients the older
action their sockets open with. Card, switcher and refused-page links use `deviceHref` and
`followLink`; the only link that names a player is the card's "Open with <player>". List to a
phone is an open; Switch, a tab change, the player change and the refused page's "Open screen"
are switches. No view assigns `location.hash` or calls `location.assign` for an in-app address.

**Header and names.** StreamView, CoreDeviceStreamView, ToolView, ToolUnavailable, the
not-connected state and Notifications draw `AppBar`. The list heading, its tab title and every
back control say Phones, and the Actions sheets have no exit row. `AppBar` renders the title as
`<strong>`, so Notifications has no `h1`.

**Notifications** (p3-notifications-nav). The view is its address:
`#!action=notifications[&source=][&panel=setup][&filter=unread|archive][&app=][&q=][&notification=]`,
defaults left out. `state/notificationPage.ts` reads and builds it and imports no router;
`state/notificationNav.ts` writes it with `switchRoute` and writes nothing when another page is
shown. The search text is written 400 ms after the last key (Safari limits history writes) and at
once before a screen is opened. A push link's `notification` parameter leaves the address once the
notification is found. A link to an iPhone that is not linked writes `panel=setup`. The scroll
position and list length are kept in memory under the address when a screen is opened from the
inbox, and restored once on the return; a reload does not restore them.

**Kept on purpose.** `App.tsx:29` `onPageChange(closeAllSheets)`: SettingsSheet refuses `onClose`
while Apply runs, so only this closes it on a page change, and a sheet opened without a press has
no entry for the router to close. The `closeAllSheets()` calls in the mount and unmount effects of
`StreamView`, `CoreDeviceStreamView` and `ToolView` stay; the mount ones close a sheet when a
stream or tool restarts on the same page, which the router does not see as a page change.

**Tests.** `scripts/test-routes.js`, `test-files.js`, `test-shell.js` and
`test-notification-page.js` (all in `npm test`) cover the router, the hidden tools and the
Notifications address. New browser suites, in the default list: `overlay-back` (Back with each
overlay on both stream views, the list and Notifications), `device-page` (tabs, the tools kept
behind them, Switch and Forward, links) and `history-walk` (a walk across the pages at 390x844 and
1280x800, a corrected Files path under the switcher, a folder step under it, an older Files link).
Suites that compare history after a sheet has closed count `history.state.nav.index`: the sheet's
entry stays ahead of the page, and `history.length` counts it.

**Not verified.** The Back gesture in Android Chrome and in the installed app; Chrome's rule that
skips an entry added without a press (Playwright's `goBack` goes to the entry directly);
`carryDown` and `history.go(1)` from a `popstate` handler in WebKit; Safari's swipe back and its
keyboard for Type text; Chrome's close request for the notification sheet; the Android stream
stopping and starting across tabs on a phone, with the server's 30 s grace; one iPhone session per
open after Switch and from a notification; Safari's pacing of `replaceState` for the search text;
the safe-area inset of the Notifications header in the installed app.

### Redesign step 6s: the iPhone services stop without building new ones (2026-11-11, fixture-tested only)

Package p6-server-lifecycle, merged into `redesign` from `review/p6-server-lifecycle`. Server
only: the client and the browser suites did not change. Nothing below has run on a phone or in
the container.

**Stop order.** `src/server/index.ts` lists `CoreDeviceRunner` before the iPhone `ControlCenter`.
`Shutdown` releases the services in reverse start order and did not change, so the tracker stops
first: it takes its listeners off the runner, releases the unlock scheduler, then the state
monitor. The runner stops the sessions after it. The runner's `start()` (a check of the helper's
patches, nothing on the phone) now runs before the tracker's first poll, so a stop during that
poll releases the runner too.

**Nothing is built again.** `ControlCenter` keeps the runner and the monitor it subscribed to in
`init()` (`statusSource`, `stateSource`) and takes its listeners off those. It used to call
`getInstance()` there, which built a new runner when the runner had stopped first. `release()` on
`CoreDeviceRunner`, `DeviceStateMonitor` and `ControlCenter` does nothing the second time and
clears the singleton only when it is that instance (`startServices` releases a service a second
time when a stop arrives during its `start()`). `CoreDeviceProxy` pokes the monitor after input
only if one exists.

**No screen session after a stop.** `index.ts` calls
`CoreDeviceRunner.setShutdownCheck(() => shutdown.isStopping())`. From then on `acquire()` throws
the plain `Server is shutting down` error on any runner, before the device check, the port, the
mount and the spawn. This covers a runner built after the stop by a caller that still asks for the
singleton: `UnlockDriver.run()` does, for a run queued behind another. Such a run builds an empty
runner and monitor, is refused, and the scheduler records `failed-session` as it did before for a
run that reached the released runner. A session still starting when the stop comes is dropped by
the runner's release, and `bringUp` sees that after the mount, before the spawn. The error is the
one a released runner already threw, so the viewer's close code (4009) and the unlock outcomes did
not change.

**Left as it was.** `WebSocketServer.start()` attaches after `HttpServer.start()` listens, but in
the same turn of the event loop (`listen(port)` binds at once and `listening` comes on nextTick),
so no upgrade is dropped. Services still take their dependencies through `getInstance()`, as
decided. The tests are in `scripts/test-coredevice.js` (with the `late` mode of
`scripts/fixtures/shutdown-harness.js`) and `scripts/test-crash-paths.js`. The unlock comments in
`UnlockScheduler.ts` and `IosSettingsStore.ts` no longer cite the plan or the W1/W2 workstreams;
they name the methods, the types and the sections of this file. No unlock statement changed.

**Not verified.** A container stop with an iPhone session open. The log should show
`Stopping iDevice Tracker [...]`, then `Stopping iOS CoreDevice session runner`, then serve-web's
`shutdown complete` for the phone, and Node should exit well inside the 80 s `stop_grace_period`.

### Redesign step 4a: role tokens, one root size and cascade layers (2026-11-11, tested without a phone)

Package p4-tokens, merged into `redesign` from `review/p4-tokens`. Stylesheets and two test
scripts only; no `.ts` or `.tsx` file changed. Nothing a person can see changed. The step is not
deployed on its own: the live container still runs 2f17e28, and `redesign` also carries the
undeployed server change of step 6s.

**Proof that nothing changed.** `scripts/e2e-atlas.js` (suite `atlas`) takes 146 states in both
themes at 390x844 (touch) and 1440x900 (mouse) and records a picture and the computed style of
every element. At integration, the atlas of the base commit (3d60ba9, built from an export) and
the atlas of the merged head matched exactly: 292 of 292 files, no pixel and no computed style
different, with no tolerance. Three runs of the head in a row matched each other. Seven more
states taken with a scratch copy of the suite also matched (28 states, 56 files): the Restart
services and Remount prompts on an iPhone card, the Reboot prompt in the iPhone Actions sheet,
the Remove passcode prompt in Scheduled unlock, the Clear all on iPhone prompt, the erase-text
prompt in Setup, and the app filter field with focus.

**Tokens.** `src/style/tokens.css` has the role tokens of section 2 of the plan next to the older
names, for both themes, with the values of the approved mockup: `--surface`, `--surface-raised`,
`--surface-sunken`, `--border`, `--border-strong`, `--text`, `--text-muted`, `--accent`,
`--accent-text`, `--accent-soft`, `--on-accent`, danger, success, warning, info and neutral as
`-text` and `-fill`, `--scrim`, `--shadow-raised`, `--focus-ring`, `--focus-ring-offset`,
`--disabled-opacity`, font sizes 12/13/15/17/20/24 and 16 for inputs, weights 400/600/700, space
4 to 32, radius 8/12/20/full, control heights 44 and 32, and `--z-header` 5, `--z-overlay` 10,
`--z-sheet` 20, `--z-toast` 30. The names beyond the plan's list (surface-sunken, accent-text,
accent-soft, info, neutral, scrim, shadow-raised, disabled-opacity) come from the mockup; the
header and overlay z values are the worker's choice, as the mockup shows only sheet and toast.
Step 4b should confirm them before building on them. Nothing reads the role tokens yet, and no
older name is aliased to them: the older names keep their values, so no existing rule changed.
Step 4d deletes the older names. The file keeps one dark block, after every light value, because
the contrast tests in `scripts/test-sheet-ui.js` read the file as light, then dark. Breakpoints
(600 and 1024) are only named in a comment; a media query cannot read a custom property.

**One root size.** The root is 16px (`app.css`), and `body` carries the 14px (`--font-size`)
that text with no size of its own had. Every rem and em length is now the px it rendered at
(rem times 14). The one rem in a media condition (`StreamView.css`, 37.5rem) was relative to the
browser's 16px and became 600px. Six rules in `filelisting.css` had em lengths that were a share
of the explorer's own size (12.5px, and 13.5px on a touch screen), so each has a second value
under `(hover: none) and (pointer: coarse)`. No size was moved to the type scale; that is adoption
work in 4c.

**Layers.** Every stylesheet opens with `@layer tokens, base, components, views;` and holds its
rules in its own layer: `tokens.css` in tokens, `app.css` in base, `ui/` in components, `views/`,
`filelisting.css` and `morebox.css` in views. A layer later in that list wins over an earlier one
whatever the selectors weigh. Where a component rule used to win over a page rule by weight, the
rule was moved, not marked `!important`: `body.sheet-open #devices` went from `app.css` to
`views/DeviceList.css`, `.floating-toolbar-panel[data-exiting]` from `app.css` to
`views/FloatingToolbar.css`, and the disabled Wake button from `ui/AsleepBanner.css` to
`views/DeviceList.css`. `views/Notifications.css` still styles `p`, `button` and `a` by tag; those
rules now leave out the confirm prompt's parts, the toast's close button and links with
`.ui-button` through `:where()`, which adds no weight, and the file has one components block (the
toast's close button) and one base block (`.ui-button` links) that keep what those elements had.
The focus rule of `views/NotificationActionSheet.css` leaves out the confirm prompt's buttons the
same way. Both go when p4-adopt-notifications and p4-kit-sheet remove the rules by tag.

Layer order decides only between layers. Inside one layer, rules of equal weight are still
decided by the order of the files in the bundle. That is why the side-effect imports in
`src/app/views/App.tsx` (`./ToolRoute`, `./StreamView`, `./CoreDeviceStreamView`) stay: without
them about 1000 lines of `main.css` move inside the layers, and some selectors are defined in two
views files (`.device-debug-facts` in `views/DeviceList.css` and `views/ActionsSheet.css`). The
`ToolView.css` import in `src/app/ui/TabStrip.tsx` also stays, as the component's own style. The
`@import` of `ui/AppBar.css` at the top of `views/StreamView.css` is gone; `AppBar.tsx` already
puts that file earlier in the bundle.

Three consequences for later steps. xterm's stylesheet (`@xterm/xterm/css/xterm.css`, in the
Shell chunk) has no layer, so it wins over every app rule; no app rule names an xterm element
today, and Shell matched in the atlas. A rule that has to restyle xterm's parts must sit outside
the layers. An `!important` in an earlier layer beats one in a later layer, so the reduced-motion
`!important` durations in `app.css` (base) win over any `!important` a page adds. Cascade layers
need Chrome 99, Firefox 97 or Safari 15.4; an older browser drops every layer block and shows the
page without styles.

**The style test.** `scripts/test-style-rules.js` (in `npm test`) reads every file under
`src/style` without a browser. It fails when a file does not open with the layer order, when a
rule is outside a layer, when a layer block names an unknown layer or sits inside another block,
and when a font size is in rem or em. Outside `tokens.css` it counts, per file, colours written
as values (hex, colour functions and colour names), font sizes written as numbers, radii written
as numbers, z-index numbers, `!important`, and blocks for a layer that is not the file's own
(`otherLayers`). `ALLOWED` at the top of the file holds the count each older file had when the
test was added. The test fails when a count rises above its entry, and a file not in the list is
allowed none, so a new stylesheet must use tokens from the start. A count that falls passes
without touching the list. The test does not force the list down, so a package that moves a
file's values onto tokens lowers that file's numbers in `ALLOWED` in the same commit (and drops
the line when all are zero); otherwise the room it leaves lets raw values come back unnoticed.
Step 4d empties the list. Only font sizes are checked for rem and em; other em lengths are not.

**The atlas suite.** It is in the default list of `scripts/test-browser.js` and takes about two
minutes. Without `ATLAS_COMPARE` it checks that each state can be reached, throws no page error
and comes to rest, and removes its temporary directory. To prove a change is invisible: build the
commit before, run `ATLAS_OUT=<dir> node scripts/test-browser.js atlas`, build the change, and run
again with `ATLAS_OUT=<dir2> ATLAS_COMPARE=<dir>`. `ATLAS_ONLY=<regexp>` limits the states, and
`ATLAS_STYLES=full` writes every computed property instead of a hash, to read a difference. The
style record leaves out custom properties (an unused token would change every hash), the ids
Preact's `useId` makes, and xterm's `.xterm-scroll-area`, whose height xterm sets differently
from run to run. Chromium rasters on one thread so that two runs of one build match. The atlas
does not show the failure screen, the stream failure card, stream and tool notices, the tracker
notice, Bluetooth pairing, Files uploads or Files properties; the rules for those were read, not
compared.

**Left for later.** `src/style/app.css` holds `.live-text-overlay[data-exiting]
.live-text-backdrop` and `.live-text-backdrop`, which no markup uses, and `src/style/morebox.css`
is never imported; both are for 4d. Element selectors under page classes, `!important`,
breakpoints and duplicate button classes are counted, not changed, and are adoption work in 4b
and 4c.

### Redesign step 4b: the kit's controls, sheet and menu (2026-11-11, tested without a phone)

Packages p4-kit-controls and p4-kit-sheet, merged into `redesign` from their `review/` branches,
then joined. The design kit now exists and no existing page uses it: nothing a person can see on
a page of the app changed. The step is not deployed on its own: the live container still runs
2f17e28, and `redesign` also carries the undeployed server change of step 6s.

**Proof that nothing changed.** The atlas of the base (45e94c8, built from an export) and the
atlas of the merged head matched on 292 of 292 files, with no tolerance. The style test passes
with no entry of `ALLOWED` raised; the entry for `app.css` went down from 6 to 5 `!important`.

**The parts.** Each is a thin Preact wrapper over `kit-` classes, so Files and the toolbox can
write the same classes into HTML strings. All are in `src/app/ui`:
- `icons.ts`: 62 icons, each one stroke path on a 24 by 24 grid. `Icon` draws one at 16, 20 or
  24; `iconSvg(name, size)` returns the same markup as a string. Sound has `headphones`, apart
  from `volUp`, `volDown` and `volMute`.
- `Button`: primary, secondary, quiet and danger (danger text on the raised fill, as the
  mockup's `.btn.risk`); `size="compact"` is 32px under a fine pointer and 44px on a touch
  screen; `busy`, `disabled`, `pressed`, `icon`, `full`; with `href` it is a link.
  `buttonClass()` gives the class string. A busy button stays enabled so it keeps focus
  (`aria-busy`, `aria-disabled`), and its press is cancelled, so a busy submit button does not
  send its form again.
- `IconButton`: outlined or bare, compact, danger, pressed, link. It throws at render when its
  label is empty: never build a label from data alone, because the throw blanks the view
  through the ErrorBoundary, and in a stream view that ends the session.
  `iconButtonClass()` gives the class string.
- `Field.tsx`: `TextField`, `TextAreaField` and `SelectField` (44px, radius 12, raised fill,
  border-strong edge, 16px text so iOS does not zoom), each with label, hint and error. They set
  `id`, `aria-label`, `aria-describedby` and `aria-invalid` themselves; values passed for these
  are replaced. `kit-range` is the slider.
- `Switch`: a checkbox with `role="switch"`. `SegmentedControl`: a radio group for two to four
  options. Keyboard use and state come from the browser, so both work on plain markup.
- Messages, three forms only: `InlineStatus` under the control that caused it (neutral,
  success, warning, error), `Banner` at the top of a page or sheet (warning, info, error) with
  one action, and `Toast` with `kit`.
- Sheet parts in `SheetControls.tsx`: `SheetGroup`, `SheetRow`, `SheetToggleRow`,
  `SheetStatus`, `VolumeSlider` and `SoundRows` take `kit`; `SheetSelectRow`, `SheetMessageRow`
  and `SheetFooter` are new and exist in the kit look only. `Disclosure` (in
  `AnimatedDetails.tsx`) is the kit disclosure, and its marker is one rule in
  `style/kit/Disclosure.css`, without `!important`.
- `AppBar` and `AppBarStatus` take `kit` (and `root`, and `onTitle` with `titleLabel` for the
  phone switcher). The kit bar's title is an `h1` unless it is a button. `TabStrip` takes `kit`.
- `ConfirmPrompt` takes `kit`: the classes `kit-confirm`, `-question`, `-consequence` and
  `-actions`, with the kit's buttons; a removal is confirmed on the solid danger fill.
- `Sheet.tsx` and `Menu.tsx`, described below.

New tokens in `tokens.css`: `--accent-pressed`, `--surface-inverse` (the toast; `#3a3f49` in
the dark theme), `--on-inverse` and `--shadow-control`. `--z-header` (5) and `--z-overlay` (10)
are confirmed: the kit bar uses `--z-header`, the menu's fallback `--z-overlay` and the kit
toast `--z-toast`.

**The side-by-side rule.** A new kit class starts with `kit-` and lives in a stylesheet under
`src/style/kit/`, in the components layer; `scripts/test-style-rules.js` reads that folder as
components and allows it no raw colour, font size, radius, z-index or `!important`. A shared
component that pages already use (AppBar, AppBarStatus, TabStrip, Toast, the sheet group and
rows, VolumeSlider, SoundRows, ConfirmPrompt) keeps its markup and classes by default and takes
the kit look only when an instance passes `kit`. Without `kit` each renders exactly as before.

**How a view adopts the kit (step 4c).** Pass `kit` to the shared components the view uses,
replace its own buttons, fields, switches and messages with the kit parts (or the class
strings, in code that builds HTML), move BottomSheet users to `Sheet`, and then delete the
view's old rules and lower its numbers in `ALLOWED`. The class names and test selectors that
change:
- `.stream-header`, `-back`, `-device`, `-status`, `-status-dot` become `.kit-bar`,
  `.kit-bar-back`, `.kit-bar-title`, `.kit-bar-name` and `.kit-bar-status` (no dot, no
  `connected` class).
- `nav.tool-navigation`, `.tool-tabs` and its buttons become `nav.kit-tabs`, `.kit-tabs-list`
  and `.kit-tab`; `aria-current` stays.
- `.app-toast`, `.toast-message`, `.toast-action`, `.toast-close` become `.kit-toast` and
  `.kit-toast-message`, `-action`, `-close` (no `.toast-error`, no tick for success).
- `.sheet-group`, `-title`, `-hint`, `-card` become `.kit-group`, `.kit-group-title`,
  `.kit-group-hint` (now under the card) and `.kit-card.kit-list`. `.sheet-row` inline, stack
  and pair become `.kit-row`, `.kit-row-stack`, `.kit-row-pair`, with `.kit-row-text`, `-title`,
  `-desc` and `-control`. `input.sheet-switch` becomes `input.kit-switch[role=switch]` inside
  `label.kit-row-toggle`. `.sheet-status.<tone>` becomes `.kit-status.kit-status-<tone>`.
  `.sheet-volume` becomes `.kit-volume` with `input.kit-range`. `.sheet-details` becomes
  `.kit-disclosure`.
- `.confirm-prompt`, `-question`, `-consequence`, `-actions`, `-button` become `.kit-confirm`
  and its parts, with `.kit-button` buttons (`.kit-confirm-go`, `.kit-confirm-cancel`).
- `.bottom-sheet-root.open` becomes `dialog.kit-sheet[open]`; `.bottom-sheet` becomes
  `.kit-sheet-panel`; `-backdrop`, `-handle`, `-heading`, `-title`, `-subtitle`, `-close` and
  `-body` keep their names under `kit-sheet-`; `.bottom-sheet-drag-region` and
  `.bottom-sheet-header` become `.kit-sheet-header`. The role and the name move from the panel
  (`aria-label`) to the dialog (`aria-labelledby`).
- `.fx-menu` and its items become `.kit-menu` and `.kit-menu-item`, placed by `bindMenu`.
About 20 browser scripts select `.stream-header`, eight select the tab names, four the toast
names, five the sheet group names and about 85 lines the BottomSheet names; each adoption
package updates the suites for the screens it moves.

**Sheet, on the native dialog.** `Sheet` has BottomSheet's props plus `footer`. It is a
`<dialog>` opened with `showModal()`: below 600px a bottom sheet, from 600px a dialog 560px wide
and centred across the window, whatever the pointer. The top edge of the dialog is fixed (as in
988a9db), not centred vertically as in the mockup. The `<dialog>` covers the window and is
transparent; inside it are `.kit-sheet-backdrop`, a real element so a press on it closes the
sheet in every browser (`::backdrop` is left transparent), and `.kit-sheet-panel`, which is what
moves. The close control is the kit `IconButton` with the class `kit-sheet-close`. The dialog
stays mounted while closed, so the children keep their state, as in BottomSheet. What it carries
over from BottomSheet: the history entry through `useOverlayHistory` with its `stays` option,
Escape cancelling a confirm prompt first, the stop of touch, mouse and wheel events at the sheet
so a gesture in it never reaches the listeners that drive the phone, the list scroll lock and
`body.sheet-open` (counted, so a stacked sheet keeps it), focus on the dialog itself so opening
a sheet does not raise the phone keyboard, focus kept inside, the header drag on a bottom sheet,
the visual-viewport variables for an on-screen keyboard, and focus returned to the opener or to
the floating controls button. What the native dialog changed:
- Escape is answered at keydown, so the browser raises no close request of its own.
- The dialog's `cancel` event (what Chrome on Android sends for Back on a modal dialog) runs
  the same close request: a confirm prompt first, then a menu inside the sheet, then the sheet
  if it may close.
- When the browser closes the dialog itself (a second close request with no press in between
  cannot be cancelled), the `close` handler shows it again, so only `open` decides.
- A modal dialog makes everything outside it inert and draws it behind. `AboveSheet` renders
  its children inside the top open sheet; `Toast` uses it, so a toast raised while a sheet is
  open shows above it and can be pressed. The toast mounts again, and plays its entry, when a
  sheet opens or closes under it.
- A sheet opened from inside another stays open while the outer one is open; a sheet that
  takes the place of another must be its sibling, because a dialog inside a closed dialog is
  not drawn. A closing sheet stays modal for its exit (about 220 ms).
- `sheetDrag.ts` and `Presence.tsx` take the media query under which a sheet is a dialog; the
  default is BottomSheet's.

**Menu.** `bindMenu(menu, anchor, onClose)` works on any markup with `.kit-menu` and
`.kit-menu-item` (roles `menu` and `menuitem`, `menuitemcheckbox` with the kit check icon), and
`<Menu>`, `<MenuItem>` and `<MenuSeparator>` wrap it. The menu sits in the top layer through the
Popover API (Chrome 114, Safari 17, Firefox 125), above any sheet; without that API it is a fixed
box. It opens under its button, or above it when there is no room, takes the arrow keys, Home and
End, has one history entry through `openOverlay`, and closes on Escape, Tab, a press outside,
Back and a scroll that moves its button; a scroll elsewhere leaves it open. Focus goes back to
the button, and a sheet opened from a menu item returns focus to the menu's button when it
closes (`menuButtonOf`, and the second argument of `rememberDialogFocus`). Items are 44px high
everywhere.

**The kit page.** `#!action=kit` (`src/app/views/KitPage.tsx`) shows every part in every
variant and state with its name beside it, then a section of sheet examples and a menu. The
separate page `#!action=kit-sheets` was folded into it. Nothing in the app links to it and no
route writes that action; it ships in the main bundle. `KitPage` is imported last in `App.tsx`
so it moves no stylesheet of the views earlier in the bundle.

**Tests.** `scripts/test-kit.js` (in `npm test`) checks the icon paths, the button's classes
and states (a busy press is cancelled), the refused icon button, the switch, the messages and
the sheet parts with and without `kit`. Browser suite `kit` (default list) measures the kit
page at 390x844 touch and 1440x900 mouse in both themes: heights, type sizes, radii, that every
colour is a role token, contrast, one accent fill, the focus ring on all of about 85 stops, the
switch and segments by keyboard, and the kit toast; it leaves the contents of a closed sheet
out. Browser suite `kit-sheet` (default list) runs on the same page: the width rule, the header
and footer, history and Back, the confirm-first order, a busy sheet, focus, stacking, the toast
above a sheet, the event stop, the visual viewport, and the menu. Both take screenshots when
`E2E_OUT` is set. With reduced motion every property still has a 0.01ms transition (`app.css`),
so a test waits a frame before it reads a computed style after a change.

**Not verified on a phone.** The on-screen keyboard in a sheet on iOS Safari, Back on Android
reaching the dialog as a `cancel` event, and the installed app. The suite simulates the first
two with a stubbed `visualViewport` and dispatched `cancel` and `close` events. Nothing ran in
WebKit or Firefox.

**Left for 4c and 4d.** `src/app/googDevice/localKeyboardTarget.ts:4` checks
`.bottom-sheet-root.open`: add `dialog.kit-sheet[open]` when the first stream sheet moves to
`Sheet`. While both containers exist, BottomSheet removes `body.sheet-open` on close even when a
Sheet is still open, so do not open one over the other. `SheetFooter` (actions after the last
group, scrolling with the body) and the Sheet's `footer` slot (kept in view under the body)
overlap; p4-adopt-sheets picks one. A status chip and an unread badge on an icon button are not
built. The old tab rules stay in `src/style/views/ToolView.css` until 4d, because they share a
declaration block with other tool-page buttons. In 4d the `:where()` list of the marker rule in
`kit/Disclosure.css`, the summary hover rule in `app.css`, `DESKTOP_DIALOG` in `sheetDrag.ts`
and its copy in `Presence.tsx`, and `.bottom-sheet-drag-region` in the no-select rule of
`app.css` go with the older containers.

### Redesign step 4c: every screen on the kit (2026-11-12, tested without a phone)

Packages p4-adopt-screen, p4-adopt-sheets, p4-adopt-list, p4-adopt-notifications and
p4-adopt-files, merged into `redesign` from their `review/` branches in that order, then joined.
This is the step where the app changes its look. It is not deployed on its own: the live
container still runs 2f17e28, and `redesign` also carries steps 6s, 4a and 4b. The deploy and the
check on the phones come after step 4d.

**Which screen uses which kit part.**
- A phone's page (`StreamView`, `CoreDeviceStreamView`, `DevicePage`, `ToolView`,
  `ToolUnavailable`, the not-connected page): `AppBar kit` (the name is the page's one h1, the
  status is `.kit-bar-status` with no dot), `TabStrip kit` (`nav.kit-tabs`), Switch as a compact
  `Button`, stream notices and the tool banner as kit banners, the failure, stopped and sleep
  cards with kit buttons (the sleep card has a Wake button), the Shell keys as compact `Button`
  and `IconButton`. The lock notice is the kit's info banner across the page.
- The controls (`GoogToolBox`, `ApplToolBox`, `soundButton`): each is
  `button.kit-icon-button.kit-icon-button-bare.control-button` with an icon from `iconSvg()`.
  New kit part `kit-icon-button-captioned` (`style/kit/IconButtonCaption.css`) keeps the caption
  and the whole tile as the press target, and draws the focus ring inside the tile. The controls
  button is the outlined `IconButton` look with the kit grid and close icons. `SvgImage.ts` and
  the Material files are deleted.
- Sheets: Stream settings, Scheduled unlock, both Unlock sheets, both Actions sheets, Type text,
  Switch phone, the Notifications sheets and the Files dialog are all `dialog.kit-sheet`.
  Nothing under `src/app` imports `ui/BottomSheet.tsx` any more. The Files dialog is the kit
  sheet written as markup with the sheet's helpers (`FileListingClient.ts`), because it keeps
  its own history logic from step 3b. `NotificationActionSheet.tsx` is a wrapper over `Sheet`
  that only adds a focus fallback.
- Sheet rows: `SheetGroup`, `SheetRow`, `SheetToggleRow`, `SheetMessageRow`, `SheetStatus`,
  `VolumeSlider` and `SoundRows` with `kit`; select rows are `SheetRow layout="pair"` with a
  `SelectField`. Actions that end a sheet are in the `Sheet` footer slot; `SheetFooter` is used
  only by the kit page.
- The Phones list: `AppBar kit root` (h1 "Phones", the summary as its status line, the bell and
  Reload as icon buttons), cards with kit buttons, `Chip` for the status, `Badge` for unread
  counts, banners for card conditions (a local `CardBanner` in `DeviceCard.tsx:150`) and
  `InlineStatus` for the outcome of a card command, under the control that sent it.
- Notifications: `AppBar kit`, `SegmentedControl` for the page tabs and the inbox filter,
  `TextField`, `SelectField`, `Switch`, `Checkbox`, `Disclosure`, `Banner`, `InlineStatus`, kit
  `Toast` and `ConfirmPrompt`, and `Chip` for the state of a link (integration change).
- Files: `buttonClass()` and `iconButtonClass()` in its HTML strings (compact: 32px under a
  mouse, 44px under a finger), `iconSvg()` for every icon including the file types, and one
  persistent `.kit-menu.kit-menu-compact.files-menu` opened through `bindMenu`.

**New kit parts.** `Chip` (`ui/Chip.tsx`, `kit/Chip.css`; neutral, success, info, warning, and
a solid error), `Badge` (`ui/Badge.tsx`, `kit/Badge.css`), `Checkbox` (`ui/Checkbox.tsx`,
`kit/Checkbox.css`; sheets and Notifications each added one, joined at integration with the
label as children and an optional `describedBy`), `kit-icon-button-captioned`, and
`kit-menu-compact` (`kit/Menu.css`; `<Menu compact>` since integration). All have specimens on
`#!action=kit`; the kit-sheet suite opens the compact menu and measures it (32px items under a
mouse, 44px on touch).

**Integration changes.**
- `scripts/test-stream-config.js` and `scripts/test-notifications-style.js` are in `npm test`;
  suite `files-kit` is in the default list of `scripts/test-browser.js`.
- The Files menu hook class is `files-menu` (was `fx-menu`), and the row whose menu is open is
  `fx-row-menu-open` (was `fx-menu-for`).
- The atlas checks, in every state, that no element carries a class of a part the kit replaced
  (`OLDER_CLASSES` in `scripts/e2e-atlas.js`: `stream-header`, `tool-tabs`, `tool-navigation`,
  `app-toast`, `bottom-sheet`, `sheet-row`, `sheet-group`, `confirm-prompt`, `fx-button`,
  `fx-menu`, `ui-button`, `sheet-button`, `settings-sheet`, `unlock-sheet`, `live-text-bar`,
  each with its own parts). Its sheet helpers name only the kit sheet.
- `.stream-header button` (`ui/AppBar.css`) and `.tool-tabs button` (`views/ToolView.css`) are
  deleted: no page draws the older header or tabs.
- overlay-back now presses a key on the picture while each sheet of the screen is open (Actions,
  Settings, Switch, Type text, Unlock, on both kinds of phone) and checks that nothing reaches
  the phone, then checks that the same key does reach it with nothing open.
  `localKeyboardTarget.ts` names `dialog.kit-sheet[open]`, which also covers the Files dialog.
- The lock notice is the kit's info banner with a compact Unlock button (it was a band with a
  primary button), so the screen's notices share one form.
- In Stream settings, Listen sits beside its text as in the Actions sheet; the row goes to two
  lines on a phone only when Retry audio shows too.

**Stream path.** The stream effects, their dependencies, the keyed stage and the mount order in
`StreamView.tsx` and `CoreDeviceStreamView.tsx` are as at 4031c80; only the chrome around the
stage changed. `DevicePage.tsx` changed only `AppBar kit`, `TabStrip kit` and one button. No
route, router or service worker file changed. Type text still begins and ends its typing session
on `open`, not on mount, although the kit sheet keeps it mounted while closed. One socket per
open is asserted in navigation, device-page, history-walk and overlay-back.

**UI text that changed** (old, then new):
- Sleep card: one large button "Screen is off / Tap to wake the device", then "Screen is off"
  with a "Wake" button.
- iPhone card screen link: "Open screen →", then "Open screen".
- Switch phone rows: "Screen →" and "Asleep →", then "Screen" or an "Asleep" chip with an arrow
  icon; the current phone shows a "Viewing" chip.
- Type text: the "Done" button is gone; the header's close button is "Close Type text". The key
  labels "←", "→", "⌫ Delete" and "Enter ↵" are icons with the same names (Move cursor left, Move
  cursor right, Delete previous character, Send Enter).
- Shell keys: "↑" and "↓" are arrow icons with the same names (Previous command, Next command).
  Step 6a renamed them Up arrow and Down arrow and added Left arrow and Right arrow.
- Card Settings button tooltip: "Stream settings" or "Scheduled unlock", then
  "Settings for <name>" (its name was already this).
- The bell no longer shows the word "Notifications" at 480px and wider; its name is unchanged.
- Notification sheets: the close button "Close actions", then "Close <sheet title>".
- Notifications, "Filter by app · N selected" is the disclosure "Filter by app" with
  "N selected" or "All apps" as its note. The reason the "Open iPhone screen" button is off is a
  line under the button, not inside it.
- Files: the submenu's "‹ Back" is "Back" with an icon; menus are named "Item actions" and
  "Folder actions"; dialog close buttons are "Close <title>" or "Close this question".
- Stream settings: the quality presets no longer show their figures on each button (they show
  in the line under Quality); "No encoders were listed" replaces the encoder row's description.
- The failed-panel notice keeps its text "This panel failed"; its title is an h2.
No other label changed. "Device" is still in "Unlock device", "Device locked", "Device media",
"Device controls", "Switch device" and "Find a device…"; phase 5 owns the wording.

**What `ALLOWED` still holds** (`scripts/test-style-rules.js`): `app.css` colours 3, font sizes
3, radii 1, `!important` 5; `morebox.css` z-index 1, `!important` 1; the older shared files
`ui/AppBar.css` (font sizes 2, radii 1, `!important` 1), `ui/BottomSheet.css`,
`ui/ConfirmAction.css`, `ui/SheetControls.css` and `ui/Toast.css`, which 4d deletes; and four
view files with only a stacking order or a black: `views/FloatingToolbar.css` z-index 2,
`views/SleepOverlay.css` z-index 1, `views/StreamView.css` colours 2 and z-index 4,
`views/ToolView.css` colours 1. Every other stylesheet holds tokens only.

**Left for step 4d.**
- Delete the older parts and their non-kit branches: `ui/BottomSheet.tsx` and
  `ui/BottomSheet.css`; the branch without `kit` in `ui/AppBar.tsx:81-131` and
  `ui/AppBar.css`; `ui/TabStrip.tsx:55-56` and `views/ToolView.css:15-32` (`.tool-navigation`,
  `.tool-tabs`); `ui/Toast.tsx:75` and `ui/Toast.css`; `ui/ConfirmAction.tsx:240-245` and
  `ui/ConfirmAction.css`; the non-kit branches of `ui/SheetControls.tsx` (after each
  `if (kit)`, and `SoundRows:317-334`) and `ui/SheetControls.css`; `SheetFooter`
  (`ui/SheetControls.tsx:217`, kit page only); `.bottom-sheet-root.open` in
  `googDevice/localKeyboardTarget.ts:8`; `DESKTOP_DIALOG` in `ui/sheetDrag.ts:3` and its copy in
  `ui/Presence.tsx:8`.
- `src/style/app.css`: `.stream-header` and `.bottom-sheet-drag-region` in the no-select rule
  (:46-47; the kit bar gets the same rule for the phone page only, `views/StreamView.css`);
  `body.list` (:104), taken back by the negative margins of `.devices-page`
  (`views/DeviceList.css:6`); `.notification-unread-count` (:160), still drawn by `UnreadBadge`
  (`views/NotificationHistory.tsx:33`) in the Notifications bar with a raw colour and 11px; the
  `:where()` lists at :219-228 (`.notifications-page`, `.bottom-sheet`, `.stream-header`,
  `.notification-link-button`; decide the kit toast's press in `kit/Toast.css` first, because
  `.notifications-page` still gives it one); :249 (`.settings-advanced`, `.settings-playback`,
  `.sheet-details`, `.notification-details`); `.device-list-header` and `.tool-navigation` in the
  surface-enter rule (:264-266); `.settings-sheet-apply-bar` (:298, :370);
  `.toolbar-close-glyph` and `.toolbar-controls-glyph` (:302-317);
  `:where(.tool-view, .live-text-bar, .sleep-overlay-card) button` (:337-344); the field rules
  for `.sheet-input`, `.settings-sheet-row`, `.notification-search-row input` and
  `.live-text-input` (:348-364).
- `kit/Disclosure.css:10-13, 30-33, 41-44` list `.settings-advanced`, `.settings-playback`,
  `.sheet-details` and `.notification-details`. `ui/StreamServiceStatus.css:35` exists only for
  the older header. `views/DeviceList.css:197` `.device-debug-facts dd` also styles the iPhone
  Actions sheet.
- The webpack rule for `.svg` (`webpack/ws-scrcpy.common.ts:52`), `typings/custom_svg.d.ts` and
  the `svg-inline-loader` dependency (`package.json:83`) have no user; removing the dependency
  needs the owner's leave.
- `control-button` stays as a hook class without rules (`toolbox/ToolBoxButton.ts:13`): the
  views, FloatingToolbar's disable-by-title and 17 scripts find the controls by it. p5-controls
  removes it with the title matching.
- `views/FloatingToolbar.tsx:104-110, 195-197, 405` (`openedOverSheet`, the `liveTextOpen` part
  of `sheetOpen`) is dead now that a modal sheet covers the controls button. Step 4d made Type
  text not modal again, so this code is in use again: do not remove it.
- Kit decisions: a toast above a bottom sheet covers the sheet's last action
  (`ui/Toast.tsx:151`, `ui/Sheet.tsx:262`); Notifications holds its toasts while a sheet is open
  (`views/NotificationHistory.tsx:228`, `views/NotificationsView.tsx:440`). `ui/Sheet.tsx:154`
  hears Escape only inside the dialog (the switcher works round it,
  `views/DeviceSwitcherSheet.tsx:161`). `ui/Banner.tsx` passes no event and takes no
  aria-label, hence `CardBanner`. `kit/Group.css:104` lets a select shrink to about 40px beside a
  long description. `kit/Button.css` has no user-select rule and no solid danger variant (Files
  borrows `kit-confirm-go` in a `kit-confirm-danger` footer). `kit-button-compact` keeps 13px
  labels on a phone.
- `scripts/e2e-deeplink.js:41-61` (phone only, already stale) looks for a control titled
  "Switch device".

**Behaviour that changed, beyond the look.** Type text was modal in this step: a press on the
picture closed it and did not reach the phone. Step 4d undid this (U-stream-5 holds again; see
that section). The list's bar stays in place. Notifications sets body class `notifications`, not
`list`, and pads its own sides and bottom. Notifications hides a toast while a sheet is open
and shows it again, with its timer restarted, when the sheet has gone. Files menus sit in the
top layer, close when their button is pressed again or scrolled away, and keep list shortcuts
from running behind them. Kit sheets stay mounted while closed. The tab row moves by about
10px between Screen (two status lines in the bar) and Files or Shell (one), as it did before
the kit; the one screen view of p5-screen-shell puts the status in one place.

**Tests.** All default browser suites pass, including `files-kit`; `npm run check` passes. The
atlas reaches 146 states and finds no older class name in any of them. A contrast probe over
every atlas state (run once, not kept) found no text under 4.5:1 outside disabled controls; the
lowest is 4.96:1, white on the accent. Focus rings are measured by the kit, device-page,
files-kit, home and notifications suites.

**Only a phone can show.** The picture and touch aim under the taller header (61px with one
status line, 71px with the stream service line; tabs 45px); holding Power, volume and Siri on the
new tiles; the iOS keyboard raised by `focus()` in a sheet shown in the same tap, and Type text
standing on it; the Unlock footer above the keyboard and Enter submitting through a button
outside the form; Back on Android reaching a kit sheet, the switcher or the Files dialog as a
`cancel` event; the list and Notifications bars under a real notch in the installed app; the
native time field in Scheduled unlock; the switch, tick boxes and selects in iOS Safari;
swiping notifications by finger; the Files sheet over the keyboard and the menu in the top layer
in Safari 17. Nothing ran in WebKit or Firefox.

### Redesign step 4d: one look, and Type text leaves the picture in use (2026-11-12, tested without a phone)

Packages p4-type-text and p4-close, merged into `redesign` from their `review/` branches in that
order, then joined. This ends phase 4. It is not deployed on its own: the live container still
runs 2f17e28, and `redesign` carries steps 6s and 4a to 4d. The phone check and the deploy come
next; the walk for it is at the end of this section.

**The kit look is the only look.** `AppBar`, `AppBarStatus`, `TabStrip`, `Toast`,
`ConfirmPrompt` and the sheet parts in `ui/SheetControls.tsx` (`SheetGroup`, `SheetRow`,
`SheetToggleRow`, `SheetStatus`, `VolumeSlider`, `SoundRows`) have one markup with the `kit-`
class names and no `kit` prop; `AppBarStatus` also lost `connected`. No caller passes `kit`, and
the type check refuses one. The side-by-side rule of step 4b is over: a new part or a new rule
for a view uses the kit classes and the role tokens from the start, and nothing older is kept
beside it.

**What was deleted.** `ui/BottomSheet.tsx` and `SheetFooter`; the stylesheets
`ui/BottomSheet.css`, `ui/AppBar.css`, `ui/Toast.css`, `ui/ConfirmAction.css`,
`ui/SheetControls.css`, `ui/NotificationsLink.css` (its 359px bell rule moved to
`views/StreamView.css`) and `morebox.css` (never imported); the old tab rules in
`views/ToolView.css` and the older header rule in `ui/StreamServiceStatus.css`; `DESKTOP_DIALOG`
in `ui/sheetDrag.ts` and its copy in `ui/Presence.tsx` (a sheet passes `SHEET_DIALOG`, and a
`sheet` presence without a query always slides); `.bottom-sheet-root.open` in
`googDevice/localKeyboardTarget.ts`; the `.svg` rule in `webpack/ws-scrcpy.common.ts` and
`typings/custom_svg.d.ts`. In `app.css`: the page-wide button rules
(`:where(#devices, .notifications-page, ...) button` and `:where(.tool-view, ...) button`),
`.flex-center`, `.wait`, `.ui-button*`, `.notification-unread-count`, the toolbar glyphs,
`.live-text-backdrop`, the older field rules, `.device-list-header`, `body.list` and
`body.shell`. At integration also the Type text field's halo from before the kit
(`.live-text-input:focus-visible`), so the field has the kit focus ring only, as every other
field. `svg-inline-loader` (`package.json:83`) is now an unused dependency; removing it needs the
owner's leave.

**Tokens.** `tokens.css` holds the role tokens, the motion tokens (`--motion-fast`,
`--motion-settle`, `--motion-exit`, `--ease-out` and the new `--press-transform`) and the font
stacks (and the new `--font-size-root`). The 51 older names are gone with no alias; each use
moved onto the role token with the same meaning, and where the values differed the role token
won. Body text is 15px (`--font-size-15`, was 14px). `scripts/test-sheet-ui.js` fails when a
stylesheet reads a custom property that no stylesheet defines and no script in `src/app` sets.

**Reduced motion without `!important`.** Under `prefers-reduced-motion` the motion tokens are
0.01ms and `--press-transform` is `none`, and `app.css` gives every other transition and
animation 0.01ms in the base layer. So a press scale is written
`transform: var(--press-transform)`, and a raw duration in a components or views rule is not
shortened unless that rule has its own reduced-motion block. xterm's CSS is outside the layers:
the Shell cursor now blinks at its normal rate under reduced motion (`!important` used to force
0.01ms).

**Small kit changes.** `Button` has a `danger-solid` variant for the answer that confirms a
removal. `ConfirmPrompt` with `danger` and the Files dialogs (Replace and the removals) use it;
`kit-confirm-go` is a hook class only. On a touch screen `kit-button` and `kit-icon-button` take
no text selection and no iOS callout on a long press, so a long press on Open screen, a card's
Files or Shell link or the bell no longer offers "Open in new tab". A select at the end of a row
is never narrower than its options and takes at most 70% of the row. The Notifications unread
count is the kit badge (`kit-badge kit-badge-inline`, with `notification-unread-count` kept as a
hook class). Toast buttons have a press of their own on every page; the back control, the tabs
and the switcher rows no longer scale on press on Files and Shell (that came from the deleted
`.tool-view button` rule, and Screen never had it).

**The style test** (`scripts/test-style-rules.js`, in `npm test`). No stylesheet holds
`!important`. A width in a media or container query is 600 or 1024px (599 or 1023 for the side
under it); the other widths the views still use are listed in `VIEW_BREAKPOINTS` for phase 6, and
a view may not add one. `ALLOWED` holds four entries, each with its reason, and each must equal
the file's real count, so a value that goes away must leave the list too:
- `views/FloatingToolbar.css`, z-index 2: the controls (8) and their shield (4) over the picture.
- `views/SleepOverlay.css`, z-index 1: the sleep overlay over the picture, under the header.
- `views/StreamView.css`, colours 2 and z-index 4: the black behind the picture, and the order of
  the picture, its touch layer and the two failure cards.
- `views/ToolView.css`, colours 1: the black around the terminal, the colour xterm draws it in.
  The brief named only the black behind the picture; this one was kept as the same case. The
  owner may want it made a token.
Every other stylesheet holds tokens only.

**The sheet that is not modal.** `ui/Sheet.tsx` takes `modal` (default true). With
`modal={false}` the dialog is opened with `show()`, not `showModal()`, and has the class
`kit-sheet-modeless` (`kit/Sheet.css`): no backdrop, no drag and no handle; the dialog lets
presses through and only the panel takes them, at `z-index: var(--z-sheet)`. The page is not
inert, the body gets no `sheet-open` class, and the sheet is never `topSheet`, so a toast raised
meanwhile stays on the page. It keeps what every sheet has: the header and its close control, the
history entry (Back closes it; a tab change or another page closes it), Escape and the Tab trap
while focus is inside it, focus back to the opener, the visual-viewport variables, and the stop
of touch, mouse and wheel events inside it. Only Type text and the kit page's specimen "Sheet
that leaves the page in use" use it. Every other sheet is modal as before.

Why Type text: the owner taps the next field on the phone and goes on typing (U-stream-5, as in
phase 2 at 4031c80). Step 4c had made Type text modal, so a press on the picture closed it and
was lost. Now a press on the picture reaches the phone, Type text stays open and its field keeps
focus: `LiveTextOverlay.tsx` gives focus straight back to the field when the Android screen
(`.touch-layer`) takes it, as at 4031c80; the iPhone screen does not take focus. Type text keeps
its place from step 4c, at the bottom of the window with the picture fitted above it. With the
controls button in reach again, the panel opened over Type text (`openedOverSheet` and the
`liveTextOpen` part of `sheetOpen` in `views/FloatingToolbar.tsx`) is in use again; Back closes
the panel first, then Type text.

One exception to the step 4b rule that a closing sheet stays modal for its exit: when a sheet
that is not modal opens while a modal sheet is still playing its exit (iPhone Actions, then Open
Type text), the modal one's dialog closes at once (`endExit` and `exitEnded` in `Sheet.tsx`). A
closing modal dialog keeps the whole page inert for about 220 ms, so the field could not take
focus in the tap, and iPhone Safari raises its keyboard only for a focus in the tap. If that
sheet opens again before its exit would have ended, it is shown again as a modal. The visible
effect: Actions goes without its exit animation when it hands over to Type text.

**Keys.** `localKeyboardTarget.ts` matches `dialog.kit-sheet[open]`, which also matches a dialog
shown with `show()`. While Type text is open no key reaches the phone through the capture path,
wherever focus is, and a key typed in the field is sent once (Android: one text message and no
key event; iPhone: one key press). The selector must stay `[open]`: `:modal` would let keys
reach the phone while Type text is open.

**Proof without a phone.** New checks in default suites, each shown to fail on a build of
7cca59f: `e2e-ios-typing.js` `pictureFlow` (an iPhone picture from a stubbed `VideoDecoder`:
presses reach the phone, the field keeps focus, one key press per key, one session, and focus in
the press from Actions); `e2e-sheet-chrome.js` `typeTextKeepsPicture` (replaces
`typeTextIsASheet`; Android at 390x844 and 1280x800, both themes); `e2e-overlay-back.js`
`pageInUseUnderTyping` (replaces `nothingOpensOverTyping`) and the Type text `modal: false` and
typed-once checks; `e2e-kit-sheet.js` `modeless`. overlay-back still presses a key on the picture
under every sheet of the screen on both kinds of phone and checks that nothing reaches the phone,
and that every sheet but Type text is modal. At integration `e2e-sheet-chrome.js`
`modalSheetsHoldPresses` was added: on an Android screen at both widths, Actions, Stream settings
and Switch are modal with their backdrop over the picture, and a press or a wheel there reaches
nothing and closes the sheet; with nothing open the same press reaches the phone. It passes on
7cca59f too: it guards the other sheets, not the change. Unit checks:
`test-style-rules.js` (no `!important`, breakpoints, exact `ALLOWED`), `test-kit.js` (one look
for the sheet parts, the long press, the select width, the unread badge, `danger-solid`) and
`test-sheet-ui.js` (role tokens only); the kit suite measures the row select in the browser. No
test file is new, so `package.json` and `scripts/test-browser.js` did not change. At
integration `pressAtRest` in `scripts/e2e-files.js` also makes a trial press before the press.
`files-flows` "menus on short screens" failed about one run in four, on a build of 7cca59f too:
when something covered the row menu button at 926x428, Playwright scrolled again inside the
press, the scroll event came after the press, and the menu closed as a scroll that moves its
button should. The trial press does that scroll first; a probe of the same steps went from 5
failures in 40 to none. A real tap does not scroll, so the app did not change.

**Atlas.** At integration the base (7cca59f, built from an export) and the merged head were
each taken twice, with style hashes and with `ATLAS_STYLES=full`. 44 of 292 files have pictures
that differ, and each was looked at:
- 36 are the Notifications unread count in the bar, now the kit badge (`#c82e40` to
  `--danger-fill`, 11px to 12px, the same size and place).
- 8 are Type text, on both kinds of phone at both widths in both themes: no scrim over the
  picture and the bar, no handle, the field's focus ring whole on a phone (4px moved from the
  header to the body; the sheet keeps its height), and the field without its older halo.
Every other difference is in computed style only and paints nothing in any state: text that
inherits 15px instead of 14px, `user-select: none` on kit buttons and links on a touch screen,
the body colours under the views (`body.stream` is `--surface-sunken`, `body.shell` has no black),
the badge's own box, the Shell's hidden textarea taking the kit focus ring, and lists of
transition durations. The style differences outside Type text are the same as p4-close's own
comparison, and the motion differences match it exactly. The Type text states also lose
`body.sheet-open`, and every stream state has one element fewer (the Type text backdrop, which
is not rendered). The atlas still checks every state for an older class name and finds none.
In one of three runs of the head, one more picture (the list, desktop, dark) differed at the
rounded edges in the lower part of the first card; taken again it matched the base exactly. Two
runs of one build do not always match: take a single state that differs again before reading it
as a change.

**Left for phase 5.**
- Kit decisions: a toast drawn above a bottom sheet covers the sheet's last action
  (`ui/Toast.tsx:107`, `AboveSheet`); Escape is heard only inside a sheet (`ui/Sheet.tsx:195`;
  the switcher works round it, `views/DeviceSwitcherSheet.tsx:158`); `ui/Banner.tsx` takes no
  event and no label, hence `CardBanner` (`views/DeviceCard.tsx:150`); `kit-button-compact`
  keeps 13px labels on a touch screen (`kit/Button.css:60`).
- p5-controls: `control-button` stays a hook class without rules
  (`toolbox/ToolBoxButton.ts:13`); `openedOverSheet` in `views/FloatingToolbar.tsx` is in use (see
  above), so it is not dead code.
- `src/app/googDevice/client/ShellClient.ts:54`: xterm's `fontSize: 14` is off the type scale. It
  stays because a change resizes the terminal sent to the phone. (Step 6a: the size is now 12, 14,
  16 or 18 px, chosen with A− and A+ and kept per browser; 14 is the default.)
- Rules still in the base layer or written by ID: the `.notification-page-header` and
  `#devices .device` entrances and `.notification-panels` (`app.css:160-192`), and the `#devices`
  selectors in `views/DeviceList.css`. No test rejects ID selectors or a selector written twice
  in one file.
- Wording: "Unlock device", "Device locked", "Device media", "Device controls", "Switch device"
  and "Find a device…" still say device. `scripts/e2e-deeplink.js:41-61` (phone only, not in the
  default list) still looks for a control titled "Switch device".

**Left for phase 6 (p6-desktop-layout).**
- The widths in `VIEW_BREAKPOINTS` (`scripts/test-style-rules.js:43`): `filelisting.css` 360,
  380, 700, 720 (a container query) and 900; `views/DeviceList.css` 360, 720 and 1040;
  `views/StreamView.css` 359 (the compact bell); `views/ToolView.css` 700 and 1000. Take each out
  of the list as its layout moves.
- The Type text side panel from 1024px is not built. Type text is `<Sheet modal={false}>`
  (`views/LiveTextOverlay.tsx:274`), placed from 600px by `views/LiveTextOverlay.css:39-50`, and
  the stream view reserves the dock height (`views/StreamView.css:17-25`). With Type text open on
  a desktop the reserved dock cuts off the bottom of the control rail (Type text and Settings are
  partly hidden at 1440x900), as in 4c and at 4031c80. This matters more now that the rail can be
  pressed while typing.
- `kit-sheet-modeless` (`ui/Sheet.tsx:264`, `kit/Sheet.css:178-196`) is a separate axis from the
  presentation: a docked side panel should be one more presentation, not a change to modal.
- The controls panel (z-index 8) draws under the Type text sheet (`--z-sheet`, 20) where they
  overlap, as at 4031c80.

**Risks the owner should know.** A sheet that is not modal cuts short the exit of any modal sheet
animating out when it opens; only iPhone Actions to Type text does this today. For about 220 ms
after that, `topSheet` still names the closed Actions dialog, so a toast raised then would stay
hidden until the window ends; no toast exists on the stream page. Two presses within about 220 ms
(Type text closing, then Open Type text in Actions) do not run `endExit`, and the field may miss
focus in that press. Escape closes Type text only while focus is inside it, as at 4031c80.

**Phone check for steps 6s and 4a to 4d.** See the walk below. Nothing in steps 4a to 4d changed
a route, the router, the service worker or what decides whether a stream view mounts: the stream
path files (`StreamView.tsx`, `CoreDeviceStreamView.tsx`, `DevicePage.tsx`) changed in 4d only by
the removed `kit` prop. Type text still begins and ends its typing session on `open`.

The walk is ordered so that it takes two iPhone screen starts in all (step 4 and the reconnect
in step 6). Keep the server log open and count `display serve-web` starts. Do not open and close
the iPhone screen in quick succession: three starts in five minutes is the limit, and a burst of
short sessions wedges the phone's display service.
1. Deploy, then reload the installed app once on each phone. A page without styles means an old
   cached stylesheet; reload again.
2. No screen open, on both phones (installed app and browser) and on the desktop:
   - Phones list on the notched iPhone, portrait and landscape: the bar reaches under the status
     bar once and the last card clears the home indicator (`body.list` is gone; only emulated
     insets were checked). Text is 15px and reads as before.
   - Long press on Open screen, on a card's Files or Shell link and on the bell: no text
     selection and no callout. Arm Stop stream service (or Restart services on the iPhone card):
     the confirm answer is solid red. Press Cancel.
   - Notifications: the unread count in the bar is the red kit badge. The search field is 44px
     and does not zoom on focus. The switch, tick boxes and selects work in iOS Safari. Swipe a
     card by finger to read and to archive. Drag a sheet down by its header. A toast raised
     while a sheet is open shows after the sheet closes, and its Undo works. On Android, Back
     with a card sheet open and a prompt armed cancels the prompt first, then closes the sheet.
     Setup: the Bluetooth pairing part looks right.
   - `#!action=kit` (no stream): on the iPhone, Sheet with a text field raises no keyboard until
     a field is tapped, then stands on the keyboard with no zoom. On Android, Back closes Short
     sheet and stays on the page; with the confirm prompt armed, the first Back cancels it; a
     busy sheet stays on Back. On both: a drag past halfway closes a sheet, a short drag settles
     back, a tap on the dimmed backdrop closes it, the long sheet scrolls only its body, Toast
     over a sheet can be pressed, a stacked sheet closes first on Back, the menu opens at More
     and closes by an outside tap and by Back, Rename returns focus to More. New: Sheet that
     leaves the page in use has no dimming, the page beside it can be pressed and scrolled while
     it stays open, its field raises the keyboard, and Close, Escape and Back close it. From
     Short sheet, Go to the page in use: the short sheet goes at once and its field can be
     tapped in the same press.
   - Desktop with a mouse: hover and Tab through the sheets; the focus rings show. With reduced
     motion on, sheets and toasts appear at once; the Shell cursor blinks at its normal rate
     (known).
3. Android screen (no iPhone start):
   - The bar (61px, 71px with the stream service line) and the tabs (45px) sit above the
     picture. Touches near the top, the bottom and the edges land where pressed. Hold Power and
     the volume keys on the controls tiles: a hold is a hold, a tap is a tap.
   - Type text: the keyboard comes up, the sheet stands on it, and nothing dims the picture or
     the bar. Tap a text field in the picture: the tap reaches the phone, Type text stays open,
     the keyboard stays up (it may flicker as focus comes back to the field) and typing goes into
     the new field, each key once. The field's focus ring is whole. Open the controls panel over
     Type text: Back closes the panel, then Type text, then leaves the page. The Files tab closes
     Type text, and it does not come back on Screen. Close ends typing.
   - Each other sheet (Settings, Actions, Unlock, Switch phone): a tap beside it closes it and
     does not reach the phone. The Back gesture closes it and stays on the page. A hardware or
     Bluetooth keyboard sends nothing to the phone while any sheet is open, Type text included;
     with nothing open its keys reach the phone. In Stream settings, Listen sits beside its text.
   - With the screen off, Wake: one wake, the card goes, no second stream. With the phone
     locked, the lock notice is the blue banner; Unlock opens the sheet, its footer stays above
     the keyboard and Enter submits.
   - Files: New folder and Rename stand above the keyboard; row menus open on top and close on a
     second press of their button; Replace in a name conflict is solid red; a quick second Back
     on that question does not skip the next one; the upload bar and Properties look right.
     Shell: the keys work with the on-screen keyboard and the terminal fills its area.
   - Stop the stream service from the card and open the screen: the failure card and the
     notices look right. Open and leave the screen a few times: one stream per open.
4. iPhone screen, one session (first start). Keep this page open for step 5.
   - Bar, tabs and touch aim as on Android. Hold Siri on its tile: a hold is a hold, a tap is a
     tap.
   - Type text from the controls: the keyboard comes up in the same tap, the sheet stands on it
     and the picture shows above it. Tap a text field in the picture: the tap reaches the iPhone,
     the keyboard stays up, Type text stays open and typing goes into the new field. Also in
     landscape. Close ends typing.
   - Actions, then Open Type text: Actions goes at once, without its animation, and the keyboard
     comes up in that same tap.
   - Unlock sheet, only with the right passcode: the footer stays above the keyboard and Enter
     submits. The lock notice stays bright while the screen is asleep. Scheduled unlock: the time
     field works and the status is as before.
   - Open the same iPhone page in a desktop browser while the phone's page is still open. It joins
     the running session (the log shows no new start). With each sheet open, keys from the
     desktop keyboard do not reach the iPhone; with nothing open they do; in Type text each key
     arrives once.
5. With that iPhone screen still open, stop the container once (normal stop, 80 s grace). After
   `Received signal SIGTERM` the log shows `Stopping iDevice Tracker [...]`, then
   `Stopping iOS CoreDevice session runner`, then serve-web's `shutdown complete` for the phone,
   and Node exits well inside the grace. No `mounter auto-mount`, `Preparing the device` or new
   `display serve-web` start after the signal; no `did not stop in time`, `Still running after
   shutdown` or `Failed to stop`.
6. Start the container. The open iPhone page reconnects with one serve-web start (second start);
   the screen, touch, keys and buttons work. If the display service looks stuck, reboot the
   phone and keep the log. The Phones list shows each iPhone's session, screen and lock state,
   and the scheduled unlock status is as before. The next scheduled unlock run finishes.
7. Optional: stop the container with an iPhone page open and no screen session. It exits within
   a few seconds.

### Redesign step 5a: one status model and one place for the status words (2026-11-12, tested without a phone)

Package p5-status (findings U-home-6, U-system-7, U-stream-11), merged into `redesign` from
`review/p5-status`. The screens keep their structure; they read their words, tones and names from
the new modules. The rebuilds come in step 5b. Not deployed: step 5a goes live with step 5b.

**The status model.** `src/app/state/phoneStatus.ts`. One adapter per platform (`googFacts`,
`applFacts`, chosen by `phoneFacts`) turns a list entry into facts:
- `trusted`: the phone is not `unauthorized`.
- `connected`: Android `device`, iPhone `Connected`.
- `session`: `starting`, `running`, `failed`, `stopped` or `unknown`. On Android it is the stream
  service: a pid above 0 is running, the optimistic Start flag is starting, pid -1 is stopped,
  anything else unknown. On an iPhone it is the server session (`ready` is running, `error` is
  failed).
- `problems`: only iPhones report them (a failed session at level error; Developer Mode off and a
  scheduled unlock that cannot run at level attention), and only while connected.
- `screen` (`on`, `asleep`, `unknown`) and `lock` (`locked`, `unlocked`, `unknown`), only on
  positive evidence. Android reads `screen.power` and `device.awake`, the iPhone `screen.power`;
  both read `device.locked`.
- `viewed`: this browser shows the phone (`activeStream` for Android, `activeCoreDeviceStream`
  for an iPhone; before, the iPhone check read the Android signal).

`derivePhoneStatus(facts)` applies one precedence to both platforms (`PHONE_STATUS_ORDER`):
Unauthorized, Offline, Error, Starting, Needs attention, Asleep, Locked, Ready. Streaming is no
longer a status. A running session or `viewed` sets `sessionRunning`, a second mark that never
takes the place of Asleep, Locked or Ready. The result also carries the screen and lock facts of a
reachable phone ('unknown' for any other); the cards and both screen views decide the asleep
banner and the sleep card from `getDeviceStatusInfo(entry).screen`. Only the unlock flow still
reads the lock and keyguard fields raw (`LockScreenNotice`, `UnlockSheet`, `ApplUnlockSheet`,
`state/unlockDevice.ts`). The optimistic Start flag (`markStarting`, `clearStarting`,
`isDeviceStarting`), `listSummary` and `needsAttention` moved into the module and give the same
results.
`state/deviceStatus.ts` and `state/streamService.ts` only re-export from it.

The connection of a page has its own function: `connectionStatus(state)` returns label, tone and
icon for Connecting, Connected, Reconnecting, Offline, Failed and Stopped (warning, success,
warning, neutral, error, neutral). `screenConnection` is the one value of a screen page;
`StreamView` and `CoreDeviceStreamView` derive it once and pass it to the header and to
`SleepOverlay`, which keeps no connection state of its own. Each view remembers the stream client
that has been connected (`connectedClient`): the same client reconnects, a new one (another phone,
Start again) connects. After an iPhone failure, Trying again counts as connecting; Reconnecting is
only for a drop without a failure. `toolConnection` gives the chip of Files and Shell. The tone
is on the header line and the tool chip as `data-tone`; nothing shows it yet.

**Where the words live.** `src/app/copy.ts`, grouped as CONNECTION, SCREEN_CONNECTION, STATUS,
SCREEN, LOCK, SESSION, LIST_SUMMARY, PROBLEM, FACT and STREAM_SERVICE. It holds status words only
and is not a translation layer. `scripts/test-phone-status.js` fails if 'Screen is off', 'Screen
is asleep.', 'Device locked', 'Lock screen active', 'streaming service', 'Connecting to device…',
'Connecting…', 'Reconnecting…' or `'Streaming'` appears in any other file under `src/app`, and if
`phoneStatus.ts` holds a phrase of its own.

**Names.** `state/devices.ts` keeps the last name each serial had in the list, for the life of
the page. `phoneName(udid, entry)` gives the listed name, else that last name, else the serial.
The Android, iPhone and tool headers and the tab title use it, so an unplugged phone keeps its
name. The memory is keyed by serial only.

**Capabilities.** `src/app/state/capabilities.ts` is one table per platform, as data, with the
code place of each value in a comment: files, shell, panels, rotate, clipboard read, clipboard
paste, unlock kind (`passcode-field` on Android, `server-passcode` on an iPhone), power actions,
scheduled unlock, stream quality and Type text. `capabilities(entry or platform)` returns it. So
far only `supportsDeviceTools` in `state/devices.ts` reads it.

**What the owner sees change.**
- Phones list, iPhone card: Streaming is gone. An iPhone with a running session shows its real
  status (Ready, Asleep, Locked, Needs attention) and a second grey chip, Session running, in the
  line under its name. In the atlas the Spare iPhone, whose scheduled unlock cannot run, now says
  Needs attention. The same chip shows on a switcher row that cannot be opened (a connected iPhone
  with Developer Mode off and a running session). Android cards are unchanged apart from below.
- An Android phone being started ranks Starting above Asleep and Locked.
- The iPhone card shows the Screen is asleep banner whenever the screen is asleep, also while a
  session runs or starts.
- Screen is asleep, without a period, on the card banners; the card over the picture said Screen
  is off and now says Screen is asleep.
- The lock notice says Phone locked (was Device locked). Swipe up to unlock (was Lock screen
  active) shows only when an Android phone reports itself not locked while its lock screen shows;
  a lock the phone does not report gets Phone locked.
- iPhone card Details: Session Running, Starting, Failed or Stopped (was ready, starting, error,
  stopped); Paired Yes or No; Developer Mode On, Off or Unknown.
- Stream service tooltips say stream service and phone (were streaming service and device). The
  stopped card on the Android screen says "The stream service on this phone was stopped."
- Screen header: a stream that was connected and dropped says Reconnecting… (was Connecting…).
  When the list reports the phone as not connected, unauthorized included, and there is no
  picture, it says Offline. The card over the picture prints the header's word: Connecting… on a
  first connection (was Connecting to device…), Reconnecting… after a drop, Offline, Stopped with
  the stream service stopped, and on an iPhone's first start Starting the phone stream…. Its hint
  after 12 seconds says phone (was device).
- Files and Shell chip: Opening… becomes Connecting…; Unavailable and Disconnected become Unable
  to connect, or Offline when the list reports the phone as not connected; Ended becomes Stopped.
  A tool whose code could not be downloaded now says Unable to connect. The Files status line
  starts with Connecting… (was Connecting to device…).
- An unplugged phone keeps its name in the screen and tool headers and in the tab title (was its
  serial).

**Proof.** `npm run check` passes (615 node tests with `scripts/test-phone-status.js`, lint 0
errors and 38 warnings as before). All default browser suites pass, with the new `phone-status`
suite (`scripts/e2e-phone-status.js`): Reconnecting in the header and the overlay on both
platforms, Offline in the neutral tone, the last name in the header and the title, the sleep card
from the screen fact, and the lock notice texts. The atlas of the base (e2fd657, built from an
export) and of the merged head differ in 66 files, each one a status word or the second chip:
- The lock notice word in 22 pictures: android-screen, android-switcher, android-type-text and
  android-unlock (4 each), android-actions and android-settings on the desktop, android-controls
  on the phone (2 each).
- The sleep card sentence in android-asleep: 4 pictures and 4 style files (the card is wider).
- The list states, 36 files: two more elements (the Session running chips of the two atlas
  iPhones, which makes the Bench iPhone's line under its name wrap), Streaming replaced by Ready
  and Needs attention, the Pixel 7 banner without its period, and in list-details the fact values
  Running, Yes and On. These are list, list-details and list-confirm (8 each) and
  list-android-settings and list-iphone-settings (4 style files and the 2 desktop pictures each;
  the sheets themselves are unchanged, and on a phone the sheet covers the list). In
  list-confirm on a phone only the anti-aliasing of two text lines differs, because the taller
  card above moves the scrolled prompt.

**The stream path did not change.** In `StreamView.tsx`, `CoreDeviceStreamView.tsx`,
`ToolView.tsx` and `SleepOverlay.tsx` only the lines that choose a word, a tone or a name differ.
The mount effects and their dependencies are as before. The new `connectedClient` state is set in
an effect of its own. `ToolView` lost its `loaded` state, which only chose the word Opening…. No
route, router, service worker or server file changed.

**Left for step 5b.**
- p5-screen-shell: colour the header line and the tool chip by `data-tone` (`ui/AppBar.tsx:79`,
  `style/kit/AppBar.css:107`, `views/ToolView.tsx:363`). The disconnected card of `SleepOverlay`
  keeps its spinner for Offline and Stopped (`views/SleepOverlay.tsx:94`), and with the stream
  service stopped it shows under the stopped card (`views/StreamView.tsx:177`); one state card
  should replace both. Not done here by decision: the Android header's third line,
  `StreamServiceStatus` (`views/StreamView.tsx:127`, `views/ToolView.tsx:352`), and the look of the
  disabled Switch (`views/StreamView.tsx:133`, `views/CoreDeviceStreamView.tsx:181`).
  `PhoneNotListed` titles the page with the serial (`views/DevicePage.tsx:96`); `phoneName`
  would show a name the page saw earlier. The header says Offline for an unauthorized phone;
  decide whether the state card says Unauthorized, as the list does.
- p5-list-rows: show the stream service line only when it is not running
  (`views/DeviceCard.tsx:269` and `:493`); an iPhone card shows both Session running and Stream
  service: Running. Decide the final form of the session mark (`views/DeviceCard.tsx:480`,
  `views/DeviceSwitcherSheet.tsx:231`). The unavailable hints and buttons still say device
  (`views/DeviceCard.tsx:142-143`, `:282`, `:588`).
- p5-unlock: `LockScreenNotice` takes its text from `lockNotice(locked)`
  (`views/LockScreenNotice.tsx:28`). In the swipe case its Unlock button opens a sheet that can
  only say to swipe. The notice does not know `keyguard.occluded`, so a not-locked phone whose
  lock screen is covered by another screen also gets Swipe up to unlock.
- p5-settings-sheet: the Phone group prints 'unknown' and Developer Mode 'on' or 'off' raw
  (`views/ApplSettingsSheet.tsx:647-662`). Use `onOffFact` and `FACT.unknown`.
- p5-actions-sheet: the iPhone Troubleshooting rows print raw values
  (`views/ApplActionsSheet.tsx:476-494`), so the sheet says 'ready' where the card says Running.
  Use `sessionFact`, `screenFact`, `lockFact` and `connectionStatus`.
- p5-controls: take power, rotate and Type text from `capabilities()` in the controls definition;
  today `views/FloatingToolbar.tsx:79` adopts the platform toolboxes
  (`googDevice/toolbox/GoogToolBox.ts`, `applDevice/toolbox/ApplToolBox.ts`).
- All 5b packages: move platform checks onto `capabilities()`, for example `PHONE_TABS`
  (`views/DevicePage.tsx:44`), `VIEWS` (`state/pageTitle.ts:8`), the platform branches in
  `DeviceCard` and the settings sheet openers.
- Notifications page: the Bluetooth feed chip keeps its own Connected and Reconnecting, without
  an ellipsis (`views/NotificationHistory.tsx:52-56`). It is another link than the page's
  connection to a phone; align it if one word set is wanted.

**Phone check for step 5a** (with step 5b, after the deploy). No step here adds a screen start.
- Phones list: an iPhone with a running session says Ready (or Asleep or Locked) with Session
  running beside it, never Streaming; its Details say Running, Yes, On. With the iPhone's screen
  off the card says Asleep and shows the banner. Where the phone does not report its screen or
  lock (the state probe off), the card says Ready and shows no banner.
- Android screen: with the phone locked by PIN, the notice says Phone locked. With the screen
  off, the card over the picture says Screen is asleep and Wake brings one wake and no second
  stream.
- Restart the container once with an Android screen open: header and card both say
  Reconnecting…, then Connected, with one new stream. With an iPhone screen open the same
  restart is one serve-web start, and the page says Reconnecting… in both places.
- Unplug the Android phone with its screen open: the header and the tab title keep its name. The
  header says Offline while the list lists it as offline, else Reconnecting…; the page keeps
  trying as before and opens no extra stream.
- Files: the chip goes Connecting…, Connected. In Shell, `exit` makes it Stopped.

### Redesign step 5b: one screen, one set of sheets, one row (2026-11-12, tested without a phone)

Six packages merged into `redesign` in this order: p5-settings-sheet, p5-actions-sheet,
p5-unlock, p5-controls, p5-screen-shell, p5-list-rows (each from its `review/` branch). Findings
U-settings-9, U-settings-4, U-settings-7, U-stream-8, U-system-5 (Actions part), U-settings-6,
U-settings-8, U-stream-7, C-client-ui-14, C-client-stream-9 (button hold), U-stream-11,
U-stream-14, C-client-ui-10, U-home-5, U-home-12 and U-system-7 (card part). Nothing was run on
a phone. Not deployed: steps 5a and 5b go live together after the phone check below.

**One screen view.** `src/app/views/ScreenView.tsx` draws the screen of both kinds of phone: the
kit header, one banner slot, the stage and the sheets. What differs is a hook adapter that
ScreenView calls with its own mount ref: `views/screen/android.tsx` (`useAndroidScreen`) and
`views/screen/iphone.tsx` (`useIphoneScreen`). Each adapter holds the effect that starts its
stream client, copied line for line from the old views: the same keys (Android: udid, player,
ws and the Start again count; iPhone: udid), the same cleanup order, the same `closeAllSheets`
and signals. The mount node is made once and never moved; the state card and the controls are
its siblings. `DevicePage` renders `ScreenView` with the adapter of the phone, Android and
iPhone at separate places among its children, so one view never changes its adapter (its
hooks). The two wrappers `StreamView.tsx` and `CoreDeviceStreamView.tsx` are gone; `App.tsx`
imports `./screen/android`, `./ScreenView` and `./screen/iphone` where it imported them, and the
CSS bundle kept its rule order. Keep this effect untouched whenever the view changes: a view
that mounts twice starts two sessions.

**Header.** The title is `phoneName` (an unplugged phone keeps its name; a phone that is not
listed shows a name the page saw, else the serial). The connection line takes the colour of its
tone (`style/kit/AppBar.css`): Failed red, Connecting and Reconnecting amber, Connected in the
text colour, Offline and Stopped grey. The Files and Shell chip does the same
(`style/views/ToolView.css`). The Android stream service line shows only while that service is
Stopped, Starting or Unknown (`StreamServiceStatus` with `unlessRunning`), on the screen and on
the tool header, so an Android header is two lines when all is well.

**Banner slot and state card.** `.stream-banners` sits in the layout under the header and the
tabs and stacks the lock notice, the first-start progress line and the stream notice, in that
order. The stage takes the height that is left, so no banner lies over the picture; both phones
refit by CSS. (This said the iPhone refits through its viewport observer and 150 ms
`applyBounds`; step 5c found that path only writes `BasePlayer.bounds`, which nothing reads.)
`views/screen/StateCard.tsx` is the one card on the stage for every state without a picture, at
z-index 5 (above the controls' shield, under the controls button), centred on the picture's
part of the stage through `--stream-rail-width`. In order: a known problem (start error, no
decoder, iPhone failed or stopped or unlock by hand with Retry, Android service stopped with
Start again; each with Phones as a second button), Unauthorized (the list's hint), Offline (no
spinner), Connecting or Reconnecting (a spinner and after 12 s a one-line hint), Asleep (Wake).
While the screen is asleep the lock notice is held back (`connected && !screenOff`) and comes
back once the screen is on. `SleepOverlay` is deleted. A tool tab whose code is gone after a
deploy shows the same card with Reload. The tabs and the page title's views come from
`capabilities()`.

**Controls.** `src/app/controls/definition.ts` holds every control as data: id, label, caption,
icon, slot (row and column of a 3-column grid), hold, needsConnection and the capability it
needs (`power`, `typeText`, or the new `phoneKeys()` block in `state/capabilities.ts`). Rows 1 to
4 are the same on both phones: Back, Home, Overview / Volume down, Mute phone, Volume up / Lock,
Listen, Screenshot / Type text, Actions, Settings. An iPhone leaves the Back and Overview cells
empty and has Siri at row 5, column 1. `controls/androidControls.ts` and
`controls/iphoneControls.ts` supply the actions; `ControlPanel.tsx` (floating button and panel,
touch) and `ControlRail.tsx` (rail, mouse) draw them through `ControlButton.tsx`, which disables a
control from `needsConnection` and takes the hold behaviour from `hold`; no code compares a label
or a title. `controls/heldButtons.ts` is the one code that turns a press into down and up: an
iPhone tap is one `press`, a hold past 700 ms is down then up; a press ends once on pointer up,
cancel, lost capture, blur, page hide or the panel closing, and a disconnect ends it without
sending. The toolbox classes (`src/app/toolbox/*`, `GoogToolBox.ts`, `ApplToolBox.ts`) are
deleted; `FloatingToolbar({ client })` stays the one thing the screen mounts, and the clients
expose `getControls()`. The side button is Lock on both phones, in the controls and in Actions.

**Settings.** One sheet, `views/SettingsSheet.tsx`, titled Settings and mounted once in `App`,
for a phone of either kind in any state, from the list or from the screen. Its sections are
files in `views/settings/` and always come in this order: Stream, Sound, Keyboard, Unlock, About
and troubleshooting (`sections.ts`); a section is left out only where `capabilities()` gives the
platform nothing for it, so an iPhone has no Stream. There is one way to open it:
`openSettings(udid, { deviceKey, section })` in `state/settingsSheet.ts`; a section scrolls to
its heading and focuses it. The Unlock sheet's Open Settings and the card's iPhone unlock problem
open the Unlock section; an unavailable Listen on Android opens Sound. Rows that need the phone
or its open screen stay, disabled, with a one-line reason.
- Stream: presets and the advanced values of the old Android sheet, Playback (player, quality
  stats). A value applies when it is changed (`StreamConfigSession.change` sends only what
  differs): 'Restarting stream…' then 'Settings saved.' or the error under the control's group.
  The restart is asked first only when the open screen reports other viewers
  (`getClientsCount()`); from the list it applies at once. The sheet cannot be closed while a
  change is applied. A refused or unconfirmed change puts the control back; a change still out
  when the phone goes offline or the sheet closes is given up as a timeout
  (`StreamConfigSession.givenUp`). The Apply bar is gone.
- Sound: the kit's `SoundRows` on both phones, plus capture, source and format on Android.
- Keyboard: 'Send this keyboard to the phone' on both, and Native keyboard (UHID) on Android.
- Unlock: Saved passcode with one row per store: This browser (Android: Saved or Not saved,
  Forget at any time) or Server (iPhone: stored, empty or rejected, Replace and Remove). The
  scheduled unlock panel moved as one unit into `settings/ScheduledUnlock.tsx`; only its passcode
  row moved up. `state/unlockSchedule.ts` did not change.
- About and troubleshooting: the facts in `copy.ts` words (Status, Model, System, Serial,
  Connection, Screen, Lock; on an iPhone also Session, Paired, Developer Mode and, with its
  screen open, Decoder), the service rows (`settings/ServiceRows.tsx`: Android stream service
  Start or Stop; iPhone Stop stream service, Restart services, Remount developer image, Refresh
  info, each with its prompt as before) and, for an Android phone whose screen is not open here,
  Open with another player. The iPhone's Stop is off while this browser shows its screen,
  because the screen would reconnect at once and start a counted session. When the list socket
  drops, the rows stay, off, until the phone is listed again, so a command's outcome is still
  shown (an integration fix; ios-settings checks it).
- `settings/useRetainedTarget.ts` keeps the target through the exit and releases it when the
  dialog closes, so a closed sheet holds no hidden text. `SheetContent` wraps the content in a
  component because Preact keeps stale parent links on element children when `Sheet` renders
  itself, and a later `useId` would restart at the title's id.

**Actions.** `views/actions/PhoneActionsSheet.tsx` is the one sheet. `ActionsSheet({ client })` and
`ApplActionsSheet({ client, descriptor })` keep their names and props and only build an
`ActionsAdapter` (`views/actions/adapter.ts`) of what their platform sends; they stay because
that is real per-platform code. Groups in a fixed order: Clipboard, Screen, Lock, Power, then an
untitled Settings row. Android has no Power group. Rows come from `capabilities()` and the new
`actionCapabilities()` block (`pictureRecovery`). Every title, description, label, prompt and
result line is in `views/actions/actionRows.ts`. Clipboard is one group with one limit, one busy
state and one message set; Type text stays where pasting is not possible (the iPhone). Android's
panel rows moved into Screen. Unlock is a row on both phones whatever the lock state, and a new
Lock the phone row sends one side-button press (Power key down and up on Android,
`pressButton('lock', 'press')` on an iPhone), closes the sheet, and is off while the screen is
asleep. What each action sends is unchanged. Group state is held in PhoneActionsSheet above
`Sheet` for the same Preact reason as above, and the wrappers read no signal while rendering.

**Unlock.** `PhoneUnlockSheet` in `views/UnlockSheet.tsx` is the one sheet; `androidUnlock` and
`iphoneUnlock` in `state/unlockDevice.ts` are its adapters. `UnlockSheet` and `ApplUnlockSheet`
keep their names and props; ApplUnlockSheet adds the banners for a missing, rejected or locked
out server passcode. Both phones: title 'Unlock phone', one primary 'Unlock', states idle,
waiting, confirmed and failed (`data-unlock-state`), failures in the error tone, one hint. Only
Android has the field and the PIN or Password choice. An attempt (`unlockOnce`) sends once and
waits up to 25 s from the send for the list to report the phone unlocked; it never resends. The
sheet closes once the phone reports itself unlocked, also when that happens another way. A stream
drop ends an attempt only on Android; an iPhone run is the server's and goes on. The field takes
focus on a pointer device, not on touch.
One tap: with a passcode saved for the phone, the lock notice's Unlock sends it through
`oneTapUnlock(udid)` and says 'Unlocking…' with a busy button; the sheet opens only after a
failure, with the reason. Saved means remembered in this browser on Android (only behind
Remember in this browser and only after a confirmed unlock, as before), or on an iPhone a server
passcode that is stored, not rejected and not locked out. oneTapUnlock returns nothing, and the
sheet opens instead, without a live stream (`streamConnected`), with another screen over an
Android lock screen, or with no usable passcode. The iPhone tap is the same RUN_UNLOCK_NOW with
keepUnlocked as the sheet, with the same cooldown and start budget, and it reuses the open
session. An Android copy that was sent without a confirmed unlock is removed. In the swipe case
the notice has no Unlock and hides while `keyguard.occluded` is true. With a passcode saved, the
prefilled sheet is reached from Actions, Unlock.

**Row and card.** `src/app/ui/PhoneRow.tsx` is the head of a list card and a switcher row: tile,
`phoneName`, the platform line (`Android 16 · 80%`, battery only while connected; `iOS 27.2`), a
dot with 'In use' while `getDeviceStatusInfo().sessionRunning`, the unread count (switcher only)
and one status chip; no serial and no tracker name. The card's rules are a pure function,
`state/phoneCard.ts`. At most one line under the head, in this order: unauthorized hint, offline
hint (both from `copy.ts` UNAVAILABLE_HINT, the same words as the screen's card), the first
problem (Developer Mode first when it blocks the screen), then no player. Step 5b first also
gave a ready Android phone with its stream service stopped or unknown a line ('The stream
service is stopped. Opening the screen starts it.') with Start. That line and Start are now gone
from the card: since phase 2 the service stops 30 s after the last viewer leaves, so the line
was on every idle Android card, and U-home-5 and the approved mockup keep one status per card
with no service line. Open screen starts the service; Start and Stop stay in Settings under
About and troubleshooting, and Start there still shows Starting… on the card. Open screen is
always the first button,
disabled with the line saying why. Wake sits beside Asleep (`ui/WakeButton.tsx`, the same
`wakeDevice` request; a late reply does not speak for a later sleep). The Details disclosure is
gone, Settings is on every card in every state, Files and Shell are icon links from
`capabilities()` and the new `cardCapabilities()` block. The card keeps Enable and restart,
Restart services and Open settings, each on its line. The switcher puts the phone on
screen first with 'Viewing', then the phones that can be opened, then the rest greyed, not
focusable; 'Switch phone', 'Find a phone…'; the search matches the name and the platform line.

**Where everything went.** Nothing the base offered was dropped.
- Card Details, Android: serial and connection to About (Connection now gives the live word in
  place of the fixed 'Automatic · via server'); Open with a player to About; stream service Stop
  and Start to About.
- Card Details, iPhone: model, serial, Session, Paired, Developer Mode to About; Refresh info,
  Stop stream service, Restart services, Remount developer image to About's service rows.
- Android Actions: Sound to Settings; Clipboard stays; Phone panels into Screen; Open Stream
  settings becomes the Settings row; Unlock device (shown only while locked) becomes Unlock the
  phone, always shown.
- iPhone Actions: Sound and Send keystrokes to Settings; Screen (Rotate, Refresh picture, Restart
  video, Reconnect) stays; Type text into Clipboard; Unlock device becomes Unlock the phone;
  Open Scheduled unlock becomes the Settings row; Reboot and Shut down into Power; the Phone
  hint (model, iOS, Developer Mode) and Troubleshooting (Decoder, Session, Connection, Screen,
  Lock, Restart services, Remount, Refresh info) to About.
- Android Settings: quality and advanced values, Playback to Stream; capture, source, format,
  Listen and volume to Sound; Physical keyboard (now 'Send this keyboard to the phone') and UHID
  to Keyboard. iPhone Settings: the schedule and Run now to Unlock, the facts to About.

**What the owner sees change.**
- List: one chip per card and at most one line under it; In use after the platform line in
  place of Session running and Stream service: Running; Wake beside Asleep in place of the
  banner; Open screen always, disabled with a reason, in place of Device unavailable, Waiting
  for trust and Browser cannot play; no Details; Settings on every card; Files and Shell as
  icons; an idle Android card has no line and no Start.
- Switcher: Switch phone, Find a phone…, the phone on screen first as Viewing, unavailable
  phones last and greyed, no serial or tracker.
- Screen: the coloured connection line; no Running line on Android (the header is 10 px
  shorter); banners push the picture down instead of covering it; one card per state on the
  stage, which dims the stage only; Offline and Stopped without a spinner; Unauthorized says so;
  asleep shows only Wake; a dismissed lock notice comes back after a sleep and wake.
- Controls: the new cell order; Lock on Android (was Power); Mute phone (was Mute device), on
  the iPhone too; the heading Phone controls; empty Back and Overview cells and Siri on row 5 on
  the iPhone; a key held when the panel closes is let go at once.
- Actions: the four groups and the Settings row; no Sound, keystroke switch or Troubleshooting;
  Unlock always; the new Lock row; 'Copy here'; 'Reconnecting to the phone. …' as the paused
  banner and 'No answer from the phone. Check that it is still connected.' for a clipboard read
  on both phones.
- Settings: one sheet named Settings for both phones, also from the list in any state; the
  iPhone has Sound and Keyboard there; a change applies at once and restarts the stream; Saved
  passcode with Forget for this browser.
- Unlock: Unlock phone with one Unlock button and a hint; one tap from the notice when a
  passcode is saved; the sheet closes once the phone is unlocked; the field is focused only with
  a mouse.
- Words: Waiting for phones, No phones available, Android phones are unavailable, Shell is not
  available for this phone, Phone root and Phone files in Files, the sound messages and the file
  errors say phone, a dropped file says 'To upload files, open the Files tab.', a link to another
  server says 'Open the phone from the Phones page.', a phone with no reported name is 'Android
  phone' or 'iPhone'. `scripts/test-phone-status.js` now also fails on the retired words
  (Session running, Device unavailable, Unlock device, Mute device, Switch device and others).

**Proof.** `npm run check` passes: 628 node tests plus the Python suites, lint 0 errors and 29
warnings (38 before; the deleted toolbox held 9). All 32 default browser suites pass in one run
of `node scripts/test-browser.js`, with the new `actions-sheet`, `controls` and `screen-states`
suites, and `scripts/test-settings-sheet.js` runs in `npm test`. The offline check of the
settings suite raced the sheet's reload about one run in three; it now waits for the reload. Stream sockets: navigation, device-page and screen-states assert one stream socket
per open of a screen on both fixtures, none from a banner, a card, Wake or a sheet, and exactly
one more for a tab change and return, Start again or Retry; ios-reconnect counts each iPhone
start and finds no extra one. The stream effects were read against 5cab921 and are identical. No server file,
`src/common`, the service worker, `state/unlockSchedule.ts` or `state/savedPasscode.ts` changed.
The integration added two checks that left with the old groups: the Settings service rows in
the confirm suite (danger style, prompt, one command, Cancel, withdrawn prompt, kill_server
payload) and Remount with a dropped tracker socket plus Refresh info in ios-settings. The atlas
of 5cab921 (built from an export) and of the merged head are compared below.

**Atlas against 5cab921.** 292 files in the base, 276 in the head. list-details and
list-confirm (16 files) are gone with the disclosure. Of the 276 shared files, 98 pictures and
138 style files differ, and 40 are the same.
- Phone screens, both phones (screen, actions, settings, unlock, switcher, type-text, asleep at
  both sizes; controls on the phone): the coloured status line, no Running line on Android, the
  banner slot, the state card on the stage, the controls in their new cells and names, and the
  new Actions, Settings and Unlock sheets.
- List and its two Settings states: the new cards behind the one Settings sheet.
- Android Files and Shell states: the tool header without the Running line, Connected in the
  text colour, and Phone root among the Files places.
- tool-unavailable: 'Shell is not available for this phone' and 'Android phones only'.
- notifications-* and phone-not-listed: styles only. The closed Settings dialog holds no content
  now, and the `useId` numbers moved; nothing painted differs.
Each group was looked at on a phone width and a desktop width, light and dark. The pictures of
the changed states and one contact sheet per state are in the session scratchpad under
int5b/screens, and the head atlas is in int5b/atlas-head.

**Left for step 5c and phase 6.**
- p5-input and p5-reconnect (5c): the rest of C-client-stream-9 (shared audio framing, point
  mapper, resize timing). `scripts/test-coredevice.js` lost its ApplToolBox mock. The iPhone
  picture refits after a banner only through the existing observer; a real iPhone shows whether
  that is fast enough.
- p6-touch-button: idle translucency and edge snapping in `controls/ControlPanel.tsx`; the
  button is still named Show controls and Hide controls (`ControlPanel.tsx:356`).
- p6-desktop-layout: `controls/ControlRail.tsx`, the rail rules in
  `style/views/FloatingToolbar.css` and `--stream-rail-width` in `style/views/StreamView.css`,
  which the state card follows. The iPhone rail (13 cells of 56 px) fits 1280x800 and scrolls in
  a shorter window.
- p6-desktop-input: the release chord (D9) belongs in the Keyboard row
  (`settings/KeyboardSection.tsx`).
- p6-list: the stale state of a row; `rememberedPhone(udid).name` is not yet used for the title
  of a reloaded page after a server restart.
- The kit: `ui/Sheet.tsx` should wrap its children in a component so sheets need no
  `SheetContent` or state lifted above `Sheet`; SheetGroup has no heading level option
  (`settings/Section.tsx`), Banner takes no class or data attributes (`DeviceCard.tsx` CardLine),
  Badge has no inline form (`ui/PhoneRow.tsx`).
- `phoneStatus.ts` has no occluded fact; `LockScreenNotice.tsx:50` and `unlockDevice.ts:377` read
  `keyguard.occluded` raw.
- Dead code: `BaseDeviceTracker.tools` and `registerTool`, their registrations in
  `src/app/index.tsx:109` and `:126`, `applDevice/client/coreDeviceTool.ts` and the
  `createEntryForDeviceList` methods. `DEVICE_TABS` in `state/routes.ts:37` is read only by
  `scripts/test-routes.js`.
- The clearStarting rule is in both `views/DeviceCard.tsx:127` and `ui/StreamServiceStatus.tsx:40`.
- Server strings: 'Preparing the device' (`appl-device/services/CoreDeviceRunner.ts:489`, `:523`)
  still says device, and the server does not answer the Android stream service start and stop
  (`goog-device/mw/DeviceTracker.ts`), so About sends them without waiting.
- p6-docs: the older sections of this file still describe the toolbox, Stream settings,
  Scheduled unlock as a sheet and the Apply bar.
- Hardware-only scripts were edited without being run (card lookups by `data-device-key`,
  `.stream-state`), and `scripts/e2e-deeplink.js:50` still looks for a toolbar button named
  Switch device.

**Phone check for steps 5a and 5b** (after the deploy; one iPhone screen start, a second only if
needed and at least five minutes later). Items marked (fixture) are already covered by the
browser suites against fixtures and only need a glance; the rest need the phones. A headless
browser cannot decode the iPhone picture, so the iPhone state card, Wake, the lock notice, the
refit and Type text focus need a person.
1. During the deploy, keep only the Android screen open in a browser (no iPhone screen): the
   header and the card say Reconnecting…, then Connected, with one new stream (5a).
2. Phones list, no screen open: one chip and at most one line per card, the platform line with
   battery and OS from the real phones, no serial (fixture for the layout). An Android phone
   whose stream service runs shows In use; an idle one has no line and no Start. Start in its
   Settings, About: the card says Starting…, then In use, and no stream opens.
3. Turn the Android screen off on the phone: the card says Asleep with Wake beside it; one press
   sends one wake, opens no stream, and the screen lights.
4. Settings from each card (fixture for the sections): Android has five sections and About shows
   the real model, Android version and serial. The iPhone shows Sound, Keyboard, Unlock and
   About; the time field and Replace and Remove behave as before. Do not press Run now: it is a
   counted start.
5. Open the Android screen once: one stream, a two-line header with Connected in the text
   colour, the slot map on the panel (phone) or the rail (desktop). Tap Lock: one press, screen
   off, no power menu; hold it about 1 s: one press, no menu. With the screen off only the Wake
   card shows and no lock notice; Wake wakes it once and the card goes; with a PIN set the
   notice says Phone locked and comes back once the screen is on.
6. Unlock with nothing remembered: on the desktop the field has focus and Enter sends; on the
   phone no keyboard comes up until the field is tapped and the footer stays above the keyboard.
   Tick Remember in this browser: once the phone reports unlocked the sheet closes by itself and
   Settings, Unlock shows This browser as Saved. Lock it with Actions, Lock the phone (one press,
   the sheet closes), press Wake on the card, then tap Unlock on the notice: Unlocking…, the PIN
   is typed once, the phone unlocks and no sheet opens. Forget in Settings removes the copy.
7. Actions on Android: Read returns the phone clipboard; Paste puts the text once into the
   focused field; Notifications, Quick settings and Collapse act and close the sheet.
8. Settings on the Android screen: Data saver shows Restarting stream… under the presets, the
   stream comes back at the new quality, then Settings saved. Capture audio off and on restarts
   the stream each time. With a second browser on the same phone, the restart is asked first.
   Listen in this browser plays the phone's sound.
9. Drop a file on the picture: the band pushes the picture down and touches still land where
   pressed; dismissing it gives the height back.
10. Files then Screen opens one stream; the Files chip goes Connecting…, Connected; `exit` in
    Shell makes it Stopped (5a). Switch phone lists the phone on screen first as Viewing.
11. Settings, About, Stop stream service on the Android phone: asked first; the screen shows one
    card with Start again, no spinner, and Stopped in grey; Start again opens one stream.
12. Unplug the Android phone with its screen open: the name stays, the header and the card say
    Offline in grey without a spinner, no extra stream opens. Settings from its card then says
    Offline and why each row is off.
13. Open the iPhone screen (start 1): the Preparing band sits in the slot with the stage and the
    Starting card under it; the picture fits once connected; Connected in the text colour; no
    tabs. Home sits alone in the middle of the top row and Siri under Lock.
14. Tap Lock: the phone locks and Siri does not start. With the screen off only the Wake card
    shows (it says Screen is asleep); Wake taps the side button; the lock notice appears once the
    screen is on and the picture refits (by CSS, at once) with touches still aimed right.
15. With a passcode stored on the server, tap Unlock on the notice: Unlocking… until the phone
    reports unlocked, no sheet. The server log shows exactly one RUN_UNLOCK_NOW with
    keepUnlocked, no new serve-web start and no Lock press after. Repeat only after the phone
    has locked again.
16. Hold Lock or Siri past 0.7 s: Siri starts and ends on release. On a phone browser, hold
    Volume up in the panel and close the panel: the volume stops at once.
17. Actions on the iPhone: Read; Send to phone, then paste by hand; Rotate Left and Right;
    Refresh picture; Restart video; Reboot and Shut down each ask first (Cancel them). Do not
    press Reconnect: it is a counted start.
18. Settings on the iPhone screen: Listen plays sound, the keyboard switch is on, the schedule
    is there, About says Session Running and names the decoder, and Stop stream service is off
    with 'stop it from the list'. Type text: the field takes focus and the text reaches the
    focused field on the phone.
19. Leave the iPhone screen: its card shows In use during the grace and then not, with Ready,
    Asleep or Locked as its status (5a).
20. Only if needed, start 2, at least five minutes after start 1: Restart services from Settings
    on the iPhone screen reconnects the screen once and the outcome shows under the service rows.

### Redesign step 5c: one mouse contract, one point mapper, one audio reader (2026-11-12, tested without a phone)

Two packages merged into `redesign` in this order: p5-input, p5-reconnect (each from its
`review/` branch). Findings U-stream-15 and C-client-stream-9 (point mapper, audio framing, the
reconnect policies written down; resize timing did not apply). Nothing was run on a phone. Not
deployed. One server file changed, `src/server/mw/WebsocketProxy.ts`, so the deploy of this step
restarts the server; nothing else under `src/server` or `src/common` changed.

**Mouse contract.** `src/app/input/mouseContract.ts` (`MOUSE_CONTRACT`) holds what the mouse does
per platform as facts. `FeaturedInteractionHandler` (Android) and `CoreDeviceInteractionHandler`
(iPhone) act on them, and the Actions sheet's new last Screen row, Mouse and keyboard, prints them
through `mouseHelp()` in `views/actions/actionRows.ts` (Show and Hide, `aria-expanded`, its state
in `useScreen` above `Sheet`). The help cannot list what the handlers do not do.
- Wheel. Android: a scroll message at the pointer, as before (30 ms throttle, up to 16 notches).
  iPhone: one wheel gesture is one swipe (below).
- Drag. Both follow the held primary button on `window` (capture listeners while it is down). A
  point beside the picture is clamped onto its edge, and the touch lifts once where the button
  comes up. The press must start on the picture. The middle button does nothing on either phone.
- Right-click. Android: `KEYCODE_BACK` down and up, the messages of the Back control, and no
  touch. iPhone: nothing, because it has no Back. `BasePlayer` keeps the browser menu away on
  both.
- Ctrl+drag pinches on both: a second finger mirrored through the middle of the picture, or,
  with Shift too, through the point pressed. The press sets the centre on both phones. Android
  sends two scrcpy pointers; the centre is now in video pixels (it was in CSS pixels, which put
  the second finger in the wrong place, or at a negative point that threw in `writeUInt32BE`,
  whenever the picture was scaled). The iPhone sends `touch-frame` contacts 0 and 1, and both lift
  in one frame; `CoreDeviceProxy` and `python/patches/multitouch.py` already take up to five
  contacts. A plain iPhone drag keeps the single-contact `touch` messages. Android also draws
  the pinch fingers while hovering with Ctrl held; the iPhone draws them only during the drag.

**Wheel swipe on an iPhone.** `src/app/input/wheelSwipe.ts`: a touch down at the pointer, 5 moves
20 ms apart that cover 0.2 of the screen against the scroll direction (scrolling down moves the
finger up), a 100 ms rest so the page does not fling, then one lift at the last point: 7 `touch`
messages over about 200 ms. The larger delta picks the axis. The whole swipe stays 10% away from
every edge, so it is never Home, a panel or Back. A wheel event is dropped while a swipe, a mouse
button or a finger is down, and when it comes sooner than 400 ms after the last swipe began. A
held or fast wheel therefore gives at most 2.5 swipes a second: 17.5 touch messages a second on
average and never more than 8 in any 400 ms, against one message per animation frame for an
ordinary drag. A finger or a mouse press ends a running swipe with a lift first. The constants
were chosen without a phone.

**Point mapper.** `src/app/input/pointMapper.ts` replaces `applDevice/touchMath.ts` and the box code
of `InteractionHandler`. It is pure: `elementBox` (the touch layer in CSS pixels, whatever the
pixel ratio and the canvas bitmap size), `isInside`, `clientPointToVideo` (the picture centred in
the box, the point clamped onto it), `lastPixel` (Android's width - 1), `pictureCentre` and
`mirrorPoint`. Rotation needs no step: both phones send their video already turned, so a rotation
arrives as a new video size. What each platform sends for a point is unchanged:
`scripts/test-point-mapper.js` holds the messages of both handlers for 78 fixed points recorded at
58f690c, and the integration ran that table against the 58f690c handlers as well; both match.

**Release.** The `InteractionHandler` base owns it. It lets go once on window blur, `pagehide` and
a hidden page, and `release()` (the view unmounting) lets go before it unbinds. Subclasses
implement `releaseActiveTouch` (sends the lifts) and `forgetActiveTouch` (sends nothing). Pointer
up and touch cancel end a touch in the handlers. Android released on none of blur, hidden or
unmount before, and on unmount it dropped held touches without lifting them. The iPhone already
released on blur, a hidden page and unmount, and now also on `pagehide`. An iPhone mouse lifted by
blur or unmount now lifts at its last position; it used to lift at (0,0) once the last move had
been sent.
- Disconnect, Android: `StreamClientScrcpy.onDisconnected` calls `forgetActiveTouch()` next to
  `forgetHeldButtons()`, because an up sent then is queued and replayed on the next connection.
  The server does the lift: `WebsocketProxy` remembers the last one-message `INJECT_TOUCH_EVENT`
  frame (32 bytes: type, action, pointer id, x, y, width, height, pressure, action button,
  buttons) of each finger a viewer has down, by pointer id; an up removes it. When the viewer's
  socket goes, it writes each one again with action UP and pressure 0, once, as it already did for
  held keys (`scripts/test-video-bootstrap.js`).
- Disconnect, iPhone: the client's lift is dropped by the closed socket, and `CoreDeviceProxy`
  lifts all five contacts in its teardown, as before.

**Shared and separate between the two stream stacks.**
- Audio framing is shared: `AudioEnvelopeReader` in `src/app/client/audioPacket.ts`, one per
  receiver. It reads `scrcpy_audio_2` at offset 0 on Android and at offset 1 behind the iPhone's
  frame-type byte, and the legacy `scrcpy_audio_1` (Android only). It keeps the latest metadata
  and decoder config for a player that starts late, drops the config on a codec change or a
  status other than ready, turns any bad packet into an error status, and clears its state when
  the socket closes. Each WebSocket message is one whole envelope. `scripts/test-stream-receivers.js`
  plays one script of packets through both receivers and the reader and compares what the player
  gets byte for byte, including that it gets a view into the message, not a copy; its receiver
  tests also pass against the 58f690c receivers.
- The point mapper and the release rules above are shared.
- The two reconnect policies stay separate on purpose (owner decision D10), and each is written
  at the top of its receiver. Android (`StreamReceiver.ts`) reconnects after every close except
  4012 and a close after `stop()`, at 1 s x 1.5^n up to 8 s, and `scrcpy_initial` resets n: no
  phone-side limit applies, and its socket ends at this server, which reaches scrcpy through a
  local adb forward. The iPhone (`CoreDeviceReceiver.ts`) reconnects at 1 s x 2^n up to 60 s; the
  codec or Retry resets both the delay and the failed-start count. It stops at once on 4011 and on
  the third 4009 without a session in between, and retries 4010 without counting it. Every
  iPhone start is a serve-web display session, counted against three starts per phone in five
  minutes, and a burst of short sessions wedges the phone's display service. Both policies are
  pinned with exact delays and one socket per attempt in `scripts/test-stream-receivers.js`.
  Neither changed in this step: no backoff, stop rule, close-code meaning or ready point.
- Resize timing was not shared, because there is none to share. Android has had no resize code
  since C-client-stream-5, and CSS fits the picture on both (`StreamView.css`, `.video > canvas`,
  `.video > video`, `.video-layer`). The iPhone's viewport observer and 150 ms `applyBounds` only
  write `BasePlayer.bounds`, which nothing reads, so the iPhone also refits by CSS, at once, when a
  banner comes or goes. The two step 5b notes that said otherwise are corrected above.
- `scripts/test-coredevice.js` had not lost an ApplToolBox mock (step 5b's note): ApplToolBox was
  deleted in dba152c and the layout fixture builds the real controls. Its audio routing test now
  builds a real receiver, because the receiver owns the reader.

**What the owner sees change.**
- iPhone: the wheel scrolls, as a short swipe at the pointer. Ctrl+drag pinches. A blur during a
  drag lifts the finger where it is instead of at the top left corner.
- Android: a drag that leaves the picture keeps going along its edge and ends where the button is
  let go; it used to lift when the pointer left the picture. A mouse drag that starts beside the
  picture and moves onto it no longer becomes a touch (touch edge swipes are unchanged).
  Right-click is Back, with no touch. Ctrl+drag pinches around the middle of the phone's screen
  also when the picture is scaled; Shift+Ctrl pinches around the point pressed, not around where
  the pointer first hovered. Switching window or tab, or closing the page, lifts what is held. A
  viewer that drops mid-drag no longer leaves a finger down on the phone.
- Both: Actions, Screen ends with Mouse and keyboard, which lists the four gestures for the phone.

**Proof.** `npm run check` passes: 653 node tests (628 before; new: `scripts/test-point-mapper.js`
and `scripts/test-stream-receivers.js`, now in `npm test`, plus 8 tests in
`scripts/test-stream-clients.js` and 1 in `scripts/test-video-bootstrap.js`), the Python suites,
lint with 0 errors and 29 warnings (29 at 58f690c as well), and the production build. All 33
default browser suites pass in one run of `node scripts/test-browser.js`, with the new `ios-input`
suite in the default list. `sheet-chrome`, `overlay-back`, `ios-reconnect`, `android-lifecycle`,
`navigation`, `device-page`, `screen-states`, `audio-availability`, `ios-typing` and `controls`
are unchanged and pass; `actions-sheet` expects the new row and `android-stream` now runs its
desktop-dark pass at pixel ratio 2. Stream sockets, as those suites assert them at the merged head:
- ios-reconnect: three failed starts open three sockets about 1 s and 2 s apart, then none for
  4.6 s; Retry opens one; a 4011 refusal after a drop opens one and then none; a 4007 close and a
  dropped socket each open exactly one more.
- android-lifecycle: one socket per open; none after a 4012 close (3.5 s, longer than two
  reconnect delays); Start again opens one; a 4007 close opens exactly one; Wake on a list card
  opens none, and Wake on the screen's card keeps the page at one.
- navigation: one socket per open of a phone screen on both fixtures, none from Back, the list
  arriving or Switch beyond the phone opened, and one iPhone session per open.
- ios-input: one screen session per visit, and no touch message from a wheel or press under the
  open Actions sheet.
The integration read the combined diff of both receivers and both stream clients against 58f690c:
no new place opens a socket, and the reconnect code, stop rules, close codes, the ready point
(`scrcpy_initial` on Android; a ready status or the codec on the iPhone) and `streamConnected` are
unchanged. The only stream client change is the `forgetActiveTouch()` call in
`StreamClientScrcpy.onDisconnected`. No router, route, `App.tsx`, service worker or screen adapter
file changed. The `WebsocketProxy` lift was read against `TouchControlMessage.toBuffer`: it keeps
the 32-byte layout the client writes and changes only the action byte and the pressure, as the
client's own emulated up does.

**Atlas against 58f690c.** 276 files in each. 64 differ, all from the new row: the 8 Actions
states (both phones, both sizes, both themes) differ in pixels inside the sheet, where the Screen
group grows by one row; the other 48 phone screen states differ only by the 6 elements of that row
in the closed Actions sheet, with nothing painted differently. Nothing else differs. The two
atlases are in the session scratchpad under int5c/atlas-base and int5c/atlas-head.

**Phone check for step 5c** (after the deploy, which restarts the server; one iPhone screen start,
a second only if needed and at least five minutes later). Items marked (fixture) are covered by
the browser suites against fixtures and need only a glance; the rest need the phones. A headless
browser cannot decode the iPhone picture and cannot see what a phone does with a touch, so every
effect on a phone needs a person.
1. During the deploy, keep the iPhone screen open in one desktop browser and the Android screen in
   another: each says Reconnecting…, then Connected. The server log shows exactly one new
   serve-web start for the iPhone and no second stream socket; the Android page reconnects by
   itself and ends with one stream. That reconnect is iPhone start 1: do the iPhone items below in this session, without
   leaving the screen.
2. Listen on, on both phones: sound comes back after that reconnect without touching anything.
3. Actions, Screen, Mouse and keyboard, Show, on both phones: four lines; on the iPhone the wheel
   line says short swipe and right-click says nothing (fixture).
4. iPhone wheel, over a long list (Settings): one notch moves the content about a fifth of the
   screen in the wheel's direction and stops without flinging; a sideways wheel moves sideways;
   a wheel near the top or bottom edge never goes Home or opens a panel; spinning the wheel fast
   gives at most about 2.5 swipes a second and the phone keeps up, with taps answering at once
   afterwards.
5. Drag off the picture, both phones: press on a list, drag out past the right edge and up over
   the header, let go there. The finger rides the edge and lifts where the button came up; the
   next click is an ordinary tap. On Android this is new; on the iPhone it worked before.
6. Ctrl+drag on both, in Maps or Photos: a two-finger pinch zooms in and out around the middle;
   Shift+Ctrl pinches around the point pressed. On the iPhone, check that the held Control key
   (sent to the phone while keyboard capture is on) does not change the pinch or trigger a
   shortcut.
7. Right-click on Android goes Back once and no browser menu appears. On the iPhone nothing
   happens and no menu appears.
8. Android viewer dropping mid-drag: turn on Show taps (Developer options) on the Android phone,
   hold a mouse drag on its picture in a desktop browser, and end that browser's process from the
   task manager while the button is held. The touch mark goes away on the phone once the server
   sees the socket close; nothing stays pressed.
9. Blur during a drag: hold a drag on each phone's picture and switch window with Alt+Tab. The
   finger lifts where it was; on the iPhone it no longer jumps to the top left corner first.
10. Touch from a phone browser on both (regression): taps, swipes, a two-finger pinch and an edge
    swipe from beside the picture behave as before.

**Left for phase 6.**
- Dead iPhone resize path, removable as one change: `applDevice/client/StreamClientCoreDevice.ts`
  `:1` and `:128` (observeViewport), `:489` (`input-video-resize` to `applyBounds`), `:525-543`
  (`onWindowResize`, its 150 ms timer and `applyBounds`), `:560-563` (timer cleanup in stop);
  `player/BasePlayer.ts:71` and `:401-403` (`bounds` and `setBounds`, never read);
  `client/observeViewport.ts`; `getVideoBounds` and `computeMaxSize` in `ControlBarLayout.ts`;
  the streamLayoutFixture tests in `scripts/test-coredevice.js`. `views/FloatingToolbar.tsx:29-30`
  dispatches a window `resize` for that path; `controls/ControlPanel.tsx`, `views/LiveTextOverlay.tsx`,
  `ui/viewport.ts`, `ui/Sheet.tsx` and `ui/Menu.tsx` also listen for window resize, so check them
  before removing it.
- Input release on disconnect and blur is still wired per stream client: Android
  `StreamClientScrcpy.ts` (onDisconnected, and the blur, pagehide, visibilitychange and focusin
  release of the UHID keyboard), iPhone `StreamClientCoreDevice.ts` (onDisconnected, and the
  blur, pagehide and visibilitychange release of keys and typing). They release different things,
  so a shared helper would only cover the listener wiring.
- The WHEEL_SWIPE constants in `input/wheelSwipe.ts:9-22` were chosen without a phone. Upstream
  serve-web's own swipe uses 10 steps over about 200 ms with no rest.
- iPhone keyboard capture (`StreamClientCoreDevice.onKey`) sends Control to the phone while
  Ctrl+drag pinches. If the phone check shows an effect, keep Control out of key capture while
  the mouse is down.
- Android shows the pinch fingers while hovering with Ctrl held; the iPhone only during the drag.
- `WebsocketProxy` lifts by pointer id per viewer. Two viewers that use the same pointer id at
  the same moment already collide at scrcpy, and a departing viewer's lift could lift the other
  viewer's finger with that id.
- A drag whose mouseup never arrives (the button let go outside the browser with no blur) keeps
  the finger down until the next blur or click on both phones. Ending the drag on a mousemove with
  `buttons == 0` would cover it.
- A trackpad pinch over the iPhone picture arrives as a wheel event with Ctrl and now makes a
  swipe instead of zooming the page; on Android it already scrolled. Ctrl+click on macOS is a
  secondary click, and Ctrl+drag has not been tried on a Mac.
- `applDevice/client/CoreDeviceReceiver.ts:206` throws a RangeError on an empty binary message.
  The server never sends one; unchanged from before.

### Redesign step 6a: Shell keys, Files service, Notifications setup, the list while reconnecting, the touch button and the desktop stage (2026-11-12, tested without a phone)

Six packages merged into `redesign` in this order, each from its `review/` branch: p6-shell-keys,
p6-files-service, p6-notification-setup, p6-list, p6-touch-button, p6-desktop-layout. Findings
U-tools-11, C-client-tools-css-9 (service half only; the view half was dropped by D6),
C-client-tools-css-13, U-tools-9, U-notifications-13, U-notifications-4 (header part only),
C-notifications-9 (feed extraction only), U-home-8, U-home-9, U-stream-9, U-stream-10, and two
step 5b leftovers (U-stream-11 remembered name, U-home-12 card link names). p6-android-device is
not part of this merge. Nothing was run on a phone. Not deployed: live still runs e2fd657, and
steps 5a, 5b and 5c are merged and waiting for the owner's iPhone.

Server and shared files: only `src/server/notifications/` changed (NotificationFeed.ts new,
NotificationService.ts, NotificationStorage.ts), so the deploy of this step restarts the server.
`src/common/Notification.ts` gained the `MutedApp` interface and the optional
`NotificationSource.muted` field; the file declares interfaces only, so no compiled code changes
there. No router, route, `App.tsx`, service worker, stream client or screen adapter file changed.
In the kit, the Sheet has a docked presentation (p6-desktop-layout); p6-list also gave
`ui/PhoneRow.tsx` its stale look (its brief owns that) and `ui/WakeButton.tsx` an optional
`disabled` prop, and p6-touch-button added the `--idle-opacity` token to `style/tokens.css`.

**Shell key row (p6-shell-keys, U-tools-11).** `src/app/views/shell/ShellKeys.tsx` is one row of
kit buttons named Extra keys that scrolls sideways: Esc, Tab, Ctrl, Left arrow, Up arrow, Down
arrow, Right arrow, Paste, Copy, A− (Smaller text) and A+ (Larger text). It is drawn only while
the browser matches `(pointer: coarse)`, read once and kept current by a change listener; with a
mouse there is no row and the terminal takes that height. Show keyboard is gone: a tap on the
terminal focuses xterm, and every typing key focuses it too. A mousedown on the row is cancelled
so a press does not take the focus from the terminal. The row talks to the terminal through
`ShellTerminal` (sendKey, setControl, focus, pasteText, textToCopy, setTextSize); `MountedTool`
in ToolView extends `Partial<ShellTerminal>`, so a public member of FileListingClient with one of
those names must keep the same signature. The bytes come from pure functions in
`shellInput.ts`: the arrows send ESC O x while a program has application cursor keys on and
ESC [ x otherwise; a paste turns line ends into CR, is bracketed only in bracketed paste mode and
loses an embedded end marker. Ctrl stays one-shot, and neither the row's keys nor a paste use it.
- Paste reads the clipboard only when pressed and sends the text once. On the plain http address
  it reads nothing and says "Paste needs this app's secure (HTTPS) address."; a secure page that
  refuses says "This browser blocked reading the clipboard.". Text over the 256 KB clipboard limit
  is refused.
- Copy takes the xterm selection, or with none the rows in view (wrapped rows joined, trailing
  blanks dropped), through `copyTextToClipboard` (execCommand fallback on http). Copy stays on
  without a session, so the output of a session that ended can still be copied; every other key
  is off until the shell is connected.
- The row's toasts carry `shell-keys-toast`; a views-layer rule in `ToolView.css` lifts them above
  the row. If the kit toast's `bottom` formula changes, that rule must follow.
- Text size is 12, 14, 16 or 18 px (default 14), kept per browser through `ui/storage.ts` under
  `ws-scrcpy.shell.text-size`. ShellClient builds xterm at the kept size, so the start message
  already has the right columns and rows. A change refits the terminal and reuses the 100 ms
  debounced resize: one resize per press, and quick presses send one resize with the final size.
- The session, its socket, reconnect and the Stopped state are unchanged. `shellInput.ts` is now in
  the main bundle; xterm stays in the lazy Shell chunk.

**Files service, large folders and uploads (p6-files-service).**
- `src/app/googDevice/files/FileService.ts` builds and reads every request on the Files channel:
  STAT, LIST, SIZE, MKDR, MOVE, COPY, DELE, the upload push protocol, the FSLS channel init and the
  HTTP download link. Each request returns a promise with `cancel()` and rejects with one
  `FileError` whose kind and message can be shown ('refused' carries the phone's own words, also
  when they come as a close reason). Replies after `cancel()` or `release()` are ignored.
  FileListingClient.ts (3,503 lines) keeps the DOM and builds no protocol bytes.
  AdbkitFilePushStream.ts and FilePushStream.ts are deleted; FilePushHandler is only the queue (two
  at a time), drag and drop, the name question and Cancel. The frames are unchanged:
  `scripts/test-files.js` runs a fixed script and compares every frame with
  `scripts/fixtures/files-wire.json`, recorded at f0862e3; `FILES_WIRE_RECORD=1` rewrites it, and
  only on purpose.
- Rendering: `files/FolderEntries.ts` holds the folder by name and sorts once per change (one
  `Intl.Collator`, keys computed once, the same order as before). `files/KeyedRows.ts` keeps one
  row per item; filter, sort and a growing listing move rows instead of rebuilding them. While a
  listing arrives, a render waits until 250 ms after the previous one. A list of more than 200
  items has only the rows near the view, with a spacer above and below (`files/RowWindow.ts`).
  Each line measured between two others keeps its pitch, other lines take the mean, and only a
  change of view or width forgets the measures (a hidden tab keeps them). Folders of 200 items or
  fewer render as before. In a long list the keys scroll the target row into view first; when the
  focused row leaves the document, focus moves to the list container and the keys continue from
  it.
- Uploads no longer block: folders open, commands run and more files can be dropped while uploads
  run. Each upload goes to the folder it was planned for. When a batch ends, only the folder on
  screen (or the one being opened) is listed again, and only if files went to it; a Files tab shown
  again also relists during uploads now. A drop is refused only while a folder loads, an operation
  runs or a question is open: "Wait for the current folder or operation to finish before adding
  files." Each upload row shows the name, a bar (role progressbar), the bytes sent of the total
  ('Waiting', 'Starting' and 'Saving' otherwise) and Cancel. Downloads are unchanged.
- Other changes the owner may notice: a LIST that the server ends with close(4000, reason) now
  shows the phone's reason instead of "The connection to the phone was interrupted.".

**Notifications setup and header (p6-notification-setup).**
- Server: `src/server/notifications/NotificationFeed.ts` is the pure feed (receive, replay hints,
  pruning, counts, history, forgetText, removeSource) with an injectable clock and key generator
  and its own unit tests. `shouldRelay(event, source, sub?)` is the only app filter: without a
  subscription it decides what is kept, with one it decides the push. Process supervision and the
  routes are still in NotificationService.ts.
- Mute list: each iPhone record has an optional `muted: [{app, name}]` beside the older allow-list
  `apps`. A muted app's new notifications are neither kept nor pushed, also on top of an
  allow-list, and a push already queued for one is dropped. Notifications stored before the mute
  stay. Anything that arrives between a mute and its Undo is lost. The name is stored so Setup can
  show a muted app after its history has aged out.
- Compatibility. POST /sources accepts the request a page left open across the deploy sends:
  without `muted` the existing mute list is kept, and a new record is stored exactly as before
  (no `muted` field). A changed iPhone now keeps its place in the list (before, every change moved
  it to the end, which reordered Setup and changed the inbox opened without a chosen iPhone).
  Settings files written before the mute list are read unchanged, and reading them writes nothing
  back. The collector is still sent the whole sources list and reads only `address` and `id`, and
  a mute change does not restart it. After a rollback, the older server ignores `muted` and drops
  it at the next change of that iPhone. Tests: `scripts/test-notification-service.js` 'an existing
  allow-list keeps filtering exactly as before', 'a request in the old shape is still accepted and
  means what it meant', 'settings saved before the mute list existed are read as they are and keep
  working', and 'a changed iPhone keeps its place in the list'.
- Setup (`src/app/views/notifications/SourceSettings.tsx`, state in
  `src/app/state/notificationSources.ts`): Settings for an iPhone has an Apps list of the apps seen
  from it (newest name from history, plus muted apps with no history left), each with its icon
  (fetched when the list is first opened) and a switch (on comes through, off is muted). An older
  allow-list shows as "Only these apps" with "Clear the list and use muting". Every setting applies
  when it is changed, with a toast and Undo (12 s): Include notification text, mute, clear list,
  the "Get notifications from" switches and "This app is open on". A refused change puts the
  control back and the error banner says why. Save app filter, Save changes and the typed
  identifier field are gone. Removing an iPhone also removes it from this browser's saved
  choices.
- Header: one AppBar row with back, "Notifications" and a status line "<iPhone> · Connected",
  "Reconnecting" or "Action needed" in the state's tone ("Setup & delivery" on Setup), the unread
  badge, Switch (aria-label Switch iPhone, only with two or more iPhones; a sheet with unread
  counts), and Search and Setup icon buttons, pressed while open. The Inbox and Setup tabs, the
  iPhone select, the name row and the Last notification row are gone. Search opens the search row
  with Filters; text or an app in the address opens it, closing it clears the search, and Search
  pressed on Setup shows the inbox with the field in focus. "Open iPhone screen" is the first item
  of the list's Notification actions sheet. The first card starts at 129 px on a 390x844 screen
  without safe-area insets.
- Two traps the worker found. A kit ConfirmPrompt mounted during an ancestor's own re-render can
  repeat ids already on the page (Preact `useId`); Setup's armed prompt is therefore held in
  NotificationsView and the Switch sheet mounts only after its first use. The review's check finds
  no repeated ids with both iPhones' settings open and a prompt armed; the Preact cause was not
  reproduced. And a replace within the same page does not close an open sheet
  (`state/router.ts` commit), so a sheet that changes the address must close itself.

**Phones list while reconnecting, and the grid (p6-list).**
- A closed list socket no longer empties the list. `BaseDeviceTracker.onSocketClose` marks the
  tracker's entries stale (`DeviceEntry.stale`, `markTrackerDevicesStale` in `state/devices.ts`);
  the tracker's next list replaces them, and a phone missing from it goes. `STALE_LIST_LIMIT_MS`
  (30 s, from the first close) clears them if no list comes; the 2 s reconnect is unchanged. A
  restarted server lists its phones under a new tracker id (it hashes `os.uptime()`), and
  `setIdAndHostName` removes the old id's entries.
- Stale is a flag on the entry; the status model ignores it, so a stale card keeps its last chip
  (title "Last known status: …") and is never Offline. `isDeviceAvailable` and `canOpenScreen` are
  false for it (`reportedConnected` is the old check). `findDeviceByUdid`,
  `findDeviceWithoutTools`, `findDeviceForStream` and `findDeviceForTool` skip stale entries, so
  phone pages, screens, tools, Actions and Unlock behave as before a drop. Only the list, the
  switcher, the page title, Notifications setup's iPhone picker and Settings see stale entries.
- The list shows the cards dimmed under one Banner, "Reconnecting… The phones are shown as last
  reported.", outside the scroller, and the AppBar line says Reconnecting…. Open screen, Wake,
  Files, Shell, Enable and restart and Restart services are off; Settings, Open settings and the
  Notifications bell stay on. Settings opened for a stale phone says "Reconnecting to the server.
  Settings that need it are off until it is back."; its service rows, stream controls and the
  scheduled unlock controls are off, and it finds the phone again by its serial when the next list
  names it under a new key (`views/settings/phone.ts`).
- Before the first list a delayed "Loading phones…" box shows. `listReceived` is computed over the
  trackers that have listed, plus a host list that named none, so "No phones connected" needs an
  empty list. The page restores scroll as before, refocuses the card link a page was opened from,
  and gives the focus back to the card control that had it when the list turned stale.
- Grid: `repeat(auto-fill, minmax(min(100%, 340px), 1fr))` inside 1200 px, so at most three
  columns of up to 392 px, two at 1024, one on a phone. Each card's action row sits at its foot,
  so the cards of a row line up. The 720 and 1040 breakpoints are gone and the gutter widens at
  600; the 360 narrow-phone rule stays (VIEW_BREAKPOINTS lists only it for DeviceList.css).
- `phoneName` falls back to the name this browser kept (`rememberedPhone(udid).name`), so a
  phone page reloaded after a server restart is named before the list is back. The card's tool
  links are named "Files on <name>" and "Shell on <name>".

**Touch controls button (p6-touch-button, U-stream-9, D4).** On a touch screen the controls
button is a 44x56 tab on the left or right edge of the stage, named Phone controls, with
`aria-expanded`. Its place is a side plus a fraction of the height it can move in (pure logic in
`src/app/controls/buttonPlace.ts`, tested by `scripts/test-controls-place.js`), kept per browser
under `controls_button_place`; an old `floating_toolbar_position` corner is converted once and
left in storage. It sits only inside the stage, cut to the visual viewport and the safe-area
insets, so it never covers the header, the tabs, the banner slot or the Type text sheet. It is
placed again when the stage or the picture changes size, the picture element changes, the
window or the visual viewport changes size or scrolls, the `.stream-view` style or class changes
(Type text pans it with the keyboard), or a sheet docks beside the stage (below). With no saved
place it sits on the right at 44% of its height range. After a drag it slides to the nearer edge
through `ui/motion.ts` (no motion when reduced). It goes to `var(--idle-opacity)` (a new token,
0.5 rather than about 45%, because at 0.45 it falls under 3:1 against a white picture) from mount
and 3 s after the last touch, and is fully opaque while touched, while its panel is open and with
keyboard focus. The 3 s clock pauses under the modal sheets (Actions, Switch, Unlock, Settings),
not under Type text. The panel opens beside the button, centred on it (above or below under
about 358 px), and never below the stage. Back and Home stay in the panel.

**Desktop stage (p6-desktop-layout, U-stream-10, D5).**
- With a mouse, at every window width, the rail stands against the right edge of the picture and
  is as tall as it. `ScreenView.tsx` (`usePictureBox`) reads the touch layer's box (the mount
  node's box until the player has sized the canvas) and writes `--stream-picture-top`, `-right`,
  `-width` and `-height` on the stage. It only observes. The mount node keeps the rail's width
  and a docked panel's width free at its right, so the picture and the rail are centred together.
  `ControlRail.tsx` picks one or two columns from its own height (slots x 56 px) and applies a
  change on the next frame. Under a mouse `.video` is transparent, so the stage is one colour
  (#05080e) around the picture and the rail.
- The kit Sheet has a docked presentation: the `dock` prop, `SHEET_DOCK = (min-width: 1024px)`
  and `useSheetDock(ref)` to name the host. From 1024 px, while a phone's screen is shown, Actions,
  Settings and Type text open as a 380 px panel (`--kit-sheet-dock-width`) at the stage's right
  edge, as tall as the stage, with nothing dimmed. This applies on a touch screen too. It is only
  a presentation: modal, history, focus, Escape and Back and the event stop are the code they were.
  The host has `data-sheet-docked` while the panel is shown, including its exit. Actions and
  Settings stay modal (a press beside the panel closes it and reaches nothing); Type text stays
  not modal (a press on the picture reaches the phone while the field keeps typing). Settings
  docks only while ScreenView is mounted, so from the list, Files and Shell it is the centred
  dialog. Rows in the panel are laid out as on a phone. Below 1024 px the sheets are where they
  were. `dialog.kit-sheet[open]` still matches every open sheet, so `localKeyboardTarget.ts` is
  unchanged: a docked Actions or Settings blocks keys to the phone and a docked Type text takes
  them once.
- The state layer dims the stage up to a docked panel or the stage edge and keeps the rail's width
  free, so the state card is centred on the picture; the card is no wider than the picture, so the
  rail never covers it. Long messages on a narrow portrait iPhone picture wrap to more lines.

**Integration.**
- No textual conflicts. `scripts/e2e-tools.js` from p6-shell-keys still opened the Shell from its
  card by the old link name 'Shell'; it now uses 'Shell on Fixture Phone A' (9d172c7).
- `scripts/test-controls-place.js` is in `npm test` and `desktop-layout` in the default browser
  suites (9d6e6b4).
- Touch button beside a docked sheet (39d0e72): from 1024 px a touch screen docks the sheets too,
  and the button stayed at the stage's edge under the docked panel, unreachable while Type text
  was open. `ControlPanel.tsx` now keeps the button and its panel to the part of the stage the
  sheet leaves (`dockedWidth`, read from `data-sheet-docked` and `--stream-dock-width`, watched
  through a MutationObserver on the stage), and the button goes back to the edge when the sheet
  closes. New check `besideDockedSheet` in the controls suite at 1180x820 on both phones; it fails
  on the merge without the fix ("the button stands against the docked sheet (1180, sheet from
  800)").
- `scripts/e2e-device-page.js` focusFollowsTheTabs (b6df8e8): failed once in four runs because the
  terminal takes the focus when it is created on a desktop, and the Shell code sometimes arrived
  before the check read the focus. The lazy code is now held until the focus has been read. The
  assertion is unchanged; the race was there before this step.
- `scripts/e2e-android-stream.js` (903cfa9): with a mouse the rail takes a second column for the
  shorter picture after a rotation, a frame after the picture changes size, and the picture moves
  again (1191 px wide with one column, 1103 px with two, at 1280x800). The desktop-dark pass read
  the box in between once and missed its aim. It now reads the box after it has stayed the same
  for three frames; the assertion is unchanged. A person clicking does not meet this, but a
  script that measures the picture right after a change of its size must wait the same way.
- Assertion changes in default suites made by the packages, kept: sheet-chrome
  typeTextKeepsPicture, ios-typing desktopFlow and pictureFlow, and ios-input mouseHelp asserted
  the step 4d placement of Type text (under the picture) on windows of 1024 px and wider, or a
  point measured while Actions was open; from 1024 px they now assert the panel beside the picture.
  Below 1024 px the old assertions run unchanged. overlay-back changed only how Notifications
  reaches Filters (through Search). The renamed "Phone controls", "Files on <name>" and "Shell on
  <name>" names and the removed "Show keyboard" button changed selectors in settings, sheets,
  android-stream, device-page, navigation, tools and files-flows.

**What the owner sees change.**
- Shell on a phone: a sideways row of Esc, Tab, Ctrl, four arrows, Paste, Copy, A− and A+ under the
  terminal; no Show keyboard button (tap the terminal); the text size is kept per browser. Shell on
  a desktop: no key row.
- Files: a large folder scrolls without stalls; folders and commands work while files upload;
  each upload has a bar, bytes of total and Cancel; a refused listing shows the phone's reason.
- Notifications: one-row bar with Switch, Search and Setup; Setup has a mute switch per app and
  applies every change at once with Undo; "Open iPhone screen" moved into the list's actions.
- Phones list: cards stay, dimmed, during a reconnect or a deploy shorter than 30 s; "Loading
  phones…" before the first list; on a desktop the cards are an even grid of up to three columns;
  one column from 600 to about 739 px.
- Phone screen on a touch screen: the controls button is an edge tab, translucent when idle, and
  starts on the right at 44% height instead of the bottom right.
- Phone screen with a mouse: the rail is attached to the picture; from 1024 px Actions, Settings
  and Type text open beside the picture and the picture moves left to make room; the stage around
  the picture is #05080e instead of black.

**Proof.** `npm run check` passes: 697 node tests (653 at f0862e3; new:
`scripts/test-controls-place.js`, now in `npm test`, and new tests in test-shell, test-files,
test-notification-service, test-notification-page, test-home and test-client-lifecycle), the
Python suites, lint with 0 errors and 29 warnings (29 at f0862e3), and the production build.
All 34 default browser suites pass in one run of `node scripts/test-browser.js`, with
`desktop-layout` new in the list. The `files` suite took 157 to 158 s of its 240 s limit in
three runs (about 155 s before). Two earlier full runs at the merged head each stopped once on a
timing race in a test, fixed as described under Integration. The main bundle grew from 446 KB to
463 KB. Stream sockets, as the suites assert them at the merged head:
- desktop-layout: one stream socket per open of the screen on both fixtures, at 1440x900 and
  1366x650, light and dark, after Actions, Settings, Type text, Switch phone, the window crossing
  1024 px and six more panel opens; the stage and the mount node stay the same elements; the
  state card check and Settings from the list open none.
- controls (besideDockedSheet): one stream socket on a 1180x820 touch screen with Type text docked
  and closed, on both phones, and the same stage element.
- navigation: one socket per open of a phone screen on both fixtures, none from Back or the list
  arriving, and one iPhone session per open.
- ios-input: one screen session per visit.
- device-page: the stream stops and starts once across the tabs, and a player change restarts it
  once.
No package opens a socket from a new place: the stream clients, adapters, routes and `App.tsx`
are unchanged, and the new code on the screen (`usePictureBox`, the docked Sheet, the
ControlPanel observers) only reads layout and sets styles.

**Atlas against f0862e3.** The base was built from an export of f0862e3. 276 files at the base,
284 at the head (the new `notifications-search` state, 8 files). 198 files differ (90 pictures,
108 style records). Files (its six states, 44 files), `phone-not-listed` and `tool-unavailable`
do not differ.
- Phone screen at 390x844 (both phones, every state): only the touch button changes (its
  `floating-toolbar` elements): the edge tab on the right, translucent when idle, and the panel
  opened beside it in the controls state. Pixels differ only in a band at the right edge, except
  in the controls state. Nothing else on the phone screen changes.
- Phone screen at 1440x900 (screen, asleep, actions, settings, switcher, type-text, unlock, both
  phones): the rail is attached to the mount node's right edge (the atlas has no decoded picture),
  the stage is one colour, and Actions, Settings and Type text are the docked panel; asleep has
  the state layer dimmed to the edge.
- Shell: the Extra keys row at 390 (the row is wider than the screen and scrolls); at 1440 the old
  shortcut row is gone.
- Phones list (with its two Settings states): the even grid at 1440 (pixels); at 390 only the
  computed styles of the grid and the cards change, no pixel.
- Notifications (every state, both sizes): the one-row bar; Setup with the Apps list; the new
  search state.
Two atlas runs of the merged build match byte for byte. The two atlases are in the session
scratchpad under int6a/atlas-base and int6a/atlas-head, and
pictures of each changed screen at both sizes and in both themes under int6a/screens.

**Phone check for step 6a** (after the deploy, which restarts the server; at most one iPhone
screen start for the screen items, a second only if needed and at least five minutes later).
Items marked (headless) are covered by the browser suites against fixtures and need only a
glance; the rest need the phones or a person. A headless browser cannot decode the iPhone picture,
see a phone keyboard, or see what a phone does with a touch.
1. Deploy with the Phones list open in a desktop browser and on a phone (no screen open there):
   the cards stay, dimmed, under "Reconnecting… The phones are shown as last reported.", Open
   screen and Wake are off, and the cards come back live under the restarted server's new ids,
   with a focused card link still focused. No iPhone session starts from the list (server log:
   no serve-web start). A deploy longer than 30 s shows Connection lost, then "Loading phones…".
   A Settings sheet left open on a card shows the phone again afterwards. (headless for the
   behaviour; the real deploy timing needs the server)
2. Notifications (no screen session): on the bench iPhone, mute one app in Setup >
   Settings for <iPhone> > Apps. Send a notification from that app and one from another app: the
   muted one neither appears nor pushes, the other does both. Unmute with the switch and check the
   next one comes through. Press Undo once after a mute and check the switch goes back. (phone)
3. Notifications header in the installed app on the iPhone: the one-row bar sits under the notch,
   the status line reads "<iPhone> · Connected", and Search and Setup open and close. With two
   iPhones linked the status line may be cut short at 390 px (known). (phone; the layout at
   390x844 without insets is headless)
4. Shell on the Android phone in Chrome and on the iPhone in Safari: tap the terminal and check the
   on-screen keyboard opens; with it open, the Extra keys row sits just above it and Esc, Ctrl and
   the arrows do not close it; arrows move the cursor in a shell line and in `vi`/`less`; a toast
   from Paste or Copy sits above the row. Paste over https: on iOS Safari the system Paste bubble
   appears and one paste reaches the shell; over plain http the toast reads "Paste needs this
   app's secure (HTTPS) address.". Copy over http with the keyboard open: the text reaches the
   phone clipboard; note whether the keyboard flickers. A+ and A− change the size and the shell's
   columns follow (`stty size`). (phone; the bytes and the single resize are headless)
5. Files on the Android phone: open a real folder with several thousand items on /sdcard (for
   example DCIM), in Details and in Tiles: scroll, filter, arrow
   keys and Shift selection, with no stutter and no rows jumping. Upload a large file and cancel it
   half way: no partial file is left. Upload again and, while it runs, open another folder and
   make a folder there: the upload ends in the folder it started in, and the bar shows bytes of
   total. (phone; the 5,000-item fixture and the upload flows are headless)
6. Touch controls button on the iPhone in Safari and in the installed app, portrait and landscape
   (one screen session): the tab sits clear of the notch and the home indicator; drag it to each
   edge and to the very bottom; it stays inside the safe area; a tap soon after a drag opens the
   panel; at 50% over a light picture in the light theme it is still easy to find. With Type text
   open and the keyboard up, scroll or pan the page: the tab stays on the stage and does not
   cover the header or the sheet. On the Android phone in Chrome: the same drag and tap. (phone;
   placement against fixtures and simulated insets is headless)
7. Desktop with a mouse, a real Android picture and a real iPhone picture, at about 1440x900 and
   1366x650: the rail is flush against the picture's right edge, one column at 900 high and two at
   650. Actions, Settings and Type text open beside the picture without covering it; the picture
   moves left without shrinking. With Type text open, a click on the picture lands where pressed
   while the field keeps typing. With a state card shown (asleep, reconnecting), the card sits on
   the picture, not under the rail, and the stage is evenly dimmed. Open and close Actions and
   Settings a few times on the iPhone: still one serve-web session (server log). (person at a
   desktop; geometry and the socket count are headless) Items 6 and 7 each open one iPhone
   screen session; leave at least five minutes between them.
8. Phones list on a desktop at 1024, 1280 and 1920 wide: an even grid, up to three columns, action
   rows lined up. (headless)

**Left for later steps.**
- p6-desktop-input (6b): keys are blocked by `dialog.kit-sheet[open]` in any presentation, so a
  docked Actions or Settings still blocks keys to the phone and a docked Type text takes them
  once. The keyboard chip and the release chord can go anywhere in the header; the stage only
  changes styles. `scripts/e2e-controls.js` slotMap expects one rail column at 1280x800, where the
  iPhone rail fits with 1 px to spare (13 slots of 56 px in 729 px); a taller header (the chip) or
  a banner gives two columns, and that check then needs the two-column mapping.
- p6-inbox (6b): "Mute this app" on a card's menu should call `setAppMuted(source, item.app,
  item.appName || item.app, true)` (`src/app/state/notificationSources.ts:70`), refresh, and offer
  Undo with `muted` false. The filter row with counts is unchanged; the search row
  (`views/NotificationHistory.tsx:592`) opens only from the bar's Search and holds Filters,
  which could move into the filter row. "Open iPhone screen" is in the list's actions sheet
  (`NotificationHistory.tsx:764`). `.notification-history-tools` margin-bottom went from 8 to 4 px.
  At 390 px with two or more iPhones, or with a long name and the unread badge, the bar's status
  line is cut short; an icon-only Switch or the title as the switcher would fix it.
- C-notifications-9, remaining: process supervision (`startCollector`,
  `src/server/notifications/NotificationService.ts:257`, and the restart and backoff code) and the
  routes with a schema validator (`mount` at :578, POST /sources at :908).
- Kit: `src/app/ui/ConfirmAction.tsx:128-129` uses `useId`; ids from a module counter would avoid
  the repeated ids the worker saw. `src/app/ui/Presence.tsx:53`: a docked panel enters with the
  dialog's rise; a slide from the right would need a new motion kind.
- `src/style/views/StreamView.css:63-69`: the base `.stream-controls-slot` rule no longer has a
  visible effect; it was kept so phone states compute the same styles. Remove it with a new atlas
  baseline. `src/app/controls/ControlRail.tsx:7` SLOT_HEIGHT repeats the CSS row height.
- Touch button: `--idle-opacity` is 0.5 (`src/style/tokens.css:51`), not the 45% of D4; raise it
  if the idle tab is too faint over light pictures. The old `floating_toolbar_position` key stays
  in each browser (`ui/storage.ts` has no remove helper). The button starts translucent rather
  than opaque for its first 3 s. Non-default scripts that rely on its old place
  (`scripts/e2e-ux.js`, against the live server) were not run.
- Phones list: `scripts/e2e-atlas.js:315` listStates has no loading or reconnecting state. A
  single `device` message does not end the stale limit (`src/app/client/BaseDeviceTracker.ts:189`);
  only a list does, and the server always sends the list first. The switcher shows stale phones
  greyed with no Reconnecting line (`views/DeviceSwitcherSheet.tsx:74`). For a stale phone,
  Settings' service rows say "Not available while the phone is not connected."
  (`views/settings/AboutSection.tsx:198`) while Connection says Reconnecting…. A card link to
  another server is also remembered for the focus return (`views/DeviceList.tsx:135`). With
  several servers, one server reconnecting puts the Reconnecting… bar on the whole page.
  `state/streamDevice.ts:37` findDeviceForSettings is used only by a test.
- Files: the view half of C-client-tools-css-9 (Preact components, BottomSheet reuse) was dropped
  by D6; FileListingClient.ts is 3,503 lines and the row-window glue (`renderWindow`,
  `measureLines`, `measureRows`, `viewInBody`, `reveal`, :896-1019) could move next to
  `files/RowWindow.ts`. When a batch ends, the relist clears a selection or filter in that folder.
  Two batches uploading the same name to one folder are not checked against each other; the
  phone refuses the second. In Tiles of a large folder of uneven tiles, scrolling back through
  lines never measured can still move the rows in view in Safari.
- Dead code named in step 5b: `ShellClient.createEntryForDeviceList`
  (`src/app/googDevice/client/ShellClient.ts:326`), `FileListingClient.createEntryForDeviceList`
  (`FileListingClient.ts:217`), `BaseDeviceTracker.tools/registerTool` and the registrations in
  `src/app/index.tsx`.
- Shell: the tab's hint "Use the terminal of this phone. Tap it to type."
  (`src/app/views/ToolView.tsx:63`) is now the only instruction for opening the keyboard.
- p6-docs (6c): README.md lines 518-536 still describe the old Notifications page (Setup &
  delivery, app filters, Save changes, the name row with Last notification and Open screen).
- p6-android-device is still to come in 6a, with its own Android check and deploy after 5b is
  live.

### Redesign step 6b: keyboard capture, the inbox and server settings (2026-11-12, tested without a phone)

Merged from base `4434a62` in the approved order, each with `--no-ff`:
`review/p6-desktop-input` at `6958e45537254262742a09dc50c689d55e72f2fc`,
`review/p6-inbox` at `c7a15185fd090d67fe1d26391c5b647b711bc28e`, then
`review/p6-server-config` at `4563fbbeb38596c7688a5d8796cb9bf57e4f14fc`.
The merge commits are `674f414`, `33a4eb1` and `5365573`. There were no conflicts.
`9439a08` registers `scripts/test-settings.js` in `npm test` and `desktop-input` and
`notification-inbox` in the default browser list. No integration feature fix was needed.
Not deployed. No phone, adb, real pymobiledevice3, Docker or live server was used.
All server and browser checks below used fixtures.

**Keyboard and paste (p6-desktop-input).** Findings U-stream-6, U-flows-8 and U-stream-12
are done in fixtures. `state/keyboardCapture.ts` owns the open screen's capture state,
keyboard listeners, deferred modifiers and clipboard cancellation. The header chip and
Keyboard settings read the same state. The chip says `Keyboard: phone` or
`Keyboard: this page`; local fields and open sheets make the latter visible without
changing the capture preference. The chip is shown only with a fine pointer. Its full
wording wraps at 320/390px mouse widths; Back, Notifications and Switch remain reachable.
The existing under-360px bell rule now applies only to coarse pointers.

Ctrl+Alt+K releases or recaptures the keyboard (Ctrl+Option+K on a Mac). The Keyboard
section lists K capture, S Switch phone, H Home, B Back, O Overview, T Type text,
P Screenshot and C Copy from phone, all with Ctrl+Alt. iPhone omits Back and Overview.
Reserved chords use the existing offered control table and do not send their modifiers
to the phone. Ctrl/Cmd+K still opens Switch after release. With capture on, fine-pointer
rail actions and sheet close refocus the picture, or the mount before a picture arrives.
Released capture retains page focus. `dialog.kit-sheet[open]` stays the local-keyboard
gate for bottom, centred and docked sheets. Type text keeps its own keys and paste once.
UHID preference survives release; the Android keycode fallback uses the same gate.

Direct browser paste uses Android's existing clipboard-and-paste message. iPhone writes
the clipboard once, waits for its matching successful result, then sends Cmd+V as four
reports: Command, Command+V, Command, empty. Failed writes send no paste keys. The shared
UTF-8 limit is 262130 bytes (256 KiB less the 14-byte Android header); the notice says
256 KB. Local fields retain native paste. A busy clipboard action rejects overlap.
Target change, blur, page hide, disconnect or stop cancels pending work. Queued iPhone
paste reports recheck the target and lift a modifier already sent. Repeated Copy from
phone keeps one read outstanding. A late browser-copy result cannot replace a later
screen's notice or start its fallback textarea; a write already given to the browser
clipboard API cannot be retracted. The temporary fallback field is removed and prior
focus restored, including on denial.

A ready iPhone session now enables commands, Unlock and Type text independently of HEVC
decoding. The no-picture card remains. New contacts stay blocked without a usable
picture; decoder loss lifts existing contacts and permits their releases. No unlock was
run. The inert elements inspected with Type text open are retained panels in closed
Sheets. The open input and stage remain active; no inert rule changed.

**Inbox (p6-inbox).** Findings U-notifications-4, -5, -7, -14 and the card action part of
-13 are done in fixtures. An unscoped inbox combines multiple linked iPhones. An explicit
source, including an already delivered push link, remains scoped. The Switch iPhone sheet
adds All iPhones and per-source unread counts; combined cards name their source. The
filter row says Inbox with count, Unread with count, Archive; Mark all read is a direct
toolbar action. The first actual card is 129px from the top at 390x844 without safe-area
insets. The desktop inbox can grow to 1024px.

Cards use local calendar-day headings, shorter times and regular muted app names.
Adjacent notifications sharing source, app, title and day form a stack, with access to
each member and its own actions. Missing apps or titles do not stack. A click or Space
expands text and marks that item read; opening its phone also marks it read. The badge
counts update. Expanded text remains in Unread until collapsed or hidden, including when
its stack closes. Opening a phone waits for the read response and cannot navigate after
the inbox has been left or its address changed. A push notification parameter is consumed
once; filter and search writes do not consume it again.

Fine-pointer cards have hover/focus Mark read/unread, Dismiss and Open screen controls,
and an anchored Menu even at a 768px mouse width. Touch keeps Sheets and swipes. J/K or
arrows move between cards; E archives here, U changes read state, / opens search and Z
undoes. Native controls, typing and open overlays retain their keys. Successful local
restore, phone actions and mute move focus to the next available card. Cancelled swipes
suppress the compatibility click, so they cannot mark text read by accident. Scroll,
cancellation, multi-finger and reduced-motion checks remain.

Mute this app calls the existing source API, refreshes and offers Undo. Mute and Undo
fetch the current source before saving its whole record, preserving other settings and
mutes changed since the last poll. A failed read saves nothing. Existing history remains;
new muted-app events still follow the established server drop policy. Combined bulk
archive freezes each source's keys/read states and can undo a partial success. Clear all
on iPhone requires one chosen source and a frozen confirmation set. Individual phone
labels, expectedLabel payloads, confirmations, timeout constants and accepted-command
wording stay unchanged. The bounded NotificationActionSheet child wrapper keeps Preact
parent links current without changing its public props or the kit contract.

**Server settings (p6-server-config).** C-server-core-12 is done in fixtures.
`src/server/Settings.ts` holds the frozen non-secret startup snapshot, parses all 36 env
names, validates YAML/JSON configuration before services start and exposes an explicit
safe startup-report allow-list. The old EnvName exports remain. Booleans accept 0, 1,
false and true; malformed values now fail with a field error that omits the value.
`WS_SCRCPY_DEBUG=0` now turns debug off. Numeric ports, limits and times, probe JSON,
URLs/hosts, server arrays, remote hosts and TLS options/credentials are validated.
Valid trailing-dot DNS and IPv6 interface-case behavior remain. Zero still disables
the iPhone session start limit or cooldown. Time units, valid defaults, shutdown budget,
phone payloads, start/stop paths, retry policies and unlock schedule remain.

`WS_DATA_DIR` takes precedence over the legacy `WS_NOTIFICATION_DATA`; an empty canonical
value falls back to the old one. Compose passes both names with the same resolved value
for old-image rollback, and the entrypoint uses that directory. Explicit relative paths
still resolve from cwd. Bundled defaults use app/data outside dist from either launch
directory. A nonempty former dist/data blocks startup until explicitly selected or moved;
its files are not opened or copied. Compose defaults remain /app/data and
/app/data/stream-config.json. An explicit `WS_SCRCPY_STREAM_CONFIG_PATH` remains valid.
Otherwise Android stream settings read an existing cwd/stream-config.json if the new
file is absent, without writing. The next save writes the data-directory file and leaves
the former file for rollback. Stored formats do not change.

The iPhone key is consumed and deleted separately, stays outside the general snapshot,
and is excluded from every direct child environment, including decoder, icon probe,
RemoteShell, collector and both existing Device.ts children. No key or credential is
logged. All server/common env reads are now in Settings.ts. Source fixtures select both
data env names before server imports and reset the snapshot for deliberate env changes.
The new guarded import regression checks eleven setups with child tools and sockets
disabled. Review also ran all 384 affected focused cases and the full check under an
inherited synthetic WS_DATA_DIR: zero poison-directory access attempts, marker unchanged.

The server diff is confined to the 22 paths authorized in the integration brief: Settings,
Config/EnvName/dataDir, existing env callers in iPhone services, adb/RemoteShell/StreamConfig,
notification services and HTTP origin/server code. Device.ts and NotificationIcons.ts add
only filtered child envs. config/docker-entrypoint.sh and docker-compose.yml carry the data
alias. No src/common file changed. The only phone status wording change is
Preparing the phone. The Android Device split is still a separate step.

**Preserved action inventory.** The base actions remain at these paths:

| Base screen or group | Actions and current location |
| --- | --- |
| Phones list | Open screen, Wake, Files, Shell, per-phone Notifications and Settings stay on the card. Enable and restart, Restart services and Open settings keep their existing problem rows. |
| Phone header and tabs | Phones, Notifications and Switch remain in the header. Android Screen/Files/Shell and iPhone Screen remain. The switcher retains search, current phone and available rows. |
| Stage and controls | Wake, Unlock, Retry, Start again, Phones and Reload keep their state cards. Back/Home/Overview, volume down/mute/up, Lock, Listen, Screenshot, Type text, Actions, Settings and iPhone Siri keep their existing rail/touch controls and capabilities. |
| Actions | Read phone clipboard, Copy here and the local fallback remain. Android Paste and iPhone Send to phone/Type text remain. Android Notifications/Quick settings/Collapse; iPhone Rotate/Refresh picture/Restart video/Reconnect; mouse help; Unlock/Lock; iPhone Reboot/Shut down; Open Settings remain in their existing groups. |
| Settings | Stream quality/advanced/player/stats, Sound capture/source/format/listen/volume, Keyboard capture/UHID, Unlock stores/Forget/Replace/Remove/schedule/time zone/Run now, facts and service Start/Stop/Restart/Remount/Refresh/player choices remain in their existing sections. Keyboard gains the shared state and shortcut rows. |
| Type text and Unlock | Text/paste, cursor left/right, Backspace and Enter remain in Type text. Android PIN/password/Remember and the iPhone server-passcode flow, confirmation and one-tap notice remain in Unlock. No unlock timing changes. |
| Files | Back/Forward/Up/root/places/path, Refresh, filter, selection, Upload/Cancel, New folder, Download, Rename, Delete, Cut/Copy/Move/Paste/Copy path, Properties, view/sort/hidden items and menus remain in the unchanged Files view. |
| Shell | Terminal, Esc/Tab/Ctrl/arrows, Paste/Copy and text size remain in the unchanged Shell view. |
| Inbox browsing | Search, app filter, Clear filters, Inbox/Unread/Archive, source switch, Show older and media/link actions remain. Counts, day groups, stacks and combined scope are added. |
| Inbox item | Open iPhone screen by menu/Enter/mouse double-click, Mark read/unread, Archive/Move to inbox, phone-supplied action and guarded confirmation remain. Mouse quick actions, Space/click expand and Mute this app are added. |
| Inbox bulk | Mark all read moves to the toolbar. Archive all/Undo remain in page actions, with per-source requests in combined mode. Clear all on iPhone retains confirmation and requires a selected source. |
| Setup and push | Linking, receiver choices, permissions/repair, app mutes/legacy allow-list, previews, source removal and Undo remain. Delivered old links, notification highlight, one-time read and push cleanup remain. |

No action was found missing. Unchanged source paths, socket evidence and logs are recorded
under /tmp/ws-scrcpy-redesign/logs/integrate-6b-invariants.json.

**Visible and behavior changes, one per line.**
- Fine-pointer headers show a keyboard-target chip and keep its full wording at narrow widths.
- Active capture returns focus to the picture after rail actions or sheet close.
- Released capture permits normal page keyboard navigation.
- Keyboard settings show the release chord, Mac spelling and available shortcuts.
- Direct browser paste sends browser text once, with limits and errors in the notice.
- Copy from phone has a shortcut and prevents overlapping reads or stale fallback focus.
- A ready iPhone session offers commands and Type text without an HEVC decoder; new contacts remain blocked.
- Unscoped notifications combine linked iPhones, with their source names on cards.
- Source choices and Inbox/Unread filters show counts; Switch becomes an icon.
- Mark all read is directly on the inbox toolbar.
- Cards show day headings, short times, quieter app names and conversation stacks.
- Mouse cards have quick actions, anchored menus and card-navigation keys.
- Clicking or expanding text and opening its phone marks one notification read.
- Successful card actions focus the next available card.
- Cards offer Mute this app and Undo while preserving later source changes.
- Combined bulk archive can undo partial success; phone clear requires a selected source.
- Malformed server env/config input fails before services start with a safe field error.
- Startup logs one allow-listed settings summary.
- WS_DATA_DIR becomes canonical; old deployments keep the legacy alias.
- Default stream saves use the resolved data directory while older files remain readable.
- A nonempty former dist/data requires an explicit data selection or move.
- Child processes always omit the iPhone settings key.
- The iPhone preparing status says Preparing the phone.

**Assertion changes reviewed.** Desktop-layout and sheet-chrome now expect picture/mount
focus after close with capture enabled. Released-capture expectations, geometry, modal
isolation, history and stream counts remain. ios-reconnect's decoder case now requires
ready-session commands, Unlock and Type text enabled; it retains No picture, no Retry,
no reconnect claim and its exact socket counts. Notification helpers use counted Inbox/
Unread names, the combined default, Menu for fine pointers and Sheet for touch. Read-on-open
expects one fewer unread and the exact read request; its 50-row, scroll-within-2px, route,
history and one-stream assertions stay. Motion changes only the stale All radio selector.
Overlay-back/history-walk adapt notification roles while retaining timing/history/no-command/
stream assertions. Phone fixtures explicitly use touch, with a mouse override for narrow
windows. No assertion was changed during integration. Server fixture resets and dual data
names preserve prior assertions; the status text test now says phone. Review proved the
new behavior tests against base assets or bounded implementation reversions.

**Combined check.** npm run check passed: typecheck; lint 0 errors and 29 existing warnings;
733 Node tests, 733 passed, 0 failed; Python suites 43 OK, 32 OK with 2 skips, 4 OK; both
production builds passed. The client has the existing three webpack performance warnings.
Complete log: /tmp/ws-scrcpy-redesign/logs/integrate-6b-check.log.

node scripts/test-browser.js passed all 36 registered default suites in one uninterrupted
invocation, exit 0, 1706.957s. This includes all 43 existing notification scenarios, all
17 desktop-input scenarios and all 11 notification-inbox scenarios. First card: 129px.
No assertion, selector or fixture was changed during integration. Complete browser log:
/tmp/ws-scrcpy-redesign/logs/integrate-6b-browser.log; exact suite inventory and result:
integrate-6b-browser-suite-inventory.json and integrate-6b-browser-result.json in that
log directory. The source second pass covered both stream clients and capture controller,
ScreenView, notification mutations/focus/grouping, and Config/Settings/data/key/child env.
All 65 package files match their final reviewed heads exactly. Merge identity is recorded
in integrate-6b-merge-identity.json in the log directory. Diff checking passes.

**Stream and mount counts.** The passing browser assertions measure these values; they
count fixture sockets, not real serve-web processes:

| Checks | Measured result |
| --- | --- |
| desktop-input, Android UHID/fallback and iPhone | 1 socket per open through release/recapture, rail actions, Switch, Actions, Settings, Type text, local fields and paste. All 17 scenarios pass. |
| Native direct paste | 1 clipboard write per native paste. Android sends 0 paste key reports; iPhone sends exactly 4 ordered HID reports after the matching successful clipboard result. Socket count stays 1. |
| Narrow mouse and touch sheets | Both platforms keep 1 socket at 320/390px with both chip targets, and at 390px in both themes with a bottom Settings sheet. |
| desktop-layout | 1 socket at 1440x900 and 1366x650, both platforms/themes, after docked Actions/Settings/Type text, Switch, crossing 1024px and six more panel opens. Stage and mount stay the same elements. List Settings opens 0. |
| controls, touch dock | 1 socket and the same stage on both platforms at 1180x820 with Type text docked and closed. |
| navigation | 1 socket for each phone screen opened, including old and short links; 0 extra from list arrival or Back. An unknown phone opens 0 until identified, then 1. |
| device-page | Initial Screen opens 1. Files closes it once; returning to Screen makes 2 total. Shell and Back add 0. Each deliberate player change opens exactly 1 more. |
| ios-input | 1 screen session per visit; Actions blocks picture input. |
| ios-reconnect | 3 failed-start sockets, then no extra; Retry adds 1. The separate no-picture case has 3 sockets after its two deliberate drops and remains at 3 through decoder failure and sheets. 4011 stops, 4010 remains a retry and 4009 keeps its failed-start limit. |
| android-lifecycle | 1 per open, 0 extra after 4012, Start again adds 1, a deliberate 4007 close adds 1. List Wake opens 0; screen Wake stays at 1. |
| Inbox/history | Menus, confirmations, mutes, filters and Back open 0 streams. A requested phone screen opens 1, including delivered push routes and return/history checks. |

The adapters and mount effects, both receiver policies, routing, unlock scheduling,
control table and common protocol are byte-unchanged from the base. The ScreenView diff
only imports/renders the chip in the header; the mount node was not moved or re-keyed.

**Atlas against 4434a62.** Reused the review's git-archive export and build only after
checking 371 production/build files byte for byte against 4434a62, its successful build
log and its 142-state/284-file base atlas. The combined default invocation wrote 146
states/292 raw files: 38 phone states and 35 desktop states in each theme, at 390x844
and 1440x900. Base is /tmp/ws-scrcpy-redesign/atlas-base-4434a62; head is
/tmp/ws-scrcpy-redesign/atlas-integrate-6b. No file was removed.

Of the 284 shared files, 60 PNGs and 112 style JSONs changed; 82 PNGs and 30 JSONs are
identical. Four notifications-all states add four PNGs and four JSONs. Every changed
name, decoded pixel bound/count, raw hash and grouped count is retained in
/tmp/ws-scrcpy-redesign/integrate-6b-atlas-comparison.json and
/tmp/ws-scrcpy-redesign/integrate-6b-atlas-changed-files.txt.

| Files/states | Difference and reason |
| --- | --- |
| 28 desktop phone-screen/Settings PNGs | The new keyboard chip in both capture states and the Keyboard section rows. Covers android-actions/asleep/screen/settings/switcher/type-text/unlock; iphone-actions/screen/settings/switcher/type-text/unlock; list-iphone-settings, both themes. The Android light Settings image also has the baseline AutoHeight gap described below. |
| 4 phone iPhone Settings PNGs | New Keyboard shortcut rows in iphone-settings and list-iphone-settings, both themes. |
| 64 input/Settings JSONs | Chip nodes/styles, including the hidden chip at touch width; new shortcut rows and descriptions, including list-android-settings; and the measured AutoHeight height variation. Phone controls images retain their pixels. |
| 28 existing inbox PNGs and their JSONs | notifications-inbox/search/filters/page-actions/card-actions/confirm/toast at both widths/themes: counted filters and Mark all read, day headings/times/app text/spacing/wider inbox, anchored mouse Menu or touch Sheet with Mute, retained guarded prompt, and updated focus/counts behind Undo. |
| 12 Setup PNGs | notifications-setup/setup-details/setup-confirm pixels match base exactly. Their raw JSON differs through generated selector IDs and closed-Sheet lifecycle state. Setup actions were preserved. |
| Other notification JSON detail | The 40 existing notification JSONs also retain the raw generated suffixed Preact IDs, closed Settings panel interactivity and hidden Add another iPhone option differences. No raw data was normalized. |
| 8 other style JSONs | phone-not-listed and tool-unavailable in all widths/themes differ only on nine nodes of the closed global Settings Sheet: interactivity inert becomes auto after the notification fixture reload. Every other row matches; all eight PNGs match base. |
| 8 new files | notifications-all at both widths/themes shows Bench iPhone and Spare iPhone, with source names and the second source's read item. The fixture restores its temporary arrays afterwards. |

A second fixture atlas used ATLAS_COMPARE against base. All four state captures passed,
then comparison exited 1 with exactly 180 changed/added raw files, as expected for this
redesign. This comparison result is separate from the successful uninterrupted default
run. Log: /tmp/ws-scrcpy-redesign/logs/integrate-6b-atlas-compare.log; second raw atlas:
/tmp/ws-scrcpy-redesign/atlas-integrate-6b-compare. All 146 PNGs match the first combined
capture byte for byte. Six desktop-dark JSONs vary only by one option in the hidden
Add another iPhone select. Against the corrected inbox review atlas, all 44 PNGs match;
12 pre-Setup dark JSONs differ only by that hidden option. Raw files remain intact.
Separate structural records are integrate-6b-repeat-raw-diff.json and
integrate-6b-reviewer-raw-style-diff.json under /tmp/ws-scrcpy-redesign. The eight other
closed-Sheet JSON changes were checked against the review's full-property captures:
the old/new hashes match exactly, with only interactivity inert to auto on those nine
nodes. Full evidence is integrate-6b-hidden-style-proof.json. The existing fixture
pushManager error banner is present in both atlases and was retained.

**Baseline Quality-card gap found during atlas review.** The combined light desktop
Android Settings PNG has 40px of empty space below Quality. It shifts the rows below;
its content and actions remain. The base/review atlas images happened to capture the
natural height. A matched desktop list/Android atlas-prefix probe on the base production
assets reproduces the gap: outer 161.1875px, inner 119.1875px, two border pixels, leaving
40px extra, unchanged after 1s. The same prefix on merged assets measured the natural
121.1875px outer/119.1875px inner. Both show exactly the same quality text and config.
The base stale-card computed style hashes match both full combined captures exactly.
Against the natural card, only height/block-size and their derived transform/perspective
origins differ; all other computed properties match. AutoHeight, StreamSection, Section,
Group.css and app.css are unchanged from base. This proves a pre-existing stale inline
AutoHeight measurement, not a new data or CSS rule. A controlled merged fixture with
14 opens and 0/1/8/16/32/80/200ms replies stayed at the natural height. The precise triggering
observer order is not yet established. Root queued initialization/measurement work for
the existing kit follow-up and authorized leaving it out of 6b. No production fix or
assertion change was made. Proof: integrate-6b-quality-gap-proof.json; logs
integrate-6b-settings-base-prefix.log, integrate-6b-settings-head-prefix.log and
integrate-6b-settings-head-sequence.log; raw screenshots/full styles in
integrate-settings-base-prefix and integrate-settings-head-prefix, all under
/tmp/ws-scrcpy-redesign. The probe scripts use the fixture runner and linked built assets;
no build or hardware server was started.

Screenshots of every changed atlas state at 390/1440, light/dark remain in the head
atlas, with byte-identical PNGs in the comparison atlas. Supplementary input and combined
inbox captures are in /tmp/ws-scrcpy-redesign/screens/integrate-6b. The inbox suite writes
its four captures to a fixed inbox-screens folder; they were copied into this unique
integration folder after the suite finished. I inspected both combined inbox sizes/themes,
mouse menus and touch action sheets in both themes, the desktop headers/Settings, and
phone iPhone Settings/list Settings in both themes. Root also inspected merged combined
inbox, mouse Menu, Android header and iPhone Type text. No new clipping or missing action
was found. The baseline AutoHeight gap is retained and explained, not hidden.

**Left for later.** The baseline AutoHeight initialization gap is queued for the kit
follow-up. No new integration defect is known. This step does not prove real phone
input or delivery. p6-android-device still needs its full split, Android check and own deploy.
p6-docs remains. Collector supervision/routes, quality-preset arrow restarts, dock entry/
stage overlap, kit children/ConfirmAction IDs, list stale/atlas gaps, dead code, old browser
storage, focus-ring contrast and production kit access remain in their assigned follow-ups.
Mac Ctrl+drag gesture policy is unchanged. The owner's pending choices remain: dropping
new muted-app events on the server, 50% idle touch opacity, rail attached at every mouse width.

**One hardware checklist for this step, separate from these fixtures.**
1. Follow the separate deploy brief. Confirm the real config selects the same /app/data
   and stream file, both trackers, allowed hosts, push setup and named unlock schedule
   fields. Keep the rollback alias and startup safety. No settings save during a look check.
2. In a permitted single iPhone session and an Android session, check physical keyboard
   capture/release/recapture, rail and sheet-close focus, Tab after release, Ctrl+Alt shortcuts
   and Mac Ctrl+Option. Try Android UHID and keycode fallback. Keep one stream per open.
3. Paste browser text into a real focused phone field once on each platform; check Type text,
   local fields, denied clipboard permission, plain HTTP and Safari/Firefox. Check the actual
   clipboard-set-then-Cmd+V result on iPhone and command readiness without HEVC. Unlock needs
   separate owner permission. Verify held contacts lift if decoding is lost.
4. On a real phone/installed app, check the inbox under safe areas, mouse menus and next-card
   focus, touch scroll/swipe/cancel and read counts. With two sources, check combined and explicit
   push targets, real OS badges and delivered push taps. Mute an app, receive from it and an
   unmuted app, then Undo/unmute and receive again. Existing history must remain.
5. Check Safari, Firefox and the installed app. Fixture Chromium does not establish those
   browser or hardware outcomes. Keep the iPhone session/start discipline from the deploy brief.


### Redesign Android split: shell, polling and stream ownership (2026-11-13, tested without a phone)

D7 / C-server-android-14 is complete in code and fixtures. Hardware and deployment remain.
Merged `review/p6-android-device` at `073adedc4492ede3cbb6d3a28f2577f03724824a`
into base `111d1550fd17d4e453c2d9466cf1bffe0c162bd6` with `--no-ff`.
The merge is `7b45ae44cd231cc9a434badece9ab17640b16baf`; there were no conflicts.
`675d25ba833eb08325b4885e45f5542d4bab151d` registers the 54-test
`scripts/test-android-owners.js` suite. No browser registration or integration feature fix
was needed. All thirteen reviewed production/test files retain the reviewed bytes.
Not deployed. No phone, adb binary or daemon, real pymobiledevice3, Docker, live server,
unlock or live settings were used. Real adbkit tests use owned fake loopback peers.
No dependencies changed, install or push ran, or worktree/branch cleanup was done.

**Module responsibilities and preserved contract.** `Device.ts` is a 204-line facade for
its public descriptor, update event and 300ms throttle. It delegates actual ownership:

| Module | Responsibility |
| --- | --- |
| AdbShell | Configured adbkit diagnostic/status/stream shell reads and uploads, timeout and cancellation. Both CLI paths are gone. Files keeps quoting, exit markers, the 65,000-byte command bound, uncapped output, 15s default and 120s long-operation timeout. Diagnostics gain no default timeout. |
| DeviceStatePoller | One due-time scheduler for info/runtime/lock/PID, info backoff, properties and PID capability caches, cadence and cancellation generations. It waits for both info branches before retrying and rejects stale updates/rearming. Fresh lock reads retain ordering and unknown-on-failure. PID reads cannot overwrite newer reads or explicit session state. |
| ScrcpySession | Viewers, 30s grace, serial start/stop/settings queue, own-scid orphan handling, encoders/audio fallback and each launch's shell, forward lease, Broadcast, readiness, delay and deadline. Failed operations leave the queue usable. |
| AdbUtils / ScrcpyServer | Shared Files reader, serialized identity-counted forward leases, jar completion before launch, cancellation through upload startup and own-scid filtering. |
| adb/index.ts | Per-operation client/sync views own the actual socket before TCP/transport/shell/sync OKAY and own active file readers. Installed adbkit commands/parser/framing remain. Operation connections reject daemon startup without invoking a child. |
| BroadcastManager | The approved optional startup AbortSignal closes pending video/audio/control sockets and cleans late events; the exact returned Broadcast lets a launch retain its own identity. Existing no-signal socket order, readiness and control/audio diagnostics remain. |

Attaching an idle phone starts nothing. The first viewer starts once; additional viewers
reuse it. Last-viewer departure keeps the 30s grace; a quick return cancels it. Starts keep
the 15s deadline, 1s first connect delay and 500ms retry. A watched settings change restarts
through one queue; an unwatched change starts nothing. Only owner Stop closes viewers with
4012, and an older queued ensure cannot undo it. Disconnect, restart, idle stop and shutdown
retain ordinary reconnect behavior. Late old-launch close/audio/PID events cannot change a
successor. Launch-time audio and fatal-audio fallback/reset remain. Runtime parsing keeps
modern screen-state precedence and anchored battery level. Wake starts no idle stream.
Only the intentionally dead `runShellCommandAdb` public method was removed; production had
no caller. Other public methods, descriptor types, Files view, lock parser, protocol/audio
frames, input adapters and both client reconnect policies are unchanged.

**Forward and upload limits.** Cleanup has its own fresh 6500ms budget after a launch abort.
Confirmed ownership is retained at zero users if removal is not confirmed; a later owner
can reuse/release it without old cleanup deleting its successor. After a forward request
but before final OKAY, a lost ACK and an external norebind collision are indistinguishable.
The socket closes, but an uncertain mapping is left alone. The fixture lost-ACK and collision
cases retain one mapping and send zero removals. A stalled cleanup can also leave an
unconfirmed mapping. Zero matching TCP handles is proved; zero mappings is not claimed for
those fault cases. Per-owned-transfer cancellation runs once, keeps its first boolean result
and preserves normal/once listener order. It closes actual filepath readers before EOF.
No global/dependency patch, automatic retry chain or adb daemon side effect was added.

**Server/common scope and second pass.** The complete production diff was read before merge
and checked again with the test/mock adaptations. It contains exactly these eight approved
paths under src/server or src/common: goog-device/Device.ts, AdbShell.ts, AdbUtils.ts,
DeviceStatePoller.ts, ScrcpySession.ts, ScrcpyServer.ts, goog-device/adb/index.ts and
common/BroadcastManager.ts. No Broadcast.ts, other common or iPhone path changed.
The five reviewed test paths are test-android-owners.js, test-android-server.js,
test-server-regressions.js, test-settings.js and fixtures/data-dir-probe.js.
Old mocks now address the real owners and raw adbkit combined streams/destruction in place
of CLI stdout/stderr/SIGTERM. Existing scid, orphan, viewer, grace, lock/PID, config, audio and
close-code assertions remain. The obsolete Android child expectations in test-settings were
removed; the remaining two audio/icon children still exclude the key and retain PATH.
Only android-owners was added to the fixture import matrix/audited helper set. Both data env
names are selected before imports and restored. Integration changed no test assertion.

**Checks and regression proof.** The full combined check passed at `675d25b` in 74.547s:
typecheck; lint 0 errors/26 warnings; 787 Node tests passed, 0 failed/cancelled/skipped;
Python 43 OK, 32 OK with 2 existing skips, 4 OK; both production builds. The client retains
three existing webpack performance warnings. The 54 owner tests include all Linux FD cases.
Then one uninterrupted `node scripts/test-browser.js` invocation passed all 36 defaults
in order, exit 0, 1703.668s. No build overlapped it. No test or fixture was changed during it.
Logs and machine-readable results are in
`/tmp/ws-scrcpy-redesign/logs/integrate-android-20261112/` (check.log, check-result.json,
browser.log, browser-result.json and combined-result.json).

Review's exact-base public harness failed three real assertions on 111d and passed on review:
one reconnect info chain, no retry while a sibling read is pending, and configured adbkit
launch without a CLI child. Bounded reversion proofs cover stale cache/scheduler/PID order,
late shell/forward/upload cleanup, queue/release/Stop, Broadcast startup and exact identity,
facade callbacks and fixture isolation. Twelve old-2b handshake/cleanup logs fail actual
Socket.destroyed assertions, without missing imports. Their audit is negative-log-audit.json;
review's full proofs remain in logs/review-android-proofs and logs/review-android-handshake.
The canonical-data negative leaves the guarded marker and its times/size unchanged.

Fresh combined active-FD evidence records a direct stream receiving 394240 DATA bytes while
not at EOF, filepath abort/release positions 851968/2293760 of 67108864 bytes, and the real
ScrcpyServer upload at position 851968 before cancellation. Each leaves 0 matching client
handles/FDs, one cancel and one end. ScrcpyServer's normal/once cancel listeners each run
once in order and late launches are 0. See active-fd-evidence.json. These are fake-peer,
real-library/reader results, not physical phone results.

**Action and lifecycle inventory.** All client/style/public source and browser fixtures
match 111d. The existing action inventory from step 6b remains: list Open/Wake/Files/Shell/
Notifications/Settings and problem actions; header Phones/Notifications/Switch and tabs;
stage state-card and rail/touch actions; Actions/Settings/Type text/Unlock groups; all Files
and Shell operations; inbox browse/item/bulk actions; Setup and push routes. No action moved
or disappeared. invariants.json records the public method and unchanged path checks.

| Fixture observation | Measured passing result |
| --- | --- |
| Real facade plus owner cooperation | Tracking 0 launches; simultaneous first ensures 1 launch with 2 broadcast sockets without audio; an additional viewer adds 0 launches. |
| Grace and settings | Non-last departure and quick return cause 0 stops; 29999ms after final departure adds 0 stops and 30000ms adds 1. Watched settings add 1 queued launch with 3 broadcast sockets for audio; unwatched settings add 0. Three completed launches remove 3 owned forwards. |
| Close codes | Owner Stop yields [4012]; settings restart, idle stop, disconnect and release add no owner Stop code. |
| Android browser lifecycle | Open 1 stream socket; 4012 adds 0; Start again makes 2 total; deliberate 4007 restart makes 3. List Wake opens 0; screen Wake stays at 1. |
| Navigation/page/history | 1 stream per requested Screen open; Back/list/overlays add 0. Files closes Screen once; returning to Screen makes 2 total. Shell and Back add 0. |
| Desktop layout/input | Same stage and mount, 1 socket through panels, width changes and capture/paste/local fields on both platforms. List Settings opens 0. Separate iPhone reconnect close-code/limit checks pass. |

**Raw client and atlas identity.** Before merging/building, all 19 main-context dist/public
files were copied outside the repo with raw SHA-256 manifests. They came from the completed
6b normal build. All 19 new files, including every JS/CSS chunk and index.html, match those
premerge bytes exactly, also after browsers. No module IDs or HTML were normalized.
The premerge-source-provenance, public-assets-comparison, raw HTML and manifests are retained
in the log directory. All 271 tracked client/build inputs and all browser scripts match base.

Reused `/tmp/ws-scrcpy-redesign/atlas-integrate-6b` only after verifying all 292 golden hashes
against the retained review manifest and source identity. The fresh atlas is
`/tmp/ws-scrcpy-redesign/atlas-integrate-android-20261112`: 146 states/292 raw files, 38 phone
states and 35 desktop states in each theme, at 390x844 and 1440x900. Every raw file was compared:
145 PNGs and 145 JSONs are identical (290 files); no additions or removals.

The only changed state is android-settings--desktop--light (one PNG/one JSON). This capture
has the natural Quality-card height; the golden has the known intermittent stale 40px
AutoHeight gap. Earlier retained actual measurements are outer 161.1875px/inner 119.1875px
with 2 border pixels for the stale state, and outer 121.1875px with the same inner/borders for
the natural state. The image changes 90497 pixels within x1077..1424/y359..900. Exactly four
style rows differ: Quality card, Quality group, Stream section and outer Settings. Only
height/block-size and their derived transform/perspective origins differ. Three rows match
the retained stale/natural full-style proof exactly. The outer Settings raw hash matches the
same 40px height/20px origin shift from the retained natural full style; the old 4434 probe
predates the later Keyboard rows. All other computed rows match. Evidence: atlas-comparison.json,
atlas-style-differences.json and quality-gap-identity-proof.json in the log directory, plus
`/tmp/ws-scrcpy-redesign/integrate-6b-quality-gap-proof.json`. No capture was changed or
normalized, and no second browser run was needed. This is an existing UI baseline variation
with identical client bytes, not an Android feature fix. AutoHeight remains queued for the
kit follow-up; it is not fixed here.

I inspected Android Actions and Settings at both widths in both themes, plus the golden
Settings image. Selected raw copies are in
`/tmp/ws-scrcpy-redesign/screens/integrate-android-20261112/`. No new missing action or
clipping was found. There is no intended layout/control change.

**Visible and behavior changes, one per line.**
- Remaining Android helper errors say phone.
- Reconnect/release rejects stale info updates and retries.
- Cancelled startup closes hidden TCP connections and active upload readers.
- An earlier queued viewer ensure cannot undo owner Stop.
- Forward cleanup is bounded and preserves uncertain external/successor mappings.
- Normal stream timing, protocol, controls and both client reconnect policies remain.

**One hardware checklist, through the separate deploy/check procedure only.**
1. Idle attachment starts no scrcpy. First viewer starts once; additional viewers reuse
   the same actual process and stream.
2. Last viewer leaves: a return before 30s retains the stream; without a return it stops
   after 30s and acknowledged owned forwards are removed.
3. Rotation updates the actual picture and keeps input aligned.
4. Physical USB unplug/replug reconnects without competing starts; cancelled work stays gone.
5. Eligible Wake lights the phone. Idle-card Wake starts no scrcpy; watched Wake retains it.
6. Owner-authorized watched quality/audio changes restart serially with the chosen settings;
   unwatched changes start nothing until a viewer returns.
7. Owner Stop keeps viewers stopped until Start again; disconnect/settings restart/shutdown
   retain ordinary reconnect behavior. Check acknowledged forward cleanup separately from
   the fixture lost-ACK limit. All iPhone/session/restart-window/settings restrictions remain.

No hardware result above is claimed. The separate Android hardware/deploy step remains,
as do p6-docs and the previously assigned follow-ups. No new integration defect is known.


### Redesign followups: sheets, lists, phone header and notification service (2026-11-13, tested without a phone)

The three reviewed packages are merged on `redesign`. **NOT DEPLOYED.** No phone,
adb, real pymobiledevice3, Bluetooth collector, Docker, live server, port 8010,
unlock, live settings save, dependency install or push was used. The live version
remains the separately deployed `7f5c52f` / image `531d` recorded by the deploy step.
This integration does not verify live state again. Worktrees and branches remain
for the orchestrator to inspect and clean up. p6-docs has not started.

Base: `7f5c52feaf41ca637116824ffc15997181dfac65`. Each exact review head was checked
against its clean review tree and merged with `--no-ff`, in this order:

| Package | Reviewed head | Merge |
| --- | --- | --- |
| Kit | `8920645f8e552b23e17d8d916c0a28d8093e6682` | `81491cf0ac35cff935fd53b00cb1b561631cf59b` |
| Client | `4623c4961fd4612631aad663db854b0729854bec` | `eb7caddfb4012b2cf9ff073acd6c8b14694f327a` |
| Notification service | `2a8d3d74dbae1064ae7840d2a0be81164bfdfc1c` | `df0918eed3828912a5a1fe06fd67796ca51512db` |

There were no conflicts or source seam fixes. Registration commit and checked code
head: `cd820748ea4687763551e1d939695f88208d1c31`. It adds only
`scripts/test-notification-collector.js` and `scripts/test-notification-routes.js`
to the existing test command and `kit-followups` to the default browser list.
Dependencies and every other package field stay unchanged. All 58 reviewed paths
retain the reviewed bytes, apart from that required default-list addition. The
commit containing this section changes only HANDOFF after the checked code head;
its exact final hash and the source/build-input identity check are recorded in
`/tmp/ws-scrcpy-redesign/briefs/integrate-followups-report.md`.

Evidence below is under
`/tmp/ws-scrcpy-redesign/logs/integrate-followups-20261113-8so_nwig/`, unless a
separate path is named. `preflight.json`, `merges.json`, `frozen-source.json`,
`checked-assets.json` and `post-browser-verification.json` retain exact identities.
The main checkout began clean except the owner's untracked AGENTS.md. Neither it
nor .claude was staged, removed or changed.

**Finding status.**

| Finding | Status, reason and evidence |
| --- | --- |
| Sheet child boundary | Done. One component boundary adds no DOM wrapper or required prop. Late children, state/useId, retained exit/reopen, multiple sheets, history and focus pass. The original ancestor-only duplicate-ID cause remains UNREPRODUCED. |
| Confirmation IDs | Done for a reproduced separate-root failure. Exact original ConfirmAction duplicates P0-0/P0-1 through public AboveSheet and can alter the accessible question. Stable module-wide kit-confirm IDs pass. This does not establish the ancestor-only cause. |
| Docked motion and overlap | Done. Docked entry/exit slides horizontally with existing timings and reduced motion. Centred and bottom motion remain. The stage deliberately contains the dock host; the picture and rail stay clear. No mount or fit change. |
| Quality preset keys | Done. Only Quality uses manual activation. Arrows/Home/End move focus with zero requests; Enter and Space apply once each, pointer choice applies immediately, and refused selection stays current. The hint explains the keys. Other segmented controls retain native behavior. |
| AutoHeight initialization and resizing | Done. Layout is natural at rest, measurements include fractional layout size/padding/borders, independent inner changes begin before paint, and reversals retain actual animated height. The final light/dark fixture measures ready outer 121.1875/inner 119.1875/borders 2 with empty inline height. Held observations, 0/16/80 ms replies, parent/child/external/image/font changes, widths and reopen pass. |
| Production KitPage | Done. Normal builds force the route out, even with a build-option attempt. Its conditional import stays LAST after the ordinary views/adapters. Dedicated demo builds use a runner-owned mkdtemp outside all dist, served only as KIT_BASE. Ordinary BASE serves actual production assets. Production kit addresses fall back to Phones with zero mounts and zero streams, including the actual proxy-coredevice action. |
| Old controls-position storage | Done. Old-only and both-key browsers keep their remembered/current place. The old key is removed only after a successful current-key write. Blocked write/removal does not break controls; six browser combinations and guarded removeStorage pass. 50% idle opacity is unchanged. |
| Stale phones and multiple servers | Done. Fresh individual reports survive older expiry while unchanged stale siblings expire at their original 30 s deadline. Full/empty lists, owner/tracker replacement, repeated close/release and queued callbacks stay authoritative. Mixed lists warn only within the affected host. A recovered host regains focus while another is stale, without taking focus moved elsewhere. |
| Stale switcher and atlas gaps | Done. Disabled rows retain last status/Viewing and say Reconnecting…. Twelve new loading/list-reconnect/switcher-reconnect atlas states cover both widths/themes, preserving one exact mount and socket. |
| One phone header and dead registry | Done. Screen, Files and Shell share PhoneHeader with prior actions and placement. The screen stage/mount/ref/effects and stream lookup are unchanged. Tool connection stays in its tab strip and tools keep local keyboard targets. Only the unused registry/wrappers/coreDeviceTool and approved unused Tool declarations/interface were removed; ToolEntry/deviceTools navigation remains. |
| Six hardware-only scripts | Partial by design. Current selectors/capture handling are refreshed and all six pass syntax checks in review. Their bodies were not run on hardware. |
| C-notifications-9 remainder | Done in fixtures. CollectorProcess owns supervision/framing/writes/backoff; NotificationRoutes owns the same 18 ordered routes; the 32-line schema preserves old bounds/payloads. Service retains domain state. Feed, Storage and PushDelivery stay unchanged. Hardware remains unverified. |
| Focus-ring and other owner choices | Untouched. Dark focus-ring colour, server mute-drop policy, 50% idle opacity and rail attachment at every mouse width remain the owner's pending choices. No new owner decision is needed here. |

**Visible and behavior changes, one per line.**

- Docked panels slide horizontally on entry and exit.
- Quality arrows browse; Enter/Space apply, with visible and accessible help.
- AutoHeight returns to natural layout after motion and avoids the independently reproduced stale gap.
- Prompts use stable IDs across render roots; their painted style stays the same.
- Sheet children get one component boundary without another DOM box.
- Old controls-position keys are removed after a successful migration write, preserving the current place.
- Production kit addresses return to Phones without a stream.
- Fresh phone reports survive older stale-list expiry; unchanged stale entries still expire.
- Reconnect notices sit with the affected host in mixed lists.
- Focus returns when that host recovers, while respecting focus the owner moved elsewhere.
- Stale switcher rows retain status and add Reconnecting… while disabled.
- Screen, Files and Shell use one header with the same controls and status placement.
- Unused list-tool registration and wrappers are removed.
- Notification collector ownership prevents old child/retry/write callbacks affecting a successor.
- Pair continuation rechecks the actual collector generation after the write.
- Pending pipe errors reject without counting a pipe write as phone acceptance.
- Owned notification source-phone text says phone; browser receiver-device text and protocol devices remain.

**Prior action inventory.** No prior action was found missing. The unchanged action,
router, status and capability modules have exact base/hash evidence in
`action-source-preservation.json`; the changed headers and lists were checked in
the passing rendered suites. The existing action groups stay at these locations:

| Screen/group | Actions and current location |
| --- | --- |
| Phones cards | Open screen, Wake, Files, Shell, per-phone Notifications and Settings remain. Enable and restart, Restart services and Open settings remain in the relevant problem rows. Stale cards keep Settings/notification access and disable unavailable phone actions. |
| Switcher | Search, current Viewing row, last status and available phone selection remain. Disabled stale rows now explain Reconnecting…. Switch replaces the route; it does not stack another phone visit. |
| Screen header/tabs | Phones, name, connection/service, keyboard chip, bell/inbox/count and Switch remain. Switch waits for mount. Android keeps Screen/Files/Shell; iPhone keeps Screen. |
| Files/Shell header/tabs | Phones, name, service, bell and Switch remain in PhoneHeader; connection stays in the tab strip. Tools keep their own keyboard target, client lifetime and tabs. |
| Stage and controls | Wake, Unlock, Retry, Start again, Phones and Reload stay on state cards. Back/Home/Overview, volume down/mute/up, Lock, Listen, Screenshot, Type text, Actions, Settings and iPhone Siri retain their capability-based rail/touch controls. |
| Actions | Read phone clipboard, Copy here and fallback remain. Android Paste and iPhone Send to phone/Type text remain. Android Notifications/Quick settings/Collapse; iPhone Rotate/Refresh picture/Restart video/Reconnect; mouse help; Unlock/Lock; iPhone Reboot/Shut down; Open Settings remain in the existing groups. |
| Settings | Stream quality/advanced/player/stats; Sound capture/source/format/listen/volume; Keyboard capture/UHID/shortcuts; Unlock store/Forget/Replace/Remove/schedule/time zone/Run now; facts and service Start/Stop/Restart/Remount/Refresh/player choices remain in their sections. Only Quality opts into manual keyboard activation. |
| Type text and Unlock | Text/paste, cursor left/right, Backspace and Enter remain. Android PIN/password/Remember, iPhone server-passcode flow, confirmations and one-tap notice remain. Modeless picture interaction and dialog.kit-sheet[open] keyboard blocking remain. No real unlock ran. |
| Files | Back/Forward/Up/root/places/path, Refresh, filter, selection, Upload/Cancel, New folder, Download, Rename, Delete, Cut/Copy/Move/Paste/Copy path, Properties, view/sort/hidden items and menus remain. Only the dead static list-entry wrapper changed in its client. |
| Shell | Terminal, Esc/Tab/Ctrl/arrows, Paste/Copy and text size remain. Only the dead static list-entry wrapper changed in its client. |
| Inbox | Search/app filter/Clear filters, Inbox/Unread/Archive, source switch, Show older, media/link actions, stacks, expand/read, Open screen, read/unread, Archive/Move to inbox, guarded phone actions, Mute/Undo and next-card focus remain. |
| Inbox bulk/Setup/push | Mark all read, per-source Archive all/Undo, scoped Clear all on iPhone and confirmations remain. Linking, receiver choices, permissions/repair, mutes/old allow-list, previews, removal/Undo, old delivered links/highlight/read and push cleanup remain. |

**Measured mount/socket contracts in this combined run.** These are Chromium
fixture results, not physical sessions. The exact assertions remain in the named
browser scripts; `browser.log` records their passing execution.

| Fixture path | Passing result |
| --- | --- |
| Home/mixed-host activity and list Settings | 0 stream sockets. |
| Production kit fallback | 0 stream mounts and 0 proxy-adb/proxy-coredevice/stream-coredevice sockets. |
| Navigation/cold/old links, both platforms | 1 socket per requested Screen open; late list arrival and Back/list/overlays add 0. A three-phone navigation scenario has 3 total before and after Back to the list. |
| Android Screen/Files/Shell | Initial Screen 1; Files closes it once; Shell adds 0; return to Screen 2 total; Shell closes the second; Back to list stays 2. Files and Shell clients stay mounted behind their tabs. D3 holds. |
| Phone switch replacement | The rendered sequence is Pixel, Pixel2, Pixel, iPhone: one socket for each requested open; Back/Forward add no unintended stream. |
| Shared header/stale switcher/atlas | Exactly the same connected mount element and 1 Android socket through header and stale-switcher renders/open/drop/close. Home's corresponding four contexts also remain at 1. |
| Desktop input/layout/controls, both platforms | Same stage and mount, 1 socket through capture, local fields, paste, sheets/docks, Switch and width changes. Picture/rail stay clear of the panel. |
| Android lifecycle | Open 1; owner Stop 4012 adds 0; Start again 2 total; deliberate 4007 restart 3 total. List Wake 0; watched Wake stays 1 in its own fixture. |
| iPhone reconnect | Three refused-start attempts then no extra; Retry adds 1. The separate no-picture case has 3 after two deliberate drops and stays 3 through decoder failure/sheets. 4011 stops; 4010 retries; 4009 retains its limit. |

Both client reconnect policies, gesture/input code and stream adapter dependencies
remain unchanged. No stage key/ref or mount node was moved or re-keyed. The stage's
intentional dock-host overlap is not picture/rail overlap.

**Notification server boundary.** Only these four paths under src/server/src/common
changed: notifications/NotificationService.ts, CollectorProcess.ts,
NotificationRoutes.ts and NotificationSchema.ts. There is no src/common change.
The actual final server diff matches the root-approved SHA256
`d7d2b0bbabaf4075ee88efb9580188ffbcb3867977bdeed5ca4a88f3c033593b`.
The service is a coordinator; all 18 method/path pairs and their order remain.
The collector retains pending 131072/stderr 16384 bounds, 3 s exponential backoff,
60 s cap/stable reset and expected-exit policy. Startup-write failure only reports;
completed idle stdin error is still ignored. Late callbacks and released pending
writes cannot affect a successor. A pipe write is not phone acceptance. Pairing
continuations recheck actual generation. Source/session/uid/label/snapshot checks,
15 s per-action/30 s bulk budgets and accepted/skipped/failed/unprocessed distinctions
remain. No filtering, push, phone-action, stored-file, settings/key or protocol
format changed. No new backup or migration is required.

**Checks and proof.** One agent held the exclusive build/Node/browser lease. No
build or check overlapped another. Both inherited iPhone key env names were removed.
ATLAS_COMPARE, ATLAS_STYLES, ATLAS_ONLY, KIT_FOLLOWUP_ONLY and KIT_FOLLOWUP_THEME
were unset. No assertion, timing or UI changed to collect screenshots.

- `npm run check`: exit 0, 74.942 s at cd82074. Typecheck passes; lint 0 errors/26 warnings;
  Node 813 pass/0 fail/0 cancelled/0 skipped; Python 43 OK, 32 OK with 2 existing skips, 4 OK; normal
  client/server builds pass. The client retains 3 webpack performance warnings.
  The two skips compare stock helpers after the installed screen_stream helper
  was already patched; they are not hardware/platform skips. Log: check.log;
  machine result: check-result.json. The 813 equals 787 base + 1 KIT + 1 CLIENT + 24 reported
  new notification cases (22 top-level, including 2 pair subtests).
- `node scripts/test-browser.js`: all 37 defaults in exact order, one uninterrupted
  invocation, exit 0, 1764.167 s at cd82074. Log: browser.log; result: browser-result.json.
  No suite was omitted, restarted or run directly. browser-artifacts.json lists
  all 37 output directories, 677 files/674 PNGs, plus the 316 raw atlas files separately.
  The unchanged output-only preload copies only fresh known fixed outputs; actual
  counts are review-polish 3, tools 8, notification-inbox 4, with before/after manifests.
- Offline `python3 .../compare-raw-atlas.py .../atlas`: exit 0. It compares untouched
  raw files only, after browser PASS. No recapture or normalization. atlas-compare.log,
  raw-atlas-comparison.json, raw-atlas-style-differences.json and atlas-groups.json
  record all files, hashes, rows and causes.
- Independent review evidence remains authoritative, not rerun here: KIT 8 intended
  behavioral negatives with exact restoration; CLIENT 4 public exact-base tracker
  failures, queued-callback/focus bounds, scope/switcher failures and 3 feature builds
  with actual rendered paths; NOTIF 22 fresh bounded negatives/0 cancelled plus 2 canonical
  data-isolation negatives with measured 0 poison accesses and unchanged marker/times.
  Full worker/review reports remain in /tmp/ws-scrcpy-redesign/briefs/.

The notification review did not run a fresh browser/atlas pass. Its accepted reuse
verified 272 client/build inputs through the browser-tested Android source chain,
18 fresh non-HTML files byte-identical to the retained browser-tested worktree, and
raw HTML differing only in two build-hash queries. It made no main-context 19-file
identity claim. The combined fresh 37-suite run above now covers the merged client.

Existing assertion changes were bounded: Quality now browses without a request and
presses Enter before the same restart assertion; Tools counts one visible instruction
while retained closed dialogs contain two invisible stale labels; the old phone-status
source guard follows the exact expression into PhoneHeader. Notification private mock
accesses follow collector/routes owners, three interpreter fixtures use in-memory
children, and exactly two push-body literals change device to phone. Both data-guard
lists add only the two new fixtures. No old behavior assertion was removed or relaxed.
The KIT reviewer corrected its new production observer to include actual proxy-coredevice.

Historical failures remain recorded in the six reports. The worker's ancestor-only ID
bound passed and remains unproven; its exact separate-root bound fails. Early AutoHeight
frame/selector/accessible-name test failures and client header-harness/source-guard/focus
issues were corrected before accepted review results. Integration's check and browser
run had no failure. A post-check audit initially assumed 19 public files; actual 18 was
explained from the raw 305-byte removed coreDeviceStreamTool chunk, without rebuilding.

Historical harness incident: the notification worker used Python subprocess.run(timeout=25),
which automatically SIGKILLed its OWN fake Node runner on a pending-write mutation.
No phone or collector was involved. The PID was not recorded; the subsequent process
check found none alive. The first 10 per-case names were overwritten by corrected copies;
the original timeout traceback remains. Root paused and audited the harnesses. Fresh
review produced 22 unique negative logs/0 cancelled and 2 instrumented isolation failures with
no termination. Do not treat overwritten worker logs as untouched originals. This
integrator's driver has no subprocess timeout, automatic signal or escalation; every
command ended normally and its owned PIDs were awaited. The existing browser runner's
SIGTERM suite ceiling was not reached. No KILL fallback was added or used.

**Production/fixture asset boundary.** Premerge 19 normal public files were preserved
outside the repo. Final combined normal public has 18 files; main-context filenames
are retained in checked-assets.json. The removed 305-byte 89 lazy chunk contains only
coreDeviceStreamTool.createEntryForDeviceList, whose reviewed source/registry were
deleted. The combined production build also excludes KitPage. No demo marker or
fixture artifact exists in public/dist. Existing unrelated dist/stream-config.json
was read only for its hash and was not changed. All 24 normal dist hashes and tracked
source bytes stayed identical through the browser run. The override remains exactly
three bytes 7b7d0a. Each separate review had 19 public files in its own build context;
that count is not forced on the combined main build.

The fixture compiler outputs outside all dist before any browser child. Only demo
cases use KIT_BASE; ordinary suites and atlas use production BASE. Both origins are
static fixtures without production phone middleware. The temporary fixture was removed
and no build/browser/test process remained. Accepted independent CSS proof removes
only 26 demo rules from 611, preserving all 585 ordinary declarations, ancestry and order.
LAST KitPage import/cascade order remains. The source/build-input identity after the
HANDOFF-only commit is recorded with both heads in the final report.

**Raw atlas and screenshots.** All 292 baseline hashes were verified against the retained
Android headSHA256 manifest, and 675d25b→7f changes only HANDOFF. The base was not
recaptured. New atlas: 158 states/316 files, 41 phone states and 38 desktop states per theme,
at 390x844 and 1440x900. Raw directory: atlas/. All changed/added/removed filenames and
SHA256 values remain in raw-atlas-comparison.json and raw-atlas-changed-files.txt.

| Raw group | Count and cause |
| --- | --- |
| Added loading | 8 files: list-loading PNG/JSON at both widths/themes; no cards or stream. |
| Added list reconnect | 8 files: list-reconnecting at both widths/themes; five dimmed last-status cards, disabled phone actions, retained Settings/notifications; no stream. |
| Added switcher reconnect | 8 files: switcher-reconnecting at both widths/themes; five stale disabled rows/explanations, last chips/Viewing and exact single stream mount retained. |
| Settings PNGs | 8 changed: android-settings and list-android-settings at both widths/themes, for the longer activation hint and wrapping/row shift. Centred desktop list Settings changes text pixels only. |
| Settings JSONs | 6 changed: android-settings all 4 contexts, list-android-settings phone light/dark. Exactly settings/section/quality-group/hint hashes change. AutoHeight card hashes are unchanged. |
| Confirmation JSONs | 8 changed: notifications-confirm and notifications-setup-confirm all 4 contexts. Question/consequence labels gain stable IDs; style hashes/prompt pixels remain identical. |
| Hidden USB option | 6 changed desktop-light pre-Setup JSONs: notifications-card-actions,confirm,filters,page-actions,search,toast. One inserted option with hash d7aa64a6; every other aligned row matches apart from the overlapping confirm IDs. |
| Totals | 24 added, 0 removed, 27 changed, 265 shared files byte-identical. The 27 are 8 PNGs/19 JSONs; one confirmation file belongs to two JSON groups. All 138 other shared PNGs match base. |

All 20 changed/added PNGs match the accepted KIT/CLIENT review pictures byte for byte.
The 8 Settings PNG differences are not proof of 40px gap removal: this exact base already
has natural Quality height. The exact old outer 161.1875/inner 119.1875/borders 2 gap was
independently reproduced by bounded original AutoHeight; the fixed final fixture is
121.1875/119.1875/borders 2, no inline height. Original retained evidence stays intact.

The hidden-option facts are raw insertion/unchanged rows/unchanged pixels. The timing
explanation is a SOURCE-BACKED INFERENCE: NotificationsView 100–105 derives unlinked
phones from trackers; 699–714 builds the retained USB selector; 554 keeps hidden Setup;
Presence retains initial children while hidden and refreshes when shown. Fixture Bench
is linked, Spare unlinked. HTTP-status/ATRC arrival order can retain placeholder-only
versus Spare before Setup is shown. All shown Setup captures match. Earlier 6b/Android
and client-review-proofs/raw-option-difference-context.json document the same variation.
No capture was normalized or repeated to hide it; no product fix is claimed for timing.

I inspected all 8 changed and 12 added pictures via the five atlas contact sheets, plus
all 4 multi-host Home screenshots via home-multi-host-contact.png. No clipping or missing
action was found. Raw changed screens cover both widths/themes. Supplemental natural
Settings/lifecycle images are in screens/kit-followups; multi-host and stale-switcher
captures are in screens/home; ordinary stage/rail/dock captures are in screens/desktop-layout.
The 677 suite artifacts and raw 316 atlas files remain unique to this integration.

**One remaining hardware checklist, separate from this integration.**

1. Follow a separately delegated deploy brief with rollback tag, allowed restart window,
   one iPhone session at most, no failed-start retry, and named-field/phone health checks.
   This section authorizes no deploy, unlock, live settings save or phone session.
2. The owner explicitly DEFERRED physical Android rotation, USB replug and one watched
   stream-setting restart. Do not ask again, wait for them, save settings yourself or
   label those three checks passed. Retain the prior first/last-viewer/30 s/Wake/Stop and
   acknowledged-forward checks for the separately authorized hardware pass.
3. Real iPhone picture/input aim, lock notice, owner-authorized unlock, Wake, Type text,
   wheel/pinch, actual keyboard capture/paste and physical reconnect/drag departure remain
   unverified. Fixture no-HEVC and simulated viewport/rotation results do not prove them.
4. Verify real collector startup/recovery/BlueZ, pairing, notification receipt, mute/old
   allow-list behavior, real Web Push/taps and an explicitly authorized phone action with
   its matching acknowledgment. Fixtures do not prove those hardware/delivery outcomes.
5. Safari, Firefox, phone keyboard/notch/safe areas, large real Files folders and the installed
   app remain unverified. The six refreshed hardware script bodies were not executed.

No new integration defect remains. The ancestor-only ID cause is still unproven,
known hardware limits remain, and the owner's pending choices are unchanged. Nothing
in this section deploys code or begins p6-docs.


### Redesign step 6c: current documentation (2026-11-13)

C-server-core-11: README now describes the owner's app, Docker's Node 22, stock scrcpy 4.1,
enabled audio, supported input paths and their limits. It covers the one Settings sheet,
instant capture changes, shared phone header/controls, modeless/docked Type text,
keyboard capture/paste/chords, combined inbox, current Setup and the mute-drop policy.
One environment table follows Settings.ts, including defaults, all accepted server
names and the legacy data alias. Storage, key handling, HTTPS and Host/Origin/CSP/proxy
boundaries follow current source. The clone URL comes from the configured project remote,
with credentials excluded. No credentials or live data were read for documentation.

Sections 1–6 above now describe TCP forwarding, session packet framing, Android's shell/
poller/session split and the notification collector/routes split. Dated history stays as
it was, with a scope note for superseded UI and "not deployed" entries. The obsolete
upstream scheme/debug documents are deleted after a repository link search; the plan's
plain deletion record remains. No source, settings, dependencies or test registrations
change. No further deployment is needed for this documentation-only step.

**Confirmed implementation deployment, before this docs branch.** The final deploy report
`/tmp/ws-scrcpy-redesign/briefs/deploy-followups-report.md` records `3b15a40` live on
2026-11-13 at 03:59:56.7329781Z, image
`cd5ba7160f56f2903057d1cd2289502de6dfda1cf26b899868fea634dc934ff6`.
Its final 04:06:33 audit reports healthy, zero restarts and no live serve-web. Rollback
`before-redesign-followups-20261113` preserves image
`531d61843b11fd0f72721027899d8a2ee24a82a0c34a03f77868d7bfd7f3bc71`.
This later deploy supersedes the preceding integration's historically correct
NOT DEPLOYED status. The old before-6a notification backup stayed inside the container.
This docs worker did not recheck live state or run Docker/phone commands.

The deployment made one permitted iPhone visit: one helper/socket/start, about two idle
minutes with 64.1 MB received, No picture in headless Chromium, retained mount through
sheets, clean shutdown 15.589 s after leave and sessions empty on two later reads. It
ran no unlock, input or settings save. The scheduled 03:00 unlock predated deployment;
approved named fields stayed unchanged afterward. Android was asleep and never woken:
one initial and one return socket reused the same scrcpy process within grace, with a
29.997 s final idle stop. Dock/Quality structure and production kit fallback were seen;
physical picture/input/settings application were not. Files header was observed; no
separate Shell-header capture result is claimed. Collector startup/status stayed healthy
with the same child and zero restarts, without testing arbitrary delivery or actions.

**Checks.** The implementation integration's source/check/atlas evidence remains in its
preceding dated section and final report
`/tmp/ws-scrcpy-redesign/briefs/integrate-followups-report.md`. It checked `cd82074`;
`3b15a40` changes only HANDOFF, with the same implementation and accepted main build.
Before editing, the documentation worker ran one normal `npm run dist` at exact base
`3b15a40000d3287270c015058af61b80efa2937a`; it passed, retaining override bytes `7b7d0a`.
Raw worktree build evidence is outside the repository at
`/tmp/ws-scrcpy-redesign/logs/p6-docs-worker-20261113/`. This was a fresh worktree build,
not a claim that its context-dependent chunk filenames match the main build. The worker
ran no full Node/browser check. The fresh review and main integration results below
complete the required checks.

**Final documentation integration, 2026-11-13.** Main began clean on `redesign` at
`3b15a40000d3287270c015058af61b80efa2937a`, apart from owner-untracked AGENTS.md;
AGENTS.md and .claude were preserved. The fresh review checked
`d605dacd9e31f459dac1baf8205e8539c6399288`: full check passed with 813 Node tests,
then all 37 default browser suites passed in one uninterrupted run. Its later
`8ea37bb3556c32fc410ed5251981d76de838e182` commit changes only README's Node sentence:
Docker uses Node 22; the actual host is v24.17.0. Review proved all other tracked
inputs and all 23 review-worktree compiled files unchanged. The separate main integrator
merged that exact accepted head with `--no-ff`, without conflicts or source edits.

Both fresh main checks ran at merge head
`79312da9f5ad4abf20369debacda9ec3cbca3530`, serially under one exclusive reservation:

- `npm run check`: exit 0 in 75.002 s. Type check passed; lint had 0 errors and 26
  warnings. All 813 Node tests passed, with 0 failed, cancelled or skipped. Python
  groups passed 43, 32 with 2 existing stock-helper comparison skips, and 4 tests.
  The skips reflect the already patched installed helper, not hardware coverage.
  Normal client/server builds passed; the client retained 3 performance warnings.
- `node scripts/test-browser.js`: all 37 registered defaults passed in order in ONE
  uninterrupted invocation, exit 0 in 1758.707 s. BROWSER was chromium; inherited
  atlas selectors, kit followup selectors, NODE_OPTIONS and iPhone key/UDID variables
  were cleared. The unchanged output-only wrapper retained 677 per-suite artifacts,
  including 674 PNGs. Production BASE stayed separate from the temporary demo KIT_BASE.
  No assertion, timeout, mock, registration or dependency changed; no suite was retried.
- Offline raw atlas comparison: all 316 accepted baseline hashes were verified first.
  Fresh output has 158 PNG/JSON pairs with the default four hash columns. All 158 PNGs
  match byte for byte. There are 310 identical files, 6 changed JSONs, 0 added and 0
  removed. Each changed desktop-dark Notifications file (card-actions, confirm, filters,
  page-actions, search and toast) has exactly one extra `option` row with hash `9e2c5061`;
  every other aligned row matches. NotificationsView's retained hidden Setup USB selector
  and independently arriving status/tracker fixtures support a timing explanation.
  This is an inference; raw hashes do not identify the option's text or prove reply order.
  No raw file was normalised, no base recapture or extra browser check ran.

All 535 tracked paths outside this four-document package match the implementation base.
Main's 24 normal dist files, including 18 public files and its pre-existing unrelated
stream-config file, are byte-identical before and after both checks. This is a
within-main comparison; the 23-file review worktree is a separate build context.
No selected demo markers remain in production public, temporary demo output is gone,
and build override bytes are exactly `7b7d0a` (`{}` plus newline). All owned check/browser
roots and observed descendants ended; no other check process remains. No unexpected
termination or signal occurred. The earlier fake-Node timeout incident stays in the
preceding dated record and was not repeated.

The integrator inspected fresh Settings desktop-light/phone-dark and inbox
desktop-dark/phone-light pictures, plus the desktop-dark atlas search state. No new
clipping or missing action was seen. The atlas's synthetic pushManager warning is also
pixel-identical to baseline; it is not a real notification-delivery observation.
Environment inventory (36 names), all 11 local links and preserved dated history passed
offline audits. Only README/HANDOFF changed and obsolete debug/scheme docs were deleted;
no implementation behavior changed and no new test or registration was needed.

Evidence is retained at
`/tmp/ws-scrcpy-redesign/logs/integrate-docs-20261113-vgl0v25z/`. The final HANDOFF-only
outcomes commit follows these checks. Its exact final head and proof that all 536 other
tracked inputs and all 24 compiled files still match the checked head are recorded in
`/tmp/ws-scrcpy-redesign/briefs/integrate-docs-report.md`. Passed checks were not repeated
solely for this outcome prose. These newer documentation commits are not another live
image. The existing implementation deployment above remains the latest confirmed live
state; this integration ran no Docker, live-server, phone, unlock or settings-save action.

**Still deferred or unverified.** The owner deferred physical Android rotation, USB
replug and one owner-operated stream-setting restart. Do not ask again or call them
passed. Awake Android picture, new owned-forward removal on hardware, owner Stop/Start,
real keyboard/paste/touch/wheel/drag/right-click/pinch, iPhone picture/aim/unlock/Wake,
phone keyboard/notch/safe areas, large real Files folders, Safari, Firefox and installed
app remain unverified beyond dated observations. Notification receipt/mute/old allow-list,
pairing, Web Push/taps, phone action acknowledgment and collector recovery also remain
unverified beyond startup/status. Refreshed hardware-only script bodies were not run.
The focus-ring, mute-drop, idle-opacity and rail-width owner choices remain unchanged.
The owner should reload browser tabs and reopen the installed app once after the recorded
implementation deployment; this documentation step creates no new reload/restart need.


### UI consistency and About integration (2026-11-13, fixtures only)

The owner asked for compact Scheduled unlock Time, outlined phone controls, consistent
icon/caption spacing, and a pass over About and troubleshooting. The exact large Time
gap on the owner's browser remains unconfirmed; the optional browser question is
unanswered. Physical Android rotation, USB replug and an owner-operated stream-setting
restart remain DEFERRED. This integration role authorizes no hardware action or
deployment. A separate deploy role may act under its own written brief.

The separate UI reviewer accepted `9ff2f908e657d6b8af4fa2bbf5a167f230ecf2a4` from
base `6adf768fe0a5716e7b67bedf4eb9dd0804cd2479`. The separate About reviewer accepted
its descendant `0ce4a7b3d63e62380f467a0fdefd4f1081f0441e`. Main merged those exact
heads with --no-ff, UI first, at `be1cbff2a863a8ba60fe34be1ef1cd64bf38037b` and
`29b2181e959be2afa4c800a1dbd9999e55934112`, with no conflicts or source seam fix.
Only the reviewed UI/test paths changed. No server, common, configuration, build,
public source, tokens, dependency or lockfile changed. The integrator registered the
six new tracker-command unit tests and ui-consistency/about-ui immediately before
atlas in the existing browser defaults. Fresh main checks and raw atlas review are
complete; their observed results follow below.

Phone action tiles use outlined kit surfaces, aligned icons/captions and separated
mouse rail rows. Mouse rails compact absent slots and choose columns from intrinsic
caption height and one-column picture geometry, independent of width history. Touch
keeps its three-column grid, centered Home, iPhone Back/Overview blanks and Siri last.
Narrow fine-pointer headers put keyboard capture on a second row without replacing
the stream mount. Scheduled unlock keeps the native 44px Time field and zone beside
it, with full-width draft/saving/saved feedback below and one saved-zone label. Native
Linux headless WebKit text is centered. Long notification text wraps; source names
stay bounded; fine-pointer cards below 600px use the existing menu.

About shows keyed Android Start/Stop and iPhone Stop refusals. Its additive observer
quietly expires at 30 seconds, separate from the unchanged eight-second Starting
fallback; matching descriptor completion wins over late replies. Android requires no
success acknowledgment. Old actions/openings/other phones cannot alter a new action.
iPhone Stop acknowledgment makes no claim of completed physical shutdown and Stop
stays off on its own screen. Exact initial `<NoModel>`/`<NoVersion>` read Unknown; known
metadata stays while offline, stale or unauthorized. System values wrap with readable
labels. Only Restart services uses the narrow/docked pair layout; centered desktop
stays inline. Busy active buttons retain native focus and reject repeats, with peers
disabled. Refresh still grows by 24px while busy and a dock row can grow naturally from
56 to 73.375px. Shared session problems appear beside Stream service. Commands,
payloads, counts, confirmations, schedule/timezone/save semantics, input hold/release,
launcher storage/drag/snap, keyboard gate and both reconnect policies remain intact.

Earlier evidence remains separate. The UI worker's optional Kit/Notifications run
ended at status 143 with UNKNOWN cause and missing initial PID evidence. The first UI
review full38 printed all suites but lost supervisor/result/session evidence after a
monitoring gap; cause UNKNOWN, with 341 observed records later absent. Neither is a
passed mandatory check. The replacement full38 completed independently. The About
worker fixed its initial prefer-const lint errors, then corrected a test's native
versus ARIA disabled assertion after its first partial browser run; the V3 run passed.
The About review's external parser typo changed evidence parsing only. Historical
WebKit ran at HEAD31a with saved work later4cc, not at HEAD4cc; fresh main WebKit is
required for current source. Accepted reports and raw evidence remain under
/tmp/ws-scrcpy-ui-audit-20261113/; integration evidence is in its integration/ directory.

No live state was rechecked here. The last confirmed live implementation remains
`3b15a40`, image `cd5ba7160f56f2903057d1cd2289502de6dfda1cf26b899868fea634dc934ff6`,
deployed at 03:59:56.7329781Z on 2026-11-13, as recorded above. This UI work is local
and NOT DEPLOYED. Owner choices on dark focus ring, mute-drop, 50% idle opacity and
mouse rail attachment remain unchanged. Safari, Firefox, installed app, native phone
keyboard, real input/audio/delivery and actual physical service outcomes remain
unverified. The results below retain one hardware checklist and the checked head.
The exact final HANDOFF-only head and identity proof are in the external report.
Passed checks were not repeated solely for prose.


**Fresh combined main checks.** All phases ran serially at clean checked head
`f3e55f6af30263e06a567756dc2272ee731fae92`. Root read and ACKed the actual external
short launcher, detached supervisor, phase specs and input manifests before launch.
PID/startTicks/PGID, command/CWD, fsynced polling and exact exits remain in
/tmp/ws-scrcpy-ui-audit-20261113/integration/prepared/. No outer timeout, fallback,
integrator signal, unexpected termination or repeated check occurred.

- `npm run check`: exit 0 in 87.916 s. Type check passed; lint 0 errors/26 existing
  warnings. Node 819 passed/0 failed/0 cancelled/0 skipped. Python 43 OK, 32 OK with
  two existing stock-helper comparison skips, and 4 OK. Normal client/server builds
  passed; the client retained three performance warnings.
- Installed WebKit Time-only through `node scripts/test-browser.js ui-consistency`,
  BROWSER=webkit and SCENARIO=time: exit 0 in 18.251 s; 44 states/eight contexts,
  88 PNGs, native height 44px and field-top motion exactly 0px. This is fresh merged
  source. Historical HEAD31a/saved-later4cc evidence had 22 matching non-HTML assets
  and a differing index.html; no blanket identity or real Safari result is claimed.
- ONE uninterrupted `node scripts/test-browser.js`: all 39 registered defaults in
  order, exit 0 in 1933.556 s. Chromium was explicit. About/UI/Scenario/atlas/kit
  selectors, inherited NODE_OPTIONS and private key/UDID/helper values were cleared.
  Only the output-only capture preload was supplied, SHA256
  `3d3ba323e64f8bbffb9e13cb364b2fcd3f199841c7cb909374575525c0ed9282`.
  Normal BASE stayed production; demo KIT_BASE was runner-isolated. No ATLAS_COMPARE,
  filters or style-column override was set.

Full39 retained 1297 suite artifacts (1292 PNG/five JSON), plus 158 raw atlas PNG/JSON
pairs. WebKit has a separate 89 files (88 PNG/one JSON). UI consistency records are
80 controls, 48 intrinsic heights, 10 decoded width states and 44 Time states/eight
contexts (0px movement), plus 20 notification contexts/378 PNGs. All four About flows
passed: layout, metadata, androidActions and iosActions. About has 30 contexts,
86 measurements, 216 PNGs, 46 commands and 17 guarded probes. Independent raw reading
verified all 988 rows (overflow 0), 203 natural cards (height difference 0/no inline
height) and 230 targets (44px coarse/32px fine minimums). Commands total 16 list_encoders,
10 start_server, six kill_server, 10 refresh_device, two restart_session and two
remount_ddi. All 23 list contexts opened zero stream sockets; seven dock contexts
retained one mount/socket and left by Phones. Actual About stream messages total 0.
No physical phone/service/input result follows from fake fixtures.

**Raw atlas.** All 316 canonical hashes captured at `79312da` were independently
verified; 793-to-6ad changes HANDOFF only. Main has 184 identical files, 132 changed
(32 PNG/100 JSON), zero added/removed, 316 total. Complete raw hashes, pixel bounds,
style edits and filenames remain in integration/raw-atlas-comparison.json,
raw-atlas-style-differences.json, atlas-state-groups.json, atlas-row-classification.json
and atlas-changed-files.txt. No file was normalized. Every changed state family:

| State family | PNG | JSON |
| --- | ---: | ---: |
| android-actions | 2 | 4 |
| android-asleep | 2 | 4 |
| android-controls | 2 | 2 |
| android-screen | 2 | 4 |
| android-settings | 2 | 4 |
| android-switcher | 2 | 4 |
| android-type-text | 2 | 4 |
| android-unlock | 2 | 4 |
| iphone-actions | 2 | 4 |
| iphone-controls | 2 | 2 |
| iphone-screen | 2 | 4 |
| iphone-settings | 2 | 4 |
| iphone-switcher | 2 | 4 |
| iphone-type-text | 2 | 4 |
| iphone-unlock | 2 | 4 |
| list-android-settings | 0 | 4 |
| list-iphone-settings | 0 | 4 |
| notifications-all | 0 | 4 |
| notifications-card-actions | 0 | 4 |
| notifications-confirm | 0 | 4 |
| notifications-filters | 0 | 4 |
| notifications-inbox | 0 | 4 |
| notifications-page-actions | 0 | 4 |
| notifications-search | 0 | 4 |
| notifications-toast | 0 | 4 |
| switcher-reconnecting | 2 | 4 |

The 32 PNG changes are four open touch-control panels and 28 desktop rail pictures.
All 158 current atlas PNGs match the accepted UI0 full38 images byte for byte. Every
one of 1186 row edits is classified: 60 header descriptor classes with identical style
hashes; 84 rail/caption/layout; 694 outlined controls; 116 About System/pair/natural
size; four Actions hover hashes; 216 notification wrapping/source bounds; six hidden
option deletions and six insertions. About's 116 rows exactly match the isolated
fresh9ff-to0ce reference: three System children per context, Restart's pair descriptor
and six row/child plus five containing-node natural-size changes where stacked.
Dedicated About pictures show lower content outside the normal atlas's painted area.

All 32 Notifications PNGs match baseline. Twelve light JSONs (card-actions, confirm,
filters, page-actions, search, toast) add one hidden option on phone/remove one on
desktop, hash d7aa64a6. Other aligned rows change only wrapping/source styles. Against
accepted About full39, all PNGs and 310 total files match; six dark JSONs add one
hidden option, hash 9e2c5061. The retained hidden Setup USB selector and independently
arriving fixture tracker/status data support timing as an inference; raw hashes do
not identify option text or reply order. Actual baseline/current Actions images show
Refresh/Rotate Right hovered. The click point moves with rail compaction; pointer
coordinates were not recorded, so that explanation remains an inference.

The integrator opened 41 distinct actual PNGs, including Time in both engines,
320px headers, controls/audio/rail history, long notifications, About metadata,
Services/refusals/busy/session reason, changed atlas phone/desktop light/dark and both
baseline Actions themes. Exact paths/hashes: viewed-images.json and
viewed-image-hashes.json. The matrices contain more images than were opened. No
clipping or lost action was seen; short viewport scroll edges are normal boundaries.

**Cleanup and final documentation.** All 1098 observed process records, including
three launchers/supervisors and their children, are absent. Before this outcomes edit,
all 540 checked tracked inputs and 24 normal dist hashes (18 public) matched completed
checks. Selected demo
markers are absent, override is exactly 7b7d0a, and no run-created kit directory remains.
The unrelated stream-config artifact was hashed only and preserved. Server/common
source has no diff from the last confirmed live source. The final HANDOFF-only commit
and proof of identical other tracked/runtime/compiled inputs are recorded with exact
checked/final heads in final-source-audit.json and the report named below.

Two external prose/audit guards stopped before final writing. One incorrectly assumed
all /tmp/ws-scrcpy-kit-* directories were absent; older ws-scrcpy-kit-4MVabD predates
this run by mtime/ctime and was preserved. Root accepted auditing this run's new-mkdtemp
cleanup instead. The other caught an unmatched sentinel-formatting replacement before
writing HANDOFF. Their raw errors/corrections are in offline-audit-assumption.json and
documentation-guard-correction.json. Corrected offline audits passed. No product/test
source, raw evidence or completed check changed or reran.

**Remaining hardware checklist, outside this integration.**

1. A separate deploy role uses its own rollback/window/one-session procedure, never
   retries a failed iPhone start, and waits for clean shutdown. This role did not deploy.
2. Physical Android rotation, USB replug and one owner-operated stream-setting restart
   remain DEFERRED. Do not ask again, perform them or mark them passed.
3. Real picture/input aim, lock/Wake/unlock, holds, capture/paste/wheel/pinch/drag and
   physical service outcomes remain unverified beyond earlier dated observations.
   An iPhone unlock always needs separate owner authorization.
4. Real collector recovery/pairing/receipt/muting/old allow-list/Web Push/taps and
   matching phone-action acknowledgment remain unverified beyond startup/status.
5. Safari, Firefox, native picker/keyboard/notch/safe areas, audible capture, large real
   Files folders and installed app remain unverified. The owner's exact Time symptom
   and optional browser question remain unconfirmed/unanswered. Pending owner choices
   stay unchanged.

Whole findings/evidence and the exact final HANDOFF-only head:
/tmp/ws-scrcpy-ui-audit-20261113/reports/ui-consistency-integration.md. Local UI changes
remain NOT DEPLOYED. No live-server/Docker/phone/helper/unlock/settings-save/data-export/
secret-file operation, install, dependency change or push occurred. Review worktrees
and branches remain for root's verified cleanup and a separately assigned deploy.


### UI consistency and About deployment (2026-11-13)

The separate deployment role deployed source
`33bc04f927089e9da59197ef40c225fa96f428e9` from `redesign`. Its checked implementation
was `f3e55f6af30263e06a567756dc2272ee731fae92`; the difference was HANDOFF only.
Image `sha256:8086f74b79d68260d48ba1abcc8172eda2249a30b532760c5c75f5265fcd6faa`
started at `2026-11-13T14:05:11.684179175Z`; Compose recreation took 0.398 s.
The first Docker mutation created rollback tag
`ws-scrcpy:before-ui-consistency-20261113`.
The tag was verified before build/restart at the actual prior image
`sha256:cd5ba7160f56f2903057d1cd2289502de6dfda1cf26b899868fea634dc934ff6`.
No rollback trigger was observed and no rollback was needed. This later deployment
supersedes the preceding integration's NOT DEPLOYED status; that earlier role did
not deploy and its dated record remains unchanged.

**Accepted evidence.** Root read the whole FINAL deployment report and accepted its
source/artifact/session/health/cleanup proofs. The report is
`/tmp/ws-scrcpy-ui-audit-20261113/reports/ui-consistency-deploy.md`, SHA256
`484877cc2e5a12033f99980bbeac4bf93c1f160e063141d16062d5dc8a4b19e2`.
Raw records remain under `/tmp/ws-scrcpy-ui-audit-20261113/deploy/`; accepted-deploy.json and
deploy/root-final-deploy-audit.json record root's independent acceptance. All 376
recorded host PID/start identities were inactive, with no zombies or PID reuse.
All 540 tracked hashes and 24 normal HOST artifact hashes matched accepted main;
owner AGENTS.md and .claude were preserved. Server/common/Python/config/Docker/build/
dependency diffs were empty; package.json changed only its reviewed test registration.
No stored-file format changed; the old notification backup stayed in the container.

**One isolated iPhone visit.** Health before the visit found iOS 27.2.1/build 24B156,
the developer image already mounted, CoreDevice answering and media sessions empty.
No command reported password protected; no mount, unlock or retry occurred. The
fresh 13:35 baseline differed from older unlock history: lastRun was unlocked at
04:32:21.698Z and lastTypedUnlockAt/lastUnlockedAt were 04:32:31.358Z. That earlier
change has an unconfirmed cause and was not attributed to this task. All subsequent
named-field comparisons used and matched the fresh baseline.

The isolated 8010 server excluded Android, used both data aliases and stream config
under data/test, disabled the collector and had no enabled schedule/stored passcode.
The four patches and the 32 Python patch tests passed, with two existing stock-helper
comparison skips. The temporary build passed and override bytes were restored at once.
The original sampler read global process arguments; root caught this before display.
It was replaced by stat-only monitor 36145. During that replacement, only own sampler
34951 received SIGTERM; Node 34954 and waiting parent 34952 stayed. This was a logger replacement,
not an unexplained server termination or phone restart.

The sole Screen click was 13:58:10.605Z: one socket, helper PID 39009/startTicks
1921552765, and one new budget timestamp at 13:58:11.421Z. All 17 observations passed,
with child exit 0 and no harm, exception, browser error or mutating HTTP request.
Time was native 44px high; System/Services were visibly reached; Restart used its
pair layout and own-screen Stop stayed disabled. The 11 outlined controls, modal
Switch/Actions/Settings and empty modeless Type text kept the same stage/mount/socket/
navigation through 320/390/1280 widths. No phone input, service action, unlock or
settings save was sent. Headless Chromium showed No picture: HEVC bytes are not proof
of a decoded picture, touch aim, native phone keyboard or audible playback.

During two idle minutes, received bytes grew from 6,570,784 to 71,162,988. Phones leave
was 14:00:25.800Z; the helper was first observed gone at 14:00:41.214Z, 15.414 s later,
with shutdown complete. Two media reads 30 s apart showed running false/sessions[].
There was no second iPhone context, failed-start retry, live iPhone visit or unlock.
Own Node 34954 then received SIGTERM and exited 0; parent/monitor/helper were gone and
8010 was free. The normal build restored all 24 HOST hashes exactly, public 18/demo
off/override 7b7d0a. No test server/viewer/helper remained.

**Live health and look-only checks.** Immediate 14:05:37, 90-second 14:06:42 and
six-minute 14:11:12 snapshots passed: healthy/running/zero restarts, Node uid/gid 1000
and supplementary group 111, both phones tracked, trusted hosts 200 and unknown Host
403, unchanged data paths, no serve-web or unrequested unlock. Collector PID 48503
stayed unchanged across 35 observations, Bluetooth connected/Receiving notifications,
zero restarts and empty errors. This proves startup/link/status, not actual delivery,
pairing, muting, push or recovery. Whitelisted unlock fields stayed equal to the fresh
baseline through the final 14:14:24 audit; absent zone/lockedOutAt/retryAt stayed absent.
No `ios-settings.json`, key or ciphertext was printed, copied or hashed.

The live Android look used one context: all 20 local predicates passed, two planned
sockets both closed and zero iPhone sockets. The phone stayed asleep; no Wake, input,
typing or settings save occurred. Files closed the first stream after 47 ms; Shell
connected without typing. Screen return after 405 ms reused app_process 6611/scid
7f0b9c97 within grace. Phones/Back added no extra stream. After the last close at
14:06:34.772Z, polls bracketed final process stop between 28.823 and 30.819 s; this is
not an exact shutdown timestamp. The process and wrapper were gone. Existing forwards
stayed unchanged; newly owned-forward removal was not established on hardware.

Header reflows retained mount/navigation/socket; Actions/Settings docked and Type text
was empty/modeless. System/Services fitted. Quality's natural outer/inner heights were
121.1875/119.1875px, with 2px borders and no retained inline height; no preset was
pressed. Dock motion and picture/rail clearance matched the fixture design. Five
permitted Android/list pictures were inspected. The initial list Settings capture was
still Loading settings; later screen Settings had the recorded geometry. Narrow
headers and lower About were measured without separate screenshots.

Notifications were inspected by structural counts only: one header/toolbar, three
filters and 18 cards. Setup opened/closed locally with one Apps section and two app
rows. No content dump/screenshot/read/archive/mute/pair/push/action/save occurred.
A separate non-phone production Kit visit at 14:08:14.852Z returned the Phones
fallback with demo absent and zero mount/screen/phone stream/browser error.

**Qualifications and retained failures.** The Android context captured one pageerror:
sessionStorage Access is denied for this document. Production storage calls catch
denial; the injected guard reads storage before its document marker, and Back reset
the document. Root classified an injected-guard/opaque-document cause as likely.
Exact source/time remain unproven because no stack/time was captured. The look was
not error-free and was not repeated; no defined rollback trigger was observed.

HOST normal artifacts remain byte-identical across all 24 files, including 18 public.
Docker has the same 18-file public inventory, with 17 of 18 public files byte-identical
to HOST. Only
index.html differs: bundle.js/main.css cache queries are f56c09203ecc23a147b8 on HOST
and df7c9e4cc4bf0d57b29c in Docker. Root proved those two replacements are the whole
raw HTML difference; HtmlWebpackPlugin uses hash:true. The reason the compilation
hash differs across contexts remains unproven. All JS/CSS and the remaining static
files match.
The overly broad optional public-identity assertion exited 1 and was retained. No
normalization, rebuild, phone rerun or blanket Docker 18/24-file byte claim followed.

Temporary, normal and Docker client builds each retained three performance warnings.
A final combined-channel log audit read 16 stdout and three stderr lines: no selected
operational/session/unlock errors, with the Files DEP0180 fs.Stats deprecation warning
at 14:06:34.222963201Z retained. Earlier external package-comparison and readiness-state
guards stopped before display and were corrected; root's readiness-parser key error
also predated ACK/phone action. Pre-visit visibility/cleanup/ACK/attempt/result guards
were corrected before the one visit. Original failures and the sampler replacement
remain in the deployment evidence. No successful check or phone visit was repeated.

**Documentation-only continuation and limits.** This later writer appended only this
entry and made no test/build/format/browser/phone/helper/Docker/live/test-server/
settings/data/key/install/push/redeploy action. Checks already passed at f3; source
33bc was deployed. The new documentation-only final head and before/after proof are
in `/tmp/ws-scrcpy-ui-audit-20261113/reports/ui-deploy-notes.md`. All 539 other tracked
inputs and all 24 HOST normal hashes remain identical; the existing stream-config
artifact was hashed only. This prose commit needs no tests, deployment or iPhone visit.

Physical Android rotation, USB replug and an owner-operated stream-setting restart
remain DEFERRED; do not ask again, perform them or mark them passed. No standing
iPhone unlock permission exists. Real iPhone picture/aim/Wake/unlock, phone input/
holds/paste/wheel/pinch/drag, audible capture, physical service outcomes, Safari/
Firefox/native picker/keyboard/notch, large real Files folders, installed app,
collector recovery/pairing/real delivery/muting/old allow-list/push/action acknowledgment
remain unverified beyond dated evidence. The exact owner Time gap/browser remains
unconfirmed/unanswered. Focus-ring, mute-drop, idle-opacity and rail-attachment owner
choices remain unchanged. Reload every browser tab and reopen the installed app once
after this deployment.


### About Phone fact alignment correction (2026-11-13, fixtures only)

The owner pointed out a missed inconsistency after the previous About pass: Model and
Serial still appeared under their labels while other Phone facts used right-aligned
values. All Phone facts now use the same kit value element, with whole labels on the
left and selectable, complete values wrapping in the right lane. Feature changes stay
in AboutSection, scoped About fact CSS and the existing about-ui suite. Services keep
their control/description layout and all command, focus, confirmation and stream rules.
No shared kit, token, breakpoint, arbitrary size, server or configuration changed.

Root accepted the fresh review at `145df66acdc66e5f3c1a73ae88ef2c59fbb46574` from base
`b1a25757812efe2f7dadb3af560f494614b19cab`. Main merged it with --no-ff at `b5a69ff4865463a73f148aa18bd33deace4e982f`,
without conflicts, seam fixes or test registration. The new geometry checks cover
all fact lanes, reading size, full content, selection, clipping and ordinary compact
rows. Primary 440x956 is included for both themes/platforms, with 320/390, 956x440
landscape, centered desktop and dock retained. The independent base-product negative
failed Model's real lane geometry, not a missing selector; separate fixture controls
proved clipping and whole-label assertions. Focused review and all four About flows
passed; main check and raw atlas results follow below.

The first main npm check passed at `e309bff`. The first default39 stopped normally
with exit 1 after 205.676 s: Settings still looked for Serial in the old description
element. The audit found one other stale Model lookup in ios-settings. Root approved
two one-line adaptations to the existing value helper, retaining exact Serial/Model
equality, committed separately at `13c522c`. All 98 browser descendants and the
supervisor/launcher were gone; source and 24 artifacts matched the first check. Raw
failure evidence is preserved. A fresh read-only second pass accepted the two-line
seam unchanged. The first browser run remains a failed result.

At frozen `c109f773c052be78b4ae32403c4ebf48e4cbba7d`, the replacement `npm run check`
passed in 75.876 s: all 819 Node tests, Python 43 + 32 (two existing stock-helper
skips) + 4, type checks and both builds. Lint retained 26 warnings and no errors;
the client build retained three performance warnings. Then one uninterrupted
all-default39 runner invocation passed in 1944.629 s, including the strict Serial
and Model assertions. There was no focused or WebKit repeat.

About passed all four flows: 34 contexts, 98 geometry records, 232 PNGs, 48 fixture
commands and 17 guarded early actions. List contexts had zero stream sockets (27);
dock contexts retained one socket and left the screen (7), with zero stream messages.
Offline bounds checks covered 1,120 rows and 233 cards with no scroll overflow or
card-height mismatch. I opened 18 fresh About PNGs: primary and desktop both themes/
platforms, 320px long metadata both themes/platforms, lower iOS facts and landscape.
Labels stayed whole, values shared their right edge and long values wrapped fully.
Services retained their separate description/control layout.

The raw atlas retained all 158 PNG/JSON pairs. All PNG bytes match the current f3
baseline (b1 differs from f3 only in HANDOFF). Of 28 changed JSONs, 16 contain 140
edit groups wholly within Phone facts: scoped lane/wrap/whole-label styles and the
Model/Serial value elements. Twelve Notifications JSONs each lose one hidden USB
select option and change nothing else. Setup stays mounted and that list derives
from phone/status state; timing is a possible cause, not proven by the hash-only
capture. No notification source changed. No raw capture was normalized or rerun.

All 1,373 recorded PID/start identities across both attempts and their launchers/
supervisors were gone. All 35 original evidence hashes remain unchanged. Replacement
source and all 24 normal artifacts (18 public) matched their successful build;
override remained exact. The final results commit changes HANDOFF only, with all
539 other tracked inputs and all 24 artifact hashes preserved. Owner AGENTS/.claude
were left intact. Raw logs, classifications, 1,308 per-suite PNGs and exact checked/
final heads are in `/tmp/ws-scrcpy-about-facts-20261113/integration.md.result` and
its linked manifests. No further tests were run for this prose.

This correction is not deployed by this integration. Last confirmed live remains
source `33bc04f`, image `8086`, from the separate deployment above. A 440px Chromium
fixture is not a real iPhone 17 Pro Max or Safari result. Physical Android rotation,
USB replug and owner-operated stream-setting restart remain DEFERRED; do not ask,
perform or mark them passed. Real browser/phone selection handles, Safari/Firefox,
installed app, keyboard/notch/safe areas and physical input/service behavior remain
unverified. Pending focus-ring/mute-drop/idle-opacity/rail-attachment choices stay.


### About Phone fact alignment deployment (2026-11-13)

The separate deployment role deployed source `6915c36d7452eab1c22d14282a45ee64097937a7`,
checked at `c109f773c052be78b4ae32403c4ebf48e4cbba7d`. All Phone facts, including
Model and Serial, now share label-left/value-right lanes; long values wrap fully.
The failed first default39 and reviewed two-selector adaptation remain recorded
above. This later documentation role did not repeat checks or deploy anything.

Image `sha256:73504e796884545aafc9af5d454ee72cb80c18663e94a72f84f012c5df8b4afd`
started at `2026-11-13T18:05:10.566183867Z`. The rollback tag
`ws-scrcpy:before-about-facts-20261113` was created and verified FIRST at prior
image `8086`. Immediate, 90-second and six-minute checks passed: healthy, zero
restarts, UID1000/group111, both phones, trusted Hosts200/unknown403. Collector
53394 stayed stable and receiving; named unlock fields stayed unchanged. No
rollback was needed. Root accepted the final report and cleanup proof.

Exactly one isolated test-server iPhone visit passed all nine required results.
It used one helper/socket/new timestamp, retained two-minute byte growth, left by
Phones, closed its context and waited for helper shutdown. Two post-close media
reads were empty at least 30 seconds apart. Headless “No picture” was expected;
decoded video was not proved. Own Node received SIGTERM and exited 0; its parent/
supervisor exited, port 8010 was free and all normal artifacts were restored
before Docker. No extra visit, retry, unlock, input or settings save occurred.

One live Android look-only context passed ten results. Both list-card Phone facts
and Android screen facts passed primary 440px portrait, both themes, landscape
and desktop captures. Two planned Android sockets reused the same grace process;
Files and Shell were visited without typing. Phones then Back added no stream;
final grace cleanup completed. No Wake/input/settings save or browser/guard error
was captured. The optional separate live Kit context was omitted.

Preparation had a retained failure: the first temporary-server supervisor used
the Node log filename and exited 1 before Node Popen. A premature metadata probe
was refused; a readiness launcher also hit a label guard. No helper/stream/attempt
claim existed. Reviewed naming and external harness safety fixes used the actual
server8010 phase and verified PID/monitor/HTTP before later probes. Offline smoke
checks passed. Root's first ACK writer had a parse typo before any write; its
correction caused no helper change or extra phone attempt. Raw ledgers remain.

All 17 non-HTML public files match approved HOST bytes, including JS/CSS. Only
index.html differs: exactly two cache-query values changed from HOST
`ca03f508578ed78cbc52` to Docker `986071cece29fd2d2bdb`; all other bytes match.
Root retained the complete raw-difference proof. HtmlWebpackPlugin uses hash:true;
the underlying compilation-hash cause remains unproven. There is no blanket
18/24-file cross-context identity claim. Builds retained three performance warnings;
final runtime logs retained one DEP0180 fs.Stats warning during Android Files.

Final deployment audit passed; all 360 recorded host identities were absent and
named fields unchanged. Accepted deployment evidence is
`/tmp/ws-scrcpy-about-facts-20261113/deploy-report.md`, with raw evidence in its
linked run directory. This HANDOFF-only continuation preserved all 539 other
tracked inputs, all 24 normal HOST hashes (18 public), exact override and owner
AGENTS/.claude. stream-config was hash-only; no ios-settings.json, key or ciphertext
was printed/copied/hashed. Exact deployed versus new docs-only heads and proofs
are under `/tmp/ws-scrcpy-about-facts-20261113/deploy-notes/`.

CSS 440x956 is not real iPhone 17 Pro Max or Safari validation. Real Safari/Firefox/
PWA, decoded HEVC, native phone input/audio and actual notification delivery remain
unverified. Physical Android rotation, USB replug and owner stream-setting restart
remain DEFERRED. Owner focus-ring/mute-drop/idle-opacity/rail choices are unchanged.
Reload each browser tab and reopen the installed app once after this deployment.

### Owner UI feedback: header status, controls, icons and Files (2026-11-14, fixtures only)

The owner looked at the app on an iPhone 17 Pro Max and on a desktop and named six things. An
inspection of every page at 440x956, 956x440 and 1440x900 came first (no code changed), then the
owner chose between the open options and asked for the fixes. Not deployed.

Owner's choices of 2026-11-14: item check boxes are off until turned on; the iPhone gets its own
control layout; the thirteen control icons take Lucide's shapes; a tap on a file on a touch
screen opens a sheet with the file's actions.

What changed, one commit each:

- **A tool's connection is under the phone's name.** On Files and Shell the word "Connected" was
  the last item of the tab row: on a phone it read as a fourth tab, on a desktop it stood alone at
  the far right, and the header had no status line, so the phone's name moved when the tab changed.
  `ToolView.tsx` now passes its `toolConnection` to `PhoneHeader` (`connection`,
  `connectionClass`), the same line Screen uses. `TabStrip` takes no children any more and
  `DevicePage` passes the strip itself, not a function. The line keeps the classes
  `tool-connection` and `connected`, which many browser checks wait for.
- **The unread count of Notifications is words.** The bar drew the kit's badge on its own, a red
  number with no icon. `UnreadCount` (`NotificationHistory.tsx`) now writes " · N unread" after
  the status line, in `notification-bar-status`. The status line (`kit-bar-status`) keeps its own
  text, and the number keeps the class `notification-unread-count`.
- **The iPhone has its own control cells.** `IPHONE_SLOTS` and `slotOf` in
  `controls/definition.ts`; `shownControls` returns each control with its cell for the phone at
  hand, in cell order. iPhone: Home, Siri, Lock / Volume down, Mute phone, Volume up / Listen,
  Screenshot, Type text / Actions, Settings. Android is unchanged. The desktop rail follows the
  same order. This gives up "one cell on both kinds of phone" for every control but the volume
  keys.
- **Lucide shapes for the control icons.** `navBack`, `home`, `square`, `power`, `volDown`,
  `volUp`, `volMute`, `headphones`, `mic`, `camera`, `text`, `sliders` and `bolt` in
  `ui/icons.ts` are the shapes of Lucide 1.72.0, each merged into one path (a circle and a
  rectangle written as arcs). `navBack` is its triangle turned to point left. No dependency is
  added; the ISC and MIT notices are in a `/*! */` comment at the end of the file. The old paths
  measured 24x24 in Chromium and WebKit, so nothing was stretched: the shapes themselves were
  uneven (ink from 12x12 to 17.5x12). `sliders` and `bolt` are used outside the controls too.
- **Files: Item check boxes, a sheet for a file, and tidier menus.**
  - "Item check boxes" in the View menu, stored as `checkboxes` in
    `ws-scrcpy.files.preferences`, off by default. `data-checkboxes` on the explorer shows the
    column for every row or for none. It no longer appears with a selection, which moved every
    name aside on the first click.
  - On a touch screen a tap on a file opens `askAboutFile`: the name, size, type and date, and
    Download, Rename, Delete and Cancel. Each runs the row menu's command for that file. A mouse
    double click and Enter still download at once.
  - In the installed app on an iPhone (`navigator.standalone`) the download link opens in a new
    context. Not tried on a phone: see below.
  - The check of a menu item is drawn at the end of the item (`kit/Menu.css`), so "Select items"
    starts where the items above it start. A line separates the sort key from the direction.

Tests added or changed: `e2e-device-page.js` (the tool's line is in the header and the strip
holds only tabs), `e2e-controls.js`, `test-stream-clients.js`, `e2e-ui-consistency.js` (the
iPhone cells and order, no hole in either grid), `test-kit.js` and `e2e-notifications.js` (the
count in words), `e2e-files-kit.js` (the option off, on, kept, and off with a selection),
`e2e-files-flows.js` (a tap opens the sheet and starts no download; Download and Rename in it),
`e2e-files.js` (its `open` helper answers the sheet on touch; rows are pressed in selection
mode).

Not done, from the same inspection, and the owner's to decide:

- The Keyboard section of Settings and the hint "Use arrow keys to browse" show on a touch phone,
  as does "Mouse and keyboard" in Actions. Hiding them would also hide them from a phone with a
  keyboard attached.
- In landscape on touch (956x440) Files uses the desktop toolbar, which scrolls sideways with no
  hint; its quick access rows are 22 px high. The header, tabs and lock notice take 157 of 440 px.
- Shell's key row needs about 575 px, so Copy, A- and A+ are off-screen at 440 px.
- Files uses the same arrow for Forward and for Move. The root "/" of the address is 17 px wide.
- On a desktop the cards of Phones stretch to the tallest in their row, and "Volume down" wraps
  in the rail, so that tile is taller than the others.
- With two iPhones the switcher of Notifications is a chevron on its own in the bar.

Needs hardware (the owner's iPhone, Safari and the installed app):

- Download from the file sheet in the installed app: iOS should show the file outside the app's
  window, with Done. If it shows a blank view or still replaces the app, the next thing to try is
  `navigator.share({ files })`, which holds the file in memory and needs a size limit.
- The file sheet, the check boxes and the controls panel under a real finger.

Checks at the head of this step, all on fixtures: `npm run check` passes (type check; lint with
0 errors and 26 warnings; 819 node tests; the Python tests; the production build), and
`node scripts/test-browser.js` passes all 39 default suites. The new browser checks were not run
against a build of the base to prove they fail there; the base behaviour is in the inspection's
screenshots. No atlas comparison with the base was made: the header of Files and Shell, the bar
of Notifications, the controls, every menu with a check item and the control icons differ on
purpose. No phone, adb, docker or live server was touched, and nothing is deployed.

### Owner UI feedback deployment (2026-11-14)

The owner asked for the deploy while watching the iPhone on the live server. A screen session was
running in the live container, so the owner closed the iPhone's screen first (session gone at
01:49:19 UTC). Head `f29246b` plus this section. Client only:
`git diff --stat 647de3b f29246b -- src/server src/common src/public python Dockerfile docker-compose.yml package.json`
is empty.

Before: image `73504e796884`, started 2026-11-13T18:05:10Z, healthy, 0 restarts. Named unlock
fields: enabled, time 03:00, lastRun unlocked at 2026-11-13T22:48:37Z, lastTypedUnlockAt and
lastUnlockedAt 22:48:46Z, lastSlotAt 2026-11-13T15:00Z, a passcode stored.

Phone health (host venv, one-shot commands, 01:49 UTC): iOS 27.2.1 (24B156) as at the last run,
the developer image mounted at /System/Developer, `list-processes` answered, `sessions: []`.

Test server (port 8010, built with `{"INCLUDE_GOOG": false}`, data in `data/test`, no stored
passcode): 200 locally, 403 for `evil.example`. One iPhone screen session, started six minutes
after the owner's ended, at 1280x800 in headless Chromium:

- One start (stream at 01:57:16). Bytes on the one `proxy-coredevice` socket: 1.1 MB in the
  first seconds, 68.9 MB after two idle minutes, no second socket. The header said "No picture"
  and the stage "This browser cannot show the stream" (no HEVC decoder), the banner "Phone
  locked" with Unlock, which was not pressed.
- Controls in the new order: Home, Siri, Lock, Volume down, Mute phone, Volume up, Listen, Take
  screenshot, Type text, Actions, Settings. Switch phone, Actions (Clipboard, Screen, Lock,
  Power) and Settings (Sound, Keyboard, Unlock, About and troubleshooting) opened and closed.
- Left by the header at 01:59:22; the card showed "In use", then not; `shutdown complete` at
  01:59:37; no SIGKILL; Back once started nothing. No page or console error.
- An earlier run of the script ended before it opened anything: it looked for the card under
  `ios:<udid>`, and a real server keys a card `<host id>:<udid>`. It started no session.

The test server was stopped with SIGTERM by PID (exited at once), `build.config.override.json`
restored to `{}`, the normal dist rebuilt, nothing listening on 8010, `sessions: []`.

Deploy: `docker tag ws-scrcpy:latest ws-scrcpy:before-ui-feedback-20261114` (image
`73504e796884`), `docker compose build ws-scrcpy` (new image `f0382167242d`),
`docker compose up -d ws-scrcpy` at 02:01:33 UTC with no screen session in the container.

After: healthy, 0 restarts, `node index.js` as uid 1000, no error line in the log; 200 on
127.0.0.1:8000, on 10.10.10.5:8000 and for Host `mini-nuc.tailea1801.ts.net`, 403 for
`evil.example`; the named unlock fields the same straight after and at 02:07:45.

Look-only pass on the live server (Android, fresh browser context, nothing typed or saved, no
press on the picture): both phones listed; Settings from the POCO card has its five sections;
Screen connects with tabs Screen, Files, Shell and the tab row holds only tabs; the stage showed
"Screen is asleep" with Wake (not pressed); controls in the Android order; Actions and Switch
open; Files shows "Connected" under the phone's name, check boxes off, and "Item check boxes" in
the View menu; Shell connects with no key row; Screen after Files opens one new stream socket;
Notifications reads "iPhone · Connected · 38 unread" with no badge in the bar; the log shows
"No viewers left. Stopping the stream service" after each visit. No page or console error.

Not checked on the live server: the iPhone's screen (no second session was started by the
agent), the file sheet and the controls panel on a real touch screen, a download in the
installed app. At 02:05:00 a screen session was running in the live container that the agent
did not start; it was gone by 02:07:45.

Rollback, for a break only: `docker tag ws-scrcpy:before-ui-feedback-20261114 ws-scrcpy:latest`
and `docker compose up -d ws-scrcpy`. Reload each browser tab and reopen the installed app once.

### Notifications outage and restart (2026-11-14)

Notifications stopped after 03:11:59 UTC with the status "Notification response timed out;
retrying". The cause was not the deploy of 02:01 UTC. BlueZ had lost its subscription on the two
ANCS characteristics (`Notifying: false`) after a reconnect it did not announce, and the
collector subscribes once per connection. The evidence and the code fix are in `docs/TODO.md`
("Notifications stop after a silent Bluetooth reconnect"). The fix is not written yet; the owner
chose to do it later.

On the owner's word the live container was restarted at 07:28:38 UTC with
`docker compose restart ws-scrcpy`: same image `f0382167242d`, no screen session running, not
near an unlock slot. After 45 s: healthy, 0 restarts, the collector running as uid 1000, status
"Receiving notifications", `Notifying: true` on both characteristics, the LE link kept, the
named unlock fields unchanged. Until the fix is deployed the same outage can return after the
next silent reconnect, and a restart brings notifications back.

### Step 7: owner feedback of 2026-11-14 and the notifications outage (2026-11-16, fixtures only)

The owner's list of 2026-11-14 (`docs/TODO.md` at f734c43) was split into six packages. Each was
written by one agent in its own worktree and branch, then read and corrected by a second agent.
The six reviewed branches were merged into `redesign` in the order collector, polish, notif-ui,
files-touch, show-touches, ios-colour, with no textual conflict; then the integrator checked
three seams between them and closed two. Only the collector changes code that runs on the server
(`python/notifications/collector.py`); every other package is client only.

Nothing of this step has run on a phone, and it is not deployed. Every check below ran on
fixtures.

#### collector: subscribe again after a silent Bluetooth reconnect

What exists. `Client.tick` reads `Notifying` of both ANCS characteristics (Notification Source
and Data Source) from each poll's object list. A characteristic counts as lost only when a poll
has shown it notifying for this client and two polls in a row then show it not notifying or
missing. The client then ends as on a disconnect (`Client.end`): its pending actions fail with
"Bluetooth notifications stopped before the iPhone confirmed the action", the status reads
"Reconnecting to iPhone notifications", its paths leave `owned_notifications`, and the next poll
makes a new client under a new session id, which calls `StartNotify` again. The disconnect
handler uses the same `end()`.

Why it is built this way. On 2026-11-14 BlueZ attached to the iPhone again without
`Connected: false`; the link stayed up, both characteristics read `Notifying: false`, and the
collector went on asking for replies BlueZ did not pass on (section "Notifications outage and
restart"). The client is replaced rather than repaired because the iPhone announces its alerts
once per subscription and numbers them anew, so the old session's UIDs are stale. The server
treats a `session` event the same with or without a disconnect
(`NotificationService.handleCollector`: invalidate the sources, a new session, remember the
replays); after a silent reconnect this happens about 2 s later than after a real one, whose
status text already contains "disconnected". The link, `reset`, the reset hold-off, the three
attempts, the advert refresh and pairing are unchanged.

What the review changed. The worker's version ended the client every third poll when
`StartNotify` succeeded but BlueZ never listed the characteristic as notifying: ten sessions in
thirty polls. Now a characteristic must first be seen notifying. One worker test passed at the
base as written and was made to prove the check; one test was added (47 Python notification
tests).

Left for later and risks. A stale BlueZ entry could answer `StartNotify` with InProgress, and the
client would retry every 5 s under "Waiting for Bluetooth notification permission" (a
`StopNotify` before `StartNotify` would cover it; not built). A subscription BlueZ never shows as
notifying is not detected, as at the base. The new client does not inherit the old one's 35 s
reset wait. The advert is registered again once in the poll after a client ends, as after a real
disconnect. This is the one server change of the step: its deploy rebuilds the image.

#### polish: five points of the inspection of 2026-11-14

What exists.
- Files and Shell: the header has one status line, the tool's connection. `ToolView.tsx` no
  longer passes the stream service line to `PhoneHeader`; on those tabs the service is normally
  stopped and the line made the header three lines high. Screen and the list cards keep it.
- Phones on a desktop: each card is as tall as its content (`DeviceList.css`: the grid has
  `align-items: start`, the actions lost `margin-top: auto`). A card without a line under its row
  no longer has a blank band above its buttons.
- The desktop rail: no caption wraps (`FloatingToolbar.css`), so every tile is one height.
  `ControlRail.tsx` measures the widest caption in a hidden copy of a tile and writes
  `--stream-rail-column` on the stage, only when the value changes, and removes it on unmount;
  `StreamView.css` builds the rail width from it (88 px until it is written). Listen's tile says
  "Waiting" for "Waiting for audio" (`listen.ts`, `tileCaption` and `LISTEN_CAPTIONS`), so the
  widest caption is a resting one ("Volume down"), the rail is about 97 px per column (88 px at
  the base) and keeps its width in every Listen state: a press on Listen does not move the
  picture. The accessible name stays "Listen"; the hover text is the state in full words. The
  touch panel uses the same tile and also says "Waiting".
- Shell below 600 px: the keys are a grid of six equal columns in the same order (Esc to Down
  arrow, then Right arrow to A+), each 44 px high, and the toast stands above both rows
  (`ToolView.css`). From 600 px one row as before.
- The Quality hint on a touch screen says only "A change restarts the stream."
  `SegmentedControl.tsx` exports `useTouchScreen()`; on touch a group with manual activation also
  leaves the keyboard sentence out of its description for assistive technology.

What the review changed. The worker sized the rail for "Waiting for audio" (about 118 px per
column); the review sized it for the resting captions and gave Listen short captions. The worker
let each Shell key grow to fill its row; the review made two rows of six equal columns. Outside
the package: one line in `StreamView.css` and one expectation in `e2e-ui-consistency.js`
(`railFit`: pressing Listen at the one-column boundary stays at one column).

Choices made for the owner: "Waiting" on the tile; the six-column grid.

Left for later and risks. Listen's hover text changes with its state. The rail is about 9 px
wider per column than at the base. With the keyboard open on a short phone screen the second row
of keys takes 48 px from the terminal. An iPad with a hardware keyboard and no mouse counts as a
touch screen and loses the arrow-key sentence. The rail builds two hidden copies per resize;
`useTouchScreen` is the fourth copy of the same media-query hook in the client.

#### notif-ui: the filter row of the inbox, and Switch in the bar

What exists.
- `.notification-history-tools` has `padding: var(--space-8) 0` (`NotificationsInbox.css`): 8 px
  between the bar and the filter row at rest and while the row is stuck, and 8 px over the first
  day label. Its background covers the cards under it, so the strips above and under the stuck
  row are covered too. From 600 px `.notification-page-header-inbox` keeps its 12 px and the
  sticky row has a margin of minus 8 px only where it directly follows the hidden heading, so the
  desktop stays 12 px at rest and a banner at the top of the inbox keeps the whole 12 px.
- With two or more iPhones linked the bar has the kit's compact button "Switch" (accessible name
  "Switch iPhone", `aria-haspopup="dialog"`, class `notification-switch`) before Search and
  Setup, as the header of a phone's page has. It opens the same sheet the chevron did.

What the review changed. The worker took 8 px off the block above the inbox from 600 px, which
moved a banner at the top of the inbox on a desktop from 12 px to 4 px under the bar. The review
kept the block at 12 px and added the negative margin; new check `desktopBannerSpacing`, and
`stickyBarsReachScrollTop` is back to the base expectation.

Seam closed by the integrator. "Switch" is 68 px wide where the chevron was 44 px, so at 440 px
with two iPhones the status line was cut in the states that matter most ("Phone A · Action
nee…", "Reconnect…"). The unread words after the status (" · 25 unread") now give way first:
`.notification-bar-status` wraps and is one line high with its overflow hidden
(`NotificationsPage.css`), so where both do not fit the unread words go to a second line that is
not shown, and the status stays whole. Where there is room both show, as before. The count stays
in the page (`.notification-unread-count`) and in the filter row. A name too long for the line
on its own is cut by the status's ellipsis and the unread words are not shown; at the base they
kept their place and the name was cut shorter. Check `unreadGivesWay` in
`e2e-notifications.js`, seen failing before the change.

Changed expectations: "the first card within 130 px" is 146 px in `allIphones` and
`sharedHeader`: on a phone the first card starts 16 px lower (8 px above the row and 8 px above
the day label).

Left for later and risks. The sticky row is 64 px high instead of 48, so 16 px less of the list
shows while scrolling. The desktop rule depends on the hidden heading coming right before the
sticky row (`NotificationHistory.tsx`, near line 807). A banner at the top of the inbox is flush
under the bar on a phone, as at the base. At 320 px with two iPhones the title and the status
are cut short.

#### files-touch: Files on a touch screen

What exists.
- A hold selects a row and no browser menu shows. On a touch screen (`COARSE_POINTER`) the name
  of a row is a link without an address: iOS shows its page preview and menu for a held link
  with an address, and no style turns that off. It keeps `role="link"`, its accessible name and
  its Tab stop, has `draggable="false"`, and Enter on it clicks it. With a mouse it keeps its
  address. `filelisting.css` gives the row and its contents `user-select: none`,
  `-webkit-user-select: none` and `-webkit-touch-callout: none` on touch.
- The click that may follow a hold is dropped in a window that starts when the finger lifts
  (`onPointerUp`), not at the 450 ms timer: Chromium sends a click when the finger lifts after a
  long hold, and at the base a hold longer than about 600 ms toggled the row back out. A new
  touch ends the window, so a quick tap after a hold adds its row.
- The rows are built again when the pointer type changes (a mouse attached); the open menu
  closes first and the list keeps its scroll position.
- The phone layout of Files applies under `(max-width: 700px), (hover: none) and (pointer:
  coarse) and (max-width: 1023px)`; the sidebar and the one-row desktop toolbar are under `not
  all and` the same condition, and the menu builders' comments name it. On a touch screen held
  sideways and at most 560 px high, history (or the selection bar), the address and the two tools
  share one line. From 1024 px on touch the desktop layout stays, with quick access rows 44 px
  high.
- Move in the selection bar has Lucide's folder-input shape (`icons.ts`), so it no longer looks
  like Forward in the history row.
- On a coarse pointer each crumb of the address reaches to the middle of the slash on each side,
  so "/" and short names are targets of at least 44 px without moving the text apart.

What the review changed. The one-line landscape bar applied to mouse windows up to 700x560 too;
now touch only. A quick tap within 600 ms after a hold was dropped; now a new touch ends the
window. On a change of pointer the rebuild scrolled the list to the top and left an open row
menu tied to a removed button. The crumbs were centred in 44 px, which moved "/" and the first
name about 27 px apart; now each reaches to the middle of the slash. New scenario "a change of
pointer" in `e2e-files-flows.js`.

Choices made for the owner: a touch screen from 701 to 1023 px wide (an iPad in portrait) gets
the phone layout and so loses the sidebar, the command row and the Size and Type columns; the
one-line bar sideways.

Left for later and risks. On that tablet width Ctrl+F targets the hidden filter field
(`FileListingClient.ts`, near line 1561). Quick access rows on a mouse in a short window still
shrink below 32 px. At exactly 700 px wide and at most 560 px high on a mouse both blocks apply,
as at the base. `test-style-rules.js` still lists 700 and 900 for `filelisting.css`. Whether iOS
sends a click after a hold is not known. The `files` suite takes about 155 s of its 240 s limit.

#### show-touches: a circle under each finger

What exists. `views/screen/TouchMarks.tsx` with `style/views/TouchMarks.css` is mounted in
`ScreenView.tsx` as a sibling just after the mount node, only while the switch is on; the stage
keeps its key and the mount node does not move. One circle for each finger and for the left
mouse button while it is held; it follows the pointer and fades over 220 ms when let go, at once
with reduced motion. Its place comes from `markPoint` (`input/touchMarks.ts`), which uses
`clientPointToVideo`, the input's own mapping: a drag that leaves the picture keeps its circle on
the edge, where the phone has the touch, and a press on the bands beside the picture draws
nothing. The layer has `pointer-events: none`, `aria-hidden`, passive listeners, and never
cancels an event. It listens for itself (touch and mousedown on the mount node; while the button
is held, capture listeners on the window; it lets go on blur, pagehide and a hidden page) instead
of taking positions from the handlers, because the iPhone handler sends its touches from code the
base class does not see. The second finger of a Ctrl+drag pinch comes from
`InteractionHandler.watchPinch`; a watcher that throws is caught. `TOUCH_RULES` says which
pointers each kind of phone takes (an iPhone: five fingers at most, no finger while the mouse
button is held and no mouse press while a finger is down; Android: the emulated down after the
window lost focus), and a unit test checks it against both real handlers; `DevicePage.tsx` passes
the kind of phone through `ScreenView.tsx` to the layer. The layer lies at z-index 3, over the
picture's touch layer (2) and under the controls' shield (4).

The switch "Show touches" is in Settings, Keyboard, a group "Touch" after the shortcuts, with the
hint "A circle where you touch the picture. This browser only." It is off by default, kept in
this browser (`ws-scrcpy.screen.show-touches` through `ui/storage.ts`, state in
`state/showTouches.ts`), applies at once, and is also in the Settings of the list's card. With it
off there is no layer and no listener. What reaches the phone is the same with it on and off.

Why it is built this way: drawn in the browser it is the same on both kinds of phone, shows at
once without waiting for the video, and is not in a screenshot. Android's own `show_touches`
would show on the phone itself and is Android only.

What the review changed. A pointer held still while the picture changed size kept its circle at
the old place; each circle now keeps its point of the picture and is placed again when the layer
resizes. The layer drew circles the phone never got (an iPhone's sixth finger, a finger while the
mouse button is held, a mouse press while a finger is down) and missed one it did get (Android's
emulated down after a lost window): hence `TOUCH_RULES`. More browser checks: layout changes with
a pointer held, 956x440, 320x956, 1024x700, Type text docked, the shield over a circle, Files with
a finger down, the wheel, a computer with touch and mouse, the list card.

Choices made for the owner: a 44 px circle; a 3 px ring in `--accent` with a 1 px `--on-accent`
edge inside and out and a 20% accent tint inside; circles cut off at the edge of the picture; a
220 ms fade; the hint as a group hint; on a mouse pinch the circles drawn over the phone's own
pinch preview.

Left for later and risks. On Android a mouse and a finger at once share pointer id 0 in the input
(an existing defect), so the layer shows two circles for one touch. After a stream disconnect, an
iPhone rotate from Actions or an iPhone decoder error, a circle stays until the finger lifts. The
iPhone wheel's swipe gets no circle. Another open tab picks up the switch only after a reload.

#### ios-colour: the colour of an iPhone's picture

What exists.
- `player/hevcColour.ts` reads the colour fields of the SPS inside the stream's `hvcC`
  (`video_full_range_flag`, and primaries, transfer and matrix where present). A header it cannot
  read gives "not known"; it never throws into the player.
- WebCodecs (`WebCodecsHevcPlayer.ts`): the decoder config carries `colorSpace`, with the range
  the stream declares (limited where it says nothing) and BT.709 for each colour value it leaves
  out. If the browser refuses the config with `colorSpace` (`configure()` throws or
  `isConfigSupported` says no), the player uses the plain config and asks for a key frame. The
  decoder is configured at once and does not wait for `isConfigSupported`.
- MSE (`hevcFmp4.ts`, `MseHevcPlayer.ts`): the init segment has a `colr` box of type `nclx` right
  after the `hvcC` in the sample entry.
- Settings, About and troubleshooting, iPhone only: a group "Picture" with the row "Picture
  colour range" (Auto, Full, Limited), after the phone's facts and before Services, kept in this
  browser (`ws-scrcpy.iphone.colour-range`, `state/pictureColour.ts`), default Auto; and a fact
  "Stream colour" after Decoder once the header has arrived (for the bench iPhone: "Full range,
  colour space not declared"). The words are in `copy.ts` (`PICTURE_COLOUR`).
- A change applies without a new session: the WebCodecs decoder is marked to be configured again
  at the next key frame and keeps decoding until then; MSE queues a new init segment before the
  next key frame; one key frame request (`pli`) is sent, and only while the session is connected
  (`isConnected()`). Choosing what is already applied does nothing.

Why it is built this way. The iPhone's SPS declares primaries, transfer and matrix as 2
("unspecified") and sets the full-range flag (the 2026-10-25 sample and the record of
2026-09-16 have the same parameter sets). A reading of Chromium's source: it drops the
full-range flag of an HEVC stream whose colour codes are unspecified, and shows full-range
pixels as limited range, which clips whites and crushes blacks: the owner's "too bright and too
contrasty". So Auto now tells the browser full range and BT.709. This is a reading, not proven on
a picture: headless Chromium cannot decode the stream. The row is there so the owner can compare
in their own browser.

What the review changed. The worker's player rebuilt the decoder at once and dropped frames
until a key frame; a second change within a second lost its key frame request (the proxy passes
one `pli` a second) and the picture froze until the phone sent a key frame by itself. Now the
decoder is rebuilt at the next key frame, and a refused colour space is handled the same way.
On a reconnect a change could send a `pli` over a new socket before the session was up; now only
while connected. The review checked the parser against ffmpeg `trace_headers` on 1,500 random
valid SPS, 20 libx265 encodes and the iPhone sample rewritten six ways; 186,000 calls on damaged
input never threw or read past the buffer; ffmpeg reads the `colr` box as
`nclx: pri 1 trc 1 matrix 1 full 1`.

Seam closed by the integrator: the atlas has the state `iphone-settings-picture`, the iPhone's
Settings with the Picture group in view (`// ios-colour` in `e2e-atlas.js`).

Choices made for the owner: the names "Picture", "Picture colour range" and "Stream colour"; a
three-way switch that applies at once; Auto on a header with no colour information uses limited
range and BT.709; one setting for every iPhone; a colour value WebCodecs has no name for becomes
BT.709 there while the `colr` box keeps the declared value.

Left for later and risks. Safari: Auto now tells every browser BT.709, transfer included, and
Apple draws BT.709-tagged video with a lighter curve, so dark areas may look a little lighter in
Safari than before; no browser check covers it. The MSE path has unit tests only; its new init
segment was not run in a browser. Another open tab picks up a change only after a reload.

#### Integration

Merges: `review/collector` 8bbed8e, `review/polish` 0afc82a, `review/notif-ui` 9e9bbd9,
`review/files-touch` 1bfcc8b, `review/show-touches` 7c74a89, `review/ios-colour` df1f737, each
`git merge --no-ff`, no conflict, the type check after each. Before the merges,
`git diff --stat f734c43 <branch> -- src/server src/common python config Dockerfile
docker-compose.yml` listed files only for collector (`collector.py` and `test_collector.py`).
`scripts/test-show-touches.js` and `scripts/test-hevc-colour.js` are in the `test` script; the
suites `show-touches` and `ios-colour` are in the default list before `atlas`.

Seams: the unread words in the Notifications bar (above, under notif-ui); the atlas state for
Picture (above, under ios-colour). Settings with both new groups was looked at on both fixtures,
from the screen and from the list card, at 440x956 touch and 1440x900 mouse, light and dark:
sections in the order Stream (Android only), Sound, Keyboard, Unlock, About and troubleshooting;
"Touch" the last group of Keyboard on both; "Picture" between Phone and Services on the iPhone
only; nothing overlapping, no row leaving its card, no sideways scroll; a change to Limited with
Show touches on configured the decoder once, sent one `pli`, kept the layer and opened no socket.
Nothing was added for it.

Checks, all on fixtures, at the merged head with the seams: `npm run check` passes (type check;
lint with 0 errors and 26 warnings; 842 node tests, which are the 819 of the base, 3 new in
`test-files.js`, 9 in `test-show-touches.js` and 11 in `test-hevc-colour.js`; the Python tests:
47 for notifications, 32 for the patches with 2 skipped, 4 for the probes; the production build).
`node scripts/test-browser.js` passes all 41 default suites in 34 min 43 s; `files` is still the
slowest and close to its 240 s limit.

Stream sockets, counted on fixtures of an Android phone and an iPhone at 440x956 touch and
1440x900 mouse: one socket for the open, and still one with the same mount node after Settings,
Actions, Type text and Switch were opened and closed, Show touches on and off, Listen pressed
(waiting) and pressed again, and on the iPhone the colour changes Limited, Full and Auto (two
`pli` requests: Auto matched what was applied). On the Android phone Files closes the stream and
the return to Screen opens the second socket: one per requested open. The suites that assert it: `show-touches`,
`ios-colour`, `controls`, `device-page`, `screen-states`, `desktop-layout`, `history-walk`.

Nothing a person could reach at the base is gone. The controls of the Files chrome, its menus,
the row menu and the selection bar are the same at 1440x900 with a mouse and at 440x956 on touch.
At 956x440 and 820x1180 on touch the desktop toolbar and the sidebar are replaced by the phone
layout: Upload, New folder, Paste, Refresh and Select are in Actions, the View choices under
"View options…", Download, Rename, Delete, Cut and Copy in the selection bar and its Actions menu
and in the row menu, Filter behind Search, and quick access behind its button. The Notifications
bar keeps Phones, Switch iPhone, Search and Setup and the same sheet; the Shell keys keep their
eleven keys in order; the rail and the touch panel keep their controls in order.

The atlas of f734c43 against this head differs only where a package meant it to: the rail of
every desktop screen state (polish; in `iphone-actions` the pointer left on the old place of the
Actions tile now rests on Refresh, so Refresh shows its hover colour), the cards of Phones on a
desktop (polish), the Quality hint in Android Settings on a phone (polish), the Shell keys on a
phone (polish), the Move icon in every Files and Shell state and the crumbs and rows of Files on a
phone (files-touch), the filter row of every inbox state and Switch in `notifications-all`
(notif-ui), the one-line box of the unread words (integrator), the Touch group in every Settings
state (show-touches) and the Picture group in the iPhone's (ios-colour), and generated ids of
Settings rows numbered later because those rows were opened earlier in the same page. Two states
are new: `android-show-touches` and `iphone-settings-picture`. One difference is not from this
step: in the desktop Notifications states a select of the hidden Setup panel has one option more
or less from run to run; two runs of the base build differ the same way.

#### Hardware checklist for step 7

Nothing here has been tried on a phone.

Chrome on the desktop:
- The iPhone's picture: Settings, About and troubleshooting, Picture colour range, on a screen
  with pure white and pure black areas. Auto and Full look like the phone and Limited looks as
  before: the reading is right and Auto is the fix. All three look the same: the browser ignores
  the colour space on this path; note the Decoder fact. Auto and Full look flat and Limited looks
  right: the phone's full-range flag is wrong. Auto differs from Full: a bug.
- A colour change while the screen is open: the picture changes at the next key frame, does not
  freeze, and the screen does not reconnect.
- Show touches with a mouse: a ring under the pointer while the button is held, following a
  drag; two rings for a Ctrl+drag pinch; none after release; none with the switch off.
- The rail: every caption on one line; Listen says "Waiting" while it waits, and the rail and the
  picture do not move when Listen is pressed; the hover text says the state in full words.
- Phones: each card as tall as its content. Files and Shell: one status line under the name.

The iPhone, in Safari and in the installed app, upright and sideways:
- Files: hold a file name for about 1 s: it is selected, the selection bar shows, and no page
  preview, menu or text selection appears. Hold a folder: selected, not opened. Hold, then drag:
  nothing lifts off and the row stays selected. Start a scroll on a row: the list scrolls and
  nothing is selected. Right after a hold, tap another row quickly: it is added. Tap a file: the
  sheet (Download, Rename, Delete, Cancel); tap a folder: it opens. Sideways: history, the
  address, Search and Actions on one line, and a deep path readable. Tap "/" and a short crumb
  near their edges: each opens its folder. Move in the selection bar is a folder with an arrow.
- Show touches (Settings, Keyboard, Touch): drag a list and note how far the picture runs behind
  the ring; pinch (two rings); swipe in from the band beside the picture (no ring on the band);
  lift (the ring fades); hold and turn the phone (the ring stays on its spot); whether the ring
  hides small text; switch it off (no rings).
- Shell upright: the keys in two rows of six, all in sight, each sends what it did.
- Notifications with two iPhones: the bar reads the status whole in every state, with the unread
  words where there is room; Switch opens the list of iPhones; 8 px between the bar and the
  filter row, at rest and while scrolling.
- Settings of an Android phone: under Quality only "A change restarts the stream."
- The iPhone's picture in Safari: compare Auto and Limited as above; note whether dark areas look
  lighter than before.

After a deploy on the live server (notifications). The deploy rebuilds the image, because
`collector.py` runs in the container. After a silent Bluetooth reconnect the status reads
"Reconnecting to iPhone notifications" and then "Receiving notifications" within about 10 s,
with no restart; both characteristics read `Notifying: true`; alerts the iPhone announces again
are not pushed twice. Until then, a restart of the container brings notifications back.

### Step 7 deployment (2026-11-16)

Head `d9b0f3d` plus this section. One server file changed:
`git diff --stat f29246b d9b0f3d -- src/server src/common src/public python config Dockerfile docker-compose.yml`
lists only `python/notifications/collector.py` and `python/notifications/test_collector.py`.

Before (16:40 UTC): image `f0382167242d`, started 2026-11-14T07:28:38Z, healthy, 0 restarts.
Named unlock fields: enabled, time 03:00, lastRun unlocked ("Locked again") at
2026-11-16T15:00:00Z, lastTypedUnlockAt and lastUnlockedAt 15:00:10Z, lastSlotAt 15:00Z, a
passcode stored. No screen session ran in the live container, and none was seen in a check every
20 s from 16:42:46 to 16:48:46.

Phone health (host venv, one-shot commands, 16:40 UTC): iOS 27.2.1 (24B156) as at the last run,
the developer image mounted at /System/Developer, `list-processes` answered, `sessions: []`.

Test server (port 8010, built with `{"INCLUDE_GOOG": false}`, data in `data/test`,
`WS_SCRCPY_DEBUG=1`): 200 locally, 403 for `evil.example`, no serve-web at start. One iPhone
screen session at 1280x800 in headless Chromium:

- Opened from the card at 16:48:51. serve-web (PID 28046) started the same second, the only one.
  Bytes on the one `proxy-coredevice` socket: 1.1 MB after 5 s, 74.5 MB at the end. The header
  said "No picture" and the stage "This browser cannot show the stream" (no HEVC decoder); the
  banner "Phone locked" with Unlock, which was not pressed.
- Rail: Home, Siri, Lock, Volume down, Mute phone, Volume up, Listen, Take screenshot, Type text,
  Actions, Settings. Each caption on one line, every tile 56 px high.
- Settings from the rail: Sound, Keyboard, Unlock, About and troubleshooting. Keyboard has the
  groups "Keyboard shortcuts" and "Touch"; Show touches was off. On: one `.touch-marks`, still one
  stream socket, the same mount node. Off: no `.touch-marks`. The picture was not pressed.
- About and troubleshooting: groups Phone, Picture, Services. "Stream colour" read "Full range,
  colour space not declared"; "Decoder" read "Unknown" (no HEVC decoder in headless Chromium).
  "Picture colour range" was Auto. Limited, 5 s, Auto, 5 s: still one socket, bytes kept
  arriving (2.9 MB, 6.0 MB, 8.9 MB), no new serve-web, no page error. The server log has no line
  for those 10 s: the server does not log a key frame request and serve-web does not log `/pli`,
  so whether one was sent is not seen.
- Actions (Clipboard, Screen, Lock, Power) and Switch phone opened and closed.
- Two idle minutes: one socket, 10.2 MB to 74.5 MB.
- Left by the header at 16:51:12. The card showed "In use" until 16:51:27 (15 s), then not.
  serve-web logged `shutdown complete` at 16:51:27; no SIGKILL. Back once, then 20 s: no phone
  screen, no new socket. No page or console error. One serve-web start in the log.

`sessions: []` at 16:52:04 and 16:52:35. The test server was stopped with SIGTERM by PID at
16:52:36 and exited in about 2 s; `build.config.override.json` restored to `{}`, the normal dist
rebuilt, nothing listening on 8010.

Deploy: `docker tag ws-scrcpy:latest ws-scrcpy:before-step7-20261116` (image `f0382167242d`),
`docker compose build ws-scrcpy` (new image `6c090b25102d`), `docker compose up -d ws-scrcpy` at
16:54:15 UTC with no screen session in the container, not near an unlock slot.

After: container started 16:54:18, healthy, 0 restarts, `node index.js` as uid 1000, no error
line in the log; 200 on 127.0.0.1:8000, on 10.10.10.5:8000 and for Host
`mini-nuc.tailea1801.ts.net`, 403 for `evil.example`; no serve-web; the named unlock fields the
same as before, straight after and at 17:00:33.

Notifications (read only, 99 s after the restart): "Receiving notifications", Bluetooth
connected, no error, no collector error, 0 collector restarts. The image's `collector.py` has the
new code (`self.notified` on 3 lines). BlueZ shows `Notifying: true` on Notification Source and
Data Source; `hcitool con` shows the LE link. The new code has not met a silent reconnect yet.

Look-only pass on the live server (Android, fresh browser contexts, nothing typed or saved, no
press on the picture):
- Mouse, 1280x800: both phones listed; each card as tall as its content (164 and 171 px). Settings
  from the POCO card: Stream, Sound, Keyboard, Unlock, About and troubleshooting; "Touch" in
  Keyboard; no "Picture" group. Screen: Connected, tabs Screen, Files, Shell; the stage "Screen is
  asleep" with Wake (not pressed); the rail in the Android order, each caption on one line, every
  tile 56 px. Files: one status line ("Connected"), the listing loaded, "Item check boxes" in the
  View menu. Shell connected. Screen after Files and Shell opened one new stream socket.
  Notifications: "iPhone · Connected · 99+ unread", no badge in the bar, cards listed; the filter
  row 8 px under the bar while stuck. At rest it is 58 px under the bar, because the test
  browser's own banner "Could not check notifications on this device" (service workers blocked
  in the test context) is above it. Back to the list, then Back once: no stream socket.
- Touch, 440x956: Files opens at /data/local/tmp, which holds only a folder, so the first touch
  pass found no file (it opened the folder `dalvik-cache`, which has none either) and its hold and
  tap steps timed out. A second pass opened Downloads from Quick access. Names have no `href` and
  cannot be dragged. A 700 ms hold on a file selected it and showed the selection bar, with no
  sheet, menu or download; Close selection cleared it. A tap on the file opened the sheet with
  Download, Rename, Delete and Cancel; Cancel closed it. Shell: 11 keys in two rows, 44 px high,
  no sideways scroll. Nothing was downloaded, renamed or deleted.
- The log shows "No viewers left. Stopping the stream service" at 16:56:51 and 17:01:27, about
  30 s after the last viewer each time. No page or console error.

Not checked: the iPhone's picture and its colour (headless Chromium cannot decode it; see the
hardware checklist above), whether a colour change sends a key frame request to the phone, Show
touches with a real pointer, the collector after a real silent Bluetooth reconnect, the iPhone's
screen on the live server, Files and Shell on a real touch screen.

Rollback, for a break only: `docker tag ws-scrcpy:before-step7-20261116 ws-scrcpy:latest` and
`docker compose up -d ws-scrcpy`. Reload each browser tab and reopen the installed app once.

### Step 8: a theme option, Android's touch dot and the Files address highlight (2026-11-16, fixtures only)

Three requests of the owner on 2026-11-16: an option for the dark theme, a Show touches mark
"more like Android's", and a hover highlight in the Files address that was taller than the field.
One package (`appearance`), written by one agent on `work/appearance` and read and corrected by a
second on `review/appearance`, merged into `redesign` with no conflict. Client only: no file
under `src/server`, `src/common`, `python` or `config` changed. `src/public` gained `theme.js`
and `index.html` loads it; `webpack/ws-scrcpy.common.ts` copies it in both client builds.

Nothing of this step has run on a phone. Every check below ran on fixtures.

#### The theme option

What exists. A "Theme" icon button (Lucide `sun-moon`, icon `theme`) in the bar of the Phones
page, after the Notifications link and before Reload. It opens the kit's menu with System, Light
and Dark as radio items; the menu stays open after a choice, as the kit does for checked items.
The choice is kept in this browser under `ws-scrcpy.theme` (`light` or `dark`; no value is
System) by `src/app/state/theme.ts`. `applyTheme` writes `data-theme` on the root for Light and
Dark and removes it for System, and sets the `color-scheme` meta and both `theme-color` metas
(#f5f6f8 light, #17191d dark). `src/style/tokens.css` has the dark values twice with the same
content: under `@media (prefers-color-scheme: dark)` for `:root:not([data-theme='light'])`, and
for `:root[data-theme='dark']`. `src/public/theme.js` does what `applyTheme` does before the
styles load: `index.html` names it in the head, after the colour metas and before the style
sheet, with the build hash on its address. Another tab, or the installed app, takes a change at
once through the `storage` event.

Why it is built this way. System stays the default so that nothing changes for a browser that
never opens the menu: an atlas of the base against the branch differs only in the Phones bar,
the desktop Files address, the touch dot and the new state `list-theme-menu`. The early script
is a file, not inline, so it survives a stricter security policy (today's policy in
`requestOrigin.ts` sets only `frame-ancestors` and `connect-src`). `sw.js` has no fetch handler
and no cache and `index.html` is served `no-store`, so no cache list needed the file. If the
file does not run, the bundle applies the choice when it loads; the first frame is then in the
system's theme. A theme change is a style change only: the signal is read by the Theme button
alone, and the `theme` suite holds one stream socket and the same mount node through a system
change and a choice made in another tab. The button is on the Phones page because the choice is
for the whole app, not for one phone.

What the review changed. The worker wrote the radio items as kit markup by hand in
`DeviceList.tsx` and loosened a guard in `scripts/test-home.js` for it. The kit's `MenuItem` now
has a `radio` form (`role="menuitemradio"`), the Theme items use it, and the guard is as it was.

Tests. `scripts/test-theme.js` (8 tests): the default, the kept and read-back choice, blocked
storage, another tab; both dark blocks hold the same tokens and values (the reviewer changed one
value, and added one token to one block, in a scratch copy: it failed both times); `theme.js`
gives the same page as `applyTheme` for every stored value; the two colours agree in all four
places; the script comes before the styles. Suite `theme` (`scripts/e2e-theme.js`, 440x956 touch
and 1440x900 mouse): the menu; Dark under a light system gives the same computed styles as
System under a dark one on Phones, a Settings sheet, Files and the inbox, and Light the same way
round; the first frame after a reload is in the chosen theme with the bundle held back 600 ms,
and in the system's theme when `theme.js` is blocked; System follows the system at once and a
choice does not; the `theme-color` in effect; no new socket and the same mount node on a phone's
screen; blocked storage. `e2e-home.js` holds the bar's order, its 44 px targets and one row at
320 px. Atlas state `list-theme-menu`.

Left for later and risks. `src/public/manifest.json` has one fixed dark `theme_color` and
`background_color`, so the installed app's splash is dark before the page loads, whatever the
choice. `eslint.config.mjs` has rules for `sw.js` only under `src/public`, so `theme.js` is
linted against none. The Shell terminal keeps xterm's default colours in both themes and the two
canvases their fixed colours, as before. The bar's title is 44 px narrower: at 320 px the summary
is cut sooner. A tab restored from the back-forward cache may miss a change made in another tab
until it reloads (not tested). Checked in Chromium only.

#### Show touches: Android's dot

What exists. The mark of `TouchMarks.css` is a 32 px dot (`--control-height-compact`) filled
with `--touch-mark-fill` (white at 60 %) with a 1 px edge of `--touch-mark-edge` (black at 30 %)
drawn outside the fill. The two tokens are in `tokens.css` with one value for both themes,
because the dot lies over the phone's picture and not over the app. It fades in `--motion-fast`
(160 ms; `MOTION.quick` in `TouchMarks.tsx`), and goes at once with reduced motion. Where and
when a dot shows (`TOUCH_RULES`, `markPoint`, the pinch pair, the switch in Settings, Keyboard,
Touch) is as step 7 left it.

Why. Android's "Show taps" draws a small translucent white disc. The fill shows on a dark
picture and the edge on a white one: in the suite's pictures it is a grey disc over black and a
thin grey ring over white. The 44 px ring in the accent of step 7 hid more of the picture and
looked like a control.

Tests. `test-show-touches.js` has "the dot is Android's". `e2e-show-touches.js` has `looks()`
(size, fill, edge, no ring, centre within 1 px) in every run, and `fades()` holds the 160 ms.

#### Files: the address highlight stays inside the field

What was wrong. `.fx-crumb:hover` set `background` as a shorthand, which reset
`background-clip`, so the fill took the full 32 px of the field and covered its border. A press
shrank the crumb. The focus ring sat on the field's edge, and the edit button's ring 4 px
outside it.

What exists. Under a mouse (`(pointer: fine), (pointer: none)`) each crumb and the edit button
is a fill box 4 px inside the field (`--space-4` above and below), with `--radius-sm` on a crumb;
hover, focus and press have that one shape and nothing moves. An `::after` keeps the press area
at the field's full height. The edit button is a 24x24 square 4 px from the field's top, bottom
and end, with the old 32x32 press area. The path and the icon are where they were in step 7.
The fade at the start of a long path lies in the field's own 4 px padding, so a path that fits,
the root included, is drawn whole. The touch rules of step 7 are untouched: positions and
targets measured the same at 440 px touch and at 1280 px with touch emulation.

What the review changed. The worker's version moved the resting layout on a desktop (the path
4 px to the right, the edit icon 7 px to the left). That was not needed for the fix; the base
positions are back and `e2e-files-kit.js` holds them ("9px and 6px").

Tests. `addressHighlight` in `e2e-files-kit.js` (1440x900 mouse, light and dark): on the base
build it lists 33 faults, for the hovered, pressed and focused root, middle crumb, current
folder and edit button. Its slash and press-area checks pass at the base too; they guard what
already held.

Left for later and risks. The root "/" is drawn in the text colour at rest on a desktop; at the
base the fade dimmed it. The start fade of a long path under a mouse is 4 px, not 16 px. Under a
mouse a press on a slash opens the path editor, as at the base (the field carries
`data-command="edit-path"`, `FileListingClient.ts`). Touch keeps the 16 px fade over the root
crumb. A mouse-first laptop with a touch screen gets the mouse rules with 32 px press areas; no
test can fake that pointer pair.

#### Integration

Merged `review/appearance` (f7af3d0) with `--no-ff` (6d9f222). `scripts/test-theme.js` is in the
`test` script and the suite `theme` is in the default list before `atlas` (0d2637b). On 0d2637b:
`npm run check` passes (type check clean; lint 0 errors, 26 warnings as before; 851 node tests;
Python 47, 32 with 2 skipped, and 4; the build with the same 3 size warnings).
`node scripts/test-browser.js` passes: all 42 default suites (the 41 of step 7 and `theme`), 490
PASS lines, no failure. The reviewer saw each new or changed test fail on a build of the base,
except the atlas block, which was not run there. The two worktrees and their branches are
removed.

#### Hardware checklist for step 8

- Theme, desktop Chrome: choose Dark with a light system and Light with a dark one; reload; no
  flash of the other theme.
- Theme, the installed app on the iPhone: the status bar colour for each choice; the first paint
  after a cold start. An installed app on an iPhone is expected to keep its own storage, so its
  choice is made in the app itself and not in Safari; check.
- Show touches: the dot under a finger on a light and on a dark screen, on the iPhone and the
  POCO; a pinch shows two.
- Files on a desktop: hover, Tab focus and press on a crumb and on the edit button; a long path.

### Step 8 deployment (2026-11-16)

Head `85bcb6c` plus this section. Client only:
`git diff --stat 090eb83 85bcb6c -- src/server src/common src/public python config Dockerfile docker-compose.yml webpack`
lists only `src/public/index.html`, `src/public/theme.js` and `webpack/ws-scrcpy.common.ts`.

Before (20:21 UTC): image `6c090b25102d`, started 2026-11-16T16:54:18Z, healthy, 0 restarts.
Named unlock fields: enabled, time 03:00, lastRun unlocked at 2026-11-16T17:09:22Z (a manual
unlock: "manual unlocked in 9493 ms" in the log), lastTypedUnlockAt and lastUnlockedAt
17:09:31Z, lastSlotAt 15:00Z, a passcode stored. No screen session ran in the live container,
and none was seen in a check every 20 s from 20:24:40 to 20:30:41.

Phone health (host venv, one-shot commands, 20:21 to 20:22 UTC): iOS 27.2.1 (24B156) as at the
last run, the developer image mounted at /System/Developer, `list-processes` answered,
`sessions: []`.

Test server (port 8010, built with `{"INCLUDE_GOOG": false}`, data in `data/test`,
`WS_SCRCPY_DEBUG=1`): the server bundle had none of `WebsocketProxyOverAdb`, `RemoteShell`,
`FileListing`; `dist/public/index.html` names `theme.js?<hash>` before `main.css`. 200 on `/` and
on `/theme.js` (`application/javascript`), 403 for `evil.example`, no serve-web at start. One
iPhone screen session at 1280x800 in headless Chromium, system colour scheme light:

- The list: the bar holds Notifications, Theme and Reload in that order. Theme opened with
  System, Light and Dark as radio items, System checked. Dark: the root got `data-theme="dark"`,
  the page background `rgb(23, 25, 29)` (#17191d), `dark` stored; no socket to a phone opened.
  Escape closed the menu.
- Opened from the card at 20:30:58. serve-web (PID 25408) started at 20:31:00, the only one.
  Bytes on the one `proxy-coredevice` socket: 1.1 MB at 20:31:03, 78.2 MB at the end. The header
  said "No picture" and the stage "This browser cannot show the stream" (no HEVC decoder); the
  banner "Phone locked" with Unlock, which was not pressed.
- Rail: Home, Siri, Lock, Volume down, Mute phone, Volume up, Listen, Take screenshot, Type text,
  Actions, Settings. Each caption on one line, every tile 56 px high.
- Theme with the stream open (20:31:04 to 20:31:19): the system scheme to dark and back to light
  (Dark stayed), `light` written from a second page of the context (the page turned light), the
  key removed from that page (no `data-theme`). After each: one stream socket, bytes kept
  arriving, the same mount node, no new serve-web.
- Settings from the rail: Sound, Keyboard, Unlock, About and troubleshooting. Keyboard has the
  groups "Keyboard shortcuts" and "Touch"; Show touches was off. On: one `.touch-marks`, one
  stream socket, the same mount node. Off: no `.touch-marks`. The picture was not pressed.
- Actions (Clipboard, Screen, Lock, Power) opened and closed.
- Two idle minutes: one socket, 12.3 MB to 78.2 MB.
- Left by the header at 20:33:23. The card showed "In use" until 20:33:38 (15 s), then not.
  serve-web logged `shutdown complete` at 20:33:38; no SIGKILL. Back once, then 20 s: no phone
  screen, no new socket. No page or console error. One serve-web start in the log.

`sessions: []` at 20:34:16 and 20:34:47. The test server was stopped with SIGTERM by PID at
20:34:48 and exited in about 2 s; `build.config.override.json` restored to `{}`, the normal dist
rebuilt, nothing listening on 8010.

Deploy: `docker tag ws-scrcpy:latest ws-scrcpy:before-step8-20261116` (image `6c090b25102d`),
`docker compose build ws-scrcpy` (new image `0bb876fcfa1f`; `package.json` changed, so `npm ci`
and the image's venv ran again: pymobiledevice3 11.44.0 as pinned, the four venv patches
applied), `docker compose up -d ws-scrcpy` at 20:36:26 UTC with no screen session in the
container, not near an unlock slot.

After: container started 20:36:26, healthy, 0 restarts, `node index.js` as uid 1000, no error
line in the log; 200 on 127.0.0.1:8000, on 10.10.10.5:8000 and for Host
`mini-nuc.tailea1801.ts.net`, 403 for `evil.example`; `/theme.js` 200 and named before
`main.css`; no serve-web; the named unlock fields the same as before, straight after and at
20:42:26, when the container was still healthy with 0 restarts and no serve-web.

Notifications (read only, 90 s after the restart): "Receiving notifications", Bluetooth
connected, no error, no collector error, 0 collector restarts. BlueZ shows `Notifying: true` on
Notification Source and Data Source.

Look-only pass on the live server (Android, fresh browser contexts, nothing typed or saved on
the server, no press on the picture; the theme and Show touches are kept in the test browser):
- Mouse, 1280x800, system light: both phones listed; the bar holds Notifications, Theme and
  Reload in one row, each 44x44. Theme: System checked; Dark made the list dark
  (`data-theme="dark"`, #17191d); after a reload the root and the body were already dark at
  `domcontentloaded` and in the first frame; Light under an emulated dark system gave the light
  list (#f5f6f8); System then followed the dark system with no attribute, and the light system
  after it.
- With Dark chosen, the POCO's screen: Connected, tabs Screen, Files, Shell, one stream socket;
  the stage "Screen is asleep" with Wake (not pressed); the rail in the Android order. The
  system scheme to dark, then `light` written from a second page: the page turned light, still
  one stream socket and the same mount node. The screen page's own background is
  `rgb(236, 238, 242)` in light and `rgb(42, 46, 54)` in dark, on the test server as well.
- Settings from the rail: Stream, Sound, Keyboard, Unlock, About and troubleshooting; "Touch"
  with Show touches in Keyboard. On: one `.touch-marks`, the same mount node, one socket. Off.
- Files under a mouse at /data/local/tmp, light and then dark: the field is 1054x32. Hovered,
  the root, "local", "tmp" and the edit button each fill a box 24 px high, 4 px below the
  field's top and 4 px above its bottom (root 15.8 px wide, "local" 47.1, "tmp" 31.5, the edit
  button 24x24 4 px from the field's end). No name or icon moved between rest and hover. The
  fill is `rgb(236, 238, 242)` in light and `rgb(42, 46, 54)` in dark. Nothing was pressed; the
  path editor stayed closed.
- Shell connected; nothing typed. Screen again: one new stream socket.
- Notifications in dark: "iPhone · Connected · 99+ unread", 20 cards. The red banner "Could not
  check notifications on this device" is the test browser's own (service workers blocked).
- Back to the list, then Back once: no stream socket. No page or console error.
- Touch, 440x956, light: the bar is one row, Notifications, Theme and Reload each 44x44 inside
  it, no sideways scroll. Theme opened (System checked) and closed; no stream socket. Files at
  /data/local/tmp: the field is 424x44; the crumbs are 44 px high, "/" 44 px wide, and each
  reaches to the middle of the slash beside it ("data" ends at 105.6 and "local" starts at
  105.7, the first slash's middle 105.6; "local" ends and "tmp" starts at 167.8, the second
  slash's middle). In Downloads a tap on a file opened the sheet with Download, Rename, Delete
  and Cancel; Cancel closed it. Nothing was downloaded, renamed or deleted.
- The log shows "No viewers left. Stopping the stream service" at 20:39:31, 30 s after the last
  stream socket closed. No page or console error.

Seen on the way: the hint under Show touches still reads "A circle where you touch the
picture" while the mark is now a dot (`src/app/views/settings/KeyboardSection.tsx`). The live
log has a `DEP0180` warning (`fs.Stats constructor is deprecated`) when Files opened; it is a
warning, not an error.

Not checked: the iPhone's picture (headless Chromium cannot decode it), the theme on a real
phone and in the installed app (status bar colour, the first paint after a cold start), Show
touches under a real finger or pointer, Tab focus and press in the Files address on the live
server (hover only), Safari and Firefox, the iPhone's screen on the live server.

Rollback, for a break only: `docker tag ws-scrcpy:before-step8-20261116 ws-scrcpy:latest` and
`docker compose up -d ws-scrcpy`. Reload each browser tab and reopen the installed app once.

After the deployment (2026-11-16, not live): the hint under Show touches now reads "A dot where
you touch the picture. This browser only." (`KeyboardSection.tsx`, and the same sentence in
`scripts/e2e-show-touches.js`). `npm run check` and the suites `show-touches` and `settings`
pass. The live image 0bb876fcfa1f was built from 85bcb6c and still says "A circle"; the change
goes live with the next deploy.

### Step 9: the browser suites side by side, and the Theme menu closes (2026-11-16, fixtures only)

Two requests of the owner on 2026-11-16: "35 min for verify/testing is too much", and the Theme
menu "should go away once clicked". Done in the main checkout, without worker and reviewer
agents: the first is the test runner alone, the second is four lines of the kit.

#### The browser suites run side by side

What exists. `scripts/test-browser.js` starts up to sixteen suites at once, one for each
processor by default; `--jobs=N` or `TEST_BROWSER_JOBS=N` sets how many, and `--jobs=1` runs
them one after another with their output as it comes. Beside others, a suite's output is
printed in one piece when it ends, after the line "Running <suite> browser checks" and before
"<suite> passed in 12.3 s" or "<suite> FAILED (1) after 12.3 s". Every suite runs even when one
fails; the last lines give the count, the five slowest and "Failed: a, b", and the exit code is
1. The time each suite took is kept in the system's temporary folder
(`ws-scrcpy-browser-times.json`) and the longest starts first next time. SIGINT or SIGTERM to
the runner stops its suites, each closing its own browser. The 240 s limit of one suite is as
it was.

Why it is safe. Each suite was already its own process with its own browser and its own mocked
phones (`page.route` and fixture sockets inside the page), against one static server on a free
port; no suite binds a fixed port or shares a folder. The suites wait more than they compute:
with sixteen at once the load average of this 16-processor machine stayed between 6 and 9, and
no suite took longer than it does alone (`files` 157 s both ways).

What was measured. All 42 default suites, one after another: 35 min. Eight at once: 5 min 32 s.
Sixteen at once: 2 min 46 s, which is the kit build and the slowest suite. Five full runs
with sixteen at once passed, each with 42 suites and no failure.
`npm run check` takes 1 min 28 s. A missing suite and a failing assertion each ended the run
with exit code 1 and their names, while the other suite still ran. SIGTERM to the runner in the
middle of three suites left no suite and no browser behind.

Left for later and risks. The run is now as long as `files` (157 s), then `notifications`
(138 s), `atlas` (117 s), `about-ui` (112 s) and `home` (111 s). `files` runs five window sizes
one after another in one browser; run side by side they would take about 35 s, and the whole
run about 2 min 20 s. Two agents that test at the same time would start 32 browsers: give each
`TEST_BROWSER_JOBS` so the total stays near the number of processors. The brief
(`CODEX-HANDOFF.md`) says so now. The node tests still bind fixed ports and still must not run
twice at once.

#### The Theme menu closes after a choice

What exists. In the kit's `Menu`, a press on a `menuitemradio` item closes the menu, as a press
on a plain item does, and the focus returns to the menu's button. An item that is on or off
(`menuitemcheckbox`) still leaves the menu open. Theme is the only menu with radio items made of
`MenuItem`; the Files View menu builds its own markup and is unchanged.

Why. A radio item is one choice of a set: once it is made there is nothing more to do in the
menu, and the owner found the open menu in the way. The checked item shows when the menu opens
again.

Tests. `e2e-theme.js`: after each of Dark, Light and System the menu is hidden, Theme is not
expanded and has the focus, and the item is checked when the menu opens again. On the build
before the change it fails with "the menu closes after Dark".

Also in this step: the hint under Show touches reads "A dot where you touch the picture. This
browser only." (7047f3b, recorded above).

Checks on the head: `npm run check` passes (type check clean; lint 0 errors, 26 warnings; 851
node tests; Python 47, 32 with 2 skipped, and 4; the build) and all 42 browser suites pass.

### Step 9 deployment (2026-11-16)

Head `0012046` plus this section. Client only:
`git diff --stat 85bcb6c 0012046 -- src/server src/common src/public python config Dockerfile docker-compose.yml webpack`
lists nothing, and `git diff --stat 85bcb6c 0012046 -- src` lists only `src/app/ui/Menu.tsx` and
`src/app/views/settings/KeyboardSection.tsx`. The suites were not run again (they pass at the
head, above).

Before (22:14 UTC): image `0bb876fcfa1f`, started 2026-11-16T20:36:26Z, healthy, 0 restarts.
Named unlock fields: enabled, time 03:00, lastRun unlocked at 2026-11-16T20:50:30Z (a manual
unlock: "manual unlocked in 9650 ms" in the log), lastTypedUnlockAt and lastUnlockedAt
20:50:39Z, lastSlotAt 15:00Z, a passcode stored. The live server logs nothing when a screen
session starts, so a check ran every 20 s from 22:14:45 to 22:20:46: no serve-web in the
container or on the host.

Phone health (host venv, one-shot commands, 22:14:52 to 22:14:54 UTC): iOS 27.2.1 (24B156) as at
the last run, the developer image mounted at /System/Developer, `list-processes` answered,
`sessions: []`.

Test server (port 8010, built with `{"INCLUDE_GOOG": false}`, data in `data/test`,
`WS_SCRCPY_DEBUG=1`): the server bundle had none of `WebsocketProxyOverAdb`, `RemoteShell`,
`FileListing`; `dist/public/index.html` names `theme.js?<hash>` before `main.css`; the client
bundle holds the new hint. 200 on `/` and on `/theme.js` (`application/javascript`), 403 for
`evil.example`, no serve-web at start. One iPhone screen session at 1280x800 in headless
Chromium, system colour scheme light:

- The list: the bar holds Notifications, Theme and Reload in that order. Theme opened with
  System, Light and Dark as radio items, System checked. A press on Dark closed the menu by
  itself; the focus was on Theme and its `aria-expanded` was "false"; the root got
  `data-theme="dark"`, the page background `rgb(23, 25, 29)`, `dark` stored; no socket to a
  phone opened. Opened again: Dark checked. Escape closed it.
- Opened from the card at 22:20:58. serve-web (PID 17560) started at 22:21:00, the only one.
  Bytes on the one `proxy-coredevice` socket: 1.07 MB at 22:21:03, 73.1 MB at the end. The
  header said "No picture" and the stage "This browser cannot show the stream" (no HEVC
  decoder); the banner "Phone locked" with Unlock, which was not pressed.
- Rail: Home, Siri, Lock, Volume down, Mute phone, Volume up, Listen, Take screenshot, Type text,
  Actions, Settings. Each caption on one line, every tile 56 px high.
- Theme with the stream open (22:21:03 to 22:21:18): the system scheme to dark and back to light
  (Dark stayed), `light` written from a second page of the context (the page turned light), the
  key removed from that page (no `data-theme`). After each: one stream socket, bytes kept
  arriving, the same mount node, no new serve-web.
- Settings from the rail: Sound, Keyboard, Unlock, About and troubleshooting. Keyboard has the
  groups "Keyboard shortcuts" and "Touch"; the hint under Show touches reads "A dot where you
  touch the picture. This browser only."; Show touches was off. On: one `.touch-marks`, one
  stream socket, the same mount node. Off: no `.touch-marks`. The picture was not pressed.
- Actions (Clipboard, Screen, Lock, Power) opened and closed.
- Two idle minutes: one socket, 12.9 MB to 73.1 MB.
- Left by the header at 22:23:23. The card showed "In use" until 22:23:38 (15 s), then not.
  serve-web logged `shutdown complete` at 22:23:38; no SIGKILL. Back once, then 20 s: no phone
  screen, no new socket. No page or console error. One serve-web start in the log.

`sessions: []` at 22:24:15 and 22:24:46. The test server was stopped with SIGTERM by PID at
22:24:47 and exited in about 2 s; `build.config.override.json` restored to `{}`, the normal dist
rebuilt, nothing listening on 8010.

Deploy: `docker tag ws-scrcpy:latest ws-scrcpy:before-step9-20261116` (image `0bb876fcfa1f`),
`docker compose build ws-scrcpy` (new image `ff5664611a2f`, under a minute: `package.json` did
not change), `docker compose up -d ws-scrcpy` at 22:26:09 UTC with no screen session in the
container, 274 minutes from the nearest unlock slot.

After: container started 22:26:09, healthy, 0 restarts, `node index.js` as uid 1000, no error
line in the log; 200 on 127.0.0.1:8000, on 10.10.10.5:8000 and for Host
`mini-nuc.tailea1801.ts.net`, 403 for `evil.example`; `/theme.js` 200 and named before
`main.css`; no serve-web; the named unlock fields the same as before, at 22:27:39 and at
22:32:09, when the container was still healthy with 0 restarts and no serve-web.

Notifications (read only, 90 s after the restart): "Receiving notifications", Bluetooth
connected, no error, no collector error, 0 collector restarts. BlueZ shows `Notifying: true` on
Notification Source and Data Source.

Look-only pass on the live server (Android, 22:27:51 to 22:28:46, fresh browser contexts,
nothing typed or saved on the server, no press on the picture; the theme and Show touches are
kept in the test browser):
- Mouse, 1280x800, system light: both phones listed; the bar holds Notifications, Theme and
  Reload in one row, each 44x44. Theme: System checked. Dark: the menu closed by itself with the
  focus on Theme and `aria-expanded` "false"; the list dark (`data-theme="dark"`, #17191d).
  Opened again: Dark checked; Escape closed it. After a reload the root and the body were
  already dark at `domcontentloaded` and in the first frame. Light under an emulated dark
  system: the menu closed, the light list (#f5f6f8). System: the menu closed and the page
  followed the dark system with no attribute; opened again, System checked; then the light
  system. Dark again closed the menu. No stream socket in all this.
- With Dark chosen, the POCO's screen: Connected, tabs Screen, Files, Shell, one stream socket;
  the stage "Screen is asleep" with Wake (not pressed); the rail in the Android order. The
  system scheme to dark, then `light` written from a second page: the page turned light, still
  one stream socket and the same mount node.
- Settings from the rail: Stream, Sound, Keyboard, Unlock, About and troubleshooting; "Touch"
  with Show touches in Keyboard and the hint "A dot where you touch the picture. This browser
  only.". On: one `.touch-marks`, the same mount node, one socket. Off.
- Files under a mouse at /data/local/tmp, light and then dark: the field is 1054x32. Hovered,
  the root, "local", "tmp" and the edit button each fill a box 24 px high, 4 px below the
  field's top and 4 px above its bottom, as at step 8. No name or icon moved between rest and
  hover. Nothing was pressed; the path editor stayed closed.
- Shell connected; nothing typed. Screen again: one new stream socket.
- Notifications in dark: "iPhone · Connected · 99+ unread", 19 cards.
- Back to the list, then Back once: no stream socket. No page or console error.
- Touch, 440x956, light: the bar is one row, Notifications, Theme and Reload each 44x44 inside
  it, no sideways scroll. Theme opened (System checked); a tap on Light closed it and the page
  stayed light (`data-theme="light"`); opened again, Light checked; a tap on System closed it
  (no attribute). No stream socket. Files at /data/local/tmp: the field is 424x44; the crumbs
  are 44 px high, "/" 44 px wide, and each reaches to the middle of the slash beside it ("data"
  ends at 105.6 and "local" starts at 105.7, the first slash's middle 105.6; "local" ends and
  "tmp" starts at 167.8, the second slash's middle). In Downloads a tap on a file opened the
  sheet with Download, Rename, Delete and Cancel; Cancel closed it. Nothing was downloaded,
  renamed or deleted.
- The log shows "No viewers left. Stopping the stream service" at 22:29:11, about 25 s after the
  touch pass left the screen. No page or console error.

Seen on the way: the `DEP0180` warning (`fs.Stats constructor is deprecated`) is still in the
live log when Files opens; it is a warning, not an error.

Not checked: the iPhone's picture (headless Chromium cannot decode it), choosing a theme item
with the keyboard (Enter or Space), the theme on a real phone and in the installed app, Show
touches under a real finger or pointer, Safari and Firefox, the iPhone's screen on the live
server.

Rollback, for a break only: `docker tag ws-scrcpy:before-step9-20261116 ws-scrcpy:latest` and
`docker compose up -d ws-scrcpy`. Reload each browser tab and reopen the installed app once.
The scripts and the brief are in `/home/brandon/ws-scrcpy-handoff/last-deploy/2026-11-16-step9/`.

### The deploy without the iPhone session, and the branch on the fork (2026-11-18)

No code changed and nothing was deployed. The live server is as step 9 left it.

The owner's words on 2026-11-18: "please push and you may leave out the iphone session".

The deploy check:
- A deploy no longer has to open the iPhone's screen on a test server. That was point 2 of the
  deploy list in the brief and steps A3 to A5 of the saved deploy briefs: the build without
  Android, the test server on port 8010, the one `serve-web` start and the six-minute wait
  before it. It took most of a deploy's 20 to 23 minutes.
- What stays: the phone health commands from the host venv, the clock check against 03:00 and
  15:00 UTC, no restart while a `serve-web` runs in the container, the rollback tag, the build,
  the checks of the live server, the unlock fields unchanged, and the look-only pass over the
  Android phone's pages.
- The rule in `AGENTS.md` stands: no iPhone screen session unless a brief's deploy procedure
  says so. A brief that leaves the session out starts none.
- Not the owner's words, the writer's reading: a step that changes how the iPhone's screen is
  started or streamed (the server's iOS code, the pymobiledevice3 patch, the stream view) should
  say in its brief whether it keeps the session. Without it, the first proof of such a change is
  the owner opening the iPhone's screen on the live server.

The push:
- `redesign` went to `origin` (the owner's fork on GitHub, which is public) as a new branch,
  with `origin/redesign` as its upstream. Nothing else was pushed: not `master`, not
  `new_scrcpy`, no tag.
- Checked before it, by file name and by pattern, printing no content: the history that went up
  holds no key file, no settings file and no token. The phone's serial, the host names and the
  LAN address in the docs were already on `origin/new_scrcpy`.
- `AGENTS.md` is untracked and stayed on this machine.
- The owner asked for this one push. The rule "No `git push`" in `AGENTS.md` is unchanged.

Still open in `docs/TODO.md`: one agent and one full run for a small change.
