const path = require("path");
const { build } = require("esbuild");

async function buildAll() {
  const result = await build({
    entryPoints: [path.resolve(__dirname, "src/index.ts")],
    platform: "node",
    bundle: false,
    write: false,
    metafile: true,
    logLevel: "info",
  });
  console.log(JSON.stringify(result.metafile, null, 2));
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
