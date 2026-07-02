import type { VercelRequest, VercelResponse } from "@vercel/node";

// Pre-built server module
let serverModule: any = null;

async function getServer() {
  if (!serverModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    serverModule = await import("../dist/index.mjs");
  }
  return serverModule;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    const mod = await getServer();
    // The exported default is the handler function
    const serverHandler = mod.default || mod.handler || mod;
    await serverHandler(req, res);
  } catch (error) {
    console.error("Serverless handler error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
