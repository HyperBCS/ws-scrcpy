import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { usePresence } from '../ui/Presence';
import { ControlButton } from './ControlButton';
import { CONTROLS_LABEL, PhoneControls, shownControls } from './definition';
import { LISTEN_CAPTIONS } from './listen';

const sides = (style: CSSStyleDeclaration, box: 'padding' | 'border') =>
    box === 'padding'
        ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
        : parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);

/**
 * The width of one column of the rail that keeps the widest caption on one line: the caption,
 * then the padding and border of its tile and the padding of the rail. The rail's border is
 * added by the stage (`StreamView.css`). Listen's other captions count too; they are short
 * (`listen.ts`), so the widest is a resting one ("Volume down") and a press on Listen does not
 * change the rail's width and move the picture. The captions are measured in a hidden copy of a
 * tile, whose width does not depend on the rail's, so writing the width cannot start a loop.
 */
function captionColumnWidth(panel: HTMLElement, list: HTMLElement): number | undefined {
    const tile = list.querySelector<HTMLElement>('.kit-icon-button-captioned');
    if (!tile) {
        return undefined;
    }
    const texts = Array.from(list.querySelectorAll('.kit-icon-button-caption'), (caption) => caption.textContent || '');
    if (list.querySelector('[data-control="audio"]')) {
        texts.push(...LISTEN_CAPTIONS);
    }
    const probe = tile.cloneNode(true) as HTMLElement;
    probe.setAttribute('aria-hidden', 'true');
    probe.inert = true;
    Object.assign(probe.style, {
        position: 'fixed',
        visibility: 'hidden',
        pointerEvents: 'none',
        width: 'max-content',
    });
    list.appendChild(probe);
    try {
        const caption = probe.querySelector('.kit-icon-button-caption');
        if (!caption) {
            return undefined;
        }
        const range = document.createRange();
        let widest = 0;
        for (const text of texts) {
            caption.textContent = text;
            range.selectNodeContents(caption);
            widest = Math.max(widest, range.getBoundingClientRect().width);
        }
        const tileStyle = getComputedStyle(probe);
        const panelStyle = getComputedStyle(panel);
        const width = Math.ceil(
            widest + sides(tileStyle, 'padding') + sides(tileStyle, 'border') + sides(panelStyle, 'padding'),
        );
        return Number.isFinite(width) && width > 0 ? width : undefined;
    } finally {
        probe.remove();
    }
}

/**
 * The controls beside the picture, for a window with a mouse. Offered controls follow one
 * another without the touch grid's empty cells. One column is centred when it fits; a short
 * picture uses two columns and scrolls when needed. The stage keeps the rail attached. A column
 * is as wide as the longest caption needs on one line: the rail writes that width on the stage
 * as `--stream-rail-column`, which the stage's rail width is made of (`StreamView.css`).
 */
export function ControlRail({ controls }: { controls: PhoneControls }) {
    const { ref } = usePresence<HTMLDivElement>(true, 'fade');
    const [columns, setColumns] = useState(1);
    const shown = shownControls(controls);
    const slots = shown.length;
    // A key held when the rail goes (the window turned into a touch screen, another stream).
    useEffect(() => () => controls.held.releaseAll(), [controls]);

    useLayoutEffect(() => {
        const panel = ref.current;
        if (!panel) {
            return;
        }
        const stage = panel.closest<HTMLElement>('.stream-stage');
        const mount = stage?.querySelector('.stream-mount');
        let observedVideo: Element | undefined;
        // The column width last written on the stage. It changes only with the captions.
        let written: number | undefined;
        const fitCaptions = () => {
            const list = panel.querySelector<HTMLElement>('.control-buttons-list');
            const width = list && captionColumnWidth(panel, list);
            if (stage && width && width !== written) {
                written = width;
                stage.style.setProperty('--stream-rail-column', `${width}px`);
            }
        };
        const wanted = () => {
            const style = getComputedStyle(panel);
            const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            let room = panel.clientHeight - padding;
            const list = panel.querySelector<HTMLElement>('.control-buttons-list');
            if (!list) {
                return 1;
            }
            // Measure a hidden one-column copy at its real target width. Grid rows stretch
            // their neighbors, so summing the current two-column buttons overcounts captions.
            const columns = Number(panel.parentElement?.dataset.columns) || 1;
            const columnWidth =
                (panel.getBoundingClientRect().width -
                    parseFloat(style.borderLeftWidth) -
                    parseFloat(style.borderRightWidth)) /
                columns;
            const width = columnWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            if (!Number.isFinite(width) || width <= 0) {
                return 2;
            }
            const picture = mount?.querySelector<HTMLCanvasElement>('.touch-layer[width][height]');
            const video = picture?.closest('.video');
            if (video !== observedVideo) {
                if (observedVideo) {
                    resize.unobserve(observedVideo);
                }
                if (video) {
                    resize.observe(video);
                }
                observedVideo = video || undefined;
            }
            const box = video?.getBoundingClientRect();
            if (
                picture &&
                box &&
                [picture.width, picture.height, box.width, box.height, columnWidth].every(
                    (size) => Number.isFinite(size) && size > 0,
                )
            ) {
                // Two columns leave a narrower, sometimes shorter picture. Test the height
                // it would have with one column, using the video's actual height/dock limits
                // and the native canvas size. CSS fits both axes without enlarging the picture.
                const candidateWidth = box.width + columnWidth * (columns - 1);
                const height = Math.min(picture.height, box.height, (candidateWidth * picture.height) / picture.width);
                room =
                    Math.round(height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)) -
                    padding;
            }
            const probe = list.cloneNode(true) as HTMLElement;
            probe.setAttribute('aria-hidden', 'true');
            probe.inert = true;
            Object.assign(probe.style, {
                position: 'fixed',
                visibility: 'hidden',
                pointerEvents: 'none',
                width: `${width}px`,
                gridTemplateColumns: 'minmax(0, 1fr)',
                margin: '0',
            });
            for (const button of Array.from(probe.children) as HTMLElement[]) {
                button.style.gridRow = 'auto';
                button.style.gridColumn = 'auto';
            }
            panel.appendChild(probe);
            try {
                return room >= probe.getBoundingClientRect().height ? 1 : 2;
            } finally {
                probe.remove();
            }
        };
        let frame = 0;
        // The rail follows the picture's height. A change of columns changes the rail's width and
        // so the picture's place: it waits for the next frame, which lays that out again.
        const changed = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                fitCaptions();
                setColumns(wanted());
            });
        };
        const resize = new ResizeObserver(changed);
        const drawn = new MutationObserver(changed);
        if (mount) {
            resize.observe(mount);
            // The player can create the video after this effect, or change its intrinsic size.
            drawn.observe(mount, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['width', 'height'],
            });
        }
        fitCaptions();
        setColumns(wanted());
        resize.observe(panel);
        const list = panel.querySelector('.control-buttons-list');
        if (list) {
            resize.observe(list);
            // Captions can change without changing a row stretched by another button.
            list.querySelectorAll('.kit-icon-button-caption').forEach((caption) => resize.observe(caption));
        }
        return () => {
            cancelAnimationFrame(frame);
            resize.disconnect();
            drawn.disconnect();
            stage?.style.removeProperty('--stream-rail-column');
        };
    }, [slots]);

    return (
        <div class="floating-toolbar desktop" data-columns={columns}>
            <div class="floating-toolbar-safearea" aria-hidden="true" />
            <div
                id="stream-controls"
                class="floating-toolbar-panel"
                ref={ref}
                aria-hidden={false}
                role="group"
                aria-label={CONTROLS_LABEL}
            >
                <div class="control-buttons-list floating">
                    {shown.map(({ definition, action }, index) => {
                        return (
                            <ControlButton
                                key={definition.id}
                                definition={definition}
                                action={action}
                                held={controls.held}
                                style={{
                                    gridRow: String(Math.floor(index / columns) + 1),
                                    gridColumn: String((index % columns) + 1),
                                }}
                            />
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
