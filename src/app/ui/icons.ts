/**
 * The one icon set. Every icon is a single path on a 24 by 24 grid, drawn as a stroke in the
 * colour of the text around it. `Icon.tsx` draws one in Preact; `iconSvg()` gives the same
 * markup as a string for code that builds HTML (Files, the toolbox).
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
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    bolt: 'M13 3L5 14h6l-1 7 8-11h-6l1-7z',
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

    // Phone controls.
    navBack: 'M15 6l-8 6 8 6V6z',
    home: 'M12 6a6 6 0 100 12 6 6 0 000-12z',
    square: 'M7 7h10v10H7z',
    power: 'M12 4v8M7.5 7a7 7 0 109 0',
    rotate: 'M4 9a8 8 0 0114-3M20 4v4h-4M20 15a8 8 0 01-14 3M4 20v-4h4',
    volDown: 'M4 10v4h4l5 4V6l-5 4H4zM17 12h3',
    volUp: 'M4 10v4h4l5 4V6l-5 4H4zM17 9a4 4 0 010 6',
    // The phone's own mute key. Sound in this browser is `headphones`.
    volMute: 'M4 10v4h4l5 4V6l-5 4H4zM16.5 9.5l5 5M21.5 9.5l-5 5',
    headphones:
        'M4 15v-3a8 8 0 0116 0v3M5 14h2a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4a1 1 0 011-1z' +
        'M17 14h2a1 1 0 011 1v4a1 1 0 01-1 1h-2a1 1 0 01-1-1v-4a1 1 0 011-1z',
    mic: 'M12 3a3 3 0 00-3 3v5a3 3 0 006 0V6a3 3 0 00-3-3zM6 11a6 6 0 0012 0M12 17v4',
    camera:
        'M5 7h2.5L9 5h6l1.5 2H19a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V8a1 1 0 011-1z' +
        'M12 10a3 3 0 100 6 3 3 0 000-6z',
    keyboard:
        'M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1z' +
        'M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M8 14h8',
    text: 'M5 6h14M12 6v13M9 19h6',
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
    move: 'M4 12h14M13 7l5 5-5 5',
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
