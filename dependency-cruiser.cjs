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
      name: 'desktop-main-no-runtime-dev-dependencies',
      severity: 'error',
      from: { path: '^desktop/electron/' },
      to: {
        dependencyTypes: ['npm-dev'],
        dependencyTypesNot: ['type-only'],
        // Electron supplies this host API; it is a build-time npm dependency, not an app runtime package.
        pathNot: '^node_modules/(?:[.]pnpm/[^/]+/node_modules/|)electron/',
      },
    },
    {
      name: 'desktop-renderer-no-runtime-dev-dependencies',
      severity: 'error',
      from: { path: '^desktop/frontend/src/' },
      to: {
        dependencyTypes: ['npm-dev'],
        dependencyTypesNot: ['type-only', 'triple-slash-directive', 'triple-slash-type-reference'],
      },
    },
    {
      name: 'core-entry-owns-host',
      severity: 'error',
      from: {
        path: '^core/src/',
        pathNot: '^core/src/(index|tui)[.]ts$|^core/src/host/',
      },
      to: { path: '^core/src/host/' },
    },
    {
      name: 'clients-use-core-entry',
      severity: 'error',
      from: { path: '^(tui/src/|desktop/frontend/src/)' },
      to: { path: '^core/src/' },
    },
    {
      // 领域模块只相互引用；装配入口（含 wire 类型的聚合）由入口自己组装。
      name: 'core-domains-avoid-entry-imports',
      severity: 'error',
      from: { path: '^core/src/(kernel|session|tools|capability|model)/' },
      to: { path: '^core/src/(index|tui|wire)[.]ts$' },
    },
    {
      // wire 只描述协议形状，不引入 Host 活态或 native 能力，避免纯类型入口拉入产品装配。
      name: 'wire-entry-avoids-product-assembly',
      severity: 'error',
      from: { path: '^core/src/wire[.]ts$' },
      to: { path: '^core/src/(host|capability)/' },
    },
    {
      name: 'core-no-cycles',
      severity: 'error',
      from: { path: '^core/src/' },
      to: { path: '^core/src/', circular: true },
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
