// Registers the .ts extension resolution hook for the Node test runner.
// Used via `node --import ./scripts/register-ts-ext.mjs ...` in the
// agentic-layer test scripts. See ts-ext-hook.mjs for the rationale.
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);
