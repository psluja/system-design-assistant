import { describe, expect, it } from 'vitest';
import { Studio } from '@sda/core';
import { registry, allManifests } from '@sda/content';
import { buildCandidates, suggestFor } from './suggest';

const catalog = allManifests;

// The MVP CORE VALUE LOOP (doc-9 §1, §5), proven with the SAME calls the canvas makes: place an API Gateway
// and a function, connect them under load, then assert the two things the architect must SEE on the first
// interaction — a FILTERED suggestion for the next component, and a QUANTIFIED live warning where it breaks.
describe('MVP value loop — place · connect · filtered suggestion · quantified warning', () => {
  it('API Gateway → function under load: a filtered next-step suggestion and a numbered overflow warning', () => {
    const s = new Studio(registry, catalog);
    const candidates = buildCandidates(catalog);

    // PLACE — a load source (the end-to-end requirement: 5000 rps), an API gateway, a serverless function.
    s.dispatch({ kind: 'addComponent', id: 'src', type: 'client.web' });
    s.dispatch({ kind: 'setConfig', node: 'src', key: 'throughput', value: 5000 });
    s.dispatch({ kind: 'addComponent', id: 'gw', type: 'gateway.api' });
    s.dispatch({ kind: 'addComponent', id: 'fn', type: 'compute.faas' });

    // CONNECT — protocol-validated wiring (the legality the canvas enforces at drop time): both succeed.
    expect(s.dispatch({ kind: 'connect', from: ['src', 'out'], to: ['gw', 'in'] }).ok).toBe(true);
    expect(s.dispatch({ kind: 'connect', from: ['gw', 'out'], to: ['fn', 'in'] }).ok).toBe(true);

    // FILTERED SUGGESTION — for the function's OPEN `out` port the suggester proposes only legal consumers.
    const out = suggestFor(s, catalog, candidates, 'fn').find((x) => x.port === 'out');
    expect(out).toBeDefined();
    expect(out!.options).toContain('db.postgres'); // a DB is a legal next hop — the function can call it
    expect(out!.options).not.toContain('client.web'); // a load source is NOT a consumer — filtered out
    expect(out!.options.length).toBeLessThan(Object.keys(catalog).length); // filtered, not the whole catalogue

    // QUANTIFIED WARNING — at 5000 rps the function (capacity = concurrency 100 / 50 ms = 2000 rps) overflows;
    // the verdict carries the NUMBER, not just a red dot.
    const overflow = s.verdicts().find((v) => String(v.scope) === 'fn' && String(v.key) === 'overflow');
    expect(overflow?.status).toBe('violation');
    expect(overflow!.computed.value).toBeGreaterThan(0);
    expect(Math.round(overflow!.computed.value)).toBe(3000); // 5000 offered − 2000 capacity
  });
});
