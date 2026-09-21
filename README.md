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

Make sure you have installed [node.js](https://nodejs.org/en/download/),
[node-gyp](https://github.com/nodejs/node-gyp) and
[build tools](https://github.com/nodejs/node-gyp#installation)
```shell
git clone https://github.com/NetrisTV/ws-scrcpy.git
cd ws-scrcpy

## For stable version find latest tag and switch to it:
# git tag -l
# git checkout vX.Y.Z

npm install
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
* Touch: one finger (tap, drag, swipe) through the touchscreen HID surface.
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
* Lock screen: typing the passcode from the Actions sheet unlocks a phone whose
  screen is locked. It is not stored anywhere.

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
