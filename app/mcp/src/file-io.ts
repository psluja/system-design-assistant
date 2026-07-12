import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import { deserialize, serialize, type ProjectDoc, type Studio } from '@sda/core';
import type { AnyTool, ToolDef, ToolResult } from './tools';
import { EDITS, fail, obj, ok, REPLACES_SESSION, str } from './tool-kit';

// @feature File-based IO (the agent edits the open .sda.json)
// @story The AI reads and writes the SAME .sda.json file the human has open — confined to the
//   workspace — so "the AI moves my canvas" just works, with an unsaved-canvas reminder instead of a
//   forked copy.
// @surfaces mcp (import_design / save_design here; get_project / import_project in
//   app/mcp/src/tools.ts), vscode (custom editor live-reloads external writes,
//   app/vscode/src/editor-provider.ts), web (import/export via app/web/src/download.ts + IndexedDB
//   autosave app/web/src/idb.ts)
// @algorithms none (data/plumbing)
// @docs none
// @e2e app/mcp/src/real-architectures.e2e.test.ts (drives the file path end to end)
// @status shipped

// FILE-BASED IO over MCP (§1) — the agent reads/writes .sda.json files DIRECTLY, so it edits the SAME
// file the human has open instead of "safely" forking a new one (the owner's live Copilot pain: it saved
// oracle-…-with-range.sda.json instead of the open file, and the canvas never moved). Saving to the open file's
// path is the whole trick: VS Code's custom editor reloads a changed-on-disk document (editor-provider docExternal),
// so an external write IS the "AI moves my canvas" effect — zero new plumbing.
//
// SAFETY (must not be a foot-gun): every path is CONFINED to the workspace root folder(s). A write outside them is
// refused; with no explicit path, save writes ONLY the file the agent imported (never a file the server never
// touched). Path resolution + confinement are PURE (testable without disk); the disk itself is a small injected
// `FileSystemPort`, so the tools are unit-tested against an in-memory fs and the SAME logic runs in production.

/** The disk operations the file tools need, injected so the logic is testable without touching a real filesystem. */
export interface FileSystemPort {
  exists(abs: string): boolean;
  /** Read a file's text; throws if it cannot be read (the tool turns the throw into a guided error). */
  read(abs: string): string;
  /** Write a file's text, creating parent directories as needed (the abs path is already confined to a root). */
  write(abs: string, text: string): void;
  /** Every `*.sda.json` under the roots (absolute paths) — the workspace candidates a guided error lists. */
  listSdaFiles(roots: readonly string[]): readonly string[];
}

/** Is `abs` inside one of the workspace `roots` (the write/read confinement boundary)? A path that resolves to a
 *  root itself, or to any descendant, is inside; anything that escapes via `..` or a different drive is outside. */
export function withinRoots(roots: readonly string[], abs: string): boolean {
  return roots.some((r) => {
    const rel = relative(r, abs);
    return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
  });
}

/** Resolve a user-supplied path against the workspace roots and CONFINE it. A relative path resolves against each
 *  root (an existing match wins, so an unqualified name finds its file); an absolute path is taken as-is. Returns
 *  the confined absolute path, or `{ ok:false }` when it lands outside every root (refused — never a silent escape). */
export function resolveInRoots(
  roots: readonly string[],
  given: string,
  exists: (abs: string) => boolean,
): { readonly ok: true; readonly abs: string } | { readonly ok: false } {
  const candidates = isAbsolute(given) ? [resolve(given)] : roots.map((r) => resolve(r, given));
  const confined = candidates.filter((c) => withinRoots(roots, c));
  if (confined.length === 0) return { ok: false };
  return { ok: true, abs: confined.find((c) => exists(c)) ?? (confined[0] as string) };
}

/** A short, workspace-relative label for an absolute path (forward slashes, stable across OSes) — what a tool result
 *  shows the agent instead of a noisy absolute path. Falls back to the basename for a path outside the roots. */
export function displayPath(roots: readonly string[], abs: string): string {
  const root = roots.find((r) => withinRoots([r], abs));
  return (root ? relative(root, abs) || basename(abs) : basename(abs)).split(sep).join('/');
}

/** The workspace root folder(s) the file tools confine to: the `SDA_WORKSPACE` env (path-delimiter-separated —
 *  the VS Code shell sets it to the open workspace folders) if present, else the process cwd (the standalone CLI
 *  runs from the project). Only existing directories are kept; an empty result falls back to the cwd. */
export function workspaceRoots(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string[] {
  const fromEnv = (env.SDA_WORKSPACE ?? '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => resolve(p))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  return fromEnv.length > 0 ? fromEnv : [resolve(cwd)];
}

/** The production `FileSystemPort` over Node's fs. Read/write are synchronous (a stdio tool call is not a hot path);
 *  the workspace scan skips heavy/irrelevant trees and is bounded so a giant repo can never stall a tool call. */
export function nodeFs(): FileSystemPort {
  const SKIP = new Set(['node_modules', '.git', 'dist', '.vscode-test', '.next', 'out', 'coverage']);
  const MAX_FILES = 200;
  const MAX_DEPTH = 8;
  return {
    exists: (abs) => existsSync(abs),
    read: (abs) => readFileSync(abs, 'utf8'),
    write: (abs, text) => {
      mkdirSync(resolve(abs, '..'), { recursive: true });
      writeFileSync(abs, text, 'utf8');
    },
    listSdaFiles: (roots) => {
      const found: string[] = [];
      const walk = (dir: string, depth: number): void => {
        if (found.length >= MAX_FILES || depth > MAX_DEPTH) return;
        let entries: import('node:fs').Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (found.length >= MAX_FILES) return;
          if (e.isDirectory()) {
            if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(resolve(dir, e.name), depth + 1);
          } else if (e.isFile() && e.name.endsWith('.sda.json')) {
            found.push(resolve(dir, e.name));
          }
        }
      };
      for (const r of roots) walk(r, 0);
      return found;
    },
  };
}

/**
 * The FILE SESSION — the server-memory record of "which file this session's design belongs to, and whether the
 * design has drifted from it" (the owner's live Copilot pain: the agent edited, never saved, and the open canvas
 * never moved). `saved` is the exact document the file last matched: commands replace the Studio's document
 * immutably, so DIRTY is the pure reference check `studio.project() !== session.saved` — no flags to keep in sync,
 * and an undo back to the saved snapshot honestly reads clean again. import_design / save_design are the only
 * writers (they sync the file), so they reset it. Never persisted — dirty-tracking is server memory, not files.
 */
export interface FileSession {
  /** Absolute path of the last imported/saved .sda.json — save_design's no-path default target. */
  path: string | undefined;
  /** Workspace-relative label of `path` for tool-result text (what the unsaved reminder names). */
  label: string | undefined;
  /** The exact document the file last matched (the design at server start until an import/save). */
  saved: ProjectDoc;
}

/** A fresh session: no file yet; the file baseline is the design at server start, so ANY mutation reads unsaved. */
export function createFileSession(studio: Studio): FileSession {
  return { path: undefined, label: undefined, saved: studio.project() };
}

/** The tools whose READ result still carries the unsaved reminder when the design is dirty — the two verdict
 *  surfaces an agent quotes to the human ("it's feasible/fast"), where an unsaved canvas is most misleading. */
const REMINDED_READS = new Set(['evaluate', 'simulate']);

/** The ONE stateful reminder line (path-aware when the session knows its file). Appended, never replacing the
 *  tool's own text — whole-form consistent with the instructions' "what the human sees" discipline. */
function unsavedLine(session: FileSession): string {
  return `⚠ unsaved — the open canvas still shows the last saved state; save_design writes to ${session.label ?? 'a {path} you name (e.g. {path:"my-design.sda.json"})'}`;
}

/**
 * Wrap the WHOLE tool surface with the unsaved-canvas reminder (file transport only — over the browser bridge the
 * canvas is live and the line would be a lie). Every tool result that leaves the design DIRTY (drifted from the
 * last-saved file) after a mutation carries the one ⚠ line; `evaluate`/`simulate` (the read-only verdict surfaces)
 * carry it whenever the design is dirty; every other read stays clean. A failed mutation appends nothing (the
 * dispatch was atomic — the document did not move), and save_design/import_design reset the session inside their
 * own run, so their results are never flagged. Pure decoration: `ok` and the tool's own text are untouched.
 */
export function withUnsavedReminder(studio: Studio, session: FileSession, tools: readonly AnyTool[]): AnyTool[] {
  return tools.map((t) => ({
    ...t,
    run: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const before = studio.project();
      const res = await Promise.resolve(t.run(args));
      const mutated = studio.project() !== before; // this call moved the document (atomic dispatch ⇒ ok)
      const dirty = studio.project() !== session.saved; // the document differs from what the file last held
      const remind = dirty && (mutated || REMINDED_READS.has(t.name));
      return remind ? { ok: res.ok, text: `${res.text}\n\n${unsavedLine(session)}` } : res;
    },
  }));
}

/**
 * The file-IO MCP tools (`import_design` / `save_design`). They give the agent a first-class notion of the file on
 * disk: import loads it into this server's Studio; save writes the (edited) design back — defaulting to the last
 * imported path, so an agent that opened the human's file writes THAT file and the canvas live-reloads. `roots`
 * confines every path to the workspace; `fs` is the injected disk. The `session` remembers the last imported/saved
 * path + the saved document — share ONE session with `withUnsavedReminder` so saving clears the unsaved flag.
 */
export function buildFileTools(studio: Studio, fs: FileSystemPort, roots: readonly string[], session: FileSession = createFileSession(studio)): ToolDef[] {
  const display = (abs: string): string => displayPath(roots, abs);
  const rootsLabel = roots.map((r) => r.split(sep).join('/')).join(', ');
  // The self-correcting hint every unknown/absent-path error carries — the workspace's actual .sda.json files, so
  // the agent picks a real one instead of guessing (the MCP contract: every error names the next action).
  const candidateHint = (): string => {
    const cs = fs.listSdaFiles(roots).map(display);
    if (cs.length === 0) return ` — no .sda.json files found in the workspace (${rootsLabel})`;
    return ` — workspace .sda.json files: [${cs.slice(0, 12).join(', ')}${cs.length > 12 ? ', …' : ''}]`;
  };

  return [
    {
      name: 'import_design',
      description:
        'Load a .sda.json design FILE from the workspace into this session (the file the human has open in the canvas, most usefully). After importing, edit the design with the normal tools and call save_design (no path needed) to write it BACK to the same file — because that is the file open in the SDA canvas, the human\'s canvas LIVE-RELOADS to your change. `path` is a workspace-relative or absolute path to a *.sda.json; an unknown path lists the workspace candidates. Paths are confined to the workspace folder. Recipe for uncertainty: import_design → set_range → uncertainty → save_design. e.g. {path:"my-design.sda.json"}',
      inputSchema: obj({ path: { type: 'string' } }, ['path']),
      annotations: REPLACES_SESSION,
      run: (a) => {
        const given = str(a.path);
        if (given === '') return fail(`import_design needs a {path} to a .sda.json file${candidateHint()}`);
        const r = resolveInRoots(roots, given, fs.exists);
        if (!r.ok) return fail(`refused: "${given}" is outside the workspace (${rootsLabel}) — import a .sda.json that lives in the workspace${candidateHint()}`);
        if (!fs.exists(r.abs)) return fail(`no file at "${display(r.abs)}"${candidateHint()}`);
        let text: string;
        try {
          text = fs.read(r.abs);
        } catch (e) {
          return fail(`could not read "${display(r.abs)}": ${e instanceof Error ? e.message : String(e)}`);
        }
        const doc = deserialize(text);
        if (!doc.ok) return fail(`"${display(r.abs)}" is not a valid .sda.json: ${doc.error}`);
        studio.load(doc.value);
        // The file and the session now agree — reset the unsaved tracking to this exact document.
        session.path = r.abs;
        session.label = display(r.abs);
        session.saved = studio.project();
        const n = doc.value.instances.length;
        const w = doc.value.wires.length;
        return ok(
          `imported "${doc.value.name}" from ${display(r.abs)} — ${n} node(s), ${w} wire(s). This is now the design in this session. Edit it (set_range / set_config / apply_design …), then save_design (no path needed) writes it BACK to ${display(r.abs)}; since that file is open in the SDA canvas, the human's canvas live-reloads to your changes. Uncertainty recipe: set_range → uncertainty → save_design.`,
        );
      },
    },
    {
      name: 'save_design',
      description:
        'Write the current design to a .sda.json FILE. With NO path it writes back to the file you last imported/saved — and because that is the file open in the SDA canvas, the human\'s canvas LIVE-RELOADS to your change (the "AI moved my canvas" effect). Pass {path} to save to a specific workspace-relative or absolute path (confined to the workspace; an out-of-workspace path is refused). This is the ONE way to save — never hand-assemble the JSON. After declaring ranges + running the uncertainty tool, save_design so the human sees the updated design (with ± ranges, the System panel\'s Uncertainty · Monte Carlo block re-samples live). e.g. {} to write back to the imported file, or {path:"variant.sda.json"} to save elsewhere.',
      inputSchema: obj({ path: { type: 'string' } }),
      // The task's canonical example of a non-destructive idempotent write: an overwrite of the tracked design
      // file with this session's design — re-running writes the identical bytes.
      annotations: EDITS,
      run: (a) => {
        const given = a.path !== undefined && a.path !== null && str(a.path) !== '' ? str(a.path) : undefined;
        let abs: string;
        if (given === undefined) {
          if (session.path === undefined) {
            return fail(`save_design needs a {path} the first time — nothing has been imported yet, so there is no file to default to. Pass a workspace path, e.g. {path:"my-design.sda.json"}, or import_design an existing file first so save defaults to it${candidateHint()}`);
          }
          abs = session.path;
        } else {
          const r = resolveInRoots(roots, given, fs.exists);
          if (!r.ok) return fail(`refused: "${given}" is outside the workspace (${rootsLabel}) — writes are confined to it${candidateHint()}`);
          abs = r.abs;
        }
        const proj = studio.project();
        try {
          fs.write(abs, serialize(proj));
        } catch (e) {
          return fail(`could not write "${display(abs)}": ${e instanceof Error ? e.message : String(e)}`);
        }
        // The file now holds exactly this document — reset the unsaved tracking (the reminder line stops).
        session.path = abs;
        session.label = display(abs);
        session.saved = proj;
        const n = proj.instances.length;
        const ranged = proj.instances.some((i) => i.ranges !== undefined && Object.keys(i.ranges).length > 0);
        return ok(
          `saved "${proj.name}" (${n} node(s)) to ${display(abs)}. If ${display(abs)} is the .sda.json open in the SDA canvas, it LIVE-RELOADS now to this design — the human sees your changes on the canvas${ranged ? ", and since it declares ± uncertainty ranges the System panel's Uncertainty · Monte Carlo block re-samples (preview → confirmed)" : ''}. save_design again (no path) rewrites this same file.`,
        );
      },
    },
  ];
}
