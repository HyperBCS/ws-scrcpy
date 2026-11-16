/**
 * The one icon set. Every icon is a single path on a 24 by 24 grid, drawn as a stroke in the
 * colour of the text around it. `Icon.tsx` draws one in Preact; `iconSvg()` gives the same
 * markup as a string for code that builds HTML (Files).
 */
export const ICONS = {
    // Navigation and disclosure.
    back: 'M15 5l-7 7 7 7',
    chevDown: 'M6 9l6 6 6-6',
    chevUp: 'M6 15l6-6 6 6',
    chevRight: 'M9 5l7 7-7 7',
    close: 'M6 6l12 12M18 6L6 18',
    check: 'M5 12l4 4L19 6',
    more: 'M12 5a1 1 0 100 2 1 1 0 000-2zM12 11a1 1 0 100 2 1 1 0 000-2zM12 17a1 1 0 100 2 1 1 0 000-2z',
    moreHoriz: 'M6 11a1 1 0 100 2 1 1 0 000-2zM12 11a1 1 0 100 2 1 1 0 000-2zM18 11a1 1 0 100 2 1 1 0 000-2z',
    grid:
        'M7 6.5a.5.5 0 100 1 .5.5 0 000-1zM12 6.5a.5.5 0 100 1 .5.5 0 000-1zM17 6.5a.5.5 0 100 1 .5.5 0 000-1z' +
        'M7 11.5a.5.5 0 100 1 .5.5 0 000-1zM12 11.5a.5.5 0 100 1 .5.5 0 000-1zM17 11.5a.5.5 0 100 1 .5.5 0 000-1z' +
        'M7 16.5a.5.5 0 100 1 .5.5 0 000-1zM12 16.5a.5.5 0 100 1 .5.5 0 000-1zM17 16.5a.5.5 0 100 1 .5.5 0 000-1z',
    search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
    refresh: 'M20 12a8 8 0 11-2.3-5.7M20 4v4h-4',
    arrowLeft: 'M20 12H5M11 6l-6 6 6 6',
    arrowRight: 'M4 12h15M13 6l6 6-6 6',
    arrowUp: 'M12 20V5M6 11l6-6 6 6',
    arrowDown: 'M12 4v15M6 13l6 6 6-6',

    // The app's pages and sheets.
    phone: 'M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2',
    bell: 'M6 16v-5a6 6 0 0112 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 004 0',
    sliders: 'M10 5H3M12 19H3M14 3v4M16 17v4M21 12h-9M21 19h-5M21 5h-7M8 10v4M8 12H3',
    bolt:
        'M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 ' +
        '1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z',
    terminal: 'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM7 9l3 3-3 3M12 15h5',
    lock: 'M7 11V8a5 5 0 0110 0v3M6 11h12a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1v-7a1 1 0 011-1z',
    moon: 'M20 13.5A8 8 0 1110.5 4a7 7 0 009.5 9.5z',
    play: 'M8 5l11 7-11 7V5z',
    mail: 'M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1zM3.5 7l8.5 6 8.5-6',
    archive: 'M4 5h16v4H4V5zM6 9v10a1 1 0 001 1h10a1 1 0 001-1V9M10 13h4',

    // Messages.
    warning: 'M12 4l9 16H3L12 4zM12 10v4M12 17h.01',
    info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5h.01',
    checkCircle: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8 12.5l2.7 2.7L16 9.5',
    errorCircle: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5v6M12 16.5h.01',

    // Phone controls. The shapes of navBack to text below, and of `sliders` and `bolt` above, are
    // those of Lucide 1.72.0 (see the notice at the end of this file), each merged into one path.
    // navBack is its triangle turned a quarter to point left.
    navBack: 'M4 10.27a2 2 0 0 0 0 3.46l14 8A2 2 0 0 0 21 20V4a2 2 0 0 0-3-1.73z',
    home: 'M2 12a10 10 0 1 0 20 0 10 10 0 1 0-20 0z',
    square: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    power: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04',
    rotate: 'M4 9a8 8 0 0114-3M20 4v4h-4M20 15a8 8 0 01-14 3M4 20v-4h4',
    volDown:
        'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 ' +
        '0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6',
    volUp:
        'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 ' +
        '0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6M19.3' +
        '64 18.364a9 9 0 0 0 0-12.728',
    // The phone's own mute key. Sound in this browser is `headphones`.
    volMute:
        'M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 ' +
        '1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298zM16.5 14.5l5-5M16.5 9.5l5 5',
    headphones:
        'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0' +
        ' 0 1-2-2v-3a2 2 0 0 1 2-2h3',
    mic: 'M12 19v3M19 10v2a7 7 0 0 1-14 0v-2M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z',
    camera:
        'M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0' +
        ' 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4zM9 13a3 3 0 1 ' +
        '0 6 0 3 3 0 1 0-6 0z',
    keyboard:
        'M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1z' +
        'M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M8 14h8',
    text: 'M12 4v16M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2M9 20h6',
    backspace: 'M9 6h11a1 1 0 011 1v10a1 1 0 01-1 1H9l-6-6 6-6zM12 10l4 4M16 10l-4 4',
    enter: 'M19 6v6a2 2 0 01-2 2H5M9 10l-4 4 4 4',

    // Files.
    folder: 'M3 7a1 1 0 011-1h5l2 2h8a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V7z',
    file: 'M7 3h7l4 4v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zM14 3v4h4',
    document: 'M7 3h7l4 4v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zM14 3v4h4M9 13h6M9 17h4',
    image:
        'M5 5h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z' +
        'M9 8.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM4.5 17l4.5-4 3 3 3-2.5 4.5 4',
    video: 'M5 6h14a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1zM10.5 9.5l4.5 2.5-4.5 2.5v-5z',
    audio: 'M9 17V7l9-2v10M9 17a2 2 0 11-4 0 2 2 0 014 0zM18 15a2 2 0 11-4 0 2 2 0 014 0z',
    zip: 'M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM10 4v3M14 7v3M10 10v3M14 13v3',
    code: 'M9 8l-4 4 4 4M15 8l4 4-4 4M13.5 6l-3 12',
    link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
    clock: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2',
    package: 'M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM9 9v6M15 9v6M9 12h6',
    house: 'M4 11l8-7 8 7v9h-5v-6H9v6H4v-9z',
    edit: 'M4 20h16M6 16L16 6l3 3L9 19H6v-3z',
    download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
    upload: 'M12 20V9M7 13l5-5 5 5M5 4h14',
    copy:
        'M9 9h10a1 1 0 011 1v10a1 1 0 01-1 1H9a1 1 0 01-1-1V10a1 1 0 011-1z' +
        'M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1',
    // Lucide's folder-input, so Move does not look like the history bar's Forward.
    move:
        'M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 ' +
        '2H4a2 2 0 0 1-2-2v-1M2 13h10M9 16l3-3-3-3',
    trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
} as const;

export type IconName = keyof typeof ICONS;
/** 24 in a 44px button, 20 beside a label or in a 32px button, 16 in a line of small text. */
export type IconSize = 16 | 20 | 24;

/** The attributes of every icon, shared by the component and the string. */
export const ICON_ATTRIBUTES = {
    class: 'kit-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
} as const;

/** An icon as markup, for code that builds HTML. It is decorative: the control carries the name. */
export function iconSvg(name: IconName, size: IconSize = 24): string {
    const attributes = Object.entries(ICON_ATTRIBUTES)
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');
    return `<svg ${attributes} width="${size}" height="${size}"><path d="${ICONS[name]}"/></svg>`;
}

/*!
 * The phone control icons (navBack, home, square, power, volDown, volUp, volMute, headphones, mic,
 * camera, text, sliders, bolt) and the Files icon move (folder-input) use shapes from Lucide
 * 1.72.0 (https://lucide.dev).
 *
 * ISC License. Copyright (c) 2026 Lucide Icons and Contributors.
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without
 * fee is hereby granted, provided that the above copyright notice and this permission notice
 * appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
 * SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
 * NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
 * OF THIS SOFTWARE.
 *
 * Some of these Lucide icons are derived from the Feather project.
 * The MIT License (MIT). Copyright (c) 2013-present Cole Bemis.
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
