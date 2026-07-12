/**
 * Extract the dragged component TYPE id from a canvas drop, across every channel that can carry it.
 *
 * The channels, in order of trust:
 *  1. `application/x-sda-component` — our tree controller's custom mime. Works verbatim in the DEV HARNESS,
 *     but in a REAL VS Code the workbench strips custom-mime VALUES when a tree drag becomes a native drag
 *     (vscode#245816): the mime arrives with EMPTY data. Verified by intercepting the native payload with
 *     CDP `Input.setInterceptDrags`:
 *       [{ mime: 'application/x-sda-component', data: '' },
 *        { mime: 'application/vnd.code.tree.sda.components',
 *          data: '{"id":"sda.components","itemHandles":["1/type:cache.redis"]}' }]
 *  2. `application/sda` — the web shell's own palette mime (parity when the shared canvas runs there).
 *  3. The BUILT-IN tree mime — survives the translation WITH data: its item handles embed our stable
 *     tree-item ids (`type:<component-type>` — see components-tree.ts, the scheme is a deliberate contract).
 *
 * Pure so it is unit-testable against the exact captured payload without a VS Code window.
 */
export function parseDropType(getData: (mime: string) => string): string | undefined {
  const custom = getData('application/x-sda-component');
  if (custom) return custom;
  const web = getData('application/sda');
  if (web) return web;
  const tree = getData('application/vnd.code.tree.sda.components');
  if (tree) {
    try {
      const parsed: unknown = JSON.parse(tree);
      const handles = (parsed as { itemHandles?: unknown }).itemHandles;
      if (Array.isArray(handles)) {
        for (const h of handles) {
          const m = /(?:^|\/)type:(.+)$/.exec(String(h));
          if (m?.[1] !== undefined) return m[1];
        }
      }
    } catch {
      /* not the JSON we expect — fall through to the honest no-op */
    }
  }
  return undefined;
}
