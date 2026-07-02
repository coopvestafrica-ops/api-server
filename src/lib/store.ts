import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// We persist in a "data" directory relative to the API server package
const DATA_DIR = path.resolve(__dirname, "../../data");

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    // Ignore error if directory already exists
  }
}

export async function readData<T>(filename: string, fallback: T): Promise<T> {
  await ensureDataDir();
  const filepath = path.join(DATA_DIR, filename);
  try {
    const content = await fs.readFile(filepath, "utf-8");
    return JSON.parse(content) as T;
  } catch (e) {
    // If file doesn't exist or is invalid, write fallback and return it
    try {
      await fs.writeFile(filepath, JSON.stringify(fallback, null, 2), "utf-8");
    } catch (writeErr) {
      // Ignore write errors in read fallback
    }
    return fallback;
  }
}

export async function writeData<T>(filename: string, data: T): Promise<void> {
  await ensureDataDir();
  const filepath = path.join(DATA_DIR, filename);
  await fs.writeFile(filepath, JSON.stringify(data, null, 2), "utf-8");
}
