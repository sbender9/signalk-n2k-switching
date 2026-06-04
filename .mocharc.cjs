// Type-checking is done up front by `tsc -p test/tsconfig.json --noEmit`
// (see the `test` script); ts-node here only transpiles the suite for
// execution, which keeps mocha on the CommonJS require path and avoids the
// Node ESM-fallback that masks type errors as ERR_MODULE_NOT_FOUND.
// TS_NODE_PROJECT is set here (not inline in the npm script) so `npm test`
// behaves identically on Linux, macOS and Windows CI runners.
process.env.TS_NODE_PROJECT = require('path').join(
  __dirname,
  'test/tsconfig.json'
)

module.exports = {
  require: ['ts-node/register/transpile-only'],
  spec: ['test/**/*.test.ts'],
  extensions: ['ts']
}
