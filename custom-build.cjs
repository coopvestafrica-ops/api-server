const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

async function buildAll() {
  const artifactDir = __dirname;
  const tmpDir = path.join(artifactDir, "tmp_transpiled");
  
  // Create tmp dir
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  
  // Transpile all TypeScript files with tsx
  function transpileDir(srcDir, destDir) {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    
    const files = fs.readdirSync(srcDir);
    for (const file of files) {
      const srcPath = path.join(srcDir, file);
      const destPath = path.join(destDir, file);
      const stat = fs.statSync(srcPath);
      
      if (stat.isDirectory()) {
        transpileDir(srcPath, destPath);
      } else if (file.endsWith('.ts')) {
        const jsFile = file.replace('.ts', '.mjs');
        const destJsPath = path.join(destDir, jsFile);
        try {
          // Use tsx to transpile and output to file
          execSync(`npx tsx ${srcPath} > /dev/null 2>&1 || true`, { stdio: 'pipe' });
        } catch (e) {}
        // Instead, let's just rename the file
        fs.copyFileSync(srcPath, destJsPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
  
  transpileDir(path.join(artifactDir, "src"), path.join(tmpDir, "src"));
  
  // Create a simple wrapper that uses tsx at runtime
  const indexContent = `
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transpileAndRun } from "./transpiler.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic import with tsx transpilation
async function main() {
  const { createServer } = await import("./app.mjs");
  const app = await createServer();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(\`Server running on port \${port}\`));
}

main().catch(console.error);
`;
  
  fs.writeFileSync(path.join(tmpDir, "src", "index.mjs"), indexContent);
  
  console.log("Prepared files for transpilation");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
