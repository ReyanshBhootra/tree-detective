// npm run check-content [-- --strict]
// Lists everything that still needs doing before a tree is demo-ready.
import { loadTrees, loadPersonas, contentProblems } from '../server/lib/trees.js';

const strict = process.argv.includes('--strict');
const personas = loadPersonas();
const trees = loadTrees();
const codes = new Set();
let blocking = 0;
for (const t of trees) {
  const problems = contentProblems(t, personas);
  if (codes.has(t.code)) problems.unshift('duplicate code');
  codes.add(t.code);
  if (!problems.length) { console.log(`✔ ${t.code} ${t.name}`); continue; }
  blocking++;
  console.log(`✘ ${t.code} ${t.name}\n${problems.map((p) => `    - ${p}`).join('\n')}`);
}
console.log(`\n${trees.length - blocking}/${trees.length} trees demo-ready.`);
if (strict && blocking) process.exit(1);
