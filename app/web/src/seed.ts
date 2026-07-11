import { Studio } from '@sda/core';
import { registry, keys, allManifests } from '@sda/content';

/**
 * Build the seed design shown on first load — the checkout path (client → NGINX → Checkout API → Postgres) with
 * a throughput SLO on Postgres and two tier boundaries. The app's `cache` port is left OPEN so the engine-backed
 * suggester proposes the next logical element. Pure construction; extracted from app.tsx to keep the component thin.
 */
export function makeStudio(): Studio {
  const s = new Studio(registry, allManifests);
  const add = (id: string, type: string, x: number, y: number): void => void s.dispatch({ kind: 'addComponent', id, type, x, y });
  add('client', 'client.web', 40, 250);
  add('nginx', 'proxy.nginx', 260, 250);
  add('app', 'compute.service', 500, 250);
  add('pg', 'db.postgres', 780, 250);
  s.dispatch({ kind: 'setLabel', id: 'client', label: 'Web client' });
  s.dispatch({ kind: 'setLabel', id: 'nginx', label: 'NGINX' });
  s.dispatch({ kind: 'setLabel', id: 'app', label: 'Checkout API' });
  s.dispatch({ kind: 'setLabel', id: 'pg', label: 'Postgres' });
  s.dispatch({ kind: 'connect', from: ['client', 'out'], to: ['nginx', 'in'] });
  s.dispatch({ kind: 'connect', from: ['nginx', 'out'], to: ['app', 'in'] });
  s.dispatch({ kind: 'connect', from: ['app', 'db'], to: ['pg', 'in'] });
  // app's `cache` port is left OPEN so the engine-backed suggester proposes the next logical element.
  s.dispatch({ kind: 'setSLO', node: 'pg', key: keys.throughput, band: { shape: 'minTargetMax', min: 5000 } });
  // visual boundaries (a real-architecture touch): the edge tier and the application tier
  s.dispatch({ kind: 'addGroup', id: 'g-edge', label: 'Edge / ingress', x: 10, y: 175, w: 440, h: 200 });
  s.dispatch({ kind: 'assignGroup', node: 'client', group: 'g-edge' });
  s.dispatch({ kind: 'assignGroup', node: 'nginx', group: 'g-edge' });
  s.dispatch({ kind: 'addGroup', id: 'g-app', label: 'Application tier', x: 465, y: 175, w: 480, h: 200 });
  s.dispatch({ kind: 'assignGroup', node: 'app', group: 'g-app' });
  s.dispatch({ kind: 'assignGroup', node: 'pg', group: 'g-app' });
  return s;
}
