import typescript from "@rollup/plugin-typescript";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import url from "@rollup/plugin-url";

const plugins = [
    typescript({ sourceMap: false, tsconfig: false, jsx: "react-jsx", jsxImportSource: "react" }),
    nodeResolve({ exportConditions: ["node"] }),
    commonjs(),
    json(),
];

const external = [
    "os",
    "url",
    "stream",
    "http",
    "crypto",
    "tty",
    "process",
    "assert",
    "buffer",
    "util",
    "path",
    "https",
    "zlib",
    "fs/promises",
    "child_process",
    "events",
    "fs",
    "dns",
    "net",
    "constants",
    "module",
    "tls",
    "punycode",
    "readline",
    "nodeaffinity",
    "inspector",
    "react-devtools-core",
];

const config = {
    input: "build/index.js",
    // Bundled into build/ first; the build script only swaps it into release/ once
    // everything succeeded, so a failed build leaves the previous client usable.
    output: [
        {
            dir: "build/release",
            format: "es",
            entryFileNames: "test-warden.mjs",
            chunkFileNames: "[name]-[hash].mjs",
        },
    ],
    external,
    plugins,
};
export default config;
