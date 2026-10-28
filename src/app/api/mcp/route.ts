/**
 * DropQ's MCP endpoint (Streamable HTTP, stateless).
 *
 * POST only: in stateless mode the SDK answers GET with 405, which is the documented
 * "no standalone SSE stream" signal and is what the official client expects. Every
 * request gets a fresh server and transport; the tools themselves are stateless and
 * carry all state in the session row they create.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { liveDeps } from "@/lib/mcp/live";
import { createDropQMcpServer } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const server = createDropQMcpServer(liveDeps(request));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 64 * 1024,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
