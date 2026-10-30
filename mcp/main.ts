// Starts the Project Transit MCP server on stdio:  node mcp/main.ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';

await createServer().connect(new StdioServerTransport());
