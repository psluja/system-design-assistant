import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RESPONSE_TIME_TITLE, RESPONSE_PER_COMPONENT_TITLE, LOAD_PER_COMPONENT_TITLE, PROPAGATION_LAG_TITLE, COST_BREAKDOWN_TITLE,
} from '@sda/presenter';

// SYSTEM-PANEL TITLE PARITY LINT (one-source by construction). The web System panel's section STRUCTURE
// must come from @sda/presenter — never be re-typed as a JSX string literal, which is exactly the drift this task
// exists to kill (a title renamed in the presenter and silently forgotten in the web JSX, or vice versa; both
// directions happened before this task: 'Load stages · transient' was hand-copied from twoTierSection's own
// returned title, and the Cost section read 'Cost · breakdown' on web but 'Cost' in the presenter). This is a
// SOURCE-READING lint in the same family as app/vscode/src/solver-dialect.test.ts's banned-word sweep: it reads
// system-panel.tsx as TEXT and fails if any shared section title reappears as a bare string literal instead of the
// imported presenter constant. A rename in the presenter can therefore never silently drift out of sync again — the
// web source either references the (now-renamed) constant, or this test fails on a stray literal.

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, 'system-panel.tsx'), 'utf8');

/** Strip block + line comments (JSX comments are block comments) — the same technique solver-dialect.test.ts uses,
 *  so a title merely mentioned in an explanatory comment never trips the lint. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

/** Every string literal's text content (single/double/template-quoted), with `${…}` interpolations blanked first
 *  (an expression is code, not a literal — this repo's established literal-sweep technique). */
function stringLiterals(source: string): string[] {
  let code = stripComments(source);
  for (let i = 0; i < 3; i += 1) code = code.replace(/\$\{[^{}]*\}/g, '');
  const literals = code.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
  return literals.map((l) => l.slice(1, -1));
}

// The section titles both shells must render VERBATIM identically — every one now a named export of
// app/presenter/src/summary.ts (PROMISES_TITLE was already shared before this task; these five are 
// extraction of the rest of the System panel's section titles).
const SHARED_TITLES: Readonly<Record<string, string>> = {
  RESPONSE_TIME_TITLE, RESPONSE_PER_COMPONENT_TITLE, LOAD_PER_COMPONENT_TITLE, PROPAGATION_LAG_TITLE, COST_BREAKDOWN_TITLE,
};

describe('system-panel.tsx — section titles come ONLY from the presenter (parity lint)', () => {
  it('references every shared section-title constant (the identifier, not a re-typed literal)', () => {
    for (const name of Object.keys(SHARED_TITLES)) {
      expect(SOURCE, `system-panel.tsx must reference the shared ${name} from @sda/presenter`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('never hardcodes a shared title as a string literal — only the imported identifier may carry the text', () => {
    const literals = stringLiterals(SOURCE);
    const offenders = Object.entries(SHARED_TITLES).filter(([, text]) => literals.includes(text));
    expect(offenders.map(([name]) => name), `system-panel.tsx re-types these as a literal instead of importing them: ${offenders.map(([, t]) => t).join(', ')}`).toEqual([]);
  });
});
