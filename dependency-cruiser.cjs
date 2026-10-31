/**
 * Source architecture rules. npm package contents are audited by the release
 * packer and clean-consumer checks; this file only describes source imports.
 */
const path = require('node:path');

module.exports = {
  forbidden: [
    {
      name: 'core-no-client-imports',
      severity: 'error',
      from: { path: '^core/src/' },
      to: { path: '^(tui/src/|desktop/)' },
    },
    {
      name: 'core-no-ui-or-electron-packages',
      severity: 'error',
      from: { path: '^core/src/' },
      to: { path: '^node_modules/(?:[.]pnpm/[^/]+/node_modules/|)(react|ink|electron)/' },
    },
    {
      name: 'electron-main-no-core-imports',
      severity: 'error',
      from: { path: '^desktop/electron/' },
      to: { path: '^core/(src|dist)/|^node_modules/[.]pnpm/[^/]+/node_modules/@ligule/core/' },
    },
    {
      name: 'renderer-electron-api-type-only',
      severity: 'error',
      from: { path: '^desktop/frontend/' },
      to: {
        path: '^desktop/electron/api[.]ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'production-runtime-no-dev-dependencies',
      severity: 'error',
      from: { path: '^(core/src|tui/src)/' },
      to: {
        dependencyTypes: ['npm-dev'],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-runtime-cycles',
      severity: 'error',
      from: {},
      to: {
        circular: true,
        viaOnly: { dependencyTypesNot: ['type-only'] },
      },
    },
  ],
  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    exclude: { path: '(^|/)(tests?|testplace|dist|vendor)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: path.join(__dirname, 'tsconfig.json') },
  },
};
