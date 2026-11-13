// Explicit test-only client. The runner owns and removes its temporary output directory.
import path from 'path';
import { frontend, SERVER_DIST_PATH } from './ws-scrcpy.common';

const output = process.env.KIT_FIXTURE_OUT;
const relative = output ? path.relative(SERVER_DIST_PATH, output) : '';
if (!output || !path.isAbsolute(output) || !(relative === '..' || relative.startsWith(`..${path.sep}`))) {
    throw new Error('KIT_FIXTURE_OUT must be an absolute directory outside dist');
}
module.exports = { ...frontend(true, output), mode: 'production' };
