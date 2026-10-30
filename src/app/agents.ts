// Connecting AI agents: the desktop app ships the MCP server (mcp/, bundled by `pnpm build:mcp`)
// as a resource, and Settings copies a ready-made setup that points at it.
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from './persistence.ts';

export interface McpSetup {
  /** the bundled server inside the installed app */
  server: string;
  /** absolute path to Node.js, if found */
  node: string | null;
}

export async function mcpSetup(): Promise<McpSetup | null> {
  if (!isDesktop()) return null;
  const { resolveResource } = await import('@tauri-apps/api/path');
  const [server, node] = await Promise.all([resolveResource('mcp/project-transit-mcp.mjs'), invoke<string | null>('find_node').catch(() => null)]);
  return { server, node };
}

const windows = () => /Windows/i.test(navigator.userAgent);
const quote = (s: string) => (windows() ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);

/** One terminal command that adds the server to Claude Code for all projects. */
export const claudeCodeCommand = (s: McpSetup) => `claude mcp add --scope user project-transit -- ${quote(s.node ?? 'node')} ${quote(s.server)}`;

/** The entry for apps configured with JSON (Claude Desktop, Cursor and others). */
export const jsonConfig = (s: McpSetup) => JSON.stringify({ mcpServers: { 'project-transit': { command: s.node ?? 'node', args: [s.server] } } }, null, 2);

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // older WebKit: fall back to a hidden text area
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
