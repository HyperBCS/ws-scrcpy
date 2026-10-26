# ws scrcpy

Web client for [Genymobile/scrcpy][scrcpy] and more.

## Requirements

Browser must support the following technologies:
* WebSockets
* Media Source Extensions and h264 decoding;
* WebWorkers
* WebAssembly

Server:
* Node.js v10+
* node-gyp ([installation](https://github.com/nodejs/node-gyp#installation))
* `adb` executable must be available in the PATH environment variable
* For [iOS](#ios): Python 3.10+ and `usbmuxd` running on the host
  (`apt install usbmuxd` on Debian/Ubuntu); `pymobiledevice3` talks to it over
  `/var/run/usbmuxd` and fails outright without it.

Device:
* Android 5.0+ (API 21+)
* Enabled [adb debugging](https://developer.android.com/studio/command-line/adb.html#Enabling)
* On some devices, you also need to enable
[an additional option](https://github.com/Genymobile/scrcpy/issues/70#issuecomment-373286323)
to control it using keyboard and mouse.

## Build and Start

Make sure you have installed [Node.js 22 or newer](https://nodejs.org/en/download/),
[node-gyp](https://github.com/nodejs/node-gyp) and
[build tools](https://github.com/nodejs/node-gyp#installation)
```shell
git clone https://github.com/NetrisTV/ws-scrcpy.git
cd ws-scrcpy

## For stable version find latest tag and switch to it:
# git tag -l
# git checkout vX.Y.Z

npm ci
npm start
```

## Supported features

### Android

#### Screen casting
The stock [Genymobile/scrcpy][scrcpy] 3.1 server streams H264 video, which is
then decoded in the browser by one of the included players:

##### Mse Player

Based on [xevokk/h264-converter][xevokk/h264-converter].
HTML5 Video.<br>
Requires [Media Source API][MSE] and `video/mp4; codecs="avc1.42E01E"`
[support][isTypeSupported]. Creates mp4 containers from NALU, received from a
device, then feeds them to [MediaSource][MediaSource]. In theory, it can use
hardware acceleration.

##### WebCodecs Player

Decoding is done by the browser's built-in (software/hardware) media decoder.
Requires [WebCodecs][webcodecs] support, available in Chrome/Edge 94+,
Safari 16.4+ and Firefox 130+. This is the default and recommended player.

#### Remote control
* Touch events (including multi-touch)
* Multi-touch emulation: <kbd>CTRL</kbd> to start with center at the center of
the screen, <kbd>SHIFT</kbd> + <kbd>CTRL</kbd> to start with center at the
current point
* Mouse wheel and touchpad vertical/horizontal scrolling
* Capturing keyboard events
* Injecting text (ASCII only)
* Copy to/from device clipboard
* Device "rotation"

#### File push
Drag & drop an APK file to push it to the `/data/local/tmp` directory. You can
install it manually from the included [xtermjs/xterm.js][xterm.js] terminal
emulator (see below).

#### Remote shell
Control your device from `adb shell` in your browser.

#### File listing
A file explorer for the device: breadcrumb navigation with back/forward
history, quick-access folders, details/list/tile views, sorting, filtering,
multi-select, upload (picker or drag & drop), download, new folder, rename,
delete and properties.

### iOS

Device control goes through Apple's own **CoreDevice** developer services, driven by
[doronz88/pymobiledevice3][pymobiledevice3]. Nothing is installed on the phone: no
WebDriverAgent, no signing, no Apple developer account. The trade-off is the iOS
version -- the display stream and the touch surface only exist on **iOS 27** (the
phone rejects them on iOS 18 and earlier).

> `INCLUDE_APPL` is **on** by default. Verified end to end on an iPhone 13 Pro Max
> running iOS 27.0; background in
> [docs/IOS-CONTROL-INVESTIGATION.md](/docs/IOS-CONTROL-INVESTIGATION.md) and the
> handoff notes.

#### Setup (Linux server)

```shell
npm run setup:ios            # creates python/venv with pymobiledevice3
sudo systemctl start usbmuxd # if it is not running already
```

Then, on the phone, once:

1. Plug it in over USB and tap **Trust** on the "Trust This Computer?" prompt.
2. Turn on **Developer Mode** (Settings → Privacy & Security → Developer Mode; the
   device card offers an **Enable** button that triggers the prompt). The phone
   reboots and asks to confirm.

The server mounts Apple's Developer Disk Image itself (downloaded and personalised
for your device the first time) whenever a screen session starts. It does not
survive a reboot, and it is not an app.

#### What works

* Screen: HEVC pushed by the phone (`com.apple.coredevice.displayservice`),
  decoded in the browser with WebCodecs, or remuxed to fragmented MP4 for Media
  Source Extensions where WebCodecs is unavailable (Chrome/Edge over plain http).
  Chrome needs hardware HEVC decoding; Safari always has it.
* Touch: tap, drag, swipe, and up to five simultaneous fingers through the touchscreen
  HID surface. Touchscreen browsers can pinch and use multiple fingers; a mouse sends
  one contact. Contacts are released on blur, cancellation, rotation, and disconnect.
  One viewer owns a phone's active gesture at a time.
  Multi-touch is not available on this path yet.
* Hardware buttons: Home, Lock, Siri, volume up/down, mute.
* App switcher: iOS has no button for it, so the server performs what opens it on
  that model -- a swipe up from the bottom edge that pauses midway on Face ID
  devices, a Home double press on Home-button devices (decided from the product
  type; `IOS_APP_SWITCHER=home|gesture` overrides). The gesture is the standard
  one; its timing has not yet been confirmed on an unlocked phone.
* Screen and lock state, like Android's Asleep/Locked badges. The display backlight is
  read from the phone's IORegistry over lockdown (0 while the screen is off), polled
  every 4 s while streaming and every 15 s idle. The lock state comes from
  `python/probes/lockstate.py`, which asks the accessibility daemon what is on screen
  (the lock screen's padlock reads "Locked"/"Unlocked", the keypad "Enter Passcode").
  That probe **never runs on a timer**: only when SpringBoard reports a lock change or
  the screen blanking, when a button or passcode goes through the stream, or when you
  ask (the Unlock button), and never while the phone is known to be awake and unlocked.
  It also turns the accessibility inspector's on-device overlay off first, so the phone
  does not draw a highlight box around what it reads. `IOS_LOCK_PROBE=0` turns the lock
  half off entirely and leaves sleep detection working. The stream page shows the same
  sleep overlay (tap to wake) and lock notice as Android. The captions are English; add
  your phone's with `IOS_LOCKED_CAPTIONS` (a lock screen in another language reads as
  unknown, never as unlocked). Verified on iOS 27 for screen on/off and the locked and
  passcode screens; the unlocked reading follows from the absence of those.
* Keyboard: your computer's keys become a virtual HID keyboard on the phone.
  The Type text sheet (also in the Actions sheet) types as you enter text, so it
  works from a phone browser as well, with Enter, Delete and cursor keys. Smart
  punctuation from an iPhone keyboard (’ “ ” — …) is typed as the plain key; a
  character with no US-layout key (é, emoji) is reported instead of dropped.
  Done, backgrounding the viewer, and disconnecting remove the virtual keyboard
  after pending text finishes, so the phone's own keyboard can appear again.
  Touch and mirroring keep their connections. `npm run patch:ios` installs the
  keyboard lifecycle support alongside the audio and multitouch patches.
* Sound: the phone's system audio (what it plays through its speaker) streams to the
  browser. The phone sends AAC-ELD; the server decodes it with `ffmpeg` (any build with
  the native AAC decoder) into the same PCM path Android uses, so the Sound button,
  Listen unlock, mute, the volume slider in the Actions sheet (the mirrored audio
  arrives at full scale whatever the phone's own volume) and Silent-switch handling are
  shared. Needs `npm run setup:ios`,
  which patches the bundled pymobiledevice3 to hand out the raw frames on Linux (upstream
  only decodes on macOS). Set `IOS_AUDIO=0` to turn it off on the server.
* Clipboard both ways, rotation, screenshots. The phone's own clipboard daemon
  sometimes stops answering, which used to make reads fail until the phone was
  rebooted; the server now notices, restarts that daemon and reads again, so the
  read still returns -- it just takes about ten seconds instead of 50 ms.
* Device power: Reboot and Shut down (each needs a second press to confirm). A
  reboot also clears a phone whose screen capture has stopped responding.
* Lock screen: **Unlock** opens the passcode panel directly. Android and iOS
  passcodes are saved per device in this browser's local storage when submitted,
  then filled in next time. **Forget** removes a saved code. Codes are only sent
  to the device when you press the submit button.

**A passcode changes one thing.** After a reboot, a passcode-protected iPhone
exposes no USB data connection until it is unlocked by hand on the device -- it
will not appear in the device list at all until then (verified: no USB
enumeration whatsoever for 143 s after a reboot, versus 38 s to reappear with no
passcode). Once it has been unlocked once, everything works, including locking
the screen again and unlocking it remotely with the Actions sheet. Also enable
Developer Mode *before* setting a passcode: a passcode blocks the toggle.

If touch or the keyboard stop responding while the picture is still live, that session
has lost the separate connection behind them. A moving picture is not evidence that
input is getting through -- it travels over a different connection to the phone. (The
clipboard is a third connection again, to a daemon on the phone that no restart on this
side can reach, which is why it recovers itself instead of appearing here.)

Every device card and the stream page's Actions sheet carry a **Debug** group for
this, in increasing order of how much it restarts:

| Action | Restarts | Use it when |
| --- | --- | --- |
| Refresh picture | asks for a new keyframe | the picture smears |
| Restart picture | the video, inside the same session | the picture is frozen or broken |
| Restart services | the whole phone session (a fresh helper process) | touch or the keyboard stopped responding |
| Remount developer image | the developer image the screen/touch services live in | the screen will not start at all |
| Reboot phone | the phone | nothing else helped |

The Debug group on the device card works without a stream, which matters because the
failures it recovers from are the ones that leave no working stream page. Capture keeps
running while the phone is locked, but the encoder throttles to a few frames per
second until it is unlocked.

Known limits: the phone's encoder emits a slightly non-conformant HEVC stream
that smears under fast motion in every non-Apple decoder (the Refresh picture
action asks for a new keyframe); no audio yet; no shell and no root filesystem
on iOS.

#### HTTPS

Chrome and Edge expose WebCodecs on secure origins only (`https://` or
`localhost`). Over plain http the client falls back to Media Source Extensions,
which costs a frame or two of latency; for the lowest-latency WebCodecs path on a
desktop, generate a self-signed certificate for this machine once and run with both
listeners:

```shell
npm run setup:https   # certs/ws-scrcpy.{key,crt} with the host's IPs as SANs, config.https.yaml
npm run start:https   # http://…:8000 as before, plus https://…:8443
```

Open `https://<server-ip>:8443/` and accept the certificate warning once per browser.
Everything (WebSockets included) then runs on that origin. If 8443 is taken on your
machine the setup script says so; pick another with
`WS_SCRCPY_HTTPS_PORT=8444 npm run setup:https` (`WS_SCRCPY_HTTP_PORT` likewise).

#### iOS configuration (environment variables)

| Variable | Purpose |
| --- | --- |
| `IOS_PYMOBILEDEVICE3` | Path to the `pymobiledevice3` executable (default: `python/venv/bin/pymobiledevice3`, then `PATH`) |
| `IOS_TUNNEL` | How the iOS 17+ tunnel is reached: `userspace` (default, in-process, no root) or `tunneld` (use a running `sudo pymobiledevice3 remote tunneld`) |
| `IOS_APP_SWITCHER` | How the App switcher button opens it: `gesture` (Face ID swipe-and-hold) or `home` (Home double press). Default: by product type |
| `IOS_STATE_PROBE` | `0` turns the screen/lock state monitor off (the badges and the sleep overlay stay silent) |
| `IOS_LOCK_PROBE` | `0` keeps the screen probe but skips the lock probe, the one that opens a developer tunnel and talks to the accessibility daemon |
| `IOS_STATE_NOTIFICATIONS` | `0` disables the per-device `notification observe` process; state then changes only at the poll interval |
| `IOS_LOCKED_CAPTIONS` | Comma-separated lock-screen captions in your phone's language (e.g. `Gesperrt,Code eingeben`) |
| `WS_SCRCPY_DEBUG` | Verbose logs, including every `pymobiledevice3` child's output |

[pymobiledevice3]: https://github.com/doronz88/pymobiledevice3

## Custom Build

You can customize project before build by overriding the
[default configuration](/webpack/default.build.config.json) in
[build.config.override.json](/build.config.override.json):
* `INCLUDE_APPL` - include code for iOS device tracking and control
* `INCLUDE_GOOG` - include code for Android device tracking and control
* `INCLUDE_ADB_SHELL` - [remote shell](#remote-shell) for android devices
([xtermjs/xterm.js][xterm.js], [Tyriar/node-pty][node-pty])
* `INCLUDE_FILE_LISTING` - [file management](#file-listing)
* `USE_H264_CONVERTER` - include [Mse Player](#mse-player)
* `USE_WEBCODECS` - include [WebCodecs Player](#webcodecs-player)
* `USE_AUDIO` - forward the device's audio (scrcpy audio stream, Opus, decoded
in the browser via WebCodecs). **Off by default**: it requires Android 11+, and
enabling it changes how many sockets scrcpy opens, so treat it as experimental.
Audio must also be enabled per-device in the stream settings sheet.
* `SCRCPY_LISTENS_ON_ALL_INTERFACES` - WebSocket server in `scrcpy-server.jar`
will listen for connections on all available interfaces. When `true`, it allows
connecting to device directly from a browser. Otherwise, the connection must be
established over adb.

## Run configuration

You can specify a path to a configuration file in `WS_SCRCPY_CONFIG`
environment variable.

If you want to have another pathname than "/" you can specify it in the
`WS_SCRCPY_PATHNAME` environment variable.

Configuration file format: [Configuration.d.ts](/src/types/Configuration.d.ts).

Configuration file example: [config.example.yaml](/config.example.yaml).

## Known issues

* The server on the Android Emulator listens on the internal interface and not
available from the outside. Select `proxy over adb` from the interfaces list.
* MsePlayer reports too many dropped frames in quality statistics: needs
further investigation.
* On Safari file upload does not show progress (it works in one piece).
* iOS screen and control need iOS 27; older phones show up in the device list
but cannot start a session. Verified on an iPhone 13 Pro Max (iPhone14,3) on
iOS 27.0 over USB: stream, touch, keyboard, hardware buttons, clipboard, rotate.
* The browser must decode HEVC itself (the stream is never re-encoded). Safari
does; Chrome/Edge need a GPU with hardware HEVC decode (Chromium builds without
proprietary codecs, such as Playwright's, show "This browser cannot decode the
phone's HEVC stream"). WebCodecs is used where available (Safari, or Chrome/Edge on
a secure origin -- see [HTTPS](#https)); otherwise the same access units are remuxed
into fragmented MP4 and played through Media Source Extensions, which also works
over plain `http://`. Add `&player=mse` or `&player=hevc` to the stream URL to force
one decoder.
* If the device list stops noticing an iPhone being plugged in, `usbmuxd` has
wedged: `sudo systemctl restart usbmuxd`.
* Drag-and-drop APK push over the stream is **broken**: `ScrcpyFilePushStream`
sends control message type `102`, a NetrisTV extension that the stock scrcpy 3.1
server does not implement, so it is misparsed and can drop the control socket —
taking all input with it. Push files over adb instead until this is rerouted.
* Changing anything in the stream settings sheet's *Stream quality* group
restarts the scrcpy server on the device, which briefly disconnects every viewer
of that device (they reconnect automatically).

## Security warning
Be advised and keep in mind:
* There is no encryption between browser and node.js server (you can [configure](#run-configuration) HTTPS).
* There is no encryption between browser and WebSocket server on android device.
* There is no authorization on any level.
* The modified version of scrcpy with integrated WebSocket server is listening
for connections on all network interfaces (see [custom build](#custom-build)).
* The modified version of scrcpy will keep running after the last client
disconnected.

## Related projects
* [Genymobile/scrcpy][scrcpy]
* [xevokk/h264-converter][xevokk/h264-converter]
* [DeviceFarmer/adbkit][adbkit]
* [xtermjs/xterm.js][xterm.js]

## scrcpy server

This fork ships the stock **scrcpy 3.1** server (see `SERVER_VERSION` in
`src/common/Constants.ts`). Video and control are fanned out to multiple
browser viewers by the server-side broadcast layer in `src/common/`, rather
than by the WebSocket patch the older NetrisTV v1.19 fork used.
* [Prebuilt package](/vendor/Genymobile/scrcpy/scrcpy-server.jar)


[scrcpy]: https://github.com/Genymobile/scrcpy
[xevokk/h264-converter]: https://github.com/xevokk/h264-converter
[adbkit]: https://github.com/DeviceFarmer/adbkit
[xterm.js]: https://github.com/xtermjs/xterm.js
[node-pty]: https://github.com/Tyriar/node-pty

[MSE]: https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API
[isTypeSupported]: https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/isTypeSupported
[MediaSource]: https://developer.mozilla.org/en-US/docs/Web/API/MediaSource
[webcodecs]: https://w3c.github.io/webcodecs/

### Bluetooth notifications and Safari PWA

The Linux server captures notifications that an iPhone exposes through Apple's
[ANCS Bluetooth service](https://developer.apple.com/library/archive/documentation/CoreBluetooth/Reference/AppleNotificationCenterServiceSpecification/Specification/Specification.html)
and relays them using Web Push. Capture continues without an open screen stream.
This collector is for iPhones; Android notification capture is not included.

The server uses the host BlueZ daemon and an adapter supporting LE advertising.
For a host installation, install `bluez python3-dbus python3-gi`, enable Bluetooth
with `sudo systemctl enable --now bluetooth`, then start the app. The collector
uses `/usr/bin/python3`, independently of the CoreDevice virtual environment.
`WS_BLUETOOTH_PYTHON` overrides that interpreter. `WS_NOTIFICATIONS_COLLECTOR=0`
disables Bluetooth collection for development without hardware.

For Docker on an AppArmor host, load the supplied profile before starting:

```shell
sudo install -m 644 config/apparmor-ws-scrcpy /etc/apparmor.d/ws-scrcpy-bluetooth
sudo apparmor_parser -r /etc/apparmor.d/ws-scrcpy-bluetooth
sudo systemctl enable --now bluetooth
docker compose up -d --build ws-scrcpy
```

The profile retains Docker's default filesystem restrictions and permits the
BlueZ D-Bus calls and callbacks needed for pairing and notifications. The compose
file mounts the system bus socket and persists settings in `ws-scrcpy-data`.
On a host without AppArmor, omit the compose `security_opt` entries. Do not run
another Bluetooth daemon for this container or remove existing device bonds.

Safari on iOS/iPadOS 16.4+ requires a trusted HTTPS origin and installation using
**Share → Add to Home Screen** for background push. A certificate warning or the
plain LAN URL is insufficient. The configured private address for this server is
`https://mini-nuc.tailea1801.ts.net/`. Connect the receiving phone to the same
Tailscale network before opening it. The host's Tailscale container serves it with:

```shell
docker exec tailscale tailscale serve --bg --yes http://127.0.0.1:8000
```

Serve manages certificate renewal and persists its configuration. This is private
Serve, not public Funnel. On another server, update `WS_PUBLIC_URL` in compose and
use that server's Tailscale DNS name.

If an older iPhone Home Screen installation has blurred headers or a gray strip
at the bottom, delete that Home Screen app and add it again from Safari, then
enable notifications again. iOS can retain the former translucent status-bar
mode in the installed app even after a reload. The current app omits that legacy
setting and sizes every view from the shared viewport. Bluetooth pairing and
source mappings on the server survive reinstalling the receiving app. See the
[WebKit explanation](https://www2.webkit.org/show_bug.cgi?id=317153#c2).

The push sender uses `WS_PUBLIC_URL` as its VAPID contact address. To override it,
set `WS_PUSH_SUBJECT` to a real HTTPS URL or `mailto:` address. Placeholder local
addresses can cause Apple to reject delivery with `403 BadJwtToken`. Changing
this contact address preserves the existing keys and receiver subscriptions.

1. Open **Notifications** on the iPhone’s device card.
2. Open **Setup & delivery**. Under **Send from an iPhone**, choose **Start Bluetooth pairing**, open that
   iPhone's Bluetooth settings, select **ws-scrcpy**, and
   confirm the matching numeric code on both sides. Allow notification sharing;
   **Settings → Bluetooth → ws-scrcpy → Share System Notifications** must remain on.
3. Match that iPhone's USB and Bluetooth connections, then choose **Use this iPhone**.
   The phone's expandable settings contain message previews and optional app filters.
4. On the receiving device, open the installed PWA and use **Receive on this device**.
   Choose the sending phones and identify whether this is one of those same phones,
   then tap **Enable on this device**. Otherwise keep **A different phone, tablet or
   computer**. Then use **Send test notification**. The receiver/source choice prevents
   loops. Later changes use **Save changes** without another permission prompt.

Keys, source mappings, subscriptions, and notification history persist across
restarts; keep the data volume when updating. **History** shows the selected
phone’s alerts, with **Inbox**, **Unread**, and **All history** filters. Device
cards link directly to that phone’s history; there is no global history link on
the Devices page. The NUC keeps up to 500 alerts per phone for 30 days in its private data directory. History starts with alerts collected by this
relay, including those iOS shares when connecting; it cannot recover alerts the
phone no longer exposes. Turning message previews off also removes saved message
text for that phone. Removing a source deletes its history and cached icons.

Original app icons are read over the trusted USB connection and cached on the
NUC. If an app icon is unavailable, the history shows a letter placeholder. This
does not change iOS's system-managed PWA notification icon or attribution.

**Mark read** and **Mark all read** update shared app unread counts; they do not
mark messages read inside the original iPhone app. **Dismiss here** moves an alert
out of the inbox while retaining it in **All history**. Where iOS offers a phone
action, the card’s **⋯** menu shows its actual label, such as **Clear on
iPhone**. A negative ANCS action is not always dismissal (it can decline a call),
so its label is checked again before sending. Actions require a current Bluetooth
session. Acceptance of an action does not claim the iPhone has removed the alert.

**Dismiss all here** and **Dismiss all on phone** live in the history toolbar’s
**⋯** menu. They each confirm the selected phone and alert count, then act on
that exact list of search/filter matches, including older results beyond the
current page. Alerts arriving afterward are left alone. Phone bulk dismissal includes
only explicit Clear/Dismiss actions, excludes actions such as Decline or Delete,
and stops if the phone disconnects or cannot confirm an action. Partial results
show how many requests were accepted and how many remain. Cards show a compact
preview with **Show more** for longer messages.

Web previews make HTTP/HTTPS links in the shared title and message clickable.
Direct HTTPS image links (including GIFs), video links, and audio links offer
**Load image**, **Load video**, or **Load audio** inside the card. Media loads
from the displayed host only after a tap; video and audio use the browser's
playback controls without autoplay. **Hide** stops playback and removes the
preview. Unavailable files and unsupported formats retain an **Open** link.
Up to four distinct media links appear per notification, and turning message
previews off hides both text and media.

This works with URLs included in notification text. The current Bluetooth
[ANCS protocol](https://developer.apple.com/library/archive/documentation/CoreBluetooth/Reference/AppleNotificationCenterServiceSpecification/Appendix/Appendix.html)
does not expose photo, video, or audio attachments. An alert saying “sent a photo”
without a media URL therefore remains text. Ordinary webpage links open in a new
tab; page metadata and third-party embeds are not fetched. Direct media links
must end in a supported file extension before any query string; the browser must
support the file's codec and the host must permit embedding.

Search matches app names, titles, and full message text, ignoring case and accents.
**Filters** limits results to one app; **Inbox**, **Unread**, and **All history**
remain directly accessible. Opening a notification from a push clears any filters
that would hide it. Search and filters are scoped to the selected phone.

On a touch screen, swipe right to toggle read/unread or left to dismiss here.
Vertical scrolling, short drags, cancelled touches, and multitouch do not trigger
actions. Both gestures have a short-lived **Undo** control that restores the app
state; they never perform an action on the iPhone. Card menus offer the same
controls for keyboard/mouse use, plus **Move to inbox** for dismissed alerts.

Unread badges show each phone’s count on its device card and notification page.
The installed PWA icon shows the combined count where supported and permitted
in OS settings. Pushes and app opening refresh the Home Screen badge. Reading an alert closes its matching
banner on this receiving device where supported. Other closed installations
refresh their badges on the next push or app opening; Safari does not permit
silent pushes just to synchronise state.

Existing alerts on reconnect are shown in history but not pushed again.
Modifications/removals update history without silent pushes. Expired subscriptions
are removed automatically. Focus, app notification settings, preview permissions,
connectivity, and the push provider can affect which alerts appear and when.
Notifications cannot bypass those iOS settings. No private content is cached by
the service worker.

The iOS toolchain is pinned in `python/requirements.txt`. `npm run setup:ios`
applies the raw-audio and five-contact HID patches; rerun it after recreating the
virtual environment. `npm test` includes ANCS fragmentation, touch lifecycle,
notification policy, persistence, and service-worker regression tests.


### Access

Open `http://10.10.10.5:8000` on the LAN or the configured private Tailscale URL.
The app has no login, setup key, session cookie, trusted-network setting or API
credential. Device connections, notifications and downloads open directly.
The server listens on port 8000 on the host network.

Browser requests retain same-origin validation. Remote WebSocket and download
proxies connect only to hosts listed in `remoteHostList`; no per-host access key
is needed. Existing notification sources, receiver subscriptions and Web Push
keys survive updates. Keep the data volume when rebuilding.

Large file downloads use the browser's download manager and stream directly from
ADB. Small downloads retain in-app progress; at most two 16 MiB buffers or pending
Blob URLs are held by the file browser. Cancelling a download closes its ADB pull.

### Verification

`npm run check` runs TypeScript, lint, unit tests, and the production build.
`npm run test:browser` then serves the built assets on an isolated ephemeral
loopback port and runs the browser fixtures. It does not connect to attached
phones or send push notifications. Install browser dependencies once with
`npx playwright install --with-deps chromium webkit`. For the WebKit checks, run
`BROWSER=webkit npm run test:browser -- review-polish notifications motion`.
The same workflow runs in GitHub Actions.

See [review fixes and validation](docs/REVIEW-FIXES-2026-10-26.md) for the changes
and remaining upstream dependency advisory.
