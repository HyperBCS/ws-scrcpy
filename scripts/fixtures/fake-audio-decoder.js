#!/usr/bin/env node
/* eslint-disable */
// Stand-in for ffmpeg in CoreDeviceAudioRelay tests (IOS_AUDIO_DECODER): for every `mdat` box
// that arrives on stdin it writes 480 samples (1920 bytes) of a fixed s16le stereo pattern, so a
// test can check packetisation and timestamps without a real decoder.
const frame = Buffer.alloc(1920);
for (let i = 0; i < 480; i++) {
    frame.writeInt16LE(1000, i * 4);
    frame.writeInt16LE(-1000, i * 4 + 2);
}
let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let count = 0;
    let offset = 0;
    while (offset + 8 <= pending.length) {
        const size = pending.readUInt32BE(offset);
        if (size < 8 || offset + size > pending.length) break;
        if (pending.toString('latin1', offset + 4, offset + 8) === 'mdat') count++;
        offset += size;
    }
    pending = pending.subarray(offset);
    for (let i = 0; i < count; i++) process.stdout.write(frame);
});
process.stdin.on('end', () => process.exit(0));
