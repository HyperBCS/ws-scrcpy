import nodeExternals from 'webpack-node-externals';
import fs from 'fs';
import path from 'path';
import webpack from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import GeneratePackageJsonPlugin from '@dead50f7/generate-package-json-webpack-plugin';
import { mergeWithDefaultConfig } from './build.config.utils';
import CopyWebpackPlugin from 'copy-webpack-plugin';

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const SERVER_DIST_PATH = path.join(PROJECT_ROOT, 'dist');
export const CLIENT_DIST_PATH = path.join(PROJECT_ROOT, 'dist/public');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');

const override = path.join(PROJECT_ROOT, '/build.config.override.json');
const buildConfigOptions = mergeWithDefaultConfig(override);
const buildConfigDefinePlugin = new webpack.DefinePlugin({
    '__PATHNAME__': JSON.stringify(buildConfigOptions.PATHNAME),
});

/**
 * `esModules: true` makes ts-loader emit real `import()` calls instead of downlevelling them to
 * `require()`. tsconfig sets `module: commonjs` for the server, and under that setting TypeScript
 * rewrites the dynamic imports in src/app/index.tsx before webpack ever sees them - so webpack
 * cannot split them out and every player, the xterm terminal and the file browser end up in the
 * initial bundle. This client is loaded over a phone connection, so that matters.
 */
export const common = (esModules = false) => {
    return {
        module: {
            rules: [
                {
                    test: /\.css$/i,
                    use: [MiniCssExtractPlugin.loader, 'css-loader'],
                },
                {
                    test: /\.tsx?$/,
                    use: [
                        {
                            loader: 'ts-loader',
                            options: esModules ? { compilerOptions: { module: 'esnext' } } : {},
                        },
                        {
                            loader: 'ifdef-loader',
                            options: buildConfigOptions,
                        },
                    ],
                    exclude: /node_modules/,
                },
                {
                    test: /\.svg$/,
                    loader: 'svg-inline-loader',
                },
                {
                    test: /\.(png|jpe?g|gif)$/i,
                    use: [
                        {
                            loader: 'file-loader',
                        },
                    ],
                },
                {
                    test: /\.(asset)$/i,
                    use: [
                        {
                            loader: 'file-loader',
                            options: {
                                name: '[name]',
                            },
                        },
                    ],
                },
                {
                    test: /\.jar$/,
                    use: [
                        {
                            loader: 'file-loader',
                            options: {
                                name: '[path][name].[ext]',
                            },
                        },
                    ],
                },
                {
                    test: /LICENSE/i,
                    use: [
                        {
                            loader: 'file-loader',
                            options: {
                                name: '[path][name]',
                            },
                        },
                    ],
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
        },
    };
};

const front: webpack.Configuration = {
    entry: path.join(PROJECT_ROOT, './src/app/index.tsx'),
    externals: ['fs'],
    plugins: [
        new HtmlWebpackPlugin({
            template: path.join(PROJECT_ROOT, '/src/public/index.html'),
            inject: 'head',
        }),
        new MiniCssExtractPlugin(),
        new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
        }),
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: path.resolve(PROJECT_ROOT, 'src/public/manifest.json'),
                    to: path.resolve(CLIENT_DIST_PATH, 'manifest.json'),
                },
                {
                    // The PWA/apple-touch icons are referenced by URL from manifest.json and
                    // index.html, so nothing imports them and no loader ever sees them. Without
                    // this they 404 in a built app and the app cannot be installed to a home
                    // screen. Top-level only: src/public/images/** is loaded through webpack.
                    from: path.resolve(PROJECT_ROOT, 'src/public/icon-*.png'),
                    to: path.resolve(CLIENT_DIST_PATH, '[name][ext]'),
                },
            ],
        }),
    ],
    resolve: {
        fallback: {
            path: 'path-browserify',
        },
        extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
        filename: 'bundle.js',
        path: CLIENT_DIST_PATH,
    },
};

export const frontend = () => {
    return Object.assign({}, common(true), front);
};

const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON).toString());
const { name, version, description, author, license, scripts } = packageJson;
const basePackage = {
    name,
    version,
    description,
    author,
    license,
    scripts: { start: scripts['script:dist:start'] },
};
delete packageJson.dependencies;
delete packageJson.devDependencies;

const back: webpack.Configuration = {
    entry: path.join(PROJECT_ROOT, './src/server/index.ts'),
    externals: [nodeExternals()],
    plugins: [
        new GeneratePackageJsonPlugin(basePackage),
        buildConfigDefinePlugin,
    ],
    node: {
        global: false,
        __filename: false,
        __dirname: false,
    },
    output: {
        filename: 'index.js',
        path: SERVER_DIST_PATH,
    },
    target: 'node',
};

export const backend = () => {
    return Object.assign({}, common(), back);
};
