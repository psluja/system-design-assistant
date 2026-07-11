# Native views

The design's results are surfaced through native VS Code UI, not a bespoke panel.

- **Activity-bar container.** The **System Design** container holds three views:
  - **Components** — the palette of blocks you can place;
  - **Selected Node** — the configuration, ports and verdicts of the node currently selected on the canvas;
  - **System** — the live system metrics (throughput, latency, load and cost) computed as you edit.
- **Problems panel.** The engine's verdicts are published as native diagnostics. A saturated tier or a missed SLO appears in the **Problems** panel like any other diagnostic — jump straight to the offending node from there.
- **Status bar.** A compact live readout of the design — throughput, latency, cost, and the current violation count — sits in the status bar.

Only what the engine actually computed is shown. A metric it could not determine is omitted rather than displayed as a guess.
