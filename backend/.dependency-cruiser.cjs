/* Module boundaries (architecture/ARCHITECTURE.md §3, OPS-702, SEC-138, D-17).
 * Enforced in the build, not by convention: `npm run depcruise` fails on any violation. */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A dependency cycle between modules makes extraction impossible (ARCH §1).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'module-internals-are-private',
      severity: 'error',
      comment: 'A module is entered only through its index.ts (ARCH §3, OPS-702).',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/(?!$1/)[^/]+/', pathNot: '^src/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'outside-code-uses-module-index',
      severity: 'error',
      comment: 'Web, db, shared, observability and tests reach a module only through its index.ts.',
      from: { path: '^(src/(web|db|shared|observability)/|test/)' },
      to: { path: '^src/modules/[^/]+/', pathNot: '^src/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'infrastructure-does-not-know-modules',
      severity: 'error',
      comment: 'db, shared and observability are leaves; they never import modules or web.',
      from: { path: '^src/(db|shared|observability)/' },
      to: { path: '^src/(modules|web)/' },
    },
    {
      name: 'modules-do-not-import-web',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^src/web/' },
    },
    {
      name: 'public-access-never-reads-policy',
      severity: 'error',
      comment:
        'Module 6 (Public Listing Access) must not read protected fields; it never imports Seller Policy (ARCH §3, D-04, SEC-138).',
      from: { path: '^src/modules/public-listing-access/' },
      to: { path: '^src/modules/(seller-policy|audit)/' },
    },
    {
      name: 'no-queue-in-this-slice',
      severity: 'error',
      comment: 'pg-boss and jobs are excluded from Slice 1a (D-18 task scope).',
      from: {},
      to: { path: 'node_modules/pg-boss' },
    },
    {
      name: 'no-marketplace-or-model-clients',
      severity: 'error',
      comment: 'No marketplace, scraping or model-provider client exists (D-07, INT-100, AI-220).',
      from: {},
      to: { path: 'node_modules/(puppeteer|playwright|cheerio|openai|@anthropic-ai|@google/generative-ai)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.cjs', '.mjs'],
    },
    reporterOptions: { dot: { collapsePattern: 'node_modules/[^/]+' } },
  },
};
