import { backend, frontend } from './ws-scrcpy.common';
import webpack from 'webpack';

const prodOpts: webpack.Configuration = {
    mode: 'production',
};

const mergeWithOutput = (base: webpack.Configuration, extras: webpack.Configuration) => {
    const merged = Object.assign({}, base, extras);
    merged.output = Object.assign({}, base.output || {}, extras.output || {});
    return merged;
};

const front = () => {
    return mergeWithOutput(frontend(), prodOpts);
};
const back = () => {
    return mergeWithOutput(backend(), prodOpts);
};

module.exports = [front, back];
