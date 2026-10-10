import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { config } from "./env.ts";

/** Connect to the agentmesh MCP server the same way a coding agent would. */
export async function connectMcp(name: string) {
  const client = new Client({ name, version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${config.workerUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${config.apiKey()}` } },
  });
  await client.connect(transport);
  return {
    tools: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (tool: string, args: Record<string, unknown>): Promise<string> => {
      const res = await client.callTool({ name: tool, arguments: args });
      const out = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
      if (res.isError) throw new Error(`${tool} failed: ${out}`);
      return out;
    },
    close: () => client.close(),
  };
}
