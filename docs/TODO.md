# To do

Work the owner has asked for or has still to decide, newest first. An item leaves this list when
it is done and recorded in a dated section of `docs/HANDOFF.md`.

## Asked for

Nothing open.

## Built in step 8, to try on hardware

Built and checked on fixtures only. What each does and what to try is in `docs/HANDOFF.md`,
section "Step 8: a theme option, Android's touch dot and the Files address highlight".

- Theme: a button in the bar of the Phones page with System, Light and Dark, kept in the browser.
- Show touches: a small white dot with a dark edge, as Android draws one.
- Files on a desktop: the highlight of a path part and of the edit button stays inside the
  address field.

## Built in step 7, to try on hardware

Built and checked on fixtures, live since 2026-11-16. What each does and what to try is in
`docs/HANDOFF.md`, section "Step 7: owner feedback of 2026-11-14 and the notifications outage".

- Notifications: 8 px between the bar and the filter row, and Switch as a word in the bar.
- Notifications after a silent Bluetooth reconnect: the collector subscribes again (a server
  change: the deploy rebuilds the image).
- The picture of an iPhone in Chrome: the colour range is told to the browser, with a "Picture
  colour range" row in Settings, About, to compare.
- Files: a hold selects a row with no iOS menu; the phone layout on a touch screen below 1024 px;
  Move has its own icon; wider crumbs.
- Show touches: a mark under each finger, switched in Settings, Keyboard, Touch (its look
  changed in step 8).
- Files and Shell header without the stream service line, cards of Phones at their own height,
  the desktop rail on one line per caption, Shell keys in two rows below 600 px, and the Quality
  hint without its keyboard sentence on touch.

## To decide (inspection of 2026-11-14, and the reviews of steps 7 and 8)

The text of the first three is in `docs/HANDOFF.md`, section "Owner UI feedback: header status,
controls, icons and Files"; of the others, in section "Step 7: owner feedback of 2026-11-14 and
the notifications outage".

- Hide the Keyboard section of Settings and the keyboard hints on a touch phone, or keep them
  for a phone with a keyboard attached.
- The header, tabs and lock notice take 157 of 440 px in landscape.
- A download in the installed app on an iPhone: try it; if iOS still replaces the app, use the
  share sheet with a size limit.
- An iPad in portrait (a touch screen from 701 to 1023 px) now gets the phone layout of Files:
  no sidebar, no command row, and no Size and Type columns. Ctrl+F there goes to the hidden
  filter field. Keep it, or give a tablet the desktop layout from some width.
- The picture colour range is one setting for every iPhone in this browser. Keep it, or keep it
  per iPhone.
- Safari: Auto now tells every browser BT.709, transfer included. Apple draws video tagged
  BT.709 with a lighter curve, so dark areas of an iPhone's picture may look a little lighter in
  Safari than before. Compare Auto and Limited in Safari before choosing.
- The installed app's splash and title bar before the page loads are always dark
  (`src/public/manifest.json`), whatever theme is chosen. Keep it, or pick one neutral colour.
- The Theme button is in the bar of the Phones page. Keep it there, or also offer the choice in
  the Settings sheet of a phone.
- Files on a desktop: a press on a slash of the address opens the path editor, as before. Keep
  it, or make a slash do nothing.
- Files on a desktop: the start of a long path fades over 4 px, not 16 px, since the path kept
  its place. Keep it, or move the path 4 px to the right for a longer fade.
