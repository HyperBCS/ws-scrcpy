# Full iOS control from ws-scrcpy — investigation (September 2026)

Scope: what it would take to drive an iPhone end to end (screen, touch, keyboard, buttons,
clipboard, files, audio) from the ws-scrcpy browser client, **over USB by preference**, from a
Linux server. No code was written for this; it is a survey of what this repo has, what the
ecosystem now provides, and the gaps between them.

---

## 1. Short version

- **The screen and the touch input are the whole problem.** Everything else (files, battery,
  info, install, reboot, screenshots) already works from Linux over USB through `go-ios` or
  `pymobiledevice3` with nothing installed on the phone.
- **Two viable routes, both over USB, both Linux-only (no Mac in the loop at run time):**
  1. **An on-device agent (DeviceKit or a streaming WebDriverAgent fork), iOS 16+.** Gives
     H.264 video from the phone's hardware encoder, single- and multi-finger touch, typing,
     hardware buttons, clipboard, and Opus system audio. Needs the agent **signed once** — with a
     paid Apple Developer account this is now doable from Linux with `ios sign provision
     appstoreconnect` + `ios ui install`; with a free Apple ID it still needs a Mac and expires
     every 7 days. This is the route that works on the attached phone regardless of its iOS
     version, and it is the natural evolution of what the repo already has.
  2. **Apple's own CoreDevice services, no agent, no signing — but iOS 27 only.**
     `com.apple.coredevice.displayservice` streams HEVC and `…hid.universalhidservice` injects
     touch, both over the developer tunnel. `pymobiledevice3` (11.12.x) already ships a browser
     viewer (`developer core-device display serve-web`) and touch/button/keyboard commands, and
     works over its no-root userspace tunnel on Linux. go-ios merged the same HID support on
     15 Sept 2026 (PR #849) but its display path needs a root kernel tunnel. Caveats that matter:
     the HEVC bitstream is "subtly non-conformant" and **smears under motion in every decoder
     except Apple's**, touch is **single-contact only**, and the phone must run iOS 27 (some
     services from iOS 26.6).
- **Recommendation:** build route 1 as the product path (it replaces the current MJPEG+WDA
  code with the same shape, just a better agent), and keep route 2 as a spike behind a flag for
  iOS 27 devices once Apple's encoder issue is understood. Do not invest further in the WDA
  MJPEG path or in AirPlay.
- **Before any of it:** the iPhone plugged into this NUC (`00008110…`, an A15 device —
  iPhone 13 family / SE 3 / 14) is invisible to `ios list` because the running `usbmuxd`
  instance is wedged (details in §3). It needs a restart and the "Trust This Computer" tap.

---

## 2. What the repo has today

| Piece | File | State |
| --- | --- | --- |
| Device tracking over usbmuxd (`ios listen`, `ios list --details`, `ios info`) | `src/server/appl-device/services/ControlCenter.ts` | Builds and runs; never exercised against a real iPhone (HANDOFF §7) |
| iOS 17+ tunnel supervisor (`ios tunnel start`, optional `--userspace`) | `GoIosRunner.ts` | Works on this machine in userspace mode; kernel mode needs root/`CAP_NET_ADMIN` |
| WDA install/launch (`ios install`, `ios runwda`) + two `ios forward`s (8100 HTTP, 9100 MJPEG) | `GoIosRunner.ts` | Unverified; needs a pre-signed `WebDriverAgentRunner.ipa` (`WDA_IPA_PATH`) |
| WDA HTTP control: tap, drag (scroll), pressButton, keys, `/appium/settings` | `WDARunner.ts` (349 lines) | Endpoint shapes marked "not verified against a real device" |
| MJPEG proxy to the browser | `mw/MjpegProxyFactory.ts`, `player/MjpegPlayer.ts` | Same proxy the Appium era used |
| Client: `StreamClientMJPEG`, `WdaProxyClient`, `ApplToolBox` (home button only), `ApplMoreBox` (send text) | `src/app/applDevice/**` | Docked bar, not the Android FAB/sidebar |

Feature-wise that is: **screen (JPEG frames), single tap, swipe, Home, type text.** No
multitouch, no keyboard capture, no clipboard, no volume/lock buttons, no audio, no files, no
unlock, no sleep/lock detection. The bundled `go-ios` npm package is **1.3.2**, which is the
current upstream release (11 Aug 2026), so no upgrade is needed to reach the newer commands
(`ui`, `ui install`, `sign …`, `image auto`, `screenshot --stream`).

---

## 3. The phone on the bench

`lsusb` shows an Apple device, `05ac:12a8`, USB serial `00008110000A28D622BA801E`. `0x8110` is the
A15 identifier, so this is an iPhone 13/13 mini/13 Pro, iPhone SE (3rd gen) or iPhone 14/14
Plus — all **Lightning**, all **eligible for iOS 27**. `ios list` returns an empty list and
`ios info` says "no iOS devices are attached", while `usbmuxd` (pid 8282, started manually at
04:19 as root) logged at 15:38:

```
Could not get old configuration descriptor for device 5-2: LIBUSB_ERROR_NOT_FOUND
Failed to request lang ID for device 5-2 (3)
Cannot find device entry while removing USB device … on location 0x50002
```

and the device now sits at USB configuration 1 with no driver bound. usbmuxd claims iPhones by
switching them to configuration 3/4; it lost this one on a re-plug and never re-claimed it. The
systemd `usbmuxd.service` cannot start because the manual instance holds the socket. This is a
host problem, not a project problem, and it blocks every iOS experiment:

```
sudo kill 8282 && sudo systemctl restart usbmuxd   # then unlock the phone and tap Trust
ios list --details                                # should list the device
ios info | grep ProductVersion                    # tells us which route is open
```

Nothing below can be validated until that is done, which is why this document stops at the
plan.

---

## 4. Building blocks that exist today

### 4.1 Transport: USB, pairing, the tunnel

- **usbmuxd** (libimobiledevice 1.1.1, installed) multiplexes USB. Wi-Fi needs `usbmuxd2` or the
  tools' own network discovery; not needed for the USB-first goal.
- **Pairing/trust** is a one-time tap on the phone (`ios pair`). Supervised devices can pair
  silently with an organisation `.p12`; not applicable here.
- **iOS 17+ developer services live behind an RSD tunnel.** Both tools provide it:
  - `go-ios`: `ios tunnel start` (root/`CAP_NET_ADMIN`, kernel TUN) or `--userspace` (no root,
    iOS 17.4+). Already wired into `GoIosRunner`.
  - `pymobiledevice3` 11.12.5 (pip): brings up an in-process, pure-Python userspace tunnel on
    demand — no root on Linux for iOS 17.4+ — and its docs state device-initiated media
    (display `serve-web`, `start-video-stream`, `start-audio-stream`) works over that userspace
    tunnel. Only `debugserver` needs the kernel tunnel.
- **Developer Mode** must be on (Settings → Privacy & Security), and the **Developer Disk
  Image** mounted for any DVT/CoreDevice service: `ios image auto` or `pymobiledevice3 mounter
  auto-mount` download and mount it from Linux.

### 4.2 Video

| Option | Codec / transport | iOS | Needs on device | Linux/USB | Latency & quality | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| WDA built-in MJPEG (current code) | JPEG frames over HTTP, device port 9100 | 11+ | Signed WDA | Yes | Default 10 fps; >~30 fps at high scale makes WDA hit the XCTest CPU limit and crash (appium#15264) | Keep only as fallback |
| **DeviceKit** (mobile-next/devicekit-ios) | `GET /h264` — VideoToolbox hardware H.264, 1–60 fps, 100k–10M bps, scale 10–100 %; also `/mjpeg` | 16+ | Signed XCUITest runner | Yes | Hardware encoder, comparable to scrcpy's; not measured here | **Primary candidate** |
| droidrun/mobilerun WebDriverAgent fork | H.264/H.265 over TCP (`POST /mobilerun/screencapture/start`), ReplayKit broadcast, Opus audio | WDA's range | Signed WDA fork (prebuilt runner zips per release) | Yes | Not measured | Alternative if we want to stay WDA-shaped |
| **CoreDevice displayservice** via pymobiledevice3 / go-ios | RTP/HEVC pushed by the device to a UDP socket on the host; audio stream pairs with it | **27** (`9021` error below; some parts 26.6+) | Nothing — DDI + Developer Mode only | pymobiledevice3: userspace tunnel OK. go-ios: kernel tunnel only ("device sends RTP to a host address") | ~5.5 Mbps, ~40–57 fps when moving, ~1 fps static; **motion smearing in VideoToolbox, ffmpeg and WebCodecs alike** — pymobiledevice3's `MOTION_TEAR_FINDINGS.md` concludes only Apple's `avconferenced` decodes it cleanly | Spike, not product, until the smearing is solved |
| CoreDevice screencaptureservice / `ios screenshot --stream` | PNG/JPEG polling | 17+ | DDI | Yes | Screenshot cadence, not video | Diagnostics only |
| AirPlay mirroring receiver (UxPlay) | H.264 + AAC over Wi-Fi (legacy AirPlay 1 protocol) | any | Nothing, user taps Screen Mirroring | Network only, GStreamer | Fine picture; user-initiated; Apple can drop the legacy protocol any release | Not USB, not automatable — no |
| Digital AV adapter → HDMI capture card | Uncompressed HDMI → USB UVC | any | Nothing | Yes (`/dev/video*`) | ~55–80 ms card latency; 1080p; DRM content blacked out; Lightning adapter is itself an H.264 hop | Robust "camera" fallback; costs a port and hardware |
| quicktime_video_hack (old ws-qvh path) | H.264 over usbmux | ≤16 | Nothing | Yes | Was excellent | **Dead** on iOS 17+ (already removed from this repo) |

### 4.3 Input

| Option | What it can do | iOS | Notes |
| --- | --- | --- | --- |
| WDA HTTP (current) | tap, drag, W3C `actions` (multi-pointer pinch etc.), `/wda/keys`, pressButton home/volumeUp/volumeDown/lock, `/wda/unlock`, pasteboard get/set | 11+ | Every command is an HTTP round trip through XCTest; ~50–150 ms per action in practice |
| **DeviceKit JSON-RPC** | `device.io.tap/swipe/longpress`, **`device.io.gesture` multi-finger press/move/release**, `device.io.text`, `device.io.button` (home, lock, volume), `device.clipboard.get/set`, app launch/terminate/foreground, orientation, open URL | 16+ | WebSocket transport, so a streaming touch protocol maps naturally onto it |
| **CoreDevice universal HID** (pymobiledevice3 `developer core-device hid …`, go-ios `ios/hid`) | tap, drag (0–65535 normalised), hardware buttons via `hid.indigo` (home, power/lock, volume, mute, siri), virtual keyboard press/release | **27** (iOS 18 rejects with 9021; `touchscreenGesture`/pointer only on 27) | **Single contact only** (58-byte report); **touch is silently dropped unless a display stream is active**; scroll/gesture/vendor envelopes not yet reverse-engineered |
| USB HID (a host presenting a mouse/keyboard) | OS-level pointer via AssistiveTouch, real keyboard | 13+ | The NUC cannot be a USB gadget; would need a Pi Zero/ESP32-S3 in the cable path and a Lightning camera adapter on this phone. Pointer is relative (cursor), not absolute touch. |
| Bluetooth HID from BlueZ | Same as above over BLE | 13+ | Not USB; Linux-side emulators have Apple-specific pairing failures (EmuBTHID) — fragile |

### 4.4 Everything else

| Capability | Tool | Status |
| --- | --- | --- |
| Screenshot | `ios screenshot`, `pymobiledevice3 developer dvt screenshot` | Works, DDI required on 17+ |
| Files | AFC: media (`/DCIM`, Downloads…) via `ios file pull/push/ls` and `pymobiledevice3 afc`; app containers via house_arrest / `VendDocuments` (go-ios 1.3.1 fallback for App Store apps) | Works; **no root filesystem** on a non-jailbroken phone, and no shell at all |
| App install / list / launch / kill | `ios install`, `ios apps`, `ios launch`, `ios kill` | Works |
| Battery, name, model, iOS version | `ios batterycheck`, `ios info`, lockdown values | Works (tracker already reads some) |
| Clipboard | WDA / DeviceKit pasteboard; go-ios 1.3.0 added a pasteboard service (REST API) | Agent-dependent |
| Lock / unlock, wake | WDA `/wda/lock` + `/wda/unlock`, DeviceKit `button lock`, CoreDevice `hid button power`; passcode typed as keys | Same shape as the Android passcode flow in this repo |
| Lock-state detection | No lockdown key for keyguard; DeviceKit foreground app + WDA `/wda/locked` | Agent-dependent |
| Audio | DeviceKit: ReplayKit broadcast → Opus over TCP 12006 (user must start the broadcast once); CoreDevice: audio stream paired with the display stream | Both viable; neither USB-native without the above |
| Location simulation, syslog, pcap, reboot, developer mode toggle | go-ios / pymobiledevice3 | Works; nice-to-haves |

---

## 5. The signing question (agent routes only)

WDA and DeviceKit are XCUITest bundles; iOS will not run them unsigned. Options, best first:

1. **Paid Apple Developer account ($99/yr) + App Store Connect API key.** `ios sign provision
   appstoreconnect` creates the certificate and profile, `ios ui download` fetches prebuilt WDA
   / DeviceKit, `ios sign app` / `ios ui install` signs and installs — **all from Linux, no Mac**,
   profiles last a year. This is the clean answer.
2. **Free Apple ID.** Needs a Mac with Xcode to build/sign; the profile expires every 7 days,
   so the phone has to be re-provisioned weekly. Fine for a first spike, unacceptable for daily
   use.
3. **Sideloading tools (AltStore/SideStore-style)** could automate the 7-day refresh with a
   free ID; extra moving parts, not recommended.

Route 2 (CoreDevice) needs none of this — only Developer Mode, the DDI, and iOS 27.

### 5.1 Can route 1 run without signing at all?

No. A stock iPhone will not execute an unsigned XCUITest bundle; the only ways around that are:

| Escape hatch | Works on | Verdict for this phone (A15, iOS 27-eligible) |
| --- | --- | --- |
| **TrollStore** (CoreTrust bug: permanent, unsigned install) | iOS 14.0 – 16.6.1, 16.7 RC, 17.0 only; patched from 17.0.1 | Only if the phone has never left iOS ≤ 16.6.1 / 17.0 |
| **Jailbreak** (Dopamine 3.0, Aug 2026) | A14–A17 on iOS 15.0 – 17.3.1; the iOS 18–26.0.1 additions are A12/A13 only | Same: only on an old build; nothing for 18/26/27 on A15 |
| **Free Apple ID, signed for you on Linux** (AltServer-Linux fork with the Sept 2026 sign-in fix, SideStore) | Any iOS | Still signing, but no Mac and no fee; 7-day profiles, 3 apps / 10 app IDs per week. SideStore re-signs from the phone itself on a schedule, so the weekly refresh can be automatic |
| **Paid Developer account via `ios sign provision appstoreconnect`** | Any iOS | Signing, but once a year and fully scripted from Linux |

The only truly signing-free control path on current iOS is route 2 (CoreDevice, iOS 27) or
hardware (HDMI capture for video + a USB HID gadget for a relative pointer/keyboard, which
needs an OTG-capable board in the cable and gives a cursor, not touch).

---

## 6. Recommended architecture

```
Browser  ─WS─▶  ws-scrcpy server (Linux)  ─usbmuxd/RSD tunnel (USB)─▶  iPhone
                 │
                 ├─ GoIosRunner (exists): pairing, tunnel, DDI mount, install, forwards
                 ├─ Agent runner (replace WDARunner): DeviceKit JSON-RPC over `ios forward`
                 │     video  ◀─ GET /h264  (H.264 Annex-B)  ─▶ existing Broadcast/WebCodecs player
                 │     input  ─▶ device.io.gesture / text / button / clipboard
                 │     audio  ◀─ Opus TCP 12006 ─▶ existing AudioPlayer (Opus path already exists)
                 └─ CoreDevice runner (flagged, iOS 27): pymobiledevice3 display + hid
                       video  ◀─ RTP/HEVC UDP ─▶ WebCodecs HEVC (Chrome/Safari)
```

Why this shape: the Android side of ws-scrcpy is already an H.264-over-WebSocket player with
WebCodecs/MSE, an Opus audio path, a control-message layer and a multi-touch interaction
handler. DeviceKit's outputs slot into those with an adapter each, and the JSON-RPC input API
is expressive enough to carry the same touch events the Android `TouchControlMessage` carries.
The CoreDevice route removes the signing burden and the agent's CPU cost, which is why it is
worth a flagged spike — but shipping it depends on someone (Apple, or the community) resolving
the HEVC smearing and on multi-touch landing in the HID reverse-engineering.

### Phases

| Phase | Work | Blocking inputs from the owner |
| --- | --- | --- |
| 0. Unblock the bench | Restart usbmuxd, trust, `ios info`, enable Developer Mode, `ios image auto`, confirm `ios tunnel start --userspace` reaches the phone. Record iOS version. | The sudo restart and the on-phone taps |
| 1. Prove video | Install DeviceKit (signed) with `ios ui install`, forward its port, pull `/h264` into the existing `Broadcast` → WebCodecs player; measure latency vs. the Xiaomi. If iOS ≥ 27: also try `pymobiledevice3 … display serve-web` and note the smearing first-hand. | Apple Developer account **or** a Mac for the first signing |
| 2. Input | Map `InteractionHandler` touch events to `device.io.gesture` (multi-finger), typing to `device.io.text`/keyboard, FAB buttons to `device.io.button`; clipboard read/write. Reuse the Android FAB/sidebar layout instead of the docked iOS bar. | — |
| 3. Lifecycle | Replace `WDARunner` with an agent runner (start/stop/reconnect/generation guards mirroring `Device.ts`), agent health = "stream service" indicator, lock/unlock via the existing passcode sheet. | — |
| 4. Files & extras | Files tool over AFC (media + app containers) using the same FSLS channel with an AFC backend; battery/info in the card; screenshot; audio via ReplayKit broadcast with a one-time on-phone prompt. | — |
| 5. CoreDevice spike (iOS 27) | Behind `IOS_COREDEVICE=true`: pymobiledevice3 subprocess for display + hid, HEVC WebCodecs path, single-touch only. Compare against phase 1 and decide. | Phone on iOS 27 |

Rough sizing: phases 0–3 are a few weeks of focused work on top of the existing runners;
phase 4 is largely reuse; phase 5 is a one-week spike with an unknown outcome.

---

## 7. Gaps against Android parity that will remain

- **No shell.** iOS has no `adb shell` equivalent without a jailbreak; the Shell tool stays
  Android-only.
- **No root filesystem browsing.** AFC exposes media and sandboxed app documents only.
- **Multitouch** depends on the agent route (DeviceKit `gesture`); CoreDevice HID is
  single-contact today.
- **Audio** always needs a one-time on-phone action (ReplayKit broadcast permission) or the
  iOS 27 CoreDevice stream.
- **Signing maintenance** (yearly with a paid account, weekly without) is a recurring chore the
  Android side never has.
- **DRM content** (Netflix, banking apps that set `isSecure`) will render black in every
  capture path, exactly as on Android.

---

## 8. Sources

- go-ios: [README](https://github.com/danielpaulus/go-ios), [releases (v1.3.2, 11 Aug 2026)](https://github.com/danielpaulus/go-ios/releases), [PR #849 CoreDevice HID (merged 15 Sep 2026)](https://github.com/danielpaulus/go-ios/pull/849), [ios/display package docs](https://pkg.go.dev/github.com/danielpaulus/go-ios/ios/display), [tunnel package](https://pkg.go.dev/github.com/danielpaulus/go-ios/ios/tunnel)
- pymobiledevice3: [README](https://github.com/doronz88/pymobiledevice3), [CLI recipes (core-device display / hid)](https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/cli-recipes.md), [iOS 17+ tunnels guide](https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/ios17-tunnels.md), `remote/core_device/display_service.py`, `hid_service.py`, `MOTION_TEAR_FINDINGS.md` (master)
- DeviceKit: [mobile-next/devicekit-ios](https://github.com/mobile-next/devicekit-ios)
- Streaming WDA fork: [droidrun/WebDriverAgent](https://github.com/droidrun/WebDriverAgent)
- CoreDevice HID on iOS 27: [ipbtools/ipb](https://github.com/ipbtools/ipb)
- WDA MJPEG limits: [appium#15264](https://github.com/appium/appium/issues/15264), [FBConfiguration.h](https://cdn.jsdelivr.net/npm/appium-webdriveragent@11.1.0/WebDriverAgentLib/Utilities/FBConfiguration.h)
- WDA on iOS 26: [appium#21347](https://github.com/appium/appium/issues/21347), [appium#21643](https://github.com/appium/appium/issues/21643)
- iOS 27 device list: [Apple Support](https://support.apple.com/guide/iphone/iphone-models-compatible-with-ios-27-iphe3fa5df43/ios)
- AirPlay receiver: [FDH2/UxPlay](https://github.com/fdh2/uxplay)
- AssistiveTouch pointer devices: [Apple Support 111775](https://support.apple.com/en-us/111775)
- usbmuxd/lockdown background: [Understanding usbmux and lockdown](https://jon-gabilondo-angulo-7635.medium.com/understanding-usbmux-and-the-ios-lockdown-service-7f2a1dfd07ae)
