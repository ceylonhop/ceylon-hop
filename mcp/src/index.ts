import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { assertNotFounder, buildServer, loadConfig } from './server';

// stdio entry point — Claude Desktop / Claude Code launch this as a child process.
// Log to stderr only: stdout is the MCP protocol channel.
const cfg = loadConfig(process.env);
const who = await assertNotFounder(cfg);
await buildServer(cfg).connect(new StdioServerTransport());
console.error(`ceylon-hop-quotes MCP ready → ${cfg.baseUrl} as ${who.email} (${who.role})`);
