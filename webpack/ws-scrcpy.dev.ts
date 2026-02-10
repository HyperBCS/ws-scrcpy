import { frontend, backend } from './ws-scrcpy.common';
import webpack from 'webpack';

const devOpts: webpack.Configuration = {
    devtool: 'inline-source-map',
    mode: 'development',
    output: {
        devtoolModuleFilenameTemplate: (info: any) => { // Adding : any is the quickest fix
            return `webpack:///${info.resourcePath}`;
        },
    },
};

const mergeWithOutput = (base: webpack.Configuration, extras: webpack.Configuration) => {
    const merged = Object.assign({}, base, extras);
    merged.output = Object.assign({}, base.output || {}, extras.output || {});
    return merged;
};

const front = () => {
    return mergeWithOutput(frontend(), devOpts);
};
const back = () => {
    return mergeWithOutput(backend(), devOpts);
};

module.exports = [front, back];
