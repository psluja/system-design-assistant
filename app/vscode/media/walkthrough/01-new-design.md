# Create your first design

A System Design Assistant design is an ordinary `.sda.json` file on disk — not hidden state.

- **Git-diffable.** The file is a stable, pretty-printed JSON document, so every change shows up as a clean diff in source control.
- **Native undo and save.** Edits go through VS Code's own document, so `Ctrl+Z` / `Cmd+Z` undo and `Ctrl+S` / `Cmd+S` save work exactly as they do for any file.
- **The file is the project.** There is no backend and no separate database — the file you save *is* the backup.

Use **Create a new design** on the left to write a small, ready-to-evaluate starter design (a client → proxy → API → database request path) and open it on the canvas.

You can also open any existing `.sda.json` in two ways:

- **as the canvas** — the default, for designing and simulating;
- **as text** (Open With → Text Editor) — to read the raw JSON, where hovers and per-node verdict lenses are available.
