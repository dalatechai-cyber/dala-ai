#!/usr/bin/env node
// GUARD: no date-suffixed model ids, and every model id lives in ONE registry. (§6.10.5.)
//
// A retired model is not a crash — it is the feature quietly becoming something else.
// The sibling shipped an OpenAI model that had been shut down two months earlier in two
// live routes, with a fallback to a legacy UI, and nothing went red. The ancestor pins a
// date-suffixed id at `api/chat.js:13`, which is the same bet with a fuse on it.
//
// Current Claude model ids carry NO date suffix — `claude-sonnet-5`, not
// `claude-sonnet-5-20260401`. A date-suffixed id is either a hallucinated one that will
// 404, or a real snapshot that will be retired on a schedule nobody here is tracking.
import fs from 'node:fs';
import { walk, stripComments, fail } from './_walk.mjs';

// ascii-safe: model ids are ASCII slugs, not user text.
const DATE_SUFFIXED = /claude-[a-z0-9-]*-\d{8}/;
const ANY_MODEL_ID = /['"`](claude-[a-z0-9.-]+)['"`]/g;   // ascii-safe: as above
const REGISTRY = 'config/models.json';

const problems = [];
const seenOutsideRegistry = new Map();

for (const file of [...walk('src'), ...walk('scripts')]) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);

  const rawLines = raw.split('\n');
  src.split('\n').forEach((line, i) => {
    // A line may opt out with an explicit `// not-a-pin:` justification. The one
    // legitimate case is a TEST that demonstrates a dated id being DETECTED — the exact
    // opposite of pinning one — and a grep cannot tell those apart. Same escape hatch as
    // check-cyrillic-matchers', and for the same reason: without it the only way past a
    // correct guard is to weaken the test, which is the worse outcome.
    if (/not-a-pin:/.test(rawLines[i] ?? '')) return;
    if (DATE_SUFFIXED.test(line)) {
      problems.push(
        `${file}:${i + 1} pins a DATE-SUFFIXED model id.\n` +
        `      Current ids carry no date suffix. A dated id either 404s now or is retired ` +
        `on a schedule nobody here tracks — and a retired model presents as a changed ` +
        `response, not as an error.`);
    }
  });

  if (file.endsWith('.test.ts') || file.endsWith('.test.mjs')) continue;
  ANY_MODEL_ID.lastIndex = 0;
  let m;
  while ((m = ANY_MODEL_ID.exec(src)) !== null) {
    const list = seenOutsideRegistry.get(m[1]) ?? [];
    list.push(file);
    seenOutsideRegistry.set(m[1], list);
  }
}

for (const [id, files] of seenOutsideRegistry) {
  problems.push(
    `Model id "${id}" appears outside ${REGISTRY}: ${[...new Set(files)].join(', ')}.\n` +
    `      §6.2.6: a model id appears in exactly ONE file. Two copies is how a migration ` +
    `updates one of them.`);
}

if (fs.existsSync(REGISTRY)) {
  const registry = fs.readFileSync(REGISTRY, 'utf8');
  if (!/claude-/.test(registry)) {   // ascii-safe: model id prefix
    problems.push(`${REGISTRY} names no model at all. The registry is where ids live; an empty one means they live somewhere else.`);
  }
}

fail('check-model-ids', problems);
