# Third-Party Notices

System Design Assistant redistributes and bundles the third-party components below.
The project itself is MIT-licensed (see [LICENSE](LICENSE)); the components keep their own licenses.

## Vendored WebAssembly solvers (redistributed binaries)

### MiniZinc (with Gecode and HiGHS) — `app/web/public/minizinc/`
A custom WebAssembly build of the MiniZinc toolchain used for exact numeric solving in the browser.

| Component | License | Upstream source |
|---|---|---|
| MiniZinc | **MPL-2.0** | https://github.com/MiniZinc/libminizinc |
| Gecode | MIT | https://github.com/Gecode/gecode |
| HiGHS | MIT | https://github.com/ERGO-Code/HiGHS |

MiniZinc is licensed under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/).
Per MPL-2.0 §3.2, the source code of the MPL-covered files is available from the upstream
repository above; the exact build recipe for this WebAssembly distribution (including any
build configuration) is maintained in this repository at [`tools/minizinc-wasm/`](tools/minizinc-wasm/).
No modifications are made to MiniZinc source files beyond build configuration.

### clingo — `app/web/public/clingo/`
The clingo ASP solver (potassco), used for topology enumeration/synthesis.

| Component | License | Upstream source |
|---|---|---|
| clingo | MIT | https://github.com/potassco/clingo |
| clingo-wasm (packaging) | Apache-2.0 | https://github.com/domoritz/clingo-wasm |

## Libraries bundled into distributed builds
The web app bundle (`app/web/dist`) and the VS Code extension webview bundle
(`app/vscode/dist/webview`) statically include:

| Library | License | Notes |
|---|---|---|
| DataScript | **EPL-1.0** | https://github.com/tonsky/datascript — Datalog engine for the relational legality layer |
| React / React DOM | MIT | https://react.dev |
| @xyflow/react (React Flow) | MIT | https://reactflow.dev |
| ws (bridge only) | MIT | https://github.com/websockets/ws |
| @modelcontextprotocol/sdk | MIT | https://github.com/modelcontextprotocol/typescript-sdk |

DataScript is licensed under the Eclipse Public License 1.0 (https://www.eclipse.org/legal/epl-v10.html);
its source is available from the upstream repository above and it is used unmodified.

Full license texts of all bundled dependencies are available in their npm packages
(`node_modules/<name>/LICENSE`) and at the upstream repositories linked above.
