// The typed bridge to the VS Code host. Inside a real webview `acquireVsCodeApi()` is injected exactly once by
// the host; calling it twice throws, so we cache the handle. Outside a webview (a plain browser at
// `dev:webview`) the function is undefined — we install a DEV STUB that logs posts to the console and lets the
// dev harness inject H2W messages, so the whole canvas is explorable without an extension host.
//
// The protocol types are imported from the FROZEN contract (`../../src/protocol.ts`) — the same file the host
// compiles against, so the two sides can never drift.
import type { W2H, H2W } from '../src/protocol';

/** The minimal surface VS Code exposes to a webview. `getState`/`setState` persist across reloads of the same
 *  webview; we don't rely on them (the document is the source of truth) but keep them typed for completeness. */
interface RawVsCodeApi {
  postMessage(message: W2H): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}

declare global {
  // Injected by the VS Code host into the webview's global scope; absent in a plain browser.
  // eslint-disable-next-line no-var
  var acquireVsCodeApi: (() => RawVsCodeApi) | undefined;
  // Dev-only manual-test handle exposed under the dev stub (see below). Absent in a real webview.
  // eslint-disable-next-line no-var
  var sdaDev: SdaDevHandle | undefined;
}

/** The typed API surface the app uses: post a W2H message, and (dev only) drive H2W messages in. */
export interface VsCodeApi {
  /** Send a message to the host (W2H). In the dev stub this logs to the console. */
  post(message: W2H): void;
  /** True when running inside a real VS Code webview (host present); false under the dev harness. */
  readonly isHost: boolean;
}

/** Dev-only hook: feed a host→webview message into the app as if the host had posted it. Used by `main.tsx`'s
 *  dev harness to send a sample `docInit`, and by `window.sdaDev` for manual browser testing. No-op in a real
 *  webview (the host drives messages via `window.postMessage`). */
export type DevHarness = (message: H2W) => void;

/** The manual-test handle exposed as `window.sdaDev` under the dev stub — lets a developer (or the smoke test)
 *  drive the same H2W actions the host would, e.g. `sdaDev.addComponent('cache.redis')` or `sdaDev.select('pg')`,
 *  and raw `sdaDev.send({ type: 'select', node: 'app' })` for anything else. */
export interface SdaDevHandle {
  send(message: H2W): void;
  addComponent(comp: string): void;
  select(node: string | null): void;
  wireSuggestion(node: string, port: string, comp: string): void;
  /** Answer a pending quick-add pick the way the host's native QuickPick would — inject the H2W
   *  `pickResult` for `token` (the token logged by the `pick` post), with the chosen type id or null (dismiss). */
  pickResult(token: number, picked: string | null): void;
}

let cached: VsCodeApi | undefined;
let devDispatch: DevHarness | undefined;

/**
 * Acquire the host API (once). In a real webview this returns a poster backed by `acquireVsCodeApi()`. In a plain
 * browser it returns a stub that console-logs every post and, via `devHarness`, can inject H2W messages by
 * re-dispatching them as a `window` 'message' event — exactly the channel the host uses — so `main.tsx` needs no
 * separate dev path. The stub also installs `window.sdaDev` for manual injection of the new canvas ACTIONS.
 */
export function getVsCodeApi(): VsCodeApi {
  if (cached) return cached;
  const acquire = typeof globalThis.acquireVsCodeApi === 'function' ? globalThis.acquireVsCodeApi : undefined;
  if (acquire) {
    const raw = acquire();
    cached = { post: (m) => raw.postMessage(m), isHost: true };
  } else {
    // DEV STUB: no host present. Log posts so a developer can see the W2H traffic — including the native-view
    // FEEDS (summary / nodeDetail / selection) with a clearer tag so the smoke test can assert on them. Injected
    // H2W messages re-emit through the SAME `window` 'message' event the host would use, so the app's single
    // listener handles both.
    devDispatch = (message: H2W) => window.dispatchEvent(new MessageEvent('message', { data: message }));
    cached = {
      post: (m) => {
        const feed = m.type === 'summary' || m.type === 'nodeDetail' || m.type === 'selection';
        // Tag the quick-add `pick` post distinctly so the smoke test can grep the token it must answer.
        const tag = m.type === 'pick' ? '[sda-webview pick]' : feed ? `[sda-webview feed] ${m.type}` : '[sda-webview → host]';
        console.info(tag, m);
      },
      isHost: false,
    };
    // Manual-test surface for a plain browser: drive the canvas ACTIONS the way the native views would.
    const dev: SdaDevHandle = {
      send: (message) => devDispatch?.(message),
      addComponent: (comp) => devDispatch?.({ type: 'addComponent', comp }),
      select: (node) => devDispatch?.({ type: 'select', node }),
      wireSuggestion: (node, port, comp) => devDispatch?.({ type: 'wireSuggestion', node, port, comp }),
      pickResult: (token, picked) => devDispatch?.({ type: 'pickResult', token, picked }),
    };
    globalThis.sdaDev = dev;
  }
  return cached;
}

/**
 * The dev harness hook. Returns a function that injects an H2W message into the running app (only meaningful in
 * the browser dev stub; a no-op inside a real webview, where the host owns the message channel). `main.tsx` calls
 * `getVsCodeApi()` first, then uses this to send the sample `docInit`.
 */
export function devHarness(): DevHarness {
  return (message: H2W) => {
    if (devDispatch) devDispatch(message);
    else console.warn('[sda-webview] devHarness ignored inside a real webview host', message);
  };
}
