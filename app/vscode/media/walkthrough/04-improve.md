# Improve — solve backwards

Most tools only check a design forwards. **Improve** runs it *backwards*: given your promises, it searches for a sizing that satisfies them.

Use **Run Improve** on the left to:

- **fix** — find the minimal change that clears a violation;
- **cheapest** — find the lowest-cost sizing that still meets every SLO;
- **fastest** — find the sizing that minimises latency within your constraints.

When it applies a result, all the changed knobs move together as a **single undoable step**, so one undo restores the whole prior design — never a half-applied hybrid.

**An honest note on exactness.** Improve runs on SDA's own in-process solver — exact on the capacity/flow designs it targets, with no external tool to install. (The generic MiniZinc/COIN-BC optimizer is kept as a CI referee that certifies the in-process answers, and stays selectable as a one-line rollback.) If a design falls outside what the in-process solver can prove, Improve reports that it could not converge rather than inventing an answer — the tool does not lie about what it verified.
