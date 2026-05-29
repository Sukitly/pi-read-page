import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebReadTool } from "../src/tools/web-read";

export default function webReadExtension(pi: ExtensionAPI) {
  registerWebReadTool(pi);
}
