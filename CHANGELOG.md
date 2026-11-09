<!-- Copyright (c) 2026 JoltWare
     SPDX-License-Identifier: Apache-2.0 -->

# Changelog

## 1.1.0

### Stateflow import
- **Import** reads a Stateflow chart from a Simulink model (`.slx`), including charts that the model uses through a library link and atomic subcharts linked from further libraries. Libraries are found in the folders of `machinaState.stateflow.libraryPath`, then below the model's folder and its ancestors.
- States, subcharts, parallel states, boxes, junctions (including junctions without an exit), history junctions, default transitions, events, `after(n, sec|msec|usec|tick)` and `[c || after(...)]` are mapped. Parameter values (durations and the sample time, which gives the step period) are read from MATLAB scripts (`machinaState.stateflow.parameterFiles`).
- Stateflow code becomes guard and action hooks. The diagram keeps the original code (shown under *Hook code* in the properties panel) and the chart's data.
- **Hook stub**: for such diagrams, *Generate Code* also writes `<Name>Hooks.hpp`, `.cs` or `.c` once, implementing every hook with its original code and declaring the data. It is never overwritten.
- Also handled: parallel charts, `E1 | E2` triggers, local events raised with `send()` (enables the event queue; the C++ and C# stubs translate them to `Post`), default flow charts in states without substates (become entry code), MATLAB `%` comments, inner-transition priority, and the step period from the chart block's sample time or the model's fixed solver step.
- **Example**: `examples/stateflow/gear_logic.slx`, a gear shift chart under the BSD 3-Clause License, and its import `Gear_Logic.machina`. The manual walks through the import.

### Stateflow semantics
- New per-diagram option *Semantics: Stateflow*:
  - the application dispatches a step event (default `Step`) once per period;
  - an event is offered to the outermost active state first;
  - states can have **during actions**;
  - `after(...)` counts step events, as `after(n steps)` or a time converted with the step period, instead of using timers.
- Implemented identically in the reference engine and simulator and in the C++, C# and C generators (switch and table). The test suite checks that all of them produce identical traces.
- Diagrams with UML semantics (the default) are unchanged: the generated code for them is byte-for-byte identical (golden tests).
- Exporting a Stateflow-semantics diagram to PlantUML, SCXML or Mermaid shows a warning, because those formats cannot express the semantics.

### File format
- `formatVersion` (2 for Stateflow semantics), `semantics`, `step`, `hooks`, `data`, and `during` on states. A file with a higher format version than the extension supports is refused, by the editor and by validation, instead of being misread.

### Fixes
- C, switch style: a diagram with orthogonal states and completion transitions, but no orthogonal state completing, generated an unused `AllRegionsFinal`, which failed to compile with `-Werror`.

## 1.0.0

### Mermaid
- **Copy Diagram as Mermaid (Markdown)** puts the diagram on the clipboard as a ```` ```mermaid ```` block that renders in GitHub, GitLab and most wikis; also in the diagram editor's title bar menu and the Explorer context menu.
- **Export Diagram as Mermaid** writes a `.mmd` file, or a Markdown file with the block.
- **Import** reads Mermaid state diagrams from `.mmd`/`.mermaid` files and from the first state diagram block of a Markdown file. The import format is now chosen by file extension, then by content.
- Exports round-trip without loss: what Mermaid cannot draw (history, named final states, actions of composite states, namespace, event parameters, region names) is kept in `%%` comments. Special characters in labels are written as Mermaid entity codes, and states named after Mermaid keywords get an alias.
- The test suite round-trips every example through Mermaid and renders every export with Mermaid 12.

### Help
- **Get Started walkthrough** on the *Welcome* page and as the command **MachinaState: Get Started**: create a diagram, draw states and transitions, simulate, generate code.
- **MachinaState: Open User Manual** opens the PDF manual for the installed version in the browser; also in the diagram editor's title bar menu.
- **Help dialog** in the diagram editor (the **?** toolbar button or the **?** key): mouse and keyboard shortcuts, transition notation, and buttons for the manual and the walkthrough.

## 0.4.0

### Runtime semantics (generated code, engine and simulator)
- **Timers are one-shot**: a dispatched timeout disarms its timer, so a repeated `DispatchTimeout` with the same generation is ignored even when the timeout's guard was false or its transition internal. Dispatching a timeout event directly (`Dispatch`/`Post`) also disarms it.
- **`Start()` is a full reset**: it clears history, completion flags and the queue, and cancels every armed timer (through `CancelTimer`, with a new generation) before entering the initial configuration. It does not run exit actions of a previous configuration.
- **Deep history restores every region** of nested orthogonal states, not only the first.
- **Orthogonal regions**: once a transition in one region leaves the orthogonal state, the remaining regions are not offered the event, even if the transition re-entered the state.
- **Region entry order**: entering an orthogonal state enters R1..Rn in order, also when the transition targets a state in a later region.
- A state with exactly one explicit region accepts a history pseudostate, like an ordinary composite state.

### Code generation
- Fixed: event parameters declared `const` (e.g. `const char* s`, `const int x`) no longer break the C and C++ code generated with the queue option.
- Table style: region index columns use a type large enough for the machine (no 256-region limit); unused trace names of choice rows are emitted as null; the C table no longer emits an unused row 0.
- Removed dead `MarkCompletion` cases and a stray blank line in C#; the C `Lock`/`Unlock` comment lists exactly which functions lock.

### Validation
- New errors: transitions from or to a region, unresolvable targets, cycles of unguarded completion transitions. All repeated unguarded transitions for one event are reported, not only adjacent ones.
- New warnings (they do not block generation or simulation): choice points without an incoming transition, parameters declared for unused events. Warnings appear as warnings in the Problems panel and the editor.
- Fixed: a transition from a region crashed validation. Validation no longer modifies the diagram.
- The simulator stops with a message instead of hanging when completion transitions loop for ever.

### Editor and simulator
- Arrow-key nudges re-nest the moved states and form one undo step; resizing releases children that end up outside and adopts states that end up inside.
- *Same width/height* ignores pseudostates and keeps the minimum size; clicking a problem clears the multi-selection.
- The dot grid follows pan and zoom and matches the snap grid; untaken, fired and selected transitions colour their arrowheads too.
- PNG/SVG export never includes simulator highlights; replayed timeouts whose timer is not running are reported as stale and not dispatched.
- Unknown top-level members of a `.machina` file are preserved when editing.

### Extension
- *Generate Code* from the palette, title bar or Explorer uses the language and style stored in the diagram; untitled diagrams ask for an output folder and confirm before overwriting.
- Diagnostics point at the right element (also for ids needing JSON escaping) and no longer reappear for closed files.
- *Auto-Layout* reports invalid diagrams instead of failing; transition bends follow the computed routes more closely.
- Webview messages are processed in order; the CSP nonce uses a cryptographic random source.

### Import and export
- PlantUML: region names survive a round trip; event-only internal transitions round-trip; single-line and unterminated notes are handled.
- SCXML: namespaces are resolved properly, `type="internal"` and region entry/exit actions are handled (with warnings where the mapping is approximate), `machina:events` is validated, and invalid character references, DOCTYPE subsets and unterminated end tags give clear errors.
- Actions with arguments (`f(a, b)`) are no longer split at the comma.

### Project
- New extension icon, redrawn to stay legible at small sizes.
- Source code extensively commented; copyright headers added.
- Marketplace metadata: publisher `JoltWare`, repository links.

## 0.3.0

### Modelling
- **Orthogonal regions**: the new **Region** tool divides a state into regions that are active at the same time. Events are offered to every region, the state completes when all regions reach a final state, and leaving it exits all regions. New `Washer` example.
- **Timer generations**: `StartTimer` now receives a generation number, and the new `DispatchTimeout(timeout, generation)` ignores timeouts that were cancelled or restarted in the meantime. A late timer can no longer fire early after its state was left and re-entered. **Breaking:** implementations of `StartTimer` must add the `generation` parameter.

### Code generation
- **C (C99) target**: a header and a source file, with hooks in a structure of function pointers plus a `void*` context, switch- or table-based, no heap allocation. Compiled with `-std=c99 -Wall -Wextra -Werror -pedantic` in the tests.
- C++, C# and C share one region-based runtime design, checked against a reference engine: all six variants and the engine must produce identical traces.

### Simulator
- Runs on the reference engine, so choice points, completion transitions and queued events are processed exactly as in the generated code.
- Guard results are check boxes, events with parameters take arguments, and running timers appear as buttons.
- **Scenarios**: record event sequences, save them in the diagram, and replay them in full or step by step.
- **Coverage**: counts the transitions taken and highlights the untaken ones.

### Editor and integration
- **Automatic layout** with the Eclipse Layout Kernel (toolbar **Layout**, or *MachinaState: Auto-Layout Diagram*).
- **PlantUML and SCXML** export and import, with round-trip tests. Imported diagrams are laid out automatically.
- Fixed: drawing a transition between two states at the same height (common with **Snap**) could fail silently, because the rubber-band line caught the mouse release.

### Project
- New extension icon (`media/MachinaState.png`), also used on the title page of the manual.
- Browser-based UI tests for the editor and simulator (Playwright, `npm run test:ui`), required in CI.
- Manual: new Tutorial 5 (regions, scenarios, coverage), C target, import/export, automatic layout and the new simulator. Screenshots are regenerated with `docs/tools/capture.js`, and quoted code is extracted from the generated files so it stays current.

## 0.2.0

### Modelling
- **Choice points**: diamond pseudostates whose outgoing branches carry guards, with an `[else]` branch taken last. Branches can chain into further choice points.
- **Completion transitions**: transitions without an event fire when a state is entered, or when a composite state's region reaches a final state.
- **Timeouts**: `after(500ms)`, `after(2s)` and `after(1min)` events. The generated class calls the `StartTimer` and `CancelTimer` hooks; your timer calls `Dispatch(timeout)` when it elapses.
- History pseudostates (shallow `H`, deep `H*`), internal transitions and event parameters (all added after 0.1.0).

### Code generation
- **Event queue** (**Queue** option): hooks can call `Post(...)` / `Post<Event>(...)` to queue events. Queued events are processed after the current one, so actions can safely raise follow-up events. The C++ queue is a fixed-size ring buffer with no heap allocation.
- **Trace** option: a virtual `Trace(kind, name)` hook for logging.
- **Thread-safe** option: user-implemented `Lock`/`Unlock` hooks guard the public interface.
- Every generator path is covered by golden-file tests, and every example is compiled and run in C++ and C#, switch-based and table-based. The traces must be identical.

### Editor
- Multi-selection (Shift+click, Shift+drag marquee, Ctrl+A).
- Align, distribute and same-size commands.
- Copy, cut, paste (Ctrl+C / Ctrl+X / Ctrl+V) and duplicate (Ctrl+D), including between diagrams.
- Arrow keys nudge the selection.
- **Snap** to a 10-pixel grid.
- **SVG** export in addition to PNG.
- Per-element colours.
- The simulator steps through choice points and completion transitions.

### VS Code integration
- Validation problems are reported in the **Problems** panel.
- New `machinaState.generateOnSave` setting regenerates code whenever a diagram is saved.

### Project
- Apache licence, README, changelog.
- Test suite (`npm test`) and GitHub Actions CI. CI builds the VSIX and the PDF manual, and publishes on version tags.

## 0.1.0

- First version: visual editor for hierarchical UML state machines, simulator, and switch- or table-based code generation for C++ and C#.
