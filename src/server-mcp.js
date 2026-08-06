// The MCP boot mode — the third way a Node's handlers run, beside createServer
// (local web app) and createHostedServer (online, multi-tenant). Projects a
// curated set of the Node's handlers as MCP tools so AI agents (Claude Desktop,
// and later remote connectors) can call them. Design + phasing:
// grounded2026/docs/MCP_BLUEPRINT.md. Proven first as a hand-written spike in
// node-verifier, then generalised here (phase 2).
//
// A Node ships a manifest (lib/mcp-tools.js) of ONLY the capabilities it wants
// to expose — never a reflection of every route:
//
//   export const mcpTools = [{
//     name: 'verify_claim',                    // MCP tool name
//     title: 'Verify a claim',                 // human label
//     description: '…what it does, honestly…',
//     inputSchema: { type: 'object', … },      // plain JSON Schema
//     annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
//     handler: 'postBrief',                    // name in `handlers`, OR a (host, args) fn
//   }];
//
// and a tiny mcp-server.js entry point:
//
//   import { createLiteHost, createMcpServer, redirectConsoleForStdio } from '@developai/grounded-node-runtime';
//   redirectConsoleForStdio();                  // BEFORE the host exists — see below
//   const host = createLiteHost({ appSlug: SLUG, nodeVersion, newsroom: process.env.NEWSROOM });
//   await createMcpServer({ slug, productName, nodeVersion, host, handlers, tools: mcpTools });
//
// The whole point is the call `run(host, args)`: byte-for-byte the same contract
// the REST wrap in server.js / server-hosted.js invokes. No handler changes.
//
// The SDK is lazy-imported (same discipline server-hosted.js uses for pg etc.),
// and lives in optionalDependencies so a Node needs no direct SDK dep.

/**
 * stdio transport gotcha: stdout IS the JSON-RPC channel, and both this
 * runtime's lite host and many Nodes log with console.log. Call this FIRST —
 * before creating the host — or the protocol stream gets corrupted.
 */
export function redirectConsoleForStdio() {
  console.log = (...args) => console.error(...args);
}

/**
 * Boot an MCP server over the SAME handlers the web app runs.
 *
 * @param {object}   opts
 * @param {string}   opts.slug         Node slug → server name `grounded-<slug>`.
 * @param {string}   [opts.productName] Human title (e.g. "Election Watch").
 * @param {string}   [opts.nodeVersion] The Node's version (shown to clients).
 * @param {object}   opts.host         A host (createLiteHost locally; hostFor(req) hosted).
 * @param {object}   [opts.handlers]   The Node's handlers module (for string handler refs).
 * @param {Array}    opts.tools        The curated manifest (see file header).
 * @param {object}   [opts.transport]  An SDK transport; defaults to stdio.
 * @returns the connected SDK Server instance.
 */
export async function createMcpServer({ slug, productName, nodeVersion, host, handlers = {}, tools, transport }) {
  if (!slug) throw new Error("createMcpServer: slug is required");
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("createMcpServer: pass the Node's curated mcpTools manifest (never expose every route)");
  }
  for (const t of tools) {
    const run = typeof t.handler === "function" ? t.handler : handlers[t.handler];
    if (typeof run !== "function") {
      throw new Error(`createMcpServer: tool "${t.name}" points at missing handler "${t.handler}"`);
    }
  }

  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  const server = new Server(
    { name: `grounded-${slug}`, title: productName || `grounded-${slug}`, version: nodeVersion || "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
      name, title, description, inputSchema, annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
    }
    const run = typeof tool.handler === "function" ? tool.handler : handlers[tool.handler];
    try {
      // The exact contract the REST wrap invokes: (host, args) → result object.
      const result = await run(host, req.params.arguments || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      await host.log?.error?.({ op: `mcp:${tool.name}`, error: err }).catch(() => {});
      return { isError: true, content: [{ type: "text", text: `${tool.name} failed: ${err.message || err}` }] };
    }
  });

  if (!transport) {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    transport = new StdioServerTransport();
  }
  await server.connect(transport);
  console.error(`[mcp] grounded-${slug} v${nodeVersion || "?"} up — tools: ${tools.map((t) => t.name).join(", ")}`);
  return server;
}
