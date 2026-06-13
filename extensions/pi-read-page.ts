import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeBrowser } from "../src/browser/browser-manager";
import { registerReadPageTool } from "../src/tools/read-page";

export default function readPageExtension(pi: ExtensionAPI) {
  registerReadPageTool(pi);

  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });
}
