import { signal } from '@preact/signals';
import { readStorage, writeStorage } from '../ui/storage';
import { PICTURE_COLOUR } from '../copy';
import { COLOUR_RANGES, ColourRange, colourNames, HevcColour } from '../player/hevcColour';

const STORAGE_KEY = 'ws-scrcpy.iphone.colour-range';

function storedRange(): ColourRange {
    const stored = readStorage(STORAGE_KEY);
    return COLOUR_RANGES.find((range) => range === stored) ?? 'auto';
}

/**
 * The colour range of an iPhone's picture in this browser: Auto (what the stream declares), Full
 * or Limited. Kept in this browser for every iPhone. The open screen's player follows it in place
 * (`StreamClientCoreDevice`); it exists so the owner can compare in their own browser, because
 * no test here can see the picture.
 */
export const colourRange = signal<ColourRange>(storedRange());

export function setColourRange(range: ColourRange): void {
    colourRange.value = range;
    writeStorage(STORAGE_KEY, range);
}

/**
 * What the stream of the iPhone screen open in this browser declares, from the header of its
 * last codec message. `colour` is undefined when that header could not be read. The stream client
 * named in `client` sets it and clears it when it stops.
 */
export const declaredColour = signal<{ client: object; colour: HevcColour | undefined } | undefined>(undefined);

/** The words of the Stream colour fact, for example "Full range, colour space not declared". */
export function streamColourFact(colour: HevcColour | undefined): string {
    if (!colour) {
        return PICTURE_COLOUR.notReadable;
    }
    const range = !colour.signalType
        ? PICTURE_COLOUR.rangeNotDeclared
        : colour.fullRange
          ? PICTURE_COLOUR.fullRange
          : PICTURE_COLOUR.limitedRange;
    const names = colourNames(colour);
    const space =
        !names.primaries && !names.transfer && !names.matrix
            ? PICTURE_COLOUR.spaceNotDeclared
            : names.primaries === names.transfer && names.transfer === names.matrix
              ? names.primaries
              : PICTURE_COLOUR.space(names);
    return `${range}, ${space}`;
}
