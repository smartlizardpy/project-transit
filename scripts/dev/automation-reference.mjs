// Prints the Automation Studio node and expression reference as Markdown, straight from the
// registry, so docs/automation-api.md cannot drift from the code. Loads the TypeScript through
// Vite (already a dependency); nothing is installed.
//   node scripts/dev/automation-reference.mjs > /tmp/ref.md
// Paste the output between the "generated" markers in docs/automation-api.md.
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const { CATEGORIES, NODES } = await server.ssrLoadModule('/src/game/automation/registry.ts');
  const { FUNCTIONS, LIMITS } = await server.ssrLoadModule('/src/game/expr.ts');
  const { typeName } = await server.ssrLoadModule('/src/game/automation/validate.ts');
  const out = [];
  const esc = (s) => s.replace(/\|/g, '\\|');
  out.push('### Nodes', '');
  for (const c of CATEGORIES) {
    const nodes = NODES.filter((n) => n.category === c.id);
    if (!nodes.length) continue;
    out.push(`#### ${c.label}`, '', c.help, '', '| Node | What it does | Inputs | Outputs | Settings |', '|---|---|---|---|---|');
    for (const n of nodes) {
      const ins = n.inputs.map((p) => `${p.label} (${typeName(p.type)}${p.list ? ' or list' : ''}${p.optional ? ', optional' : ''})`).join(', ') || '–';
      const outs = n.outputs.map((p) => `${p.label} (${typeName(p.type)})`).join(', ') || '–';
      const cfg = n.config.map((f) => f.label).join(', ') || '–';
      const impact = n.action?.impact === 'high' ? ' **Big change.**' : '';
      out.push(`| ${esc(n.label)} \`${n.type}\` | ${esc(n.description)}${impact} | ${esc(ins)} | ${esc(outs)} | ${esc(cfg)} |`);
    }
    out.push('');
  }
  out.push('### Expression functions', '', '| Function | Arguments | What it does |', '|---|---|---|');
  for (const [name, f] of Object.entries(FUNCTIONS)) out.push(`| \`${name}\` | ${f.min === f.max ? f.min : `${f.min}–${f.max}`} | ${esc(f.doc)} |`);
  out.push('', '### Expression limits', '', '| Limit | Value |', '|---|---|');
  for (const [k, v] of Object.entries(LIMITS)) out.push(`| ${k} | ${v} |`);
  console.log(out.join('\n'));
} finally {
  await server.close();
}
