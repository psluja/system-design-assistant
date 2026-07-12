import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { commonManifests, registry } from '@sda/content';
import { buildTools, type ToolDef } from './tools';

function caller(tools: ToolDef[]) {
  return (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.run(args);
  };
}

describe('MCP toolset over the command core', () => {
  it('an agent builds and verifies a design entirely through tools', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    expect(call('add_component', { id: 'client', type: 'client.web' }).ok).toBe(true);
    expect(call('add_component', { id: 'nginx', type: 'proxy.nginx' }).ok).toBe(true);
    expect(call('add_component', { id: 'app', type: 'compute.service' }).ok).toBe(true);
    expect(call('add_component', { id: 'pg', type: 'db.postgres' }).ok).toBe(true);
    call('connect', { fromNode: 'client', fromPort: 'out', toNode: 'nginx', toPort: 'in' });
    call('connect', { fromNode: 'nginx', fromPort: 'out', toNode: 'app', toPort: 'in' });
    call('connect', { fromNode: 'app', fromPort: 'db', toNode: 'pg', toPort: 'in' });
    call('set_slo', { node: 'pg', key: 'throughput', min: 5000 });

    const ev = call('evaluate');
    expect(ev.ok).toBe(true);
    expect(ev.text).toContain('violation'); // pg capped at 2000 < 5000
    expect(ev.text).toContain('pg');
  });

  it('a WHOLE-SYSTEM cost promise (set_slo scope:"system"): no node asked, judged against the one whole-graph total, scope-labelled', () => {
    const s = new Studio(registry, commonManifests);
    const call = caller(buildTools(s));
    call('add_component', { id: 'client', type: 'client.web' });
    call('add_component', { id: 'app', type: 'compute.service' });
    call('add_component', { id: 'pg', type: 'db.postgres' });
    call('connect', { fromNode: 'client', fromPort: 'out', toNode: 'app', toPort: 'in' });
    call('connect', { fromNode: 'app', fromPort: 'db', toNode: 'pg', toPort: 'in' });

    // Declare the whole-system promise — NO node argument (the quantity is global; the owner's ruling).
    const set = call('set_slo', { key: 'cost', max: 0.01, scope: 'system' });
    expect(set.ok).toBe(true);
    expect(s.project().systemPromises).toEqual([{ key: 'cost', band: { shape: 'minTargetMax', max: 0.01 } }]);
    expect(s.project().instances.every((i) => (i.bands?.length ?? 0) === 0)).toBe(true); // never a node band in disguise

    // evaluate judges it against the whole-graph total (an absurdly low ceiling ⇒ violation), scope 'system',
    // and the violation counts against feasibility exactly like a node verdict.
    const ev = call('evaluate');
    expect(ev.ok).toBe(true);
    const out = JSON.parse(ev.text) as { feasible: boolean; violations: number; systemPromiseVerdicts?: { scope: string; key: string; status: string; computed?: number }[] };
    expect(out.feasible).toBe(false);
    expect(out.violations).toBeGreaterThanOrEqual(1);
    const v = out.systemPromiseVerdicts?.[0];
    expect(v?.scope).toBe('system');
    expect(v?.key).toBe('cost');
    expect(v?.status).toBe('violation');
    expect(v?.computed).toBeGreaterThan(0.01);

    // A generous ceiling reads ok — same one truth, other side of the band.
    call('set_slo', { key: 'cost', max: 1_000_000, scope: 'system' });
    const ok = JSON.parse(call('evaluate').text) as { systemPromiseVerdicts?: { status: string }[] };
    expect(ok.systemPromiseVerdicts?.[0]?.status).toBe('ok');
  });

  it('set_slo scope:"system" refuses a flow/node-scoped key with the reason (guided, self-correcting)', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    call('add_component', { id: 'db', type: 'db.postgres' });
    const r = call('set_slo', { key: 'latency', max: 300, scope: 'system' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('is not a system-scoped quantity');
    expect(r.text).toContain('cost'); // names the covered whole-system vocabulary
    expect(r.text).toContain('set it on a node'); // and the node home for a journey quantity
  });

  it('an end-to-end availability promise is an availability band on the TERMINAL node — judged against its cumulative', () => {
    // Consolidation (flowPromises removed): availability is judged AT a node against its CUMULATIVE (the serial
    // product of every dependency on the way down to it), so a band on the flow's TERMINAL node IS the end-to-end
    // path promise — one home, the SAME node-band mechanism throughput/latency use.
    const s = new Studio(registry, commonManifests);
    const call = caller(buildTools(s));
    call('add_component', { id: 'client', type: 'client.web' });
    call('add_component', { id: 'app', type: 'compute.service' });
    call('add_component', { id: 'pg', type: 'db.postgres' });
    call('connect', { fromNode: 'client', fromPort: 'out', toNode: 'app', toPort: 'in' });
    call('connect', { fromNode: 'app', fromPort: 'db', toNode: 'pg', toPort: 'in' });

    // An unreachable floor (five nines over a serial chain of three-nines-ish tiers) ⇒ violation at the terminal,
    // judged against pg's CUMULATIVE availability cell (the serial product of every dependency on the way down).
    const set = call('set_slo', { node: 'pg', key: 'availability', min: 0.99999 });
    expect(set.ok).toBe(true);
    expect(s.project().instances.find((i) => i.id === 'pg')?.bands).toEqual([{ key: 'availability', band: { shape: 'minTargetMax', min: 0.99999 } }]);

    // Assert pg's OWN availability verdict — the SAME node-band mechanism throughput/latency use — flips with the
    // floor. We read the node verdict, not the whole-graph `feasible`: this default-load chain also overflows the
    // 2,000 req/s Postgres (client.web offers 5,000), an unrelated capacity violation that would dominate `feasible`
    // in BOTH branches — exactly why the sibling whole-system-cost test reads its promise verdict, never the roll-up.
    const evHigh = call('evaluate');
    expect(evHigh.ok).toBe(true);
    const outHigh = JSON.parse(evHigh.text) as { verdicts: { scope: string; key: string; status: string; value?: number }[] };
    const vHigh = outHigh.verdicts.find((v) => v.scope === 'pg' && v.key === 'availability');
    expect(vHigh?.status).toBe('violation'); // pg's cumulative is below the five-nines floor
    expect(vHigh?.value).toBeLessThan(0.99999);

    // A reachable floor reads ok — same one truth, other side of the band (the band replaces in place, one per key).
    call('set_slo', { node: 'pg', key: 'availability', min: 0.99 });
    const outLow = JSON.parse(call('evaluate').text) as { verdicts: { scope: string; key: string; status: string }[] };
    expect(outLow.verdicts.find((v) => v.scope === 'pg' && v.key === 'availability')?.status).toBe('ok');
  });

  it('set_slo scope:"system" only accepts the whole-system vocabulary (cost); a journey quantity is guided to the node', () => {
    const s = new Studio(registry, commonManifests);
    const call = caller(buildTools(s));
    call('add_component', { id: 'pg', type: 'db.postgres' });

    // availability is NOT system-scoped — it belongs on a node (the flow's terminal): guided, self-correcting.
    const alien = call('set_slo', { key: 'availability', min: 0.999, scope: 'system' });
    expect(alien.ok).toBe(false);
    expect(alien.text).toContain('is not a system-scoped quantity');
    expect(alien.text).toContain('set it on a node');
  });

  it('reports honest errors and round-trips a project (export → import)', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    expect(call('add_component', { id: 'x', type: 'nope' }).ok).toBe(false);
    call('add_component', { id: 'a', type: 'cache.redis' });
    const json = call('get_project').text;

    const fresh = caller(buildTools(new Studio(registry, commonManifests)));
    expect(fresh('import_project', { json }).ok).toBe(true);
    expect(fresh('get_project').text).toContain('cache.redis');
  });

  it('exposes the component catalogue', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    expect(call('list_components').text).toContain('db.postgres');
  });

  it('apply_design builds a whole design in ONE call and returns the verdicts', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    const res = call('apply_design', {
      instances: [
        { id: 'client', type: 'client.web', config: { throughput: 5000 } },
        { id: 'nginx', type: 'proxy.nginx' },
        { id: 'app', type: 'compute.service' },
        { id: 'pg', type: 'db.postgres', label: 'Orders DB', description: 'inventory' },
      ],
      wires: [['client', 'out', 'nginx', 'in'], ['nginx', 'out', 'app', 'in'], ['app', 'db', 'pg', 'in']],
      slos: [{ node: 'pg', key: 'throughput', cmp: '>=', value: 5000 }],
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain('violation'); // pg caps at 2000 < the 5000 SLO — flagged in one call
    expect(res.text).toContain('pg');
  });

  it('apply_design replaces by default and adds with replace:false', () => {
    const s = new Studio(registry, commonManifests);
    const call = caller(buildTools(s));
    call('apply_design', { instances: [{ id: 'a', type: 'cache.redis' }], wires: [] });
    call('apply_design', { instances: [{ id: 'old', type: 'db.postgres' }], wires: [] }); // replace clears 'a'
    expect(s.project().instances.map((i) => i.id)).toEqual(['old']);
    call('apply_design', { instances: [{ id: 'extra', type: 'cache.redis' }], wires: [], replace: false });
    expect(s.project().instances.map((i) => i.id).sort()).toEqual(['extra', 'old']);
  });

  it('evaluate exposes per-flow GUARANTEE results with the root cause', () => {
    // producer → SQS standard → worker: the queue's out port keeps NO order and is at-least-once, so the consumer
    // flow's ordering degrades to `none` (root-caused to the queue) and delivery is `may-duplicate`. The AI reads
    // the SAME tokens + root cause the canvas will show (no new tool — it rides on evaluate).
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    const res = call('apply_design', {
      instances: [
        { id: 'producer', type: 'client.web' },
        { id: 'q', type: 'queue.sqs' },
        { id: 'worker', type: 'compute.serverless' },
      ],
      wires: [['producer', 'out', 'q', 'in'], ['q', 'out', 'worker', 'in']],
    });
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.text) as { guarantees?: Array<{ terminal: string; dimensions: Array<{ dimension: string; token: string; rootCauseNode: string | null }> }> };
    expect(parsed.guarantees).toBeDefined();
    const flow = parsed.guarantees?.find((f) => f.terminal === 'worker');
    const ord = flow?.dimensions.find((d) => d.dimension === 'ordering');
    expect(ord?.token).toBe('none');
    expect(ord?.rootCauseNode).toBe('q'); // blamed on the SQS standard queue
    const del = flow?.dimensions.find((d) => d.dimension === 'delivery');
    expect(del?.token).toBe('may-duplicate');
  });

  it('a design with NO guarantee-degrading flow omits the guarantees field (no-filler rule)', () => {
    // a plain write to the primary is strongly consistent end-to-end ⇒ nothing degraded ⇒ no rows ⇒ field absent.
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    call('apply_design', {
      instances: [
        { id: 'client', type: 'client.web' },
        { id: 'app', type: 'compute.service' },
        { id: 'pg', type: 'db.postgres' },
      ],
      wires: [['client', 'out', 'app', 'in'], ['app', 'db', 'pg', 'in']],
    });
    const parsed = JSON.parse(call('evaluate').text) as { guarantees?: unknown };
    expect(parsed.guarantees).toBeUndefined();
  });

  it('set_guarantee_slo → evaluate JUDGES the requirement with a computed remediation (R2)', () => {
    // declare "Ordering ≥ per-key" on producer→worker; SQS standard violates it, and the remediation names FIFO.
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    call('apply_design', {
      instances: [
        { id: 'producer', type: 'client.web', config: { throughput: 45 } },
        { id: 'q', type: 'queue.sqs' },
        { id: 'worker', type: 'compute.serverless' },
      ],
      wires: [['producer', 'out', 'q', 'in'], ['q', 'out', 'worker', 'in', true]],
    });
    expect(call('set_guarantee_slo', { source: 'producer', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' }).ok).toBe(true);
    const parsed = JSON.parse(call('evaluate').text) as {
      guaranteeVerdicts?: Array<{ scope: string; dimension: string; status: string; rootCause: string | null; fix?: string }>;
    };
    expect(parsed.guaranteeVerdicts).toBeDefined();
    const gv = parsed.guaranteeVerdicts?.find((v) => v.dimension === 'ordering');
    expect(gv?.status).toBe('violation');
    expect(gv?.rootCause).toBe('q');
    expect(gv?.fix).toContain('queue.sqs.fifo'); // the computed same-family swap
  });

  it('set_guarantee_slo GUIDED errors: bad dimension, bad token, unknown flow endpoint each name the fix', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    call('add_component', { id: 'producer', type: 'client.web' });
    call('add_component', { id: 'worker', type: 'compute.serverless' });
    // unknown dimension → lists the valid dimensions
    const badDim = call('set_guarantee_slo', { source: 'producer', terminal: 'worker', dimension: 'freshness', atLeast: 'strong' });
    expect(badDim.ok).toBe(false);
    expect(badDim.text).toContain('ordering');
    expect(badDim.text).toContain('consistency');
    // unknown token → lists the dimension's tokens
    const badTok = call('set_guarantee_slo', { source: 'producer', terminal: 'worker', dimension: 'ordering', atLeast: 'sorted' });
    expect(badTok.ok).toBe(false);
    expect(badTok.text).toContain('per-key');
    // unknown endpoint → lists the design's nodes
    const badNode = call('set_guarantee_slo', { source: 'ghost', terminal: 'worker', dimension: 'ordering', atLeast: 'per-key' });
    expect(badNode.ok).toBe(false);
    expect(badNode.text).toContain('producer');
    // clearing a requirement that isn't set → honest error listing what IS declared
    const badClear = call('clear_guarantee_slo', { source: 'producer', terminal: 'worker', dimension: 'ordering' });
    expect(badClear.ok).toBe(false);
    expect(badClear.text).toContain('no guarantee requirement');
  });

  it('describe_component shows a port\'s DECLARED guarantee with its provenance', () => {
    const call = caller(buildTools(new Studio(registry, commonManifests)));
    const sqs = call('describe_component', { type: 'queue.sqs' });
    expect(sqs.ok).toBe(true);
    // the out port declares ordering:none + may-duplicate, both documented (sourced)
    expect(sqs.text).toContain('ordering:none');
    expect(sqs.text).toContain('(documented)');
    const pg = call('describe_component', { type: 'db.postgres' });
    expect(pg.text).toContain('consistency:strong'); // the writer's declared strong-read
  });
});
