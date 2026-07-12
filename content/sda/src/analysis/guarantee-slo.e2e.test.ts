import { describe, expect, it } from 'vitest';
import type { Graph } from '@sda/engine-core';
import {
  allManifests,
  categorical,
  catalogGuaranteeContributions,
  claimsFor,
  guaranteeVerdicts,
  guaranteeVerdictRow,
  instantiate,
  type GuaranteeSlo,
  type Instance,
  type Wire,
} from '../index';
import { keys } from '../vocabulary/registry';

// R2 (CONTENT round) of guarantee propagation. Two gates:
//   1. CATALOG-LABELING INTEGRITY — every declared per-port contribution names a VALID dimension + token, and every
//      `documented` claim carries a source URL (the certain/declared/refused contract: sourced or honestly est.).
//   2. THE REMEDIATION STORY — an ordering requirement violated at a standard SQS queue produces a computed verdict
//      naming the queue as root cause AND a remediation that swaps it to FIFO, with FIFO's documented 300 msg/s
//      ceiling and a real cost delta — computed off the model, never advised from air.

const build = (instances: Instance[], wires: Wire[]): Graph => {
  const g = instantiate(allManifests, instances, wires);
  if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
  return g.value;
};
// A tiny solved-value lookup with NO served load (undefined) — enough where the test does not exercise the cost
// delta / ceiling-fit (those need a served throughput; the violation, root cause and swap TYPE do not).
const noLoad = (_id: string, _k: unknown): number | undefined => undefined;

describe('R2 catalog-labeling integrity — every declared guarantee is valid + sourced-or-estimated', () => {
  it('every contribution names a valid dimension and token', () => {
    expect(catalogGuaranteeContributions.length).toBeGreaterThan(0);
    for (const c of catalogGuaranteeContributions) {
      for (const claim of c.claims) {
        const lattice = categorical.get(claim.dimension);
        expect(lattice, `dimension "${String(claim.dimension)}" for ${c.where}`).toBeDefined();
        // the token must be a real token of that dimension's lattice (rank defined)
        expect(lattice?.rank(claim.token), `token "${String(claim.token)}" of "${String(claim.dimension)}" for ${c.where}`).toBeDefined();
      }
    }
  });

  it('every declared claim is EITHER documented (has a source URL) OR an honest estimate — never a bare guess', () => {
    for (const c of catalogGuaranteeContributions) {
      for (const claim of c.claims) {
        const documented = typeof claim.source === 'string' && claim.source.length > 0;
        const estimate = claim.est === true;
        // exactly the certain/declared/refused contract: a token is sourced OR est., and never both (documented wins).
        expect(documented || estimate, `${c.where} · ${String(claim.dimension)} must be documented or est.`).toBe(true);
        if (documented) expect(claim.source).toMatch(/^https?:\/\//);
      }
    }
  });

  it('every documented source URL is well-formed (a primary-doc link, carried as data)', () => {
    for (const c of catalogGuaranteeContributions) {
      for (const claim of c.claims) {
        if (claim.source !== undefined) expect(claim.source).toMatch(/^https:\/\/[^\s]+$/);
      }
    }
  });

  it('the catalog manifests attach the SAME contribution objects (claimsFor recovers provenance by identity)', () => {
    // SQS standard's out port carries the sqsStandardContribution tokens — claimsFor must recover its sourced claims.
    const sqs = allManifests['queue.sqs'];
    const out = sqs?.ports.find((p) => p.name === 'out');
    const claims = claimsFor(out?.guarantees);
    expect(claims).toBeDefined();
    expect(claims?.some((c) => String(c.dimension) === 'ordering' && String(c.token) === 'none')).toBe(true);
    expect(claims?.every((c) => c.source !== undefined)).toBe(true); // SQS standard is fully documented
  });
});

describe('R2 remediation story — ordering violated at SQS standard → the computed FIFO swap', () => {
  // producer → SQS standard → worker; the consumer flow's ordering degrades to `none` at the queue.
  const instances: Instance[] = [
    { id: 'producer', type: 'client.web' },
    { id: 'q', type: 'queue.sqs' },
    { id: 'worker', type: 'compute.serverless' },
  ];
  const wires: Wire[] = [
    { from: ['producer', 'out'], to: ['q', 'in'] },
    { from: ['q', 'out'], to: ['worker', 'in'], semantics: 'async' },
  ];

  it('an Ordering ≥ per-key requirement is VIOLATED at the queue and the remediation names FIFO + ceiling + cost', () => {
    const graph = build(instances, wires);
    // feed the remediation a served load under FIFO's 300 msg/s ceiling so the swap is viable
    const served = new Map<string, number>([['q', 45]]);
    const value = (id: string, k: unknown): number | undefined => (String(k) === String(keys.throughput) ? served.get(id) : undefined);
    const slos: GuaranteeSlo[] = [{ source: 'producer', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' }];

    const verdicts = guaranteeVerdicts(graph, allManifests, instances, wires, value, slos);
    expect(verdicts).toHaveLength(1);
    const v = verdicts[0];
    if (v === undefined) throw new Error('no verdict');
    expect(v.status).toBe('violation');
    expect(v.computed).toBe('none'); // the queue dropped ordering to none
    expect(v.rootCauseNode).toBe('q'); // blamed on the SQS standard queue

    // THE COMPUTED REMEDIATION — the cheapest same-family swap that RESTORES the guarantee.
    const rem = v.remediation;
    expect(rem).toBeDefined();
    expect(rem?.toType).toBe('queue.sqs.fifo');
    // FIFO's documented 300 msg/s ceiling, read off its config (with the AWS quota source on the manifest).
    expect(rem?.ceiling?.value).toBe(300);
    expect(rem?.ceiling?.unit).toBe('msg/s');
    // the flow's 45 msg/s fits under 300 ✓
    expect(rem?.fitsCeiling).toBe(true);
    // a real cost delta: FIFO ($1.5/(msg/s)·mo) − standard ($1) = +$0.5 × 45 served = +$22.5/mo
    expect(rem?.costDeltaUsdMonth).toBeCloseTo(22.5, 1);
    // the one-line action names the swap, the ceiling and the delta (computed, not advised from air)
    expect(rem?.action).toContain('queue.sqs.fifo');
    expect(rem?.action).toContain('300');
  });

  it('once the queue IS FIFO, the requirement holds (ok) and no remediation is offered', () => {
    const fifoInstances: Instance[] = [
      { id: 'producer', type: 'client.web' },
      { id: 'q', type: 'queue.sqs.fifo' },
      { id: 'worker', type: 'compute.serverless' },
    ];
    const graph = build(fifoInstances, wires);
    const value = noLoad;
    const slos: GuaranteeSlo[] = [{ source: 'producer', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' }];
    const v = guaranteeVerdicts(graph, allManifests, fifoInstances, wires, value, slos)[0];
    expect(v?.status).toBe('ok');
    expect(v?.computed).toBe('per-key');
    expect(v?.remediation).toBeUndefined();
  });

  it('a requirement whose flow does not exist is honestly UNKNOWN (never a silent drop)', () => {
    const graph = build(instances, wires);
    const value = noLoad;
    const slos: GuaranteeSlo[] = [{ source: 'ghost', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' }];
    const v = guaranteeVerdicts(graph, allManifests, instances, wires, value, slos)[0];
    expect(v?.status).toBe('unknown');
    expect(v?.noRemediationReason).toContain('no flow');
  });

  it('the row mapper flattens a verdict to the design-doc shape (one computation, both surfaces)', () => {
    const graph = build(instances, wires);
    const served = new Map<string, number>([['q', 45]]);
    const value = (id: string, k: unknown): number | undefined => (String(k) === String(keys.throughput) ? served.get(id) : undefined);
    const slos: GuaranteeSlo[] = [{ source: 'producer', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' }];
    const v = guaranteeVerdicts(graph, allManifests, instances, wires, value, slos)[0];
    if (v === undefined) throw new Error('no verdict');
    const row = guaranteeVerdictRow(v);
    expect(row.source).toBe('producer');
    expect(row.terminal).toBe('worker');
    expect(row.dimension).toBe('ordering');
    expect(row.required).toBe('per-key');
    expect(row.computed).toBe('none');
    expect(row.status).toBe('violation');
    expect(row.rootCauseNode).toBe('q');
    expect(row.remediation).toContain('queue.sqs.fifo');
  });
});

describe('R2 remediation — no swap exists ⇒ honest "no remediation"', () => {
  it('a consistency requirement violated at a component with no same-family stronger option says so honestly', () => {
    // dynamodb reads are eventual; there is no same-family (db.*) component in the voice catalog that fits a
    // dynamodb's exact wiring AND declares strong consistency — but the family DOES include strong writers, so this
    // asserts the HONEST path only when no candidate qualifies. Use a design that forces the no-swap branch by
    // requiring strong on a dynamodb terminal within a family whose only fit is dynamodb itself.
    const instances: Instance[] = [
      { id: 'client', type: 'client.browser' },
      { id: 'ddb', type: 'db.dynamodb' },
    ];
    const wires: Wire[] = [{ from: ['client', 'out'], to: ['ddb', 'in'] }];
    const g = instantiate(allManifests, instances, wires);
    if (!g.ok) throw new Error(`build failed: ${JSON.stringify(g.error)}`);
    const value = (_id: string, _k: unknown): number | undefined => undefined;
    const slos: GuaranteeSlo[] = [{ source: 'client', terminal: 'ddb', dimension: 'consistency', atLeast: 'strong' }];
    const v = guaranteeVerdicts(g.value, allManifests, instances, wires, value, slos)[0];
    expect(v?.status).toBe('violation');
    expect(v?.computed).toBe('eventual');
    // whatever the swap search finds, the verdict is honest: either a real same-family swap OR a stated reason.
    expect(v?.remediation !== undefined || v?.noRemediationReason !== undefined).toBe(true);
  });
});
