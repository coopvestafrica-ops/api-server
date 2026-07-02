import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { rm } from "node:fs/promises";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Externalize all dependencies to avoid bundling issues
    external: [
      "@supabase/supabase-js",
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "firebase-admin",
      "express-rate-limit",
      "content-type",
      "path-to-regexp",
      "type-is",
      "body-parser",
      "express",
      "cors",
      "helmet",
      "pino",
      "pino-http",
      "pino-pretty",
      "zod",
      "serve-static",
      "send",
      "encodeurl",
      "escape-html",
      "etag",
      "fresh",
      "range-parser",
      "router",
      "setprototypeof",
      "vary",
      "inherits",
      "merge-descriptors",
      "methods",
      "parseurl",
      "utils-merge",
      "array-flatten",
      "get-intrinsic",
      "has-proto",
      "function-bind",
      "hasown",
      "safe-buffer",
      "safer-buffer",
      "extsprintf",
      "jsprim",
      "verror",
      "http-errors",
      "toidentifier",
      "accepts",
      "mime-types",
      "negotiator",
      "fast-deep-equal",
      "fast-json-stable-stringify",
      "json-schema-traverse",
      "uri-js",
      "punycode",
      "url",
      "which-typed-array",
      "is-typed-array",
      "available-typed-arrays",
      "foreach",
      "typedarray-to-buffer",
      "call-bind",
      "get-proto",
      "object-inspect",
      "side-channel",
      "qs",
      "cookie",
      "raw-body",
    ],
    sourcemap: "linked",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
