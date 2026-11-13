# ws-scrcpy

This is one owner's app for viewing and controlling their Android phones and iPhones
from a browser. It also keeps an iPhone notification inbox and can relay notifications
through Web Push. Phone browsers, the installed web app and desktop browsers count equally.
There is no login. Run it only where access is trusted.

Android uses the stock [scrcpy 4.1 server](vendor/Genymobile/scrcpy/scrcpy-server.jar)
over adb. iPhone screen and input use CoreDevice through
[pymobiledevice3](https://github.com/doronz88/pymobiledevice3), with no app, signing or
Apple developer account on the phone. This fork's behavior differs from upstream ws-scrcpy.
[HANDOFF](docs/HANDOFF.md) describes the architecture and dated checks.

## Phones and browsers

- Android needs USB debugging enabled and the host authorised on the phone. The host's
  adb server must already be running. Screen, Files and Shell use that connection.
  Native keyboard (UHID) and audio need Android 11 or later; older phones can use
  injected keycodes. Phone or app restrictions can prevent audio capture.
- iPhone screen and touch need iOS 27, a trusted USB connection, Developer Mode and a
  mounted Developer Disk Image. The server can mount the image when starting a session;
  an image mount does not survive a phone restart. After a restart the owner must enter
  the passcode on the phone before host services work. The latest bounded deploy check
  used an iPhone 13 Pro Max on iOS 27.2.1. This is not a promise for every iPhone or iOS release.
- Browsers need WebSockets and a video decoder supported by the chosen player. Android
  defaults to H.264 with WebCodecs, with an MSE player available. iPhone sends HEVC,
  without server video transcoding. WebCodecs needs a secure context; the iPhone MSE
  fallback can run over HTTP if that browser can decode HEVC. Codec support depends on
  the browser, OS and hardware. Headless Chromium used in checks cannot show the iPhone
  picture. A ready session can still offer commands and Type text with **No picture**;
  new touches need a usable picture.
- Audio is enabled in the normal build. Android defaults to raw 48 kHz stereo PCM;
  optional Opus needs browser AudioDecoder support. iPhone AAC-ELD is decoded by ffmpeg
  on the server into PCM. Each browser starts muted: press Listen to permit playback.
  There is no browser microphone forwarding. Call audio is subject to phone restrictions.
- iPhone has Screen only, without Files, Shell, Back or Overview. It has Home, Lock,
  Siri and volume controls. The input path supports up to five touch contacts; the mouse
  can emulate a two-finger pinch. Real input and picture checks have limits described below.

## Build and run

The checked toolchain uses Node.js 22; the Docker image uses `node:22-bookworm-slim`.
A host build needs the C/C++ and Python build tools used by node-gyp for node-pty.
A host iPhone installation also needs Python with venv support, usbmuxd and ffmpeg.
The pinned toolchain is in [python/requirements.txt](python/requirements.txt).
`npm run setup:ios` creates `python/venv` and applies the four repository patches.
`npm run patch:ios` applies them to an existing venv after patch changes.

The repository's configured project remote is:

```sh
git clone https://github.com/HyperBCS/ws-scrcpy.git
cd ws-scrcpy
```

On a fresh host, install the locked dependencies with `npm ci`. In the owner's existing
checkout, use the installed dependencies; do not install or change them during a check.
The normal commands, from the repository root, are:

```sh
npm run dist                      # production client and server in dist/
npm run check                     # types, lint, Node/Python tests and production build
node scripts/test-browser.js       # every default browser suite, with fixture servers
node scripts/test-browser.js home  # one fixture suite
```

Build options come from [the default build configuration](webpack/default.build.config.json),
with optional values in [build.config.override.json](build.config.override.json). The
normal override is `{}` plus a newline. `INCLUDE_GOOG`, `INCLUDE_APPL`,
`INCLUDE_ADB_SHELL`, `INCLUDE_FILE_LISTING`, `USE_WEBCODECS`, `USE_H264_CONVERTER`
and `USE_AUDIO` all default to true. `PATHNAME` defaults to `/`. Normal production
builds exclude the kit demo regardless of an override; fixture demo assets stay outside dist.

Run only one `npm test` or `npm run check` at a time: unit tests bind fixed ports.
Run browser suites through `scripts/test-browser.js`. Running `scripts/e2e-*.js` or
older `test:*` shortcuts directly can target the live server. Tests use fake phone
services. The six refreshed hardware-only scripts have not had their bodies run.

For a fresh host with no other app server, `npm start` builds and starts the server
from `dist/`, normally on port 8000. `npm run dev` watches and rebuilds it. Neither is
safe alongside the owner's Android-enabled server. A permitted second test server must
be built without Android and use isolated fixture data, as the current brief specifies.

### Docker

The supplied [Compose file](docker-compose.yml) is for this Linux host. It uses host
networking for the host adb TCP forward and the iPhone helper's loopback listener.
It mounts usbmuxd's socket and the system D-Bus socket for BlueZ. The host owns USB
access and pairing; the container needs no privileged mode, USB bus mount or adb key mount.
The image includes adb, Python, ffmpeg and the patched pymobiledevice3 venv.

Bluetooth notification collection needs the host BlueZ daemon, an adapter with LE
advertising, and `python3-dbus` / `python3-gi` for the collector's system interpreter.
Load the supplied AppArmor profile on this AppArmor host before a new installation:

```sh
sudo install -m 644 config/apparmor-ws-scrcpy /etc/apparmor.d/ws-scrcpy-bluetooth
sudo apparmor_parser -r /etc/apparmor.d/ws-scrcpy-bluetooth
```

Compose adds the host's Bluetooth group, default GID 111; `BLUETOOTH_GID` selects that
group if the host uses another number. The entrypoint hands the data directory to
`node`, then runs the server as uid 1000. `WS_SCRCPY_USER` is the entrypoint's optional
user override. The loopback health check reads a static file. The 80-second stop grace
allows the server and iPhone helper to shut down cleanly. Preserve it.

For this running installation, follow the current handoff's deploy brief before any
Docker build or restart. Record the old image and add a rollback tag first. Do not
restart near a scheduled unlock or while an iPhone screen helper runs. This README
is not leave to deploy. A documentation-only update needs no container restart.

### HTTPS and configuration

The default listener is HTTP on port 8000. Use the existing trusted private HTTPS
address for Web Push and sensitive settings. `npm run setup:https` generates local
certificate files and `config.https.yaml`; `npm run start:https` builds and uses that
configuration. Its default HTTPS port is 8443. The setup script alone reads
`WS_SCRCPY_HTTP_PORT` and `WS_SCRCPY_HTTPS_PORT`. A self-signed certificate is not enough
for iPhone background push; the receiving app needs a trusted HTTPS origin.

[config.example.yaml](config.example.yaml) and
[Configuration.d.ts](src/types/Configuration.d.ts) describe listeners, TLS, tracker
announcements, allowed host names and configured remote servers. Supply YAML or JSON
through `WS_SCRCPY_CONFIG`; a `.js` suffix is also parsed as JSON, never executed.
Settings and configuration are validated before services start. Invalid values fail
with the field name and omit its value. The startup summary contains only selected
non-secret fields.

## Using the app

**Phones** is the root page. Cards show one status and offer Settings in every state.
Android cards also link to Files and Shell. The header bell opens Notifications;
a linked iPhone's bell opens its inbox. Switch changes the current phone without
stacking another visit in history. Back closes the current sheet before leaving a page.
Old stream and notification push links still open.

Android has Screen, Files and Shell tabs. Leaving Screen closes its browser stream
at once. The phone-side service remains for a quick return: 30 seconds on Android,
15 seconds on iPhone after the last viewer leaves. Files and Shell keep their view
while switching tabs within the phone page. Files supports navigation, upload,
download and folder operations; upload through Files rather than dropping on the picture.
Shell has extra keys on a touch browser and keeps text size in that browser.

Screen, Files and Shell share a phone header. Mouse controls stand against the picture;
touch browsers get a movable edge button, at 50% opacity when idle. From 1024 px,
Actions, Settings and Type text open beside the picture. Actions and Settings remain
modal. **Type text** is modeless: committed typing and paste send at once, its field
stays empty, and the picture remains usable to select another phone field. iPhone
HID typing reports characters without a US-layout key; it cannot type every character.

There is one **Settings** sheet, from a card or screen. Sections are Stream, Sound,
Keyboard, Unlock, About and troubleshooting; iPhone omits Stream. Controls apply when
changed. Android quality/audio changes restart the shared stream for every viewer;
a change while nobody watches starts no stream. Quality arrows/Home/End browse choices;
Enter or Space applies once. Pointer selection applies at once. There is no Apply bar.
Rows that need a phone or its open screen explain why they are unavailable.

Actions groups are Clipboard, Screen, Lock and Power where supported, followed by
Settings. Clipboard Read and Copy here bring phone text to this browser. Android
Paste sends text to the phone's focused field; iPhone Send to phone writes its clipboard.
Direct Ctrl+V / Cmd+V while keyboard capture is active pastes on both platforms.
iPhone waits for the clipboard write before sending Cmd+V. Local fields keep normal
paste. Clipboard text is limited to 262130 UTF-8 bytes (the UI calls this 256 KB).

Capture starts enabled. On a mouse browser the chip says **Keyboard: phone** or
**Keyboard: this page**. The chip and Settings > Keyboard use one capture state.
Local fields and every open sheet keep their own keys. Ctrl+Alt+K releases or
recaptures the keyboard; on a Mac use Ctrl+Option+K. With capture released,
Ctrl+K / Cmd+K opens Switch phone when another control has not used the key.

While the screen owns the keys, the reserved Ctrl+Alt chords are:

| Letter | Action |
| --- | --- |
| K | Release or recapture keyboard |
| S | Switch phone |
| H | Home |
| B | Back (Android) |
| O | Overview (Android) |
| T | Type text |
| P | Screenshot |
| C | Copy from phone |

A drag continues along the picture edge when it leaves the picture. Android's wheel
scrolls and right-click sends Back. iPhone's wheel makes a short swipe and right-click
does nothing. Ctrl+drag pinches around the picture centre; Shift+Ctrl+drag uses the
pressed point. Mac Ctrl+drag has not been tried on hardware.

## Notifications

The Linux Bluetooth collector receives iPhone ANCS notifications without an open
screen stream. Android notification collection is not included. The header has
Switch iPhone, Search and Setup. Without a chosen source the inbox combines linked
iPhones; source-specific links stay scoped. Inbox and Unread show counts, with Archive
alongside them. Search and app filters stay in the address. Already delivered push
links reveal and highlight their notification.

Cards have day headings and can group adjacent notifications from the same conversation.
Click or Space expands and marks one read; opening its screen also marks it read.
These are app read counts, not read state in the original phone app. Touch swipes change
read state or archive, with Undo. Mouse cards have quick actions and a menu. J/K or
arrows move between cards; E archives, U changes read state, / opens search, Z undoes.
Mark all read is on the toolbar. Bulk archive offers Undo. Clear all on iPhone requires
one source and confirmation; phone actions recheck the current session and offered label.
An accepted request does not prove the phone applied it.

In **Setup**, use **Send from an iPhone** to pair over Bluetooth, confirm the matching
code on the phone, allow notification sharing and match the Bluetooth source to its
USB phone with **Use this iPhone**. Keep Share System Notifications enabled on the phone.
On the receiving browser device, **Receive on this device** chooses sending phones and
identifies whether it is one of those phones, to avoid sending its own alerts back.
**Enable on this device** requests permission; **Send test notification** tests delivery.
Existing receiver choices and source settings apply as changed, with no Save changes bar.

**Settings for … > Apps** is a mute list. An older allow-list stays active as
**Only these apps** until cleared. **Mute this app** on a card and Undo use the same
source settings. New muted-app notifications are dropped by the server and are not
stored or pushed; older history stays. Undo cannot recover events dropped meanwhile.
This drop policy is still an owner decision to confirm. Turning notification text off
also erases stored text after confirmation. History retains up to 500 notifications
per source for 30 days. Icons are cached from the trusted USB phone. ANCS supplies no
photo/video/audio attachments; direct media links in text load only after a press.

Background push requires a supported browser, permission and trusted HTTPS. An iPhone
receiving push must use the Home Screen app; Focus and OS notification settings still
apply. Delivery details lists receivers and errors. Existing reconnect alerts enter
history without being pushed again. The service worker caches no private content.
The installed app and real delivery paths still have the check limits below.

## Unlock and iPhone session safety

Settings > Unlock holds the iPhone server passcode and twice-daily schedule. Android's
optional **Remember in this browser** stores plain text in local storage only after
confirmed unlock; Forget removes it. The server never sends an iPhone passcode back.
The iPhone schedule runs at the saved time and halfway to the next day's saved time,
normally 12 hours later, using its saved zone. This splits a daylight-saving change
evenly. Older schedules without a zone use server time. A server-typed unlock less
than 11 hours before a slot counts for the skip rule; Face ID or an observed unlock
does not. A rejected passcode pauses the schedule instead of retyping it. A run that
typed the passcode is never retried. **Run now** and one-tap Unlock use the same server
safeguards, including the two-minute cooldown after a run that opened a session.
They are real phone actions.

A burst of short iPhone screen sessions can wedge its display service until reboot.
The default start budget is three starts per phone in five minutes, persisted across
server restarts, with 30 seconds after a failed session. Reuse one permitted session.
Agents must never retry a failed start, start a session outside the deploy brief, or
run an unlock without the owner's permission. Signal only owned processes by PID with
SIGTERM and wait for shutdown; never use `kill -9` or `pkill -f`. If a command says
**password protected**, stop and tell the owner. A previous iOS 27.2 observation suggests
a host connection lockout around 24 hours after passcode entry; it is not a universal
verified iOS rule.

The live schedule is 03:00 and 15:00 UTC. Do not restart within 15 minutes of either
slot, or during a screen session; a deploy brief may set a wider exclusion window.
Do not save live settings during checks or copy live data out of the container.
Never inspect, print or enter a passcode or dump its settings/key files during a check.

## Environment and storage

[Settings.ts](src/server/Settings.ts) owns the server environment snapshot. Empty values
use the fallback. Booleans accept `0`, `1`, `false`, `true`; durations below are
milliseconds. Keep real-phone safety defaults. Fixture overrides are for fixtures.
The key is consumed separately and excluded from child environments.

| Variable | Default or alias | Purpose |
| --- | --- | --- |
| `WS_SCRCPY_CONFIG` | unset | YAML/JSON run configuration path |
| `WS_SCRCPY_PATHNAME` | build `PATHNAME`, normally `/` | Server URL path; keep client build path aligned |
| `WS_DATA_DIR` | app-root `data/` | Private data directory; relative paths resolve from cwd |
| `WS_NOTIFICATION_DATA` | legacy alias | Used only if `WS_DATA_DIR` is empty/unset |
| `WS_SCRCPY_STREAM_CONFIG_PATH` | data directory `stream-config.json` | Android stream configuration path |
| `WS_PUBLIC_URL` | unset | Public app URL; trusted proxy origin and accepted host name |
| `WS_ALLOWED_HOSTS` | empty | Comma-separated host names added to config `allowedHosts` |
| `WS_PUSH_SUBJECT` | `WS_PUBLIC_URL` | VAPID contact: HTTPS URL or mailto address |
| `WS_NOTIFICATIONS_COLLECTOR` | `true` | Run the Bluetooth collector |
| `WS_BLUETOOTH_PYTHON` | `/usr/bin/python3` | Collector interpreter with D-Bus/GI modules |
| `ADB_HOST` | `127.0.0.1` | Already-running adb server |
| `ADB_PORT` | `5037` | adb server TCP port |
| `IOS_PYMOBILEDEVICE3` | project venv, then PATH | pymobiledevice3 executable |
| `IOS_TUNNEL` | `userspace` | Userspace tunnel, or an existing `tunneld` |
| `IOS_PATCH_CHECK` | `true` | Check installed helper patches before a session |
| `IOS_PROBE_CMD` | venv Python, then `python3` | Probe interpreter override for fixtures |
| `IOS_PROBE_ARGS` | `[]` | JSON string-array arguments before the probe name |
| `WS_SCRCPY_DEBUG` | `false` | Verbose child logs; sensitive during passcode typing |
| `IOS_AUDIO` | `true` | iPhone audio forwarding |
| `IOS_AUDIO_DECODER` | `ffmpeg` | Decoder command; override receives fragmented MP4 and writes PCM |
| `IOS_USBMUX_LISTEN` | `true` | Listen for USB attach/detach events |
| `IOS_USBMUXD_SOCKET` | `/var/run/usbmuxd` | usbmuxd event socket |
| `IOS_STATE_PROBE` | `true` | Screen/lock state monitoring |
| `IOS_LOCK_PROBE` | `true` | Lock-state reads in addition to screen state |
| `IOS_STATE_NOTIFICATIONS` | `true` | State observer; polling recovers missed events |
| `IOS_LOCKED_CAPTIONS` | empty | Additional captions for the older accessibility lock probe |
| `IOS_UNLOCK_FAST` | `false` | Short unlock pauses, fixtures only |
| `IOS_SERVE_WEB_BASE_PORT` | `18100` | First helper loopback port |
| `IOS_DISPLAY_WEDGED_TIMEOUT_MS` | `25000` | Wait for initial video before reporting failure |
| `IOS_SIGNAL_READY_TIMEOUT_MS` | `35000` | Preflight wait before helper signal handling |
| `IOS_SESSION_COOLDOWN_MS` | `30000` | Holdoff after a failed screen session |
| `IOS_SESSION_START_LIMIT` | `3` | Starts allowed in one window per phone |
| `IOS_SESSION_START_WINDOW_MS` | `300000` | Persisted start-budget window |
| `IOS_CLIPBOARD_TIMEOUT_MS` | unset: 8000 ms per attempt | Clipboard timeout override; fixtures also shorten recovery settle |
| `WS_IOS_SETTINGS_KEY_FILE` | data directory `ios-settings.key` | External key file path if configured |
| `WS_IOS_SETTINGS_KEY` | unset | 64-hex-character key instead of a key file; never log its value |

The bundled server defaults to `data/` beside `dist/`, even when `npm start` runs
inside dist. A nonempty former `dist/data` blocks startup until explicitly selected or
moved. Without an explicit stream path, an older cwd `stream-config.json` is read if
the new file is absent; the next save writes the data-directory file. Reads do not migrate it.
Compose defaults both data aliases to `/app/data` and preserves the `ws-scrcpy-data` volume.

| Path within the data directory | Contents |
| --- | --- |
| `stream-config.json` | Saved Android quality/audio values |
| `scrcpy-instance.json` | This server instance's scrcpy identity by port |
| `ios-session-starts.json` | iPhone start-budget timestamps |
| `ios-settings.json` | Schedule/status and AES-256-GCM-encrypted iPhone passcode |
| `ios-settings.key` | Default local encryption key |
| `ios-settings.json.bad` | Preserved unreadable iPhone settings, if encountered |
| `notifications.json` | Sources, receiver subscriptions and private Web Push keys |
| `notification-history.json` | Notification history |
| `notification-icons/` | USB-fetched icon cache |

The iPhone store uses directory mode 0700 and settings/key mode 0600. Keeping the key
beside the encrypted settings protects only against a casual read of that settings file.
Anyone who can read both can recover the passcode. An external key file keeps it outside
the data directory; preserve it privately and never put its value in command examples.
Missing or unreadable keys block unlock until repaired or the passcode is stored again.
Use trusted HTTPS to store a passcode. Debug child output can identify typed digits;
keep debug off when a passcode is stored and treat existing debug logs as sensitive.

## Security and remaining checks

There is no login, API credential or access-control account. Anyone who can reach this
service can control its phones and read its files/notifications. Keep access on the
owner's trusted network or existing private proxy. HTTPS protects transport; it does
not add a login. The configured `WS_PUBLIC_URL` must describe that trusted origin.

Every HTTP request and WebSocket upgrade checks Host. IP literals, localhost, this
machine's names, the public URL host/short name and explicitly allowed names are accepted.
Other names get 403. WebSocket upgrades, notification API requests and file downloads
also check Origin when supplied, accepting the local origin or configured public origin.
Requests without Origin are allowed. These are browser protections, not authentication.
CSP forbids framing and limits fetch/WebSocket connections to self and configured direct
remote servers. Remote WebSocket/download proxies require an exact configured remote
origin/path and reject arbitrary destinations. A phone link cannot choose an unrelated
stream server. Do not disable these checks to fix an access problem; configure the
actual trusted host names.

The 2026-11-13 deploy confirmed one bounded iPhone session and an asleep Android stream,
clean grace stops, tracked phones, collector startup/status and production kit fallback.
It did not prove an awake Android picture, physical input, notification delivery, or
settings application. Physical Android rotation, USB replug and one owner-operated stream
setting restart are explicitly deferred; do not ask again or label them passed.
Real iPhone picture/aim/unlock/Wake, keyboard/paste/touch/wheel/drag/pinch, Safari/Firefox,
phone keyboard/notch/safe areas, large real Files folders, installed app and notification
pairing/push/mute/actions/recovery remain unverified beyond recorded observations.
The dark focus ring's 2.74:1 contrast on the sunken track remains the owner's open decision,
as do mute-drop policy, idle controls opacity and rail attachment at every mouse width.
