// CommonJS entry point for callers/aliases that expect a `.cjs` file. The actual bundle
// (test-warden.mjs) must stay ESM because ink's yoga-layout dependency uses top-level await
// to instantiate its WASM binary, which the "cjs" Rollup output format cannot emit.
import("./test-warden.mjs");
