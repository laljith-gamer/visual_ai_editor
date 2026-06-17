// Module resolution hook for `node --test --experimental-strip-types`.
//
// Our source modules use EXTENSIONLESS relative imports ("./time",
// "./command") — correct for the Next.js / tsc build, but Node's ESM
// resolver does not auto-append a `.ts` extension. This hook appends
// `.ts` (or `/index.ts`) for relative specifiers that have no extension
// so the agentic-layer unit tests can import real source modules without
// changing the source to use explicit extensions (which tsc/Next reject).
//
// Test-only: it is loaded via `--import ./scripts/register-ts-ext.mjs` in
// the test scripts and never runs in the app build.

import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

function hasExtension(specifier) {
  return /\.[cm]?[jt]sx?$|\.json$/.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !hasExtension(specifier)) {
    const parent = context.parentURL;
    if (parent) {
      try {
        const tsUrl = new URL(`${specifier}.ts`, parent);
        if (existsSync(fileURLToPath(tsUrl))) {
          return nextResolve(`${specifier}.ts`, context);
        }
        const dirUrl = new URL(specifier, parent);
        const dirPath = fileURLToPath(dirUrl);
        if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
          const indexUrl = new URL(`${specifier}/index.ts`, parent);
          if (existsSync(fileURLToPath(indexUrl))) {
            return nextResolve(`${specifier}/index.ts`, context);
          }
        }
      } catch {
        // fall through to default resolution
      }
    }
  }
  return nextResolve(specifier, context);
}
