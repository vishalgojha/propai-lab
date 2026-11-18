import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { noteShown } from "./contactSession.ts";
import { redactMcpResult } from "./contactPrivacy.ts";

/** Staged contact reveal: every tool result and resource read is redacted; only the reveal tools are exempt. */
export function installContactPrivacy(server: McpServer, context: object, exemptTools: ReadonlySet<string>) {
  const rawRegisterTool = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, config: unknown, cb: (...a: any[]) => Promise<unknown>) =>
    rawRegisterTool(name, config, async (...a: any[]) => {
      const result = await cb(...a);
      if (exemptTools.has(name)) return result;
      noteShown(context as object, result);
      return redactMcpResult(result);
    });
  const rawRegisterResource = server.registerResource.bind(server) as (...a: any[]) => any;
  (server as any).registerResource = (...args: any[]) => {
    const i = args.length - 1;
    const cb = args[i] as (...a: any[]) => Promise<unknown>;
    args[i] = async (...a: any[]) => redactMcpResult(await cb(...a));
    return rawRegisterResource(...args);
  };
}
