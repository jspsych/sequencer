import dts from "rollup-plugin-dts";
import esbuild from "rollup-plugin-esbuild";

const input = "src/index.ts";
const name = "jsPsychSequencer"; // global in the browser builds

export default [
  { input, output: { file: "dist/index.d.ts", format: "es" }, plugins: [dts()] },
  {
    input,
    plugins: [esbuild({ target: "node18" })],
    output: [
      { file: "dist/index.js", format: "esm", sourcemap: true },
      { file: "dist/index.cjs", format: "cjs", exports: "named", sourcemap: true },
    ],
  },
  {
    input,
    plugins: [esbuild({ target: "esnext" })],
    output: {
      file: "dist/index.browser.js",
      format: "iife",
      name,
      exports: "named",
      sourcemap: true,
    },
  },
  {
    input,
    plugins: [esbuild({ target: "es2015", minify: true })],
    output: {
      file: "dist/index.browser.min.js",
      format: "iife",
      name,
      exports: "named",
      sourcemap: true,
    },
  },
];
