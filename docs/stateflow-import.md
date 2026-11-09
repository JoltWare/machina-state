<!-- Copyright (c) 2026 JoltWare
     SPDX-License-Identifier: Apache-2.0 -->

# Stateflow import: design notes

Status: **implemented** on branch `feature/stateflow-import`. User-facing documentation is in the
manual (`docs/manual.tex`): *Stateflow semantics* (Execution Semantics chapter), *Stateflow (Simulink
models)* and its worked example (Import and Export), and *Hook stubs* (Code Generation). This note
records the design decisions, how the work was verified, and what is still open.

## The problem

A Stateflow chart imports structurally into MachinaState without much trouble. The behaviour is the
hard part:

1. **Priority.** Stateflow offers an event to a parent's outer transitions before its children; UML
   (MachinaState's default) lets the innermost state react first. Mapped onto UML, a parent's `during`
   action has to become an always-enabled internal transition. That transition swallows every step
   before the parent's other transitions are tried, so a parent with a `[done]` exit can never leave.
2. **Code.** Guards and actions are code in Stateflow and hook names in MachinaState.
3. **Timing.** Stateflow checks `after()` at a step, in priority order with the other conditions, not as
   an asynchronous timer. Durations are often MATLAB variables.

## Decisions

| Area | Decision | Where |
| --- | --- | --- |
| Semantics | An opt-in per-diagram `semantics: "stateflow"`: outer-first dispatch, `during` actions that do not consume the event, `after()` counted in step events (`ticks`) instead of timers. UML stays the default and is unchanged. | `model.ts`, `engine.ts`, `generators/{cpp,csharp,c}.ts` |
| Step event | `step.event` (default `Step`), always part of the event list. `step.periodMs` converts times to steps, rounded up. `after(n steps)` needs no period. | `model.ts` |
| Counting | A step event advances the counter of every active state before any transition is tried. Entry resets it, so the step in which a state is entered does not count, as in Stateflow. Temporal transitions are candidates of the step event, tried in their priority position. The counter is tested before the guard, so the guard hook is not called early. | `engine.ts` `dispatchCore`, `handleEvent` |
| Code | Each expression or statement list becomes a hook, named after its SSID or state. The code is kept in `Diagram.hooks`, shown read-only in the editor, and written into a hook stub. | `interop/stateflow.ts`, `generators/stub.ts` |
| Hook stub | `<Name>Hooks.{hpp,cs,c}`, written by *Generate Code* only for diagrams with `hooks`, and only if absent. Chart data are declared with mapped types. `send(E, …)` becomes `Post(E)` in C++ and C#. C stub functions are prefixed, because a hook named `abort` clashed with libc. | `codegen.ts`, `generators/stub.ts` |
| Step period | `periodMs` if given; else the sample time of the chart block (a referencing library block or the embedded chart block, `-1` meaning inherited); else the model's fixed solver step. Parameter names are resolved through MATLAB scripts (`stateflow.parameterFiles`, or picked at import). Otherwise the import asks. | `interop/stateflow.ts`, `stateflowImport.ts` |
| Libraries | Found by file name, as MATLAB does: the setting `stateflow.libraryPath`, then below the model's folder and up to three ancestors, scanned lazily and bounded. | `stateflowImport.ts` |
| Charts | A parallel chart gets a top-level state `Chart` holding the regions. `E1 \| E2` gives one transition per event. A state's inner transitions are tried after its outer ones. Comments are removed, including `%` comments in the MATLAB action language. | `interop/stateflow.ts` |
| Flow charts | A path into a terminal junction becomes an internal transition of its source state. A default flow chart in a state without substates becomes conditional entry code (`<State>EntryFlow`) in the chart's action language. | `rewriteDeadEnds` |
| Local events | `send()` in an action enables the event queue, with a warning: `Post` handles the event after the current one, for the whole machine. | `interop/stateflow.ts` |
| Compatibility | `formatVersion: 2` for Stateflow diagrams; a higher version is refused by `parseDiagram` and the editor. v1.0.0 cannot be made to refuse a v2 file: it keeps the new fields when editing, but runs the diagram with UML semantics. | `model.ts`, `media/editor.js` |
| Export | PlantUML, SCXML and Mermaid cannot express the semantics. Exporting warns (`exportLimitations`), and the interop round trip skips Stateflow diagrams. | `interop/common.ts`, `extension.ts` |

## Verification

- **UML unchanged.** All 105 golden files are byte-for-byte identical, so generated code for UML diagrams
  did not change.
- **Semantics equivalence.** Two diagrams are compiled in C++, C# and C, in both styles and the trace,
  locked and full configurations, and must produce traces identical to the engine
  (`test/compile.test.js`):
  - `test/diagrams/StateflowLab.machina` exercises outer-first dispatch, during actions, temporal
    transitions by time and by steps, a region that exits its parallel parent, and completion
    transitions into choice points;
  - `examples/stateflow/Gear_Logic.machina` is the imported example.
- **Rules and engine.** `test/semantics.test.js` covers the analysis rules, the format version, and
  outer-first, during and step-counting behaviour against hand-written expectations, including the
  contrast with UML.
- **Import.** `test/stateflow.test.js` covers:
  - synthetic charts: labels, the zip reader, junction rewriting, library links with sample-time
    lookup, `after(n,tick)`, data, MATLAB parameters and comments, several events, inner transition
    order, default flow charts, and solver steps;
  - the bundled example, including that `Gear_Logic.machina` matches a fresh import.
- **Stubs.** `test/stub.test.js` compiles the stub skeleton of every example and test diagram against its
  machine in all three languages, and checks the imported code and the `send` translation.
- **Editor.** `test/ui.test.js` covers the semantics settings, the during field, hook code, the format
  guard and step counting in the simulator.
- **Public models.** Three openly published Stateflow models import with no analysis issues:
  - [mesh-iit/training-matlab-rev-lights](https://github.com/mesh-iit/training-matlab-rev-lights)
    (BSD-3-Clause): `gear_logic.slx`, bundled as `examples/stateflow/gear_logic.slx`, and
    `gear_logic_with_led_feedback.slx`;
  - [mathworks/getting-started-with-stateflow](https://github.com/mathworks/getting-started-with-stateflow):
    `model2_smartDecision.slx`. It is not bundled, because its license limits use to MathWorks
    products.

## Fidelity: what still differs from Stateflow

The behaviour matches Stateflow at the granularity of a step, with these known differences. The
importer reports each one when it occurs:

- **Local events** raised with `send()` are handled by `Post` after the current event, and offered to the
  whole machine instead of only the named state.
- **Condition actions on junction paths** run once a complete path has been chosen, not while Stateflow
  tests it. Side effects of failed paths are lost.
- **Terminal junctions.** A dead-end branch that is not last among its siblings is tried after them.
- **Inner transitions** into a substate are external and exit the state. Inner transitions into
  terminal-junction flow charts are imported faithfully.
- **Hook code** is copied verbatim. It behaves like Stateflow only if the user's implementation matches
  Stateflow's data types, saturation and casting rules.
- **Not imported:** `on`/`bind` sections, and graphical, MATLAB and Simulink functions. The hook code
  calls them, so the stub needs them. Junction loops are reported as choice cycles.
- **Untested inputs:** `.mdl` and `.sfx` files, and releases outside R2020b to R2021b.

## Open items

1. **Trace replay against Simulink.** Log a chart's active states in a Simulink run, replay the same
   inputs through the imported diagram, and compare per step. The bundled gear example is a good first
   candidate.
2. **Inner transitions** into substates under Stateflow semantics (exit only the active substate) would
   need a "local" transition kind in the model and all generators.
3. **Older releases.** If v1.0.0 users may open converted files, say in the release notes that Stateflow
   diagrams need 1.1.0 or later.
