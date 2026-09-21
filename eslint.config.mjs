import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
    {
        // Replaces the old .eslintignore. Vendored and generated code is not ours to lint,
        // and src/app/Util.ts is third-party UTF-8 helpers copied from Closure.
        ignores: [
            'dist/**',
            'build/**',
            'node_modules/**',
            'src/public/**/*.js',
            'vendor/**',
            'src/app/Util.ts',
            'typings/**/*.d.ts',
            '**/*.js',
            '**/*.mjs',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    prettierRecommended,
    {
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'module',
        },
        rules: {
            // The codebase marks deliberately-unused parameters with a leading underscore
            // (interface conformance, overridden hooks). Honour that convention.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            // Kept as a warning, as it was under the previous @typescript-eslint v5 preset:
            // there are ~50 pre-existing sites and they are not this change's concern.
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    },
);
