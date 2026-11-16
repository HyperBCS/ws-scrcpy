/* The theme chosen in this browser, applied before the first paint. index.html loads this file
   in its head, after the colour metas and before the styles, so the first frame is already in the
   chosen theme. It does what `applyTheme` in src/app/state/theme.ts does, with the same key and
   the same two colours; scripts/test-theme.js runs both and fails when they differ. With no
   choice, or when storage cannot be read, it changes nothing and the page follows the system.
   It is a file of its own because an inline script would not survive a stricter security
   policy; the build copies it next to index.html. */
(function () {
    'use strict';
    var choice = null;
    try {
        choice = window.localStorage.getItem('ws-scrcpy.theme');
    } catch (error) {
        return;
    }
    if (choice !== 'light' && choice !== 'dark') {
        return;
    }
    // The page's background in that theme: `--surface` of src/style/tokens.css.
    var colour = choice === 'dark' ? '#17191d' : '#f5f6f8';
    document.documentElement.setAttribute('data-theme', choice);
    var schemes = document.querySelectorAll('meta[name="color-scheme"]');
    for (var i = 0; i < schemes.length; i++) {
        schemes[i].setAttribute('content', choice);
    }
    var bars = document.querySelectorAll('meta[name="theme-color"]');
    for (var j = 0; j < bars.length; j++) {
        bars[j].setAttribute('content', colour);
    }
})();
