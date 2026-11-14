# To do

Work the owner has asked for or has still to decide, newest first. An item leaves this list when
it is done and recorded in a dated section of `docs/HANDOFF.md`.

## Asked for

### Notifications stop after a silent Bluetooth reconnect (found 2026-11-14)

The owner reported that notifications stopped. Last one stored at 03:11:59 UTC on 2026-11-14;
the status read "Notification response timed out; retrying" for hours. The deploy of 02:01 UTC
is not the cause: notifications arrived after it.

What was seen at 06:07 to 06:15 UTC, read only:

- The phone did not restart (no USB event, same iOS build). The container was healthy, the
  collector running with 0 restarts and no error.
- The LE link was up (`hcitool con`: LE, AUTH ENCRYPT). A trace with btmon showed the collector
  writing a request to the ANCS Control Point every 48 s and the iPhone answering at once on the
  Data Source with a complete, well-formed reply (143 and 206 bytes for two UIDs).
- BlueZ had `Notifying: false` on both the Notification Source and the Data Source
  (`GetManagedObjects`). It was not passing the phone's replies on, so every request timed out.
- The kernel logged `ACL packet for unknown connection handle` at 04:42:07, the line that came
  before the outage of 2026-11-05. bluetoothd logged `Device is already marked as connected` at
  06:05:35. Either is a reconnect that the collector was not told about. Which of the two ended
  the subscription is not known.

Cause in the code: `Client.tick` in `python/notifications/collector.py` adds a characteristic to
`self.ready` after `StartNotify` and never takes it out again. It learns of a lost link only
from `Connected: false` on the device. When BlueZ attaches to the phone again without that
signal, the subscription is gone and the collector goes on asking.

- Fix: in `Client.tick`, a characteristic that is in `ready` but has `Notifying: false` in the
  fresh object list leaves `ready` and `owned_notifications`, so `StartNotify` is called again.
  The iPhone announces its alerts once per subscription, so decide whether a new subscription
  needs a new session id for the feed.
- A test in `python/notifications/test_collector.py`: a client that is ready, `Notifying` turns
  false with no `Connected` change, and the next tick subscribes again.
- This is a server change: read the diff before the deploy and say so in the report.
- Until it is deployed, a restart of the container brings notifications back (the new collector
  subscribes afresh and the LE link stays). Only on the owner's word, not within 15 minutes of
  03:00 or 15:00 UTC, and not while a screen session runs.

### The picture of an iPhone is too bright and too contrasty (owner, 2026-11-14)

The owner's words: "the colors look like the contrast is turned all the way up on iphone", then
"android looks right but iphone looks too bright. i am using chrome". So this is the picture of
an iPhone's screen in the app, in Chrome. An Android phone's picture is right in the same
browser. Not known: whether that is Chrome on a desktop or on the owner's iPhone.

- A lead, not a finding: the iPhone players hand the browser no colour information. In Chrome
  the stream goes to `WebCodecsHevcPlayer.ts` first (`StreamClientCoreDevice.ts`, the choice
  near line 511), whose decoder config is `{ codec, description, optimizeForLatency }` with no
  `colorSpace`. The MSE player's fMP4 header (`hevcFmp4.ts`) has no `colr` box. The browser then
  takes the range and the primaries from the stream's own header, or guesses.
- A full-range picture read as limited range has clipped whites and crushed blacks: too bright
  and too contrasty together, which fits the report. The stream is 8-bit (`hev1.1.6.L150.B0`,
  Main profile, seen in the deploy check of 2026-11-14), so HDR is the less likely cause.
- First read what the phone sends: from a few seconds of the stream, the SPS colour fields
  (`video_full_range_flag`, primaries, transfer, matrix). Compare one frame with
  `screen-capture screenshot` of the same screen, which needs no display session.
- Then say the same to the browser: `colorSpace` (with `fullRange`) in the WebCodecs decoder
  config, and a `colr` box in the fMP4 header for the MSE player. If the stream's header is
  wrong or empty, look for a setting of pymobiledevice3's screen stream for the range or the
  pixel format.
- Reading the stream needs a display session. Take it during the one session of a deploy check,
  not in a session of its own.
- Needs hardware: headless Chromium cannot decode the iPhone's video, so only the owner's
  Chrome can show the result. Check both players if the owner also uses Safari.

### Files: holding a file selects it, without the iOS menu (owner, 2026-11-14)

On a touch screen, holding a file or a folder in Files selects it and starts multi-select. No
menu opens: not ours, and not the browser's. (The owner first asked for the right-click menu on
a hold, then chose selection. The row's menu stays on its ⋮ button.)

- The code already means to do this: `onPointerDown` in `FileListingClient.ts` starts a timer
  (`LONG_PRESS_MS`, 450 ms) that selects the row and turns selection mode on.
- What happens on the owner's iPhone in Safari (screenshot of 2026-11-14): iOS shows a preview
  of the page and its own menu (Open, Add to Reading List, Copy Link, Share…, Ask Siri). The
  name of a row is a link with an address, and `filelisting.css` has no rule that turns the iOS
  callout off.
- Fix: on touch, `-webkit-touch-callout: none` and `user-select: none` on the row and its link,
  as the kit's icon button has, and `draggable="false"` on the link so iOS does not lift it for
  a drag. If the preview still shows, the name must stop being a link with an address on touch.
- Check that iOS does not cancel the pointer before the 450 ms are over; a cancelled pointer
  clears the timer and nothing would be selected.
- The tap that ends the hold must not open the file's sheet or a folder (the code already drops
  the click that follows a hold).
- Checks on fixtures in the touch flow of `e2e-files-flows.js`. Needs hardware: Safari and the
  installed app on the iPhone. A fixture cannot show the iOS menu.

### Show touches (owner, 2026-11-14)

A circle under each finger, or under the mouse pointer while its button is down, on the picture
of a phone's screen. Like "Show taps" in Android's developer options.

- Draw it in the browser, in a layer over the picture. It is then the same on Android and on an
  iPhone, it shows at once without waiting for the video, and it is not in a screenshot. The
  phone's own setting (`settings put system show_touches 1` over adb) is Android only and also
  shows on the phone itself; do not use it for this.
- One circle for each pointer that is down, so two fingers and the Ctrl+drag pinch show two. It
  follows the pointer and fades when it is let go; no fade with reduced motion.
- Place it from the same point mapping the input uses (`PointMapper`), so it is where the phone
  receives the touch, also when the picture has bands beside it.
- The layer takes no press (`pointer-events: none`) and must not remount the stream view.
- A switch "Show touches" in Settings, kept in this browser, off by default. The Stream section
  is Android only, so it needs a place both kinds of phone have.
- Colour and size from the tokens. Checks on fixtures beside the touch suites.
- Needs hardware: a finger on the iPhone 17 Pro Max, and how far the circle runs ahead of the
  picture.

## To decide (inspection of 2026-11-14)

The text of each is in `docs/HANDOFF.md`, section "Owner UI feedback: header status, controls,
icons and Files".

- On Files and Shell the header shows "Stream service: Stopped" under "Connected" once the
  stream has stopped, which is the normal state there (seen in the owner's screenshot of
  2026-11-14). The header is then three lines high. Leave the service line out on those tabs?
- Hide the Keyboard section of Settings and the keyboard hints on a touch phone, or keep them
  for a phone with a keyboard attached.
- Files in landscape on touch: the toolbar runs off the edge; the quick access rows are 22 px.
- The header, tabs and lock notice take 157 of 440 px in landscape.
- Shell's key row is wider than a 440 px screen.
- Files uses one arrow for Forward and for Move; the root "/" of the address is 17 px wide.
- On a desktop the cards of Phones stretch to the tallest in their row, and "Volume down" wraps
  in the rail.
- With two iPhones the switcher of Notifications is a chevron on its own.
- A download in the installed app on an iPhone: try it; if iOS still replaces the app, use the
  share sheet with a size limit.
