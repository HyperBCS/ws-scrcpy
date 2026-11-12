# Redesign plan for phases 3 to 6

Checked against `review-fixes` at `5205ec5` (2026-11-11). Nothing was run or changed. Another agent was committing scheduled-unlock work during the check; re-check `ApplSettingsSheet.tsx`, `DeviceCard.tsx`, `CoreDeviceStreamView.tsx` and `state/unlockSchedule.ts` before step 5b.

The owner answered the ten decisions on 2026-11-11 and asked for a mockup before the redesign starts. The mockup (https://claude.ai/artifact/6yEd8UDG8GjH6gFNyRcGnu) was published the same day and the owner approved it ("looks good") with no changes, so step M is done. Section 5 records the answers; the packages below already reflect them.

Path roots used below:
- `A/` = `/home/brandon/ws-scrcpy/src/app/`
- `S/` = `/home/brandon/ws-scrcpy/src/style/`
- `V/` = `/home/brandon/ws-scrcpy/src/server/`
- `T/` = `/home/brandon/ws-scrcpy/scripts/`

## 1. Finding status

71 findings fall in phases 3 to 6 (55 register rows plus 16 duplicates, of which 6 are in these phases).

| Phase | Total | Open | Changed in shape | Closed |
| --- | --- | --- | --- | --- |
| 3 navigation | 14 | 7 | 5 | 2 |
| 4 design system | 13 | 10 | 3 | 0 |
| 5 one template | 19 | 8 | 11 | 0 |
| 6 screen rebuilds | 25 | 18 | 7 | 0 |
| All | 71 | 43 | 26 | 2 |

Three re-assignments:
- U-flows-8 moves from phase 3 to phase 6, because it needs the same capture state and header chip as U-stream-6.
- C-client-ui-11 moves from phase 5 to phase 4, so the Android settings sheet is rebuilt once.
- The dead-code findings (C-client-stream-12, C-client-ui-15, C-client-tools-css-12) run first, as step 0.

The phase 2 duplicates done "small part only" (U-home-7, U-home-10, U-system-12) are carried by U-flows-4, U-system-3 and U-settings-9.

### Phase 3

| ID | Status | Current state |
| --- | --- | --- |
| U-flows-1 | Open | `goToDeviceList()` is a push (`A/state/router.ts:86`). The switcher (`A/views/DeviceSwitcherSheet.tsx:93,118`) and tool tabs (`A/views/ToolView.tsx:82,268`) assign `location.hash`. |
| U-flows-2, U-stream-4, U-settings-2 | Open | No `popstate` listener and no overlay entries. Escape order was fixed (5e52970). `closeAllSheets()` still runs only when a stream or tool view mounts or unmounts. |
| U-flows-4 | Changed | Files and Shell are visible card actions (121cbdd). The tab strip still lists Files and Shell only (`ToolView.tsx:42-49`), and the screen links to neither. |
| U-flows-6, U-system-15 | Changed | Names, tab titles and app name are unified (4d7a804, cd5b0a3); every header has the bell (18f8c49). The header is still copied in `StreamView.tsx:97`, `CoreDeviceStreamView.tsx:162`, `ToolView.tsx:277` and `ToolUnavailable.tsx`. Notifications still has "← Devices" over a title. "Disconnect" (`ActionsSheet.tsx:235`) and the "Back to devices" footer (`ApplActionsSheet.tsx:608`) remain. |
| U-flows-8 | Changed, moved to phase 6 | Ctrl+K opens the switcher (910cd12), but with capture on the phone gets the key (`A/state/switcherKeys.ts`). No release chord, no chip. |
| U-flows-10, U-tools-6 | Closed | 2c94f8e: default path has no slash, a normalised path uses `replaceRoute` (`FileListingClient.ts:2415`), in-app Back and Forward call the browser's (`:1570`). Keep one regression check. |
| U-flows-11 | Open | The iPhone select still pushes (`NotificationHistory.tsx:476`); the panel is component state. |
| U-flows-12 | Changed | The socket is always this server (8118784), so no LAN address is stored; "Viewing" matches by udid. Links still carry `player` and `ws` (`DeviceCard.tsx:215`, `DeviceSwitcherSheet.tsx:111`). |
| U-notifications-8 | Open | Filter, query and app filter are `useState` (`NotificationHistory.tsx:132-135`). |
| U-tools-5 | Open | A tab change unmounts the tool (`ToolView.tsx:116-212`). |

### Phase 4

| ID | Status | Current state |
| --- | --- | --- |
| U-system-2 | Open | `.sheet-button`, `.fx-button`, `.settings-sheet-button`, `.ui-button`, `.control-button` and three element-selector rules (`.notifications-page button`, `.stream-header button`, `.tool-navigation button`) still exist. `#2563eb` appears 12 times. |
| U-system-3 | Open | 38 distinct font-size declarations; root is 14 px (`S/tokens.css:37`). |
| U-system-6, U-tools-12 | Open | Still six containers: BottomSheet (a div), NotificationActionSheet (native dialog), the Files dialog, the Files menu, Type text, the controls popover. The desktop top edge was pinned (988a9db). |
| U-system-8 | Changed | Toast has one error tone and sheet results sit under their group (7f162bc). About ten other message forms remain. |
| U-system-10 | Changed | Listen has its own icon (702ee24). Material files, inline SVGs and text glyphs (`deviceStatus.ts:30-38`, `SleepOverlay.tsx`) remain. |
| U-system-11 | Changed | The switcher field is fixed (910cd12). Scoping is not done; 14 `!important`, 14 breakpoints, 13 z-index values. |
| U-system-13, C-client-tools-css-11 | Open | Status tokens gained `-fill` and `-text` (8a80c99). Names are still upstream's; two radius tokens against 29 values. |
| U-system-14 | Open | No shared Field or Switch. |
| U-settings-10 | Open | `SettingsSheet.tsx` and the unlock sheets still use their own classes. |
| U-notifications-12 | Open | Own header, own sheet and `.notifications-page button` (`S/views/Notifications.css:137`). |
| C-client-tools-css-10 | Open | `content: '' !important` marker override is still in `S/app.css`. |

### Phase 5

| ID | Status | Current state |
| --- | --- | --- |
| U-home-5 | Open | Badge, "Stream service" line, banner, hint and a disabled button all remain; phase 2 added problem lines (0c57def). |
| U-home-6 | Open | Two precedences (`A/state/deviceStatus.ts:87-108` and `150-181`). |
| U-home-12 | Changed | Rows use the shared status for unavailable phones and have keyboard support (910cd12). They still show tracker name and serial, no OS, no unread count, and "Screen →" for every state. |
| U-stream-7 | Changed | The iPhone has a Settings button (558feaa). Slots and the Power/Lock name still differ. |
| U-stream-8, U-system-5 | Changed | Sound is the first group on both; wording says "phone" (df2788a). Order, exit rows and the conditional Unlock row still differ. |
| U-stream-11 | Changed | The iPhone has one failure card with Retry (05cc03c). Android still shows "Connecting…" in the header over "Reconnecting…"; errors use the amber dot; the title falls back to the serial. |
| U-stream-14 | Open | `.stream-notice` is still fixed at 56 px (`S/views/StreamView.css:135`). |
| U-stream-15 | Changed | Android accepts swipes from beside the picture and no longer mirrors horizontal wheel (2129e23, dc80520). The iPhone has no wheel; right-click and pinch still differ. |
| U-settings-4 | Open | Two-step apply bar remains (`SettingsSheet.tsx:764-791`). |
| U-settings-6 | Changed | The iPhone unlocks with the server-stored passcode in one sheet button. Both platforms still need notice, sheet, button, close. |
| U-settings-7 | Changed, mostly closed | Owner decisions in phase 1: no iPhone browser copy; Android copy only behind "Remember in this browser", saved after confirmation. Left: no overview, and Forget is reachable only while locked. |
| U-settings-8 | Changed | The two sheets now differ by design (the iPhone has no field). States, labels and tones can still be shared. |
| U-settings-9 | Changed | Phase 2 named the sheets by content ("Stream settings", "Scheduled unlock"). One sheet with fixed sections is not done; Android has Sound in two sheets. |
| U-system-7 | Open | "Asleep", "Screen is asleep.", "Screen is off"; "Locked", "Device locked", "Lock screen active"; raw values on the iPhone card (`DeviceCard.tsx:575-579`). |
| C-client-stream-9 | Changed | Held buttons share `A/toolbox/heldButtons.ts`. Two reconnect loops remain, now different on purpose (Android 1.5^n to 8 s; iPhone 2^n to 60 s with stop rules). |
| C-client-ui-10 | Open | Header, start error, clipboard group and service rows are still copied. |
| C-client-ui-11 | Open, moved to phase 4 | `SettingsSheet.tsx` is 801 lines. |
| C-client-ui-14 | Open | Title-string list at `FloatingToolbar.tsx:159-176`. |

### Phase 6

| ID | Status | Current state |
| --- | --- | --- |
| U-home-8 | Changed | Scroll and open cards are restored (0c57def). Cards still vanish on a socket close (`A/client/BaseDeviceTracker.ts` `onSocketClose`), and the empty state shows before the first list. |
| U-home-9 | Open | |
| U-stream-6, U-stream-9, U-stream-10 | Open | |
| U-stream-12 | Open | The only paste handler is in `LiveTextOverlay.tsx:323`. |
| U-notifications-4 | Changed | Phase 2 added the feed state row and "Open screen" (ddac032), so more rows precede the first card. |
| U-notifications-5, -7, -13, -14 | Open | |
| U-tools-9 | Changed, mostly closed | Uploads queue with Cancel (c7927c5); downloads go through the browser (1509c76). Left: uploads still block other commands (`FileListingClient.ts:889`) and show a percentage, not a bar. |
| U-tools-11 | Changed | Ctrl is one-shot (29cdaff). Arrows left and right, Paste, Copy, text size and hiding the row on desktop remain. |
| C-server-core-11 | Open | README still says Node v10+, scrcpy 3.1 and clones NetrisTV. |
| C-server-core-12 | Open | 35 distinct `process.env` reads in 18 files. |
| C-server-core-14, C-server-ios-14 | Changed | `V/Shutdown.ts` exists and the monitor is guarded. `ControlCenter.release()` still calls `CoreDeviceRunner.getInstance()` (`V/appl-device/services/ControlCenter.ts:466`). |
| C-server-android-14 | Changed | `Device.ts` grew to 1,248 lines in phase 2. The timer leak is fixed (`:204`). `runShellCommandAdb` is still dead (`:261`). |
| C-ios-unlock-13 | Open | Plan references at `UnlockScheduler.ts:106` and `IosSettingsStore.ts:236`; W1/W2 notes remain. |
| C-notifications-9 | Open | Now 1,203 lines. |
| C-client-stream-12, C-client-ui-15, C-client-tools-css-12 | Open | `MediaFormat.ts` (935 lines), four other unreferenced files, `lastFrameAt` and `S/morebox.css` are all still present. |
| C-client-tools-css-9 | Open | `FileListingClient.ts` is now 2,883 lines. |
| C-client-tools-css-13 | Open | One full sort and rebuild per frame. |

## 2. Target structure

### Navigation

**Routes.** Keep the `#!key=value` form. The service worker, push banners already delivered, the manifest shortcut and 15 test scripts read it.

| Page | Route | Notes |
| --- | --- | --- |
| List (root) | `#!` | History root. Push alerts use `#!action=`. |
| One phone | `#!action=device&udid=<udid>&view=screen\|files\|shell[&path=]` | Platform, player and socket are resolved from the phone list. `player` stays an optional override. |
| Notifications | `#!action=notifications[&source=][&panel=setup][&filter=][&app=][&q=]` | Unchanged prefix, so stored push links work. |

- Old `action=stream`, `stream-coredevice`, `shell` and `list-files` links are rewritten with `replaceState` before the first view mounts.
- The key stays `udid`, so a stale service worker still leaves a phone's page alone (`/home/brandon/ws-scrcpy/src/public/sw.js:86-87`).
- A per-browser cache of udid to name and platform lets a cold link start without waiting for the list. It also keeps the name when the phone drops (U-stream-11).

**History policy.** The router owns three verbs; views stop assigning `location.hash`.

| Verb | History | Used for |
| --- | --- | --- |
| open | push | List to a phone, list to Notifications, "Open screen" from a notification, a Files folder step |
| switch | replace | Tab change, phone switcher, iPhone select, filter and search, a normalised path, old-link rewrite |
| up | `history.back()` if the previous entry is the app's, else replace with the list | The back control in every header |

**Overlays.** One hook: opening pushes a state entry with the same address; `popstate` closes the top overlay; the close button, backdrop and Escape call `history.back()`. The router closes every overlay on a route change. Router, overlay and Files keep separate keys in `history.state`.

**Pages and sheets.**
- Pages: the list, one phone's page with tabs, Notifications with Setup as a panel.
- Sheets: Actions, Settings, Unlock, Switch phone, Type text, notification actions, Files menus on touch, confirms.
- No bottom bar or left rail. The bell on every header was the phase 2 answer to U-flows-3, and no open finding asks for more.

**One header.** `AppBar` (back, title, one status line, actions) and `TabStrip`, used on all pages. Phase 3 extracts the existing stream header and keeps its class names, so looks and test selectors do not change until phase 4.

### Design system

**Tokens.** Role names replace upstream names: surface, surface-raised, border, border-strong, text, text-muted, accent, on-accent, danger, success, warning, each status as `-text` and `-fill`.

| Scale | Values |
| --- | --- |
| Type | 12, 13, 15, 17, 20, 24 px; 16 px inputs; weights 400, 600, 700; root 16 px |
| Space | 4, 8, 12, 16, 20, 24, 32 |
| Radius | 8, 12, 20, full |
| Control height | 44, 32 |
| Breakpoints | 600, 1024 |
| Z | header, overlay, sheet, toast |

Motion tokens stay. Old names remain as aliases until the end of phase 4.

**Scoping.** `@layer tokens, base, components, views`. CSS modules are not used: Files and the toolbox build HTML strings with class names, and about 60 test scripts select on them. A node script in `npm test` rejects raw colours, sizes, radii and `!important` outside the token file. This needs no new dependency.

**Components** in `A/ui/`:
- Button, IconButton, Icon (one local stroke set, also exported as strings for imperative code), Field, Switch, SegmentedControl.
- Group and Row (today's `SheetGroup` and `SheetRow`), Disclosure.
- Sheet on native `<dialog>` (bottom sheet below 600 px, 560 px dialog above), Menu, ConfirmPrompt (exists).
- InlineStatus, Banner, Toast (exists), AppBar, TabStrip.
- Components are class-based, so the Files dialog can use Sheet styles without Preact.

### One phone page

- **Adapter per platform.** Name, capabilities (files, shell, panels, rotate, clipboard read and paste, unlock kind, power, scheduled unlock, stream quality), handlers and the stream client.
- **One status module.** Connection: Connecting, Connected, Reconnecting, Offline, Failed, Stopped. Screen: On, Asleep. Lock: Locked, Unlocked. One precedence: Unauthorized, Offline, Error, Starting, Asleep, Locked, Ready. "Being viewed" is a secondary marker.
- **One screen view.** AppBar, one banner slot in the layout, the stage, one state card with one action (Wake, Unlock, Retry).
- **One controls definition as data.** Id, label, icon, slot, hold behaviour, needs-connection. Rendered by Preact in two files (rail, touch panel). This removes the title-string matching.
- **One Actions sheet.** One-shot actions in a fixed order: Clipboard, Screen, Lock, Power. Exit rows are removed.
- **One Settings sheet.** Sections Stream, Sound, Keyboard, Unlock, About and troubleshooting. It opens from the list for any phone state and from the screen. The card disclosure goes away.
- **One Unlock sheet.** Same states, labels and tones; the field exists only on Android. With a saved passcode the notice's Unlock button acts in one tap.
- **One row component** for the list card and the switcher.

Sound and Keyboard are placed in Settings because their values persist. The findings give two orders (U-stream-8, U-settings-9); this is cheap to flip.

The owner chose between the both-defensible structures on 2026-11-11 (section 5): Settings is a sheet, the stream stops at once on a tab change, touch controls stay a floating button, and the desktop gets the rail plus a side panel.

## 3. Work packages

Rules for every package:
- Packages in one step run in parallel and own disjoint files. Each step is merged and checked on its own. A file passes to a later step only where named.
- Workers do not edit `package.json`, the default suite list in `T/test-browser.js`, or `docs/HANDOFF.md`. They report new tests and a handoff paragraph; the integrator adds them. Suites no package owns are fixed by the integrator.
- The hard rules of the phase 1 and 2 run apply unchanged (no real server, adb, pymobiledevice3 or Docker; fixtures only; `needs_hardware` is reported, never claimed).
- Tests: U = unit files in `npm test`, B = suites through `T/test-browser.js`, H = hardware.

### Step M: mockup (before any redesign package starts)

| Key | Covers | Form | Owns | Tests | Size |
| --- | --- | --- | --- | --- | --- |
| pM-mockup | The Phones list and one phone's page (Android and iPhone: tabs, header, controls, state cards, switcher); the sheets (Actions, Settings with Scheduled unlock, Unlock) as bottom sheets on a phone and in the side panel on a desktop; Notifications (inbox, Setup, mute list); Files (selection bar, menus) and Shell (key row) | One clickable private page: phone and desktop width, light and dark, working tabs, sheets and Back, placeholder phone pictures, no real phone behind it | A standalone page outside `src/`; nothing in the app changes | The owner reviews it. Changes the owner asks for go into section 2 before step 0. | Medium |

The mockup uses the token scales and component list of section 2 and the decisions of section 5, so it is also the first check of the design system. It is not shipped and no package imports from it.

### Step 0

| Key | Phase | IDs | Owns | Tests | Size |
| --- | --- | --- | --- | --- | --- |
| p0-dead-code | 6, run first | C-client-stream-12, C-client-ui-15, C-client-tools-css-12 (TypeScript part) | Deletes `A/googDevice/android/MediaFormat.ts`, `A/interactionHandler/SimpleInteractionHandler.ts`, `A/toolbox/ToolBoxCheckbox.ts`, `A/googDevice/filePush/ScrcpyFilePushStream.ts`, `A/googDevice/DragAndPushLogger.ts`, two dead `.d.ts` files, the appium and mjpeg typings, unused icons, `lastFrameAt` and its three writers, unused methods. `MsePlayer.jumpToEnd` has two `removeEventListener` references to remove with it. | Full check, all B suites. No H. | Small |

### Phase 3

| Step | Key | IDs | Owns | Needs | Tests | Size |
| --- | --- | --- | --- | --- | --- | --- |
| 3a | p3-foundation | U-flows-1, U-flows-12, U-flows-2 (hook and close on route change), U-flows-6 (component) | `A/state/router.ts`, new `A/state/routes.ts`, `A/state/links.ts`, `pageTitle.ts`, `unlockDevice.ts` (route check only), `A/views/App.tsx`, new `A/views/DevicePage.tsx` (stub holding today's three branches), new `A/ui/AppBar.tsx`, `TabStrip.tsx`, `overlayHistory.ts`, `S/ui/AppBar.css`, `/home/brandon/ws-scrcpy/src/public/sw.js` | p0 | U: new `T/test-routes.js`, `T/test-notification-worker.js`. B: new `T/e2e-navigation.js` (Back from every page never shows a stream; one socket per open). | Large |
| 3b | p3-device-page | U-flows-4, U-tools-5 (hosting), U-flows-6, U-system-15 | `A/views/DevicePage.tsx` (from 3a), `StreamView.tsx`, `CoreDeviceStreamView.tsx`, `ToolView.tsx`, `ToolRoute.tsx`, `ToolUnavailable.tsx`, `DeviceList.tsx`, `DeviceCard.tsx` (links), `DeviceSwitcherSheet.tsx` (navigation), `ActionsSheet.tsx` and `ApplActionsSheet.tsx` (exit rows), `SleepOverlay.tsx`, `A/googDevice/client/deviceTools.ts`, `S/views/StreamView.css`, `ToolView.css` | 3a | B: tools, home, switcher, android-stream, new `T/e2e-device-page.js`. H: both platforms. | Large |
| 3b | p3-tools-nav | U-tools-5 (state kept), U-flows-2 (Files dialogs and menus), checks for U-flows-10, U-tools-6 | `A/googDevice/client/FileListingClient.ts`, `ShellClient.ts` | 3a | U: `T/test-files.js`, `T/test-shell.js`. B: files, files-flows. | Medium |
| 3b | p3-overlays | U-flows-2, U-stream-4, U-settings-2 | `A/ui/BottomSheet.tsx`, `A/views/LiveTextOverlay.tsx`, `NotificationActionSheet.tsx`, `FloatingToolbar.tsx`, `A/state/stream.ts`, `settingsSheet.ts` | 3a | B: sheets, sheet-chrome, confirm, new `T/e2e-overlay-back.js` (includes reload with a sheet open). H: Back gesture in the installed app. | Medium |
| 3b | p3-notifications-nav | U-flows-11, U-notifications-8, U-flows-6 (Notifications header) | `A/views/NotificationsView.tsx`, `NotificationHistory.tsx`, `A/ui/NotificationsLink.tsx`, `A/state/notificationsTarget.ts`, `S/views/Notifications.css` | 3a | U: `T/test-notification-page.js`. B: notifications. | Medium |

Contract between p3-device-page and p3-tools-nav: `MountedTool` gains `setActive(active)`. The page calls it on a tab change; Files and Shell implement it. The upload leave guard asks only when leaving the phone's page.

### Phase 4

| Step | Key | IDs | Owns | Needs | Tests | Size |
| --- | --- | --- | --- | --- | --- | --- |
| 4a | p4-tokens | C-client-tools-css-11, U-system-13, U-system-3 (scale), U-system-11 (layers) | `S/tokens.css`, `S/app.css`, the layer wrapper and rem-to-px conversion in every other `S/` file (no value change) | 3b | U: new `T/test-style-rules.js`. B: all, plus new `T/e2e-atlas.js` (fixture screenshots, both themes, 390 and 1440 px) for before and after. | Medium |
| 4b | p4-kit-controls | U-system-2, U-system-10, U-system-14, U-system-8, U-settings-10 (missing parts), C-client-tools-css-10 (marker) | New `A/ui/Button.tsx`, `IconButton.tsx`, `Icon.tsx`, `icons.ts`, `Field.tsx`, `Switch.tsx`, `SegmentedControl.tsx`, `InlineStatus.tsx`, `Banner.tsx`; `A/ui/Toast.tsx`, `AnimatedDetails.tsx`, `SheetControls.tsx`, `AppBar.tsx`, `TabStrip.tsx` and their CSS; a kit page at `#!action=kit` (one line in `App.tsx`) | 4a | B: new `T/e2e-kit.js` (heights, sizes from the scale, one accent). | Large |
| 4b | p4-kit-sheet | U-system-6 | `A/ui/BottomSheet.tsx` (becomes Sheet), new `Menu.tsx`, `sheetDrag.ts`, `dialogFocus.ts`, `Presence.tsx`, `ConfirmAction.tsx`, `A/views/NotificationActionSheet.tsx` (thin wrapper), `S/ui/BottomSheet.css`, `ConfirmAction.css` | 4a | B: sheets, sheet-chrome, confirm, overlay-back. H: on-screen keyboard in a sheet on iOS Safari. | Large |
| 4c | p4-adopt-sheets | U-settings-10, C-client-ui-11, U-system-6 (Type text) | `A/views/SettingsSheet.tsx`, `ApplSettingsSheet.tsx`, `UnlockSheet.tsx`, `ApplUnlockSheet.tsx`, `ActionsSheet.tsx`, `ApplActionsSheet.tsx`, `LiveTextOverlay.tsx`, `LockScreenNotice.tsx`, new `A/state/streamConfig.ts`, `S/views/SettingsSheet.css`, `UnlockSheet.css`, `ActionsSheet.css`, `LiveTextOverlay.css` | 4b | U: `T/test-sheet-ui.js`. B: settings, unlock, ios-settings, ios-typing. | Large |
| 4c | p4-adopt-list | U-system-2, -3, -8, -10 on the list | `A/views/DeviceList.tsx`, `DeviceCard.tsx`, `DeviceSwitcherSheet.tsx`, `A/ui/AsleepBanner.tsx`, `StreamServiceStatus.tsx`, `TrackerStatusNotice.tsx`, `ErrorBoundary.tsx`, `NotificationsLink.tsx` and their CSS | 4b | U: `T/test-home.js`. B: home, switcher. | Medium |
| 4c | p4-adopt-screen | U-system-10 (toolbar icons, glyphs), U-system-2, -3, -8 on screen and tool chrome | `A/views/DevicePage.tsx`, `StreamView.tsx`, `CoreDeviceStreamView.tsx`, `ToolView.tsx`, `ToolUnavailable.tsx`, `FloatingToolbar.tsx`, `SleepOverlay.tsx`, `A/toolbox/*`, `A/ui/SvgImage.ts`, both toolbox files (icons only) and their CSS | 4b | B: android-stream, tools, device-page, audio-availability. | Large |
| 4c | p4-adopt-notifications | U-notifications-12, U-system-2, U-system-14 | `A/views/NotificationsView.tsx`, `NotificationHistory.tsx`, `NotificationCard.tsx`, `NotificationMedia.tsx`; deletes `NotificationActionSheet.tsx`; splits `S/views/Notifications.css` into page, inbox and setup files | 4b | B: notifications, motion. | Medium |
| 4c | p4-adopt-files | U-tools-12, U-system-6 (Files dialog, menus), C-client-tools-css-10 (override blocks) | `A/googDevice/client/FileListingClient.ts`, `A/googDevice/filePush/FilePushHandler.ts`, `S/filelisting.css` | 4b | U: `T/test-files.js`. B: files, files-flows. | Large |
| 4d | p4-close | U-system-13, U-system-11 (enforcement), C-client-tools-css-10 (rest), C-client-tools-css-12 (CSS part) | Removes token aliases, `S/morebox.css` and unused classes; empties the allow-list in `T/test-style-rules.js` | All of 4c | Full check, atlas compare. | Small |

### Phase 5

| Step | Key | IDs | Owns | Needs | Tests | Size |
| --- | --- | --- | --- | --- | --- | --- |
| 5a | p5-status | U-home-6, U-system-7 (module), U-stream-11 (model) | New `A/state/phoneStatus.ts`, `capabilities.ts`, `A/copy.ts`; `A/state/deviceStatus.ts` and `streamService.ts` become re-exports; `A/state/devices.ts` | 4d | U: new `T/test-phone-status.js`. | Medium |
| 5b | p5-settings-sheet | U-settings-9, U-settings-4, U-settings-7, C-client-ui-10 (service rows, retained target) | `A/views/SettingsSheet.tsx` and `ApplSettingsSheet.tsx` become one sheet with section files; `A/state/settingsSheet.ts`, `streamConfig.ts`, `A/views/App.tsx`, `S/views/SettingsSheet.css` | 5a | B: settings, ios-settings (must pass with no change to the schedule logic). H: Android apply and restart. | Large |
| 5b | p5-actions-sheet | U-stream-8, U-system-5, C-client-ui-10 (clipboard group) | `A/views/ActionsSheet.tsx` and `ApplActionsSheet.tsx` become one sheet; `A/client/trackerCommand.ts`, `A/ui/clipboardLimit.ts`, `copyText.ts`, `S/views/ActionsSheet.css` | 5a | B: new `T/e2e-actions-sheet.js`. H: clipboard on both. | Medium |
| 5b | p5-unlock | U-settings-6, U-settings-8, C-client-ui-10 (unlock form) | `A/views/UnlockSheet.tsx`, `ApplUnlockSheet.tsx` (kept as a wrapper), `LockScreenNotice.tsx`, `A/state/unlockDevice.ts`, `S/views/UnlockSheet.css` | 5a | U: `T/test-passcode.js`. B: unlock. H: one unlock per platform. | Medium |
| 5b | p5-screen-shell | U-stream-11, U-stream-14, C-client-ui-10 (header, start error), U-system-7 (screen) | `A/views/DevicePage.tsx`; `StreamView.tsx` and `CoreDeviceStreamView.tsx` become one `ScreenView.tsx` with two adapter files; `SleepOverlay.tsx`, `ToolView.tsx` (status words), `A/state/stream.ts`, `S/views/StreamView.css`, `SleepOverlay.css` | 5a | B: android-stream, android-lifecycle, ios-reconnect, device-page. H: both. | Large |
| 5b | p5-controls | U-stream-7, C-client-ui-14, C-client-stream-9 (button hold) | New `A/controls/*` (definition, `ControlRail.tsx`, `ControlPanel.tsx`); `A/views/FloatingToolbar.tsx` (export and `client` prop kept), `A/toolbox/*`, both toolbox files, the toolbox wiring in `StreamClientScrcpy.ts` and `StreamClientCoreDevice.ts`, `S/views/FloatingToolbar.css` | 5a | U: `T/test-stream-clients.js`. B: new `T/e2e-controls.js`. H: hold Power and Lock. | Large |
| 5b | p5-list-rows | U-home-5, U-home-12, U-system-7 (card) | `A/views/DeviceCard.tsx`, `DeviceList.tsx`, `DeviceSwitcherSheet.tsx`, new `A/ui/PhoneRow.tsx`, `A/ui/StreamServiceStatus.tsx`, `AsleepBanner.tsx` and their CSS | 5a; merge after p5-settings-sheet | B: home, switcher. | Medium |
| 5c | p5-input | U-stream-15, C-client-stream-9 (point mapper) | `A/interactionHandler/*`, `A/applDevice/CoreDeviceInteractionHandler.ts`, `touchMath.ts` (now `A/input/pointMapper.ts`) | 5b | U: `T/test-stream-clients.js`. B: android-stream. H: wheel and pinch on the iPhone. | Medium |
| 5c | p5-reconnect | C-client-stream-9 (rest, D10: shared audio framing, point mapper and resize timing only; the two reconnect policies stay separate and are documented as deliberate) | `A/client/StreamReceiver.ts`, `A/applDevice/client/CoreDeviceReceiver.ts`, `A/client/audioPacket.ts`, both stream clients (resize, audio wiring) | 5b | U: `T/test-client-lifecycle.js`, `T/test-coredevice.js`. B: ios-reconnect, android-lifecycle. H: iPhone reconnect. | Medium |

### Phase 6

| Step | Key | IDs | Owns | Needs | Tests | Size |
| --- | --- | --- | --- | --- | --- | --- |
| 6a | p6-list | U-home-8, U-home-9 | `A/views/DeviceList.tsx`, `A/ui/PhoneRow.tsx` (stale state), `A/client/BaseDeviceTracker.ts`, `HostTracker.ts`, `A/state/devices.ts`, `hosts.ts`, `S/views/DeviceList.css` | 5b | U: `T/test-home.js`, `T/test-client-lifecycle.js`. B: home. | Medium |
| 6a | p6-touch-button | U-stream-9 (D4: floating button kept) | `A/controls/ControlPanel.tsx` and its CSS: the button is translucent when idle and snaps to the nearest edge; its position is remembered per browser. Back and Home stay inside the panel. | 5b | B: controls (idle opacity, snap, position kept after a reload, never over the header). H: `T/e2e-touch.js`. | Small |
| 6a | p6-desktop-layout | U-stream-10 | `A/views/ScreenView.tsx` (stage layout), `A/controls/ControlRail.tsx`, the docked presentation in `A/ui/BottomSheet.tsx`, `S/views/StreamView.css`, `S/ui/BottomSheet.css` | 5b (D5: rail attached to the picture, even grid on the list, side panel for Actions, Settings and Type text from 1024 px) | B: new `T/e2e-desktop-layout.js` (1440x900 and 1366x650). | Large |
| 6a | p6-notification-setup | U-notifications-13, U-notifications-4 (page header), C-notifications-9 (small extraction) | `A/views/NotificationsView.tsx`, page and setup CSS, `V/notifications/NotificationService.ts`, `NotificationStorage.ts` | 4c, D8 | U: `T/test-notification-service.js`, `T/test-notifications.js`, `T/test-notification-page.js`. | Large |
| 6a | p6-files-service | C-client-tools-css-9 (service half), C-client-tools-css-13, U-tools-9 (rest) | `A/googDevice/client/FileListingClient.ts`, new `A/googDevice/files/FileService.ts`, `A/googDevice/filePush/*`, `S/filelisting.css` | 4c | U: `T/test-files.js`. B: files, files-flows. H: `T/e2e-files-device.js`. | Large |
| 6a | p6-shell-keys | U-tools-11 | `A/views/ToolView.tsx` (key row to a new file), `A/googDevice/client/ShellClient.ts`, `shellInput.ts`, `S/views/ToolView.css` | 5b | U: `T/test-shell.js`. B: tools. | Small |
| 6a | p6-server-lifecycle | C-server-core-14, C-server-ios-14, C-ios-unlock-13 | `V/index.ts`, release paths in `V/appl-device/services/ControlCenter.ts`, `CoreDeviceRunner.ts`, `V/appl-device/mw/CoreDeviceProxy.ts`; comments in `UnlockScheduler.ts`, `UnlockDriver.ts`, `IosSettingsStore.ts` | The unlock agent has finished | U: `T/test-coredevice.js`, `T/test-crash-paths.js`. | Small |
| 6a | p6-android-device | C-server-android-14 (D7: full split) | `V/goog-device/Device.ts` becomes shell, poller and session files; `AdbUtils.ts`; the dead `runShellCommandAdb` is deleted and the two adb command-line calls move to adbkit | 5b live | U: `T/test-android-server.js`, `T/test-server-regressions.js`. H: on the Android phone: start on the first viewer, stop 30 s after the last, rotate, reconnect after USB replug, Wake, settings apply and restart. Deploys on its own. | Large |
| 6b | p6-desktop-input | U-stream-6, U-flows-8, U-stream-12 | `A/googDevice/KeyInputHandler.ts`, `localKeyboardTarget.ts`, `UhidKeyboard.ts`, `A/applDevice/hidKeyboard.ts`, `A/state/switcherKeys.ts`, new `A/state/keyboardCapture.ts`, new `A/ui/KeyboardChip.tsx`, `A/views/DevicePage.tsx` (chip), key and paste handlers in both stream clients | p6-desktop-layout, 5c, D9 | B: android-keyboard, ios-typing, switcher, new `T/e2e-desktop-input.js`. H: `T/e2e-keyboard.js`, paste on both. | Large |
| 6b | p6-inbox | U-notifications-4 (toolbar), -5, -7, -14, "Mute this app" from -13 | `A/views/NotificationHistory.tsx`, `NotificationCard.tsx`, `NotificationMedia.tsx`, `A/ui/notificationSwipe.ts`, `notificationTouch.ts`, `A/state/notifications.ts`, inbox CSS | p6-notification-setup | U: `T/test-notification-swipe.js`, `T/test-notification-content.js`. B: notifications. | Large |
| 6b | p6-server-config | C-server-core-12 | New `V/Settings.ts`, `V/EnvName.ts`, `Config.ts`, `dataDir.ts`, the `process.env` reads in 18 files, `/home/brandon/ws-scrcpy/docker-compose.yml` (old name kept as alias) | Other server packages merged | U: `T/test-web-security.js`, new `T/test-settings.js`. | Medium |
| 6c | p6-docs | C-server-core-11 | `/home/brandon/ws-scrcpy/README.md`, `/home/brandon/ws-scrcpy/docs/HANDOFF.md`; deletes `docs/scheme.md`, `docs/debug.md` | Everything else | None | Medium |

37 packages: 1 mockup, 1, 5, 9, 9 and 12. The Files view rebuild (p6-files-view) is dropped by D6.

## 4. Order

0. **Step M.** The mockup is built and the owner approves it, or asks for changes, before step 0 starts.
1. **Step 0**, then **3a**, then **3b**. Deploy after 3b. 3a alone is also deployable: the old exports stay as shims, so every back control stops pushing and old links still open.
2. **Before phase 4 starts:** 3b is live and the owner has used Back on a phone and on a desktop. History faults show only in real use, and phase 4 restyles what 3b restructured.
3. **4a, 4b, 4c, 4d.** 4a and 4b change nothing visible. Each 4c package can merge and deploy alone; the app looks mixed in between, as it does today. Deploy after 4d.
4. **Before phase 5 starts:** 4d is merged, so the old control kits are gone and phase 5 unifies on one.
5. **5a, 5b.** Deploy after 5b and check both platforms on hardware. Merge p5-settings-sheet before p5-list-rows, or troubleshooting is missing for one merge.
6. **5c** touches the iPhone stream path and deploys on its own. It can run alongside 6a; the files are disjoint. The app is complete without it.
7. **6a, 6b, 6c.** Each phase 6 package is one screen or one server area and can merge alone. Any subset leaves the app usable.

Other points:
- The three server packages and step 0 do not depend on the client work. They can run alongside phase 4.
- All ten decisions are made (section 5). Changes that come out of the mockup review are applied to section 2 and to the affected packages before step 0.
- p6-android-device is a full split (D7). It needs its own Android hardware check and its own deploy, after 5b is live.
- Do not deploy within 15 minutes of a scheduled unlock slot. A deploy restarts the container and ends sessions; the next iPhone session is a counted start.

## 5. Decisions (made by the owner, 2026-11-11)

| # | Question | Decision | Draft recommendation |
| --- | --- | --- | --- |
| D1 | Name of the root page | "Phones", with "Switch phone" and the back label "Phones" | Same |
| D2 | Tabs and settings | Android: Screen, Files, Shell. iPhone: Screen, with the bell for its inbox. Settings is one sheet, opened from the list and from the screen | Same |
| D3 | Stream when another tab of the same phone is shown | Stops at once; the server grace covers a quick look (30 s Android, 15 s iPhone) | Same |
| D4 | Touch controls (U-stream-9) | **Keep the floating button**, translucent when idle and snapped to an edge | Docked row of five |
| D5 | Desktop layout (U-stream-10, U-home-9) | Rail attached to the picture, even grid on the list, and a side panel for Actions, Settings and Type text from 1024 px | Same |
| D6 | Files rebuild (C-client-tools-css-9) | Extract the service, fix the rendering cost, keep the current view on the shared styles | Same |
| D7 | `Device.ts` (C-server-android-14) | **Full split** into shell, poller and session | Partial split |
| D8 | App filter (U-notifications-13) | Mute list in the page; an existing allow-list keeps working, shown as "Only these apps" until cleared | Same |
| D9 | Reserved chord (U-flows-8, U-stream-6) | Ctrl+Alt plus a letter (Ctrl+Option on a Mac) | Same |
| D10 | Reconnect code (C-client-stream-9) | Share only audio framing, the point mapper and resize timing; document the two policies as deliberate | Same |
| Mockup | Before the redesign starts | One clickable private page covering the list and a phone's page, the sheets, Notifications, and Files and Shell | Not in the draft |

What the two departures from the draft change:
- **D4.** No docked row, so the picture keeps its full height and there is no safe-area work for a row. Back and Home stay three taps on a touch screen, and the button still covers part of the picture; U-stream-9 is answered by making the button translucent when idle and keeping it on an edge. The package is small.
- **D7.** The `Device.ts` split is large and touches the scrcpy start and stop path that phase 2 rewrote. It needs the Android phone for its check (start on the first viewer, stop after the last, rotate, reconnect, Wake, apply and restart) and deploys on its own.

## 6. Risks

**iPhone stream path**
- A view that mounts twice starts two sessions. The stream effect keys on `udid`, `player` and `ws` (`A/views/StreamView.tsx:76`). If the old-link rewrite or a late socket lookup changes them after the first mount, the stream restarts. `T/e2e-navigation.js` asserts one socket per open.
- Phase 5 must keep the failure card with Retry, the 4009, 4010 and 4011 handling, the unlock-by-hand card and held-button release.
- p5-reconnect and p5-input change code that only a real iPhone exercises.

**Session start budget**
- Three starts per phone in five minutes, persisted across restarts; the fourth is refused. Tabs and Back make leaving and returning easier, so the 15 s grace matters more (D3).
- The bench check uses at most two opens, with five minutes between checks.
- An iPhone unlock run in p5-unlock counts toward the Run now cooldown.

**Notification inbox**
- Push banners already delivered carry `#!action=notifications&source=…¬ification=…` and `#!action=`; both must keep working (`T/test-routes.js`).
- Writing filter and search into the address must not re-run the "opened from a push" handling of the `notification` parameter.
- Marking read on expand changes the badge counts.
- A page left open across the phase 6 deploy posts the old `apps` field; the server must still accept it.
- Removing `.notifications-page button` restyles every unclassed button on the page at once.

**Service worker and cached bundles**
- The worker caches nothing and `index.html` is `no-store`, so there is no stale-cache path.
- The risk is an open page across a deploy. Tabs now load lazy chunks later, so the "Reload" offer in `ToolView.tsx` must move to the phone's page.
- The worker updates at once (`skipWaiting`, `clients.claim`) and then serves old pages; it must read both route forms.
- An installed app on iOS can keep an old page for days. Reload each viewing browser once after the first deploy of a phase.

**Design system**
- Unlayered third-party CSS (xterm) wins over every layer; check Shell.
- A native dialog is in the top layer: a toast outside it is hidden behind it, and events still bubble to the body listeners that drive the phone. The existing stop in `BottomSheet.tsx:68-79` must stay.
- About 60 test scripts select on class names. Hardware-only scripts (`T/e2e-ux.js`, `e2e-toolbar.js`, `e2e-actions.js`, `e2e-keyboard.js`) are never run by workers and will drift.

**Scheduled unlock**
- p5-settings-sheet moves the panel. It must move as a unit, with the phase 1 decisions (time zone, rejected passcode) and the 12-hour logic untouched.

**Cannot be verified without the phones**
- iPhone: session reuse across tab changes and Back, Retry, wheel as a swipe, paste (clipboard then Cmd+V; the pasteboard service has wedged before), one-tap unlock, held Lock and Siri.
- Android: scrcpy start and 30 s stop across tab changes, the reserved chord against UHID capture, paste, Files on `/sdcard`, the `Device.ts` changes.
- Viewing phone: the Back gesture in the installed app, `pushState` in WebKit, a sheet with the on-screen keyboard, the floating button near the safe areas.
- A real push tap opening the inbox.

### Critical Files for Implementation
- /home/brandon/ws-scrcpy/src/app/state/router.ts
- /home/brandon/ws-scrcpy/src/app/views/App.tsx
- /home/brandon/ws-scrcpy/src/app/ui/BottomSheet.tsx
- /home/brandon/ws-scrcpy/src/style/tokens.css
- /home/brandon/ws-scrcpy/src/app/views/CoreDeviceStreamView.tsx