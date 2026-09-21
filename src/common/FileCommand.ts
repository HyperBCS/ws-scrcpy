/**
 * Extra 4-byte commands the Files channel understands, alongside the adb sync codes
 * (`STAT`, `LIST`, `RECV`, `SEND`) in `@dead50f7/adbkit`'s `Protocol`. Stock adb sync has no
 * mkdir/rename/delete, so these run as shell commands on the device instead. Keep every code
 * four ASCII bytes and distinct from the adbkit ones -- the channel dispatches on those bytes.
 */
export enum FileCommand {
    MKDIR = 'MKDR',
    MOVE = 'MOVE',
    COPY = 'COPY',
    DELETE = 'DELE',
}
