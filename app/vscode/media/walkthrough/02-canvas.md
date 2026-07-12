# The canvas

The canvas is where you place and connect components.

- **Drag from the Components view.** The Components view in the activity bar lists every building block you can place. Drag one onto the canvas to add it.
- **Connect ports.** Each component exposes typed **ports**. Drag from one port to another to wire them. Legality is enforced: a connection is only allowed when the producer's protocol is accepted by the consumer's port, so you cannot wire two things that could not actually talk.
- **Right-click for context actions.** Right-click a node or the canvas for the actions available in that spot.

The canvas is a **view over the design**, not a separate copy of it. Everything you do here edits the same `.sda.json` document — which is why native undo, save, and diffs all keep working.
