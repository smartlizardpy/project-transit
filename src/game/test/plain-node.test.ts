// The game core must load in plain Node (Node strips types but rejects TypeScript-only syntax
// such as constructor parameter properties). The MCP server relies on this.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('game core in plain Node', () => {
  it('loads the engine, analytics, automation and diagnostics without a build step', () => {
    const script = "Promise.all(['./src/game/engine.ts','./src/game/automation/registry.ts','./src/game/automation/lab.ts','./src/game/automation/templates.ts','./src/game/analytics/query.ts','./src/game/diagnostics.ts'].map((m) => import(m))).then(() => console.log('ok'))";
    const out = execFileSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' });
    expect(out.trim()).toBe('ok');
  });
});
