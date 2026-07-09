/**
 * Mock the `vscode` module so unit tests can run without a VS Code instance.
 *
 * Older versions used a `Module._load` monkey-patch driven by
 * `node --require ./out/test/setup.js`. Under Node 22.19+, that patch confuses
 * `node --test`'s subtest-discovery pass — it only sees the outer file as one
 * test and silently drops every `describe()`/`it()` inside. The reliable
 * approach is to pre-populate `require.cache` with a stub keyed on the
 * absolute path VS Code would resolve to (there's no real vscode.js in
 * node_modules, so we synthesise one).
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';

const req = createRequire(__filename);
const stubPath = path.join(__dirname, '__vscode_stub__.js');
req.cache[stubPath] = {
  id: stubPath,
  filename: stubPath,
  loaded: true,
  exports: {
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  },
  paths: [],
  children: [],
  parent: null,
  isPreloading: false,
  require: req,
  path: __dirname,
} as unknown as NodeJS.Module;

// Route any `require('vscode')` to the stub above.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]): string {
  if (request === 'vscode') return stubPath;
  return origResolve.call(this, request, ...rest);
};
