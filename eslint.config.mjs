import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

const readonly = (names) => Object.fromEntries(names.map((name) => [name, 'readonly']));

// What Node provides to the test scripts. Listed here because the `globals` package is not a
// dependency of this project.
const nodeGlobals = readonly([
    'AbortController',
    'AbortSignal',
    'Blob',
    'Buffer',
    'DOMException',
    'Event',
    'EventTarget',
    'MessageChannel',
    'TextDecoder',
    'TextEncoder',
    'URL',
    'URLSearchParams',
    'WebSocket',
    '__dirname',
    '__filename',
    'atob',
    'clearImmediate',
    'clearInterval',
    'clearTimeout',
    'console',
    'exports',
    'fetch',
    'global',
    'globalThis',
    'module',
    'performance',
    'process',
    'queueMicrotask',
    'require',
    'setImmediate',
    'setInterval',
    'setTimeout',
    'structuredClone',
]);

// Playwright runs the callbacks passed to `page.evaluate` and friends in the page, so the browser
// suites name page globals inside Node files.
const pageGlobals = readonly([
    'AudioBufferSourceNode',
    'AudioDestinationNode',
    'AudioNode',
    'CSS',
    'ClipboardEvent',
    'CompositionEvent',
    'CustomEvent',
    'DOMMatrix',
    'DOMRect',
    'DataTransfer',
    'DragEvent',
    'Element',
    'File',
    'HTMLElement',
    'HTMLVideoElement',
    'InputEvent',
    'IntersectionObserver',
    'KeyboardEvent',
    'MouseEvent',
    'MutationObserver',
    'Node',
    'Notification',
    'PointerEvent',
    'PushManager',
    'ResizeObserver',
    'Touch',
    'TouchEvent',
    'WheelEvent',
    'addEventListener',
    'cancelAnimationFrame',
    'document',
    'getComputedStyle',
    'history',
    'innerHeight',
    'innerWidth',
    'isSecureContext',
    'localStorage',
    'location',
    'matchMedia',
    'navigator',
    'requestAnimationFrame',
    'screen',
    'scrollX',
    'scrollY',
    'sessionStorage',
    'visualViewport',
    'window',
]);

const serviceWorkerGlobals = readonly([
    'AbortController',
    'URL',
    'URLSearchParams',
    'clearTimeout',
    'clients',
    'console',
    'fetch',
    'indexedDB',
    'navigator',
    'self',
    'setTimeout',
]);

const unusedVars = { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' };

export default tseslint.config(
    {
        // Replaces the old .eslintignore. Vendored and generated code is not ours to lint,
        // and src/app/Util.ts is third-party UTF-8 helpers copied from Closure.
        ignores: [
            'dist/**',
            'build/**',
            'node_modules/**',
            'vendor/**',
            'src/app/Util.ts',
            'typings/**/*.d.ts',
            '**/*.mjs',
        ],
    },
    {
        files: ['**/*.ts', '**/*.tsx'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended, prettierRecommended],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'module',
        },
        rules: {
            // The codebase marks deliberately-unused parameters with a leading underscore
            // (interface conformance, overridden hooks). Honour that convention.
            '@typescript-eslint/no-unused-vars': ['error', unusedVars],
            // Kept as a warning, as it was under the previous @typescript-eslint v5 preset:
            // there are ~50 pre-existing sites and they are not this change's concern.
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    },
    {
        // The unit tests, browser suites and fixtures. Correctness rules only (an undefined name,
        // an unused variable, a duplicate key): these files were never formatted with Prettier.
        files: ['scripts/**/*.js'],
        extends: [js.configs.recommended],
        // The suites used to open with a blanket `eslint-disable` comment. Those are removed; one
        // that comes back with a new suite should not add a warning to every lint run.
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...nodeGlobals, ...pageGlobals },
        },
        rules: {
            // Best-effort cleanup in the suites catches and ignores, with or without a name.
            'no-unused-vars': ['error', { ...unusedVars, caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['src/public/sw.js'],
        extends: [js.configs.recommended],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            globals: serviceWorkerGlobals,
        },
        rules: {
            'no-unused-vars': ['error', unusedVars],
        },
    },
);
