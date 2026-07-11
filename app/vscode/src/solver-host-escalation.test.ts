import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSolve } from './solver-host';

// HONEST ESCALATION through the VS Code Improve HOST path (docs: honest escalation; owner ruling 2026-07-04). The
// full VS Code integration harness (launch + QuickPick + refactor preview) is heavy; `runSolve` is the host-side
// core the Improve command drives (commands.ts → runSolve → the same buildSearchTools the MCP server exposes, now
// with the reference-MIP escalation target passed in), and it has NO vscode-API coupling — so this exercises the
// escalation + the normalized-body label end-to-end at the host level. When the in-process solver declines the
// CQRS budget-coupling trade-off, Improve must relay the reference-MIP answer LABELED, never dead-end.

const CQRS = readFileSync('C:/git/SystemDesignAssistant/examples/cqrs-production-large.sda.json', 'utf8');

describe('VS Code Improve host path — reference-MIP escalation is relayed and LABELED', () => {
  it('goal "fastest" on the CQRS budget-coupling design: the reference MIP answers, and the label rides the body', async () => {
    // The read sink carries the budget-coupled objective; the in-process solver declines, so this escalates.
    const res = await runSolve({ goal: 'fastest', projectJson: CQRS });
    expect(res.ok, `Improve must not dead-end, got: ${res.body}`).toBe(true);
    const body = JSON.parse(res.body) as { changes: unknown[]; engine?: string; note?: string };
    // The normalized body carries the engine so commands.ts can tell the user which solver sized the design.
    expect(body.engine).toBe('reference-mip');
    expect(body.note ?? '').toContain('reference MIP');
    // Never the mislabelled-timeout wording, and never a bare "set the knobs manually" dead end.
    expect(res.body).not.toContain('within the time limit');
  });

  it('goal "cheapest" now solves IN-PROCESS: the system-total objective dissolves the budget coupling (dogfood F8)', async () => {
    // Cheapest optimizes the WHOLE-DESIGN total cost (optimize scope:"system" — Σ of every node's own cost), so
    // every priced knob has a descent gradient and the cost ceiling is met at the descended optimum, instead of
    // binding against a single-branch objective that could not see the other knobs. The native solver therefore
    // answers directly — no reference-MIP escalation, no engine label — strictly better than the escalate-on-
    // coupling behaviour this test used to pin. The escalation path itself stays covered by the "fastest" case
    // above, whose single-cell objective still couples with the budget ceiling.
    const res = await runSolve({ goal: 'cheapest', projectJson: CQRS });
    expect(res.ok, res.body).toBe(true);
    const body = JSON.parse(res.body) as { changes: unknown[]; engine?: string };
    expect(body.engine).toBeUndefined(); // solved by the in-process native solver, not the escalated MIP
    expect(body.changes.length).toBeGreaterThan(0); // a real whole-design sizing, not a dead end
  });
});
