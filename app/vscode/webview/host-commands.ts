// The host→canvas COMMAND dispatch — the webview side of the protocol's `{type:'cmd'}` channel. A total routing
// table over the closed `HostCommand` union, extracted from App.tsx for two properties the inline switch lacked:
//   • exhaustiveness at COMPILE time — a new protocol verb (e.g. the deliberate `idealLayout` evolution) does not
//     typecheck until the canvas supplies its handler, so a verb can never arrive and silently do nothing (the
//     owner's "no dead affordances" rule, enforced by the type system);
//   • a DOM-free unit seam — host-commands.test.ts proves each verb reaches exactly its handler, and that the
//     `idealLayout` verb drives the real ✨ orchestration (ideal-layout.ts), without rendering the React canvas.
// App.tsx wires the real canvas actions in (fitView, addGroup, the design-doc build, and the ideal-layout run that
// BOTH the `tidy` and `idealLayout` verbs now drive — the single 'Tidy' button, owner ruling).
import type { HostCommand } from './host-bridge';

/** One handler per protocol `cmd` verb — the canvas actions the native palette / toolbar / keybindings drive. */
export type HostCommandHandlers = Readonly<Record<HostCommand, () => void>>;

/** Route one host command to its handler — total by construction (a Record over the closed union). */
export const runHostCommand = (cmd: HostCommand, handlers: HostCommandHandlers): void => handlers[cmd]();
