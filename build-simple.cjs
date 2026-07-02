const path = require("path");
const { build } = require("esbuild");
const fs = require("fs");

const artifactDir = __dirname;

// Preprocess: Convert all exports to module.exports in TypeScript files
function preprocess(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      preprocess(fullPath);
    } else if (file.endsWith('.ts')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      // Replace all "export default router;" with "module.exports = router;"
      if (content.includes('export default router;')) {
        const updated = content.replace(/export default router;/g, 'module.exports = router;');
        fs.writeFileSync(fullPath, updated);
        console.log('Converted:', fullPath);
      }
    }
  }
}

async function buildAll() {
  // Run preprocessing
  console.log('Preprocessing TypeScript files...');
  preprocess(path.join(artifactDir, 'src'));
  
  const distDir = path.resolve(artifactDir, "dist");
  fs.rmSync(distDir, { recursive: true, force: true });

  await build({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    banner: {
      js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`,
    },
    external: [
      "@supabase/supabase-js",
      "@vercel/node",
      "express",
      "cors",
      "helmet",
      "pino",
      "pino-http",
      "pino-pretty",
      "zod",
    ],
    sourcemap: "linked",
  });
  console.log("Build complete!");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
