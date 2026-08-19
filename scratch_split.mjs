import fs from 'fs';
import path from 'path';

const promptFile = 'lib/plan/prompt.ts';
const content = fs.readFileSync(promptFile, 'utf8');

// The original content uses \n, but in windows it might be \r\n, we use \r?\n in regexes
const match = content.match(/export const PLANNER_SYSTEM_PROMPT = `([\s\S]*?)`;/);
if (!match) throw new Error("Could not find PLANNER_SYSTEM_PROMPT");

const fullPrompt = match[1];

const sections = [
  { id: 'base', title: 'Base rules', match: /^You are the AI editor[\s\S]*?(?=^## plan$)/m },
  { id: 'plan', title: 'Plan mode', match: /^## plan\r?\n[\s\S]*?(?=^## moment$)/m },
  { id: 'moment', title: 'Moment mode', match: /^## moment\r?\n[\s\S]*?(?=^## extract$)/m },
  { id: 'extract', title: 'Extract mode', match: /^## extract\r?\n[\s\S]*?(?=^## describe  \(NEW v1\.6\.4\)$)/m },
  { id: 'describe', title: 'Describe mode', match: /^## describe  \(NEW v1\.6\.4\)\r?\n[\s\S]*?(?=^## edit  \(NEW v1\.6\.1\)$)/m },
  { id: 'edit', title: 'Edit mode', match: /^## edit  \(NEW v1\.6\.1\)\r?\n[\s\S]*?(?=^## acknowledge  \(NEW v1\.5\.2\)$)/m },
  { id: 'acknowledge', title: 'Acknowledge mode', match: /^## acknowledge  \(NEW v1\.5\.2\)\r?\n[\s\S]*?(?=^## briefing  \(NEW v1\.7\.0\)$)/m },
  { id: 'briefing', title: 'Briefing mode', match: /^## briefing  \(NEW v1\.7\.0\)\r?\n[\s\S]*?(?=^## promote  \(NEW v1\.7\.2\)$)/m },
  { id: 'promote', title: 'Promote mode', match: /^## promote  \(NEW v1\.7\.2\)\r?\n[\s\S]*?(?=^## merge  \(NEW v1\.7\.4\)$)/m },
  { id: 'merge', title: 'Merge mode', match: /^## merge  \(NEW v1\.7\.4\)\r?\n[\s\S]*?(?=^## compose  \(NEW v1\.8\.0\)$)/m },
  { id: 'compose', title: 'Compose mode', match: /^## compose  \(NEW v1\.8\.0\)\r?\n[\s\S]*?(?=^## clarify$)/m },
  { id: 'clarify', title: 'Clarify mode', match: /^## clarify\r?\n[\s\S]*?(?=^# Turn taxonomy — pick the mode for each pattern$)/m },
  { id: 'taxonomy', title: 'Turn taxonomy', match: /^# Turn taxonomy — pick the mode for each pattern\r?\n[\s\S]*?(?=^# Auto-mode autonomy \(v1\.7\.0\)$)/m },
  { id: 'autoMode', title: 'Auto-mode autonomy', match: /^# Auto-mode autonomy \(v1\.7\.0\)\r?\n[\s\S]*?(?=^# Duration & append rules \(v1\.7\.1\) — IMPORTANT$)/m },
  { id: 'duration', title: 'Duration rules', match: /^# Duration & append rules \(v1\.7\.1\) — IMPORTANT\r?\n[\s\S]*?(?=^# factsToRemember \(v1\.7\.0\)$)/m },
  { id: 'facts', title: 'Facts to remember', match: /^# factsToRemember \(v1\.7\.0\)\r?\n[\s\S]*?(?=^# Anti-loop rule \(v1\.6\.2\)$)/m },
  { id: 'antiLoop', title: 'Anti-loop rule', match: /^# Anti-loop rule \(v1\.6\.2\)\r?\n[\s\S]*?(?=^# Library awareness \(v1\.6\.0\)$)/m },
  { id: 'library', title: 'Library awareness', match: /^# Library awareness \(v1\.6\.0\)\r?\n[\s\S]*?(?=^# EditPlan schema$)/m },
  { id: 'schema', title: 'Schema and formatting', match: /^# EditPlan schema\r?\n[\s\S]*/m }
];

let remainingText = fullPrompt.replace(/\r\n/g, '\n'); // normalize for easier processing
const extracted = {};

for (const sec of sections) {
  const m = remainingText.match(sec.match);
  if (m) {
    extracted[sec.id] = m[0].trim();
    remainingText = remainingText.replace(m[0], '');
  } else {
    console.warn(`Warning: Could not match section ${sec.id}`);
  }
}

if (remainingText.trim().length > 0) {
  console.warn("WARNING: Some text was not matched!");
  console.warn(remainingText.trim().slice(0, 500));
}

const promptsDir = path.join('lib', 'plan', 'prompts');
if (!fs.existsSync(promptsDir)) {
  fs.mkdirSync(promptsDir, { recursive: true });
}

const exportsLines = [];
const importsLines = [];

for (const sec of sections) {
  if (!extracted[sec.id]) continue;
  const varName = `${sec.id.toUpperCase()}_PROMPT`;
  const fileContent = `export const ${varName} = \`\n${extracted[sec.id].replace(/`/g, '\\`')}\n\`;\n`;
  fs.writeFileSync(path.join(promptsDir, `${sec.id}.ts`), fileContent);
  exportsLines.push(`  ${varName}`);
  importsLines.push(`import { ${varName} } from "./${sec.id}";`);
}

const indexContent = `${importsLines.join('\n')}

export const PLANNER_SYSTEM_PROMPT = [
${exportsLines.join(',\n')}
].join('\\n\\n');
`;
fs.writeFileSync(path.join(promptsDir, 'index.ts'), indexContent);

// Replace PLANNER_SYSTEM_PROMPT in prompt.ts
const newPromptTsContent = content.replace(
  /export const PLANNER_SYSTEM_PROMPT = `[\s\S]*?`;/,
  `import { PLANNER_SYSTEM_PROMPT } from "./prompts/index";\n\nexport { PLANNER_SYSTEM_PROMPT };`
);

fs.writeFileSync(promptFile, newPromptTsContent);

console.log("Done successfully!");
