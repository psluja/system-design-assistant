import * as vscode from 'vscode';
import type { WireStatus } from './protocol';
import { formatStatus, statusTooltip } from './pure';

// The live-metrics status-bar item: throughput · latency · cost · violation count, mirrored from the webview's
// WireStatus messages. It is visible ONLY while an SDA editor is active (a metrics readout for another language's
// file would be meaningless), and clicking it takes the fastest route to acting on the design: open the native
// Improve flow when there are violations to fix, otherwise focus the Problems panel to inspect warnings/unknowns.

/** The command the status bar runs on click when the design has violations — the native Improve (backward-solve)
 *  flow, which lets the user pick a goal and apply the fix (registered in commands.ts). */
const IMPROVE_COMMAND = 'sda.improve';
/** The built-in command that focuses the native Problems panel (used when there are no violations to fix). */
const FOCUS_PROBLEMS_COMMAND = 'workbench.actions.view.problems';

export class SdaStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    // Left-aligned, high priority so it sits near the language/mode items where a live readout belongs.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.item.name = 'SDA System Metrics';
  }

  /** Update the readout from a fresh WireStatus and (re)point the click command based on the violation count. */
  update(status: WireStatus): void {
    this.item.text = formatStatus(status);
    this.item.tooltip = statusTooltip(status);
    // A saturated/violating design is a warning-coloured bar so it stands out; a clean design stays neutral.
    this.item.backgroundColor = status.violations > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    // Click acts: open Improve when there are violations to fix, else jump to the Problems panel to review the rest.
    this.item.command = status.violations > 0 ? IMPROVE_COMMAND : FOCUS_PROBLEMS_COMMAND;
  }

  /** Show the item (an SDA editor became active). */
  show(): void {
    this.item.show();
  }

  /** Hide the item (no SDA editor active) — a metrics readout only makes sense for a design file. */
  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
