# To do

Work the owner has asked for or has still to decide, newest first. An item leaves this list when
it is done and recorded in a dated section of `docs/HANDOFF.md`.

## Asked for

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
