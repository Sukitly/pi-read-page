import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeBrowser } from "../src/browser/browser-manager";
import { registerWebReadTool } from "../src/tools/web-read";

export default function webReadExtension(pi: ExtensionAPI) {
  registerWebReadTool(pi);

  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });
}
