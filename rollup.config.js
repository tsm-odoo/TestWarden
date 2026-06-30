import typescript from "@rollup/plugin-typescript";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import terser from "@rollup/plugin-terser";
import url from "@rollup/plugin-url";

const external = [
    "os",
    "url",
    "stream",
    "http",
    "crypto",
    "tty",
    "process",
    "assert",
    "readline",
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
    "tsl",
    "constants",
    "module",
    "tls",
    "punycode",
    "readline",
    "nodeaffinity",
    "inspector",
];

const plugins = [
    typescript({ sourceMap: false, tsconfig: false }),
    nodeResolve({ exportConditions: ["node"] }),
    commonjs(),
    json(),
];

const config = [
    {
        input: "build/index.js",
        output: [
            {
                file: "release/test-warden.cjs",
                format: "cjs",
                inlineDynamicImports: true,
                // plugins: [terser()],
            },
        ],
        external,
        plugins,
    },
    {
        input: "build/index.js",
        output: [
            {
                file: "release/warden-run.cjs",
                format: "cjs",
                inlineDynamicImports: true,
            },
        ],
        external,
        plugins,
    },
];
export default config;
