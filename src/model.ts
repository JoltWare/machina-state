// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Diagram document format (persisted as JSON in *.machina files) and semantic analysis.
//
// This module is the foundation that every other part of MachinaState builds on. It has two layers:
//
//   1. The *document* layer (`Diagram`, `StateNode`, `TransitionNode`, ...) mirrors the JSON stored in a
//      .machina file one to one. It is what the webview editor edits, what the layout and interop modules
//      (PlantUML, SCXML, XML import/export) read and write, and it deliberately carries presentation data
//      such as coordinates, bends and colours. `parseDiagram` turns file text into a `Diagram` while
//      tolerating missing or malformed top-level fields.
//
//   2. The *semantic* layer (`Machine`, `MState`, `MRegion`, `MTransition`, `MBranch`, ...) is produced by
//      `analyze`. It validates the diagram against the statechart rules supported by MachinaState and
//      resolves everything the code generators (src/generators/) and the reference interpreter
//      (src/engine.ts) need: a pre-order numbering of states, region indices, the initial transition of
//      every region, history kinds, least common ancestors (LCAs) of every transition, choice-point branch
//      trees, timeout timers, the event list, the guard/action hook lists and the parameters each hook
//      receives. Pseudostates (initial, history, choice) and region elements do not survive as states;
//      they are folded into the properties of the real states, regions and transitions.
//
// Data flow: *.machina text -> parseDiagram -> Diagram -> analyze -> { machine?, issues }. A `Machine` is
// only returned when the diagram has no errors (warnings, such as an unused choice point, do not block it);
// the issue list is shown in the Problems view (src/diagnostics.ts) and in the editor, keyed by the diagram id
// of the offending element where possible. The compiled model and engine are also bundled into the webview
// (scripts/bundle-webview.js) so the simulator runs exactly the same analysis as code generation.
//
// Semantics summary (see the "Execution Semantics" chapter of docs/manual.tex for the full definition):
// states are hierarchical; a composite state owns one region, or several orthogonal regions that are active
// together; every region with states needs exactly one initial pseudostate; transitions are external (they
// exit up to, but not including, the LCA of source and target and re-enter downwards) unless marked
// internal; event-less transitions are completion transitions; `after(...)` events are timeouts; choice
// points are evaluated with junction semantics (a complete guarded path is selected before anything is
// exited). A diagram may opt into Stateflow semantics instead (`Diagram.semantics`, see `Semantics`):
// outer states see events first, states have during actions and `after(...)` counts step events. Every
// part of the analysis specific to it is guarded, so UML diagrams are analysed exactly as before.

/**
 * Execution semantics of a diagram. `uml` (the default) is the UML run-to-completion model described above.
 * `stateflow` follows MATLAB Stateflow for charts that are woken periodically: an event is offered to the
 * outermost active state first and only reaches the substates when no transition of the state fired; each
 * state then runs its `during` actions; and `after(...)` is counted in step events instead of being a timer.
 * See the "Stateflow Semantics" section of docs/manual.tex.
 */
export type Semantics = 'uml' | 'stateflow';

/**
 * Highest `formatVersion` this release understands. Version 2 adds Stateflow semantics; a file with a higher
 * version was written by a newer MachinaState and is refused by `parseDiagram` rather than misread.
 */
export const FORMAT_VERSION = 2;

/** Element kinds of the document format; `initial`, `history`, `choice` and `region` are not real states. */
export type StateKind = 'state' | 'initial' | 'final' | 'history' | 'choice' | 'region';
/** Target language of the code generators. */
export type Language = 'cpp' | 'csharp' | 'c';
/** Code generation style: nested switch statements, or data tables interpreted by a small runtime. */
export type Style = 'switch' | 'table';

/**
 * One element of the diagram as persisted in the JSON file. Despite the name this covers real states
 * (`state`, `final`), pseudostates (`initial`, `history`, `choice`) and orthogonal region rectangles
 * (`region`), all distinguished by `kind`.
 */
export interface StateNode {
    /** Unique diagram id; transitions and children refer to elements by this id. */
    id: string;
    /** State name; must be a unique identifier for real states because it becomes a generated enumerator. */
    name: string;
    kind: StateKind;
    /**
     * Id of the containing state or region, or null at the top level. Substates of a state that has explicit
     * regions must have one of those regions as parent; regions must have a state as parent.
     */
    parent: string | null;
    /** Position and size of the element on the canvas (layout only, no semantic meaning). */
    x: number;
    y: number;
    w: number;
    h: number;
    /** Entry actions: method names separated by `;`, `,` or newlines (real states only). */
    entry?: string;
    /** Exit actions, same syntax as `entry`. */
    exit?: string;
    /**
     * During actions, same syntax as `entry` (Stateflow semantics only): run on every dispatched event while
     * the state is active and none of its own transitions fired, before the event reaches its substates.
     */
    during?: string;
    /** Optional fill colour used by the editor. */
    color?: string;
    /** History pseudostates only: deep (H*) instead of shallow (H). */
    deep?: boolean;
}

/** One transition arrow as persisted in the JSON file, labelled `event [guard] / actions`. */
export interface TransitionNode {
    /** Unique diagram id; reported back by the engine's `fired` hook and used for coverage. */
    id: string;
    /** Id of the source element (a state, or an initial/choice pseudostate). */
    source: string;
    /** Id of the target element (a state, a history pseudostate or a choice point). */
    target: string;
    /** Event name, `after(<n> ms|s|min)` for a timeout, or empty for a completion transition / choice branch. */
    event?: string;
    /** Guard method name, `!name`, or `else` on a branch leaving a choice point. */
    guard?: string;
    /** Action method names separated by `;`, `,` or newlines, run in order. */
    action?: string;
    /** Curvature of the drawn arrow (layout only). */
    bend?: number;
    /** Optional stroke colour used by the editor. */
    color?: string;
    /** Self transition that runs its action without exiting or re-entering the state. */
    internal?: boolean;
}

/** Code generation settings stored in the diagram (the `codegen` object of the JSON file). */
export interface CodegenOptions {
    language?: Language;
    style?: Style;
    /** Generate a Trace hook that reports events, transitions, exits and entries. */
    trace?: boolean;
    /** Wrap the public interface in Lock/Unlock hooks. */
    threadSafe?: boolean;
    /** Generate Post() so hooks can queue events that are processed after the current one. */
    queue?: boolean;
    /** Capacity of the fixed-size C++ event queue. */
    queueCapacity?: number;
}

/** One recorded simulator step: an event plus the context needed to replay it deterministically. */
export interface ScenarioStep {
    /** Event name as generated, e.g. `Coin` or `Collecting_After30000ms`. */
    event: string;
    /** Event arguments, in parameter order. */
    args?: unknown[];
    /** Guard results to use while the step is replayed (guards not listed are true). */
    guards?: Record<string, boolean>;
}

/** A named sequence of simulator steps saved in the diagram for replay. */
export interface Scenario {
    name: string;
    steps: ScenarioStep[];
}

/** The step event of Stateflow semantics (`Diagram.step`). */
export interface StepOptions {
    /** Name of the event the host dispatches once per period; default `Step`. */
    event?: string;
    /** Period in milliseconds; needed to convert `after(<time>)` into a number of steps. */
    periodMs?: number;
}

/** What a hook stands for, e.g. the Stateflow code it replaced on import (`Diagram.hooks`). */
export interface HookInfo {
    /** Code the hook should implement, as written in the source tool (C-like for Stateflow). */
    code: string;
    /** Where it came from, e.g. `transition 12` or `state Heating entry`. */
    origin?: string;
}

/** A variable used by the hook code (`Diagram.data`), e.g. a Stateflow input, output, local or parameter. */
export interface DataItem {
    name: string;
    /** `input`, `output`, `local`, `parameter`, `constant` or `function`. */
    scope: string;
    /** Type as written in the source tool, e.g. `single`, `uint8`, `Bus: StateMachineInput`. */
    type: string;
    /** Array size, if not a scalar. */
    size?: string;
}

/** The whole document stored in a *.machina file, as returned by `parseDiagram`. */
export interface Diagram {
    /** Format version of the file; absent means 1. See FORMAT_VERSION. */
    formatVersion?: number;
    /** Execution semantics; absent means `uml`. */
    semantics?: Semantics;
    /** Step event and period, for Stateflow semantics. */
    step?: StepOptions;
    /** Code behind the hooks (informational; used for the hook stub and shown in the editor). */
    hooks?: Record<string, HookInfo>;
    /** Variables the hook code uses (informational; declared in the hook stub). */
    data?: DataItem[];
    /** Name of the generated class (or C type prefix). */
    name: string;
    /** Optional namespace, written with `.` (C#) or `::` (C++) separators. */
    namespace?: string;
    /** All elements: states, pseudostates and regions, in diagram order. */
    states: StateNode[];
    /** All transitions, in diagram order (which is also the order of equal-priority candidates). */
    transitions: TransitionNode[];
    /** Parameter lists per event name, e.g. { "Play": "int track" }. */
    events?: Record<string, string>;
    codegen?: CodegenOptions;
    /** Event sequences recorded in the simulator. */
    scenarios?: Scenario[];
}

/** A parsed guard: the name of a Boolean hook, optionally negated with `!`. */
export interface Guard {
    name: string;
    negate: boolean;
}

/** One parsed event parameter, e.g. `const std::string& name` gives type `const std::string&`, name `name`. */
export interface Param {
    type: string;
    name: string;
    /** Declaration as written, without default value. */
    decl: string;
}

/**
 * A real (non-pseudo) state of the analysed machine. Simple, composite, orthogonal and final states all use
 * this shape; the difference lies in `regions` and `isFinal`.
 */
export interface MState {
    /** Diagram id of the state element. */
    id: string;
    name: string;
    /** Position in pre-order (parents before children); also the generated enumerator value. */
    index: number;
    /** Owning composite state, or null for top-level states. */
    parent: MState | null;
    /** Direct substates in all regions. */
    children: MState[];
    isFinal: boolean;
    /** Parsed entry action names (always empty for final states). */
    entry: string[];
    /** Parsed exit action names (always empty for final states). */
    exit: string[];
    /** Parsed during action names (Stateflow semantics only; otherwise empty). */
    during: string[];
    /** Region that contains this state. */
    region: MRegion;
    /** Own regions: empty for simple states, one for ordinary composites, several for orthogonal states. */
    regions: MRegion[];
    /** Default (initial) transition when the state has exactly one region. */
    initial?: MInitial;
    /** Kind of history pseudostate inside this composite state, if any. */
    history?: 'shallow' | 'deep';
}

/**
 * A region: the top level, the single implicit region of an ordinary composite state, or one explicit
 * orthogonal region. At run time each region has at most one active state, so engines and generated code
 * keep the active configuration as an array indexed by region index.
 */
export interface MRegion {
    /** Global index; 0 is the top-level region, regions of one state are consecutive. */
    index: number;
    /** Diagram id of the region element, or a synthetic id for implicit regions. */
    id: string;
    /** Name of an explicit region element; empty for implicit regions and the top level. */
    name: string;
    /** State that owns the region, or null for the top level. */
    owner: MState | null;
    /** Direct substates in this region, in diagram order. */
    states: MState[];
    /** Default transition of the region, resolved from its initial pseudostate. */
    initial?: MInitial;
}

/** A resolved initial transition: the state it enters (possibly nested deeper) and its actions. */
export interface MInitial {
    target: MState;
    actions: string[];
}

/** One outgoing branch of a choice point, resolved for a particular source state. */
export interface MBranch {
    /** Diagram id of the branch transition. */
    id: string;
    /** Undefined for the `[else]` (or unguarded) branch. */
    guard?: Guard;
    actions: string[];
    /** Final target; undefined when the branch continues into another choice point. */
    target?: MState;
    /** Target is the history pseudostate of `target` (restore its recorded configuration if there is one). */
    history: boolean;
    /** LCA of the transition's source and `target`; null (unused) for branches into a nested choice. */
    lca: MState | null;
    /** Branches of the nested choice point this branch leads into. */
    branches?: MBranch[];
}

/**
 * How a transition is triggered: a user event, an `after(...)` timeout, or the completion of its source.
 * Under Stateflow semantics `after(...)` is `temporal` instead: a candidate for the step event that is
 * enabled once its source has been active for `ticks` steps.
 */
export type TransitionKind = 'event' | 'timeout' | 'completion' | 'temporal';

/** A validated transition leaving a real state, with everything needed to fire it resolved. */
export interface MTransition {
    /** Diagram id of the transition. */
    id: string;
    source: MState;
    /** For history transitions the composite owning the history pseudostate; for internal and compound ones the source. */
    target: MState;
    /** User event, generated timeout event, or COMPLETION_EVENT. */
    event: string;
    kind: TransitionKind;
    guard?: Guard;
    actions: string[];
    /** Least common proper ancestor of source and target (null = top level). */
    lca: MState | null;
    internal: boolean;
    /** Target is the history pseudostate of `target`. */
    history: boolean;
    /** Present when the transition leads into a choice point. */
    branches?: MBranch[];
    /** Temporal transitions only: number of step events `source` must have been active for. */
    ticks?: number;
}

/** A timer for one distinct `after(...)` timeout of one state. */
export interface MTimer {
    /** Position in `Machine.timers`; indexes the per-timer generation/armed arrays. */
    index: number;
    /** State whose entry starts the timer and whose exit cancels it. */
    state: MState;
    /** Generated event name, `<State>_After<n>ms`. */
    event: string;
    milliseconds: number;
}

/**
 * The analysed, validated state machine: the single input of the code generators and the engine. All
 * cross references are object references, and all lists are in the order the generated code uses.
 */
export interface Machine {
    name: string;
    namespace: string;
    /** States in pre-order (parents before children). */
    states: MState[];
    /** Regions by index; regions[0] is the top level. */
    regions: MRegion[];
    /** User events, then generated timeout events, then COMPLETION_EVENT if used. */
    events: string[];
    /** Transitions ordered by source state; transitions that may not fire come before those that always fire. */
    transitions: MTransition[];
    /** Top-level initial transition, taken by Start(). */
    initial: MInitial;
    /** Distinct guard hook names (transition guards and choice branch guards). */
    guards: string[];
    /** Distinct action hook names (initial, entry, exit, transition and branch actions). */
    actions: string[];
    /** Parameters per event (empty when the event has none). */
    params: Map<string, Param[]>;
    /** Parameters received by each guard/action hook (empty for parameterless hooks). */
    hookParams: Map<string, Param[]>;
    timers: MTimer[];
    /** True when any completion transition exists. */
    completion: boolean;
    semantics: Semantics;
    /** Stateflow semantics: the step event (always part of `events`); undefined for UML semantics. */
    stepEvent?: string;
    /** True when any temporal transition exists (Stateflow semantics), i.e. per-state step counters are needed. */
    temporal: boolean;
    trace: boolean;
    threadSafe: boolean;
    queue: boolean;
    queueCapacity: number;
}

/**
 * A problem found by `analyze`. Errors prevent code generation and simulation (no machine is produced);
 * warnings point at parts of the diagram that are valid but have no effect, and a machine is still produced.
 */
export interface Issue {
    message: string;
    /**
     * Diagram id of the element the issue refers to, used to locate and highlight it. Always the id of a real
     * diagram element (state, pseudostate, region or transition); omitted for problems of the diagram as a
     * whole (machine name, top level, event declarations, ...).
     */
    id?: string;
    /**
     * Which list `id` refers to: `state` for an entry of `Diagram.states` (states, pseudostates and regions),
     * `transition` for an entry of `Diagram.transitions`. Set whenever `id` is, so that a state and a
     * transition that happen to share an id can be told apart.
     */
    element?: 'state' | 'transition';
    /** Omitted for errors. */
    severity?: 'error' | 'warning';
}

/** True unless the issue is a warning. */
export function isError(issue: Issue): boolean {
    return issue.severity !== 'warning';
}

/** The element an issue is attached to (spread into the issue object). */
type IssueTarget = Required<Pick<Issue, 'id' | 'element'>>;
/** Issue location for an element of `Diagram.states` (state, pseudostate or region). */
const stateRef = (id: string): IssueTarget => ({ id, element: 'state' });
/** Issue location for an element of `Diagram.transitions`. */
const transitionRef = (id: string): IssueTarget => ({ id, element: 'transition' });

/** Name of the internal event used to trigger completion transitions; reserved for user events. */
export const COMPLETION_EVENT = 'Completion';
/** Event queue capacity used when the diagram does not specify one. */
export const DEFAULT_QUEUE_CAPACITY = 16;

// A C-family identifier.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// `after(<number> [ms|s|min])`; the unit is optional (milliseconds) and case-insensitive.
const TIMEOUT = /^after\s*\(\s*(\d+(?:\.\d+)?)\s*(ms|s|min)?\s*\)$/i;

// Keywords of C, C++ and C# (union of the three). Names in this set cannot be used for states, events,
// guards, actions, parameters, classes or namespaces because they must compile in every target language.
const KEYWORDS = new Set(
    (
        'abstract as auto base bool break byte case catch char checked class const constexpr continue decimal default delegate delete do ' +
        'double else enum event explicit extern false finally fixed float for foreach friend goto if implicit in inline int interface internal ' +
        'is lock long namespace new noexcept null nullptr object operator out override params private protected public readonly ref return ' +
        'sbyte sealed short signed sizeof stackalloc static string struct switch template this throw true try typedef typeid typename typeof ' +
        'uint ulong unchecked union unsafe unsigned ushort using virtual void volatile while'
    ).split(' ')
);

/** Members emitted by the generators that user-defined hooks must not clash with. */
const RESERVED_MEMBERS = new Set([
    'Start', 'Dispatch', 'DispatchCore', 'Post', 'Current', 'IsIn', 'IsFinished', 'ParentOf', 'StateName', 'EventName', 'HandleEvent',
    'OnEntry', 'OnExit', 'ExitTo', 'EnterDown', 'EnterPath', 'EnterDefault', 'Invoke', 'Index', 'State', 'Event', 'None', 'Trace',
    'TraceKind', 'Lock', 'Unlock', 'ScopedLock', 'StartTimer', 'CancelTimer', 'StartTimers', 'CancelTimers', 'DrainQueue', 'QueuedEvent',
    'RunCompletions', 'HandleCompletion', 'MarkCompletion', 'TryRow', 'RecordHistory', 'TransitionRow',
    'DispatchState', 'ExitState', 'EnterRegion', 'RegionOf', 'FirstRegionOf', 'RegionsOf', 'IsFinalState', 'AllRegionsFinal', 'Innermost',
    'TimerIndex', 'RegionRow', 'TimerRow', 'Enqueue', 'EnterState', 'EnterHistory', 'IsDeepHistory',
    // Private fields of the generated C# class that a hook method of the same name would clash with.
    'history', 'exited'
]);
/**
 * Members the generators add only under Stateflow semantics (plus the `During_<State>` wrappers); reserved
 * only there, so that existing UML diagrams stay valid.
 */
const STATEFLOW_MEMBERS = new Set(['OnDuring', 'CountSteps', 'ticks', 'ticks_']);
/**
 * Name patterns of generated per-state/per-event members (e.g. `Entry_Red`, `DispatchPlay`, `PostPlay`,
 * `ArgsOfPlay`) that hook names must not match either.
 */
const RESERVED_PREFIX = /^(Entry|Exit|Init|Transition|Guard|Fire|Post|Dispatch|ArgsOf)_|^Dispatch|^Post[A-Z]/;

/**
 * Parses the text of a *.machina file into a `Diagram`. Empty text yields an empty diagram (useful for a newly
 * created file). Missing or wrongly typed top-level fields are replaced by defaults so that a partially
 * broken file can still be opened; the individual elements are not validated here — that is `analyze`'s job.
 *
 * @param text JSON text of the document.
 * @returns The diagram; scenarios without a name or step list are dropped.
 * @throws If the text is not valid JSON or its top level is not an object.
 */
export function parseDiagram(text: string): Diagram {
    const raw = text.trim() ? JSON.parse(text) : {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Diagram must be a JSON object.');
    }
    // A newer format may change the meaning of existing fields, so it is refused rather than misread.
    if (typeof raw.formatVersion === 'number' && raw.formatVersion > FORMAT_VERSION) {
        throw new Error(`This diagram uses format version ${raw.formatVersion}; this version of MachinaState supports up to ${FORMAT_VERSION}. Update the extension.`);
    }
    const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
    return {
        // The optional fields are only present when the file has them, so that a UML diagram parses (and is
        // compared in tests) exactly as before.
        ...(typeof raw.formatVersion === 'number' ? { formatVersion: raw.formatVersion } : {}),
        ...(typeof raw.semantics === 'string' ? { semantics: raw.semantics } : {}),
        ...(isObject(raw.step) ? { step: raw.step } : {}),
        ...(isObject(raw.hooks) ? { hooks: raw.hooks } : {}),
        ...(Array.isArray(raw.data) ? { data: raw.data } : {}),
        name: typeof raw.name === 'string' ? raw.name : 'StateMachine',
        namespace: typeof raw.namespace === 'string' ? raw.namespace : '',
        states: Array.isArray(raw.states) ? raw.states : [],
        transitions: Array.isArray(raw.transitions) ? raw.transitions : [],
        events: typeof raw.events === 'object' && raw.events && !Array.isArray(raw.events) ? raw.events : {},
        codegen: typeof raw.codegen === 'object' && raw.codegen ? raw.codegen : undefined,
        scenarios: Array.isArray(raw.scenarios) ? raw.scenarios.filter((s: Scenario) => s && typeof s.name === 'string' && Array.isArray(s.steps)) : undefined
    };
}

/**
 * Milliseconds of an `after(...)` event, or undefined if the text is not a timeout. The result may be
 * fractional (e.g. `after(0.5ms)`); `analyze` rejects timeouts that are not positive whole milliseconds.
 */
export function parseTimeout(event: string): number | undefined {
    const m = TIMEOUT.exec(event.trim());
    if (!m) {
        return undefined;
    }
    const factor = { ms: 1, s: 1000, min: 60000 }[(m[2] ?? 'ms').toLowerCase() as 'ms' | 's' | 'min'];
    return Number(m[1]) * factor;
}

/**
 * Number of steps of an `after(<n> steps)` (or `ticks`) event, or undefined if the text is not one. Only
 * valid under Stateflow semantics, where `after(...)` is counted in step events.
 */
export function parseSteps(event: string): number | undefined {
    const m = /^after\s*\(\s*(\d+(?:\.\d+)?)\s*(steps?|ticks?)\s*\)$/i.exec(event.trim());
    return m ? Number(m[1]) : undefined;
}

/**
 * True if one of the branches is always taken (an [else] branch whose continuation is exhaustive too). An
 * [else] branch that leads into a nested choice point without an [else] of its own can still fail, so the
 * check recurses into nested branch lists.
 */
export function isExhaustive(branches: MBranch[]): boolean {
    return branches.some(b => !b.guard && (!b.branches || isExhaustive(b.branches)));
}

/**
 * True if the transition fires whenever it is considered (no guard, and every choice has an else path).
 * Such a transition hides every later candidate for the same event, so `analyze` orders it last among the
 * transitions of its source and the generators can emit it without a fall-through path.
 */
export function alwaysFires(t: MTransition): boolean {
    return !t.guard && t.ticks === undefined && (!t.branches || isExhaustive(t.branches));
}

/** True for a C-family identifier that is not a keyword of any target language. */
function isIdentifier(s: string): boolean {
    return IDENT.test(s) && !KEYWORDS.has(s);
}

/**
 * Splits `text` at commas that are not nested inside `<>`, `()`, `[]` or `{}`, so that parameter types such
 * as `std::map<int, int>` stay in one piece. A trailing empty part is dropped.
 */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
        if ('<([{'.includes(ch)) {
            depth++;
        } else if ('>)]}'.includes(ch)) {
            depth--;
        }
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) {
        parts.push(current);
    }
    return parts;
}

/**
 * Parses the parameter list declared for an event, e.g. `const std::string& name, int retries = 3`. Each entry
 * must be `type name`; default values are stripped (the generated typed dispatch methods take all parameters).
 * Invalid and duplicate parameters are reported and skipped.
 *
 * @param text Comma-separated declaration list, or undefined when the event declares none.
 * @param event Event name, used in issue messages.
 * @param issues Receives the problems found.
 */
function parseParams(text: string | undefined, event: string, issues: Issue[]): Param[] {
    const result: Param[] = [];
    for (const raw of splitTopLevel(text ?? '')) {
        const decl = raw.split('=')[0].trim();
        // The name is the trailing identifier; the type is everything before it and must end in whitespace or
        // one of `&`, `*`, `>` so that `int&x`, `char*p` and `vector<int>v` are split correctly.
        const m = /^(.*[\s&*>])([A-Za-z_][A-Za-z0-9_]*)$/.exec(decl);
        if (!m || !m[1].trim() || !isIdentifier(m[2])) {
            issues.push({ message: `Event '${event}': parameter '${raw.trim()}' must be written as 'type name'.` });
            continue;
        }
        if (result.some(p => p.name === m[2])) {
            issues.push({ message: `Event '${event}': parameter '${m[2]}' is declared twice.` });
            continue;
        }
        result.push({ type: m[1].trim(), name: m[2], decl });
    }
    return result;
}

/**
 * Splits an action list at `;`, `,` and newlines that are not nested inside `()`, `[]`, `{}` or a quoted string,
 * the same way the PlantUML/SCXML importers do. Call-style actions with arguments are not supported (actions
 * are hook names), but splitting `f(a, b)` as one piece lets it be reported once, as written, rather than as
 * the two meaningless fragments `f(a` and `b)`.
 */
function splitActions(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            // Inside a string literal only the closing quote matters; a backslash escapes the next character.
            if (ch === '\\') {
                current += ch + (text[i + 1] ?? '');
                i++;
                continue;
            }
            if (ch === quote) {
                quote = '';
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if ('([{'.includes(ch)) {
            depth++;
        } else if (')]}'.includes(ch)) {
            depth = Math.max(0, depth - 1);
        } else if (depth === 0 && (ch === ';' || ch === ',' || ch === '\n')) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}

/**
 * Parses an action list (entry, exit, initial, transition or branch actions). Actions are separated by `;`,
 * `,` or newlines (see splitActions), and an empty call suffix `()` is accepted and dropped, so `a(); b()`
 * gives `['a', 'b']`. Actions are hook names, not code: anything that is not a plain identifier is reported.
 *
 * @param where Description of the owner for issue messages, e.g. `State 'Red' entry`.
 * @param at Diagram element the issues are attached to.
 */
function parseActions(text: string | undefined, where: string, at: IssueTarget, issues: Issue[]): string[] {
    const result: string[] = [];
    for (const part of splitActions(typeof text === 'string' ? text : '')) {
        const name = part.trim().replace(/\(\s*\)$/, '').trim();
        if (!name) {
            continue;
        }
        if (!isIdentifier(name)) {
            issues.push({ ...at, message: `${where}: action '${name}' must be a method name (e.g. 'doSomething').` });
        } else {
            result.push(name);
        }
    }
    return result;
}

/**
 * Parses a guard: a single hook name, optionally negated with `!` and optionally followed by `()`. Because
 * `else` is a keyword, `[else]` is rejected here; it is only meaningful on choice branches, which handle it
 * before calling this function.
 *
 * @returns The guard, or undefined when the text is empty or invalid (invalid guards are reported).
 */
function parseGuard(text: string | undefined, where: string, id: string, issues: Issue[]): Guard | undefined {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
        return undefined;
    }
    const m = /^(!?)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\(\s*\))?$/.exec(trimmed);
    if (!m || KEYWORDS.has(m[2])) {
        issues.push({ ...transitionRef(id), message: `${where}: guard '${trimmed}' must be a method name, optionally negated with '!'.` });
        return undefined;
    }
    return { name: m[2], negate: m[1] === '!' };
}

/** Visits every branch of a compound transition, depth first. */
export function forEachBranch(branches: MBranch[] | undefined, visit: (b: MBranch) => void): void {
    for (const b of branches ?? []) {
        visit(b);
        forEachBranch(b.branches, visit);
    }
}

/**
 * Reports completion transitions that would fire for ever: a cycle of states in which the completion of each
 * state definitely fires a transition that enters the next one and immediately completes it again. Such a
 * diagram would never return from Start or Dispatch (the generated RunCompletions loop has no limit).
 *
 * Only cycles that are certain are reported, so a state takes part only if its completion handling is fixed:
 * it has exactly one completion transition, without a guard, whose path (through choice points with nothing
 * but an [else] branch, if any) ends in a state rather than a history pseudostate, whose remembered state is
 * not known statically. A cycle that contains a guard is legitimate (it ends when the guard changes) and is
 * left to the engine's iteration limit. The states completed by firing such a transition are found by
 * following the default entry of everything it enters, exactly like EnterDown: a leaf with completion
 * transitions of its own, or a final leaf whose single-region parent has completion transitions (for an
 * orthogonal parent the completion depends on the other regions and is not certain).
 *
 * One error is reported per strongly connected group of states, on the completion transition of its first
 * state (in pre-order).
 *
 * @param transitions The analysed transitions (possibly incomplete when the diagram has other errors).
 * @param issues Receives the errors.
 */
function reportCompletionLoops(transitions: MTransition[], issues: Issue[]): void {
    const completions = (s: MState) => transitions.filter(t => t.source === s && t.kind === 'completion');
    // States reached by default entry below `from` down to `target`: like EnterDown, the target's subtree is
    // entered by default and every orthogonal state on the path default-enters the regions not on the path.
    // Returns the leaves that are entered.
    const enteredLeaves = (from: MState | null, target: MState): MState[] => {
        const path: MState[] = [];
        for (let x: MState | null = target; x && x !== from; x = x.parent) {
            path.unshift(x);
        }
        const defaultLeaves = (s: MState): MState[] =>
            s.regions.length === 0 ? [s] : s.regions.flatMap(r => (r.initial ? enteredLeaves(s, r.initial.target) : []));
        return path.flatMap((s, i) =>
            i === path.length - 1 ? defaultLeaves(s) : s.regions.filter(r => r !== path[i + 1].region).flatMap(r => (r.initial ? enteredLeaves(s, r.initial.target) : []))
        );
    };
    // The state whose completion is certain once `leaf` has been entered (see above), if any.
    const completedBy = (leaf: MState): MState | undefined => {
        if (completions(leaf).length > 0) {
            return leaf;
        }
        const p = leaf.parent;
        return leaf.isFinal && p && p.regions.length === 1 && completions(p).length > 0 ? p : undefined;
    };
    // Graph: state -> states its fixed completion transition completes again.
    const next = new Map<MState, { transition: MTransition; completes: MState[] }>();
    for (const s of new Set(transitions.map(t => t.source))) {
        const own = completions(s);
        if (own.length !== 1 || own[0].guard) {
            continue;
        }
        const t = own[0];
        // Resolve the fixed path through choice points: an unguarded first branch means it is the only one.
        let end: { target?: MState; lca: MState | null; history: boolean; branches?: MBranch[] } = t;
        while (end.branches) {
            const first: MBranch | undefined = end.branches[0];
            if (!first || first.guard) {
                break;
            }
            end = first;
        }
        if (end.branches || end.history || !end.target) {
            continue;
        }
        const completes = enteredLeaves(end.lca, end.target).map(completedBy).filter((x): x is MState => x !== undefined);
        next.set(s, { transition: t, completes });
    }
    // States reachable from `s` along at least one edge.
    const reach = (s: MState): Set<MState> => {
        const seen = new Set<MState>();
        const todo = [...(next.get(s)?.completes ?? [])];
        while (todo.length) {
            const x = todo.pop()!;
            if (!seen.has(x)) {
                seen.add(x);
                todo.push(...(next.get(x)?.completes ?? []));
            }
        }
        return seen;
    };
    const reported = new Set<MState>();
    for (const s of [...next.keys()].sort((a, b) => a.index - b.index)) {
        const fromS = reach(s);
        if (reported.has(s) || !fromS.has(s)) {
            continue;
        }
        const group = [...fromS].filter(x => reach(x).has(s)).sort((a, b) => a.index - b.index);
        group.forEach(x => reported.add(x));
        issues.push({
            ...transitionRef(next.get(s)!.transition.id),
            message: `Completion transitions of ${group.map(x => `'${x.name}'`).join(', ')} form an endless loop; give one of them a guard or an event.`
        });
    }
}

/**
 * Validates a diagram and builds the semantic `Machine` from it.
 *
 * The analysis runs in phases, each of which may add issues:
 *   1. element ids, machine name, namespace, parent links and containment cycles;
 *   2. regions (explicit region elements or implicit ones) and the real states placed in them;
 *   3. pre-order numbering of states and global numbering of regions;
 *   4. initial pseudostates (one per region) and history pseudostates (at most one per composite);
 *   5. transitions: event kind, timeouts, guards, actions, choice-point branch trees and LCAs, then priority
 *      ordering, duplicate detection and endless loops of completion transitions;
 *   6. the event list, guard/action hook lists, name clashes, and the parameter list bound to each hook;
 *   7. unused elements (warnings) and code generation options.
 *
 * The diagram is not modified. An element with an invalid parent link is treated as a top-level element by
 * the later phases (after the link has been reported), so that analysis can continue instead of failing.
 *
 * @param d The diagram, as returned by `parseDiagram`.
 * @returns The de-duplicated issues, and the machine if (and only if) there are no errors (warnings are
 *          allowed) and the top level has an initial transition.
 */
export function analyze(d: Diagram): { machine?: Machine; issues: Issue[] } {
    const issues: Issue[] = [];
    // Diagram elements by id. With duplicate ids the last element wins, but the duplicate is an error anyway.
    const nodes = new Map<string, StateNode>();
    for (const s of d.states) {
        if (nodes.has(s.id)) {
            issues.push({ ...stateRef(s.id), message: `Duplicate element id '${s.id}'.` });
        }
        nodes.set(s.id, s);
    }

    // The machine name becomes a class name; the namespace may use C# (`.`) or C++ (`::`) separators.
    if (!isIdentifier(d.name) || RESERVED_MEMBERS.has(d.name)) {
        issues.push({ message: `Machine name '${d.name}' is not a valid class name.` });
    }
    const ns = (d.namespace ?? '').trim();
    if (ns && !ns.split(/\.|::/).every(isIdentifier)) {
        issues.push({ message: `Namespace '${ns}' is not valid.` });
    }
    // Execution semantics. Everything specific to Stateflow semantics is guarded by `stateflow`, so a UML
    // diagram is analysed exactly as before.
    if (d.semantics !== undefined && d.semantics !== 'uml' && d.semantics !== 'stateflow') {
        issues.push({ message: `Unknown semantics '${String(d.semantics)}' (use 'uml' or 'stateflow').` });
    }
    const stateflow = d.semantics === 'stateflow';
    const stepEvent = stateflow ? (typeof d.step?.event === 'string' && d.step.event.trim() ? d.step.event.trim() : 'Step') : undefined;
    const period = stateflow ? d.step?.periodMs : undefined;
    if (stepEvent !== undefined && (!isIdentifier(stepEvent) || stepEvent === 'None' || stepEvent === COMPLETION_EVENT)) {
        issues.push({ message: `Step event '${stepEvent}' is not a valid identifier (or is reserved).` });
    }
    if (period !== undefined && (typeof period !== 'number' || !(period > 0))) {
        issues.push({ message: 'The step period must be a positive number of milliseconds.' });
    }

    // Effective parent id of every element: its `parent` link, or null once that link has been found invalid.
    // Kept here rather than written back into the StateNode objects, which belong to the caller; every later
    // phase reads parents through `parent()`.
    const parentOf = new Map<StateNode, string | null>();
    const parent = (s: StateNode): string | null => parentOf.get(s) ?? null;
    // Parent links: a region must sit directly inside a state; anything else may sit inside a state or a
    // region. Invalid parents are reported and the element is treated as top level from here on.
    for (const s of d.states) {
        let link = s.parent ?? null;
        if (link !== null) {
            const p = nodes.get(link);
            const valid = s.kind === 'region' ? p?.kind === 'state' : p?.kind === 'state' || p?.kind === 'region';
            if (!valid) {
                issues.push({ ...stateRef(s.id), message: `'${s.name}' has an invalid parent.` });
                link = null;
            }
        } else if (s.kind === 'region') {
            issues.push({ ...stateRef(s.id), message: 'A region must be placed inside a state.' });
        }
        parentOf.set(s, link);
    }
    for (const s of d.states) {
        // Walk up the parent chain; revisiting an element means the containment is cyclic. All later phases
        // walk parent chains too, so analysis cannot continue safely and stops right here. Every link left in
        // `parentOf` names an existing element, so `nodes.get` cannot fail.
        const seen = new Set<string>();
        for (let p = parent(s); p; p = parent(nodes.get(p)!)) {
            if (seen.has(p) || p === s.id) {
                issues.push({ ...stateRef(s.id), message: `'${s.name}' is part of a containment cycle.` });
                return { issues };
            }
            seen.add(p);
        }
    }

    // Regions: explicit region elements, or one implicit region per composite state (and the top level).
    // `explicit` maps a state id to its region elements in diagram order (which is also the order in which
    // the regions are entered and the order in which events are offered to them).
    const explicit = new Map<string, StateNode[]>();
    for (const r of d.states.filter(x => x.kind === 'region' && parent(x))) {
        explicit.set(parent(r)!, [...(explicit.get(parent(r)!) ?? []), r]);
    }
    // Once a state has explicit regions, every substate must be inside one of them; a substate placed directly
    // in such a state would otherwise form an extra, unnamed region.
    for (const s of d.states) {
        const p = parent(s);
        if (s.kind !== 'region' && p && explicit.has(p)) {
            issues.push({ ...stateRef(s.id), message: `'${s.name}' must be placed inside one of the regions of '${nodes.get(p)!.name}'.` });
            parentOf.set(s, null);
        }
    }
    // Key of the region an element belongs to: `#root` for the top level, the region element's id inside an
    // explicit region, or `<state id>#region` for the implicit single region of an ordinary composite state.
    // The keys double as MRegion ids; they are internal and never used as issue ids.
    const regionKey = (s: StateNode): string => {
        const p = parent(s);
        if (!p) {
            return '#root';
        }
        return nodes.get(p)!.kind === 'region' ? p : `${p}#region`;
    };

    // Real (non-pseudo) states.
    const isPseudo = (s: StateNode) => s.kind === 'initial' || s.kind === 'history' || s.kind === 'choice' || s.kind === 'region';
    const mstates = new Map<string, MState>();
    const names = new Set<string>();
    for (const s of d.states) {
        if (isPseudo(s)) {
            continue;
        }
        const where = `State '${s.name}'`;
        // State names become enumerators of one flat State enumeration, so they must be unique across all
        // nesting levels; `None` is the generated "no state" value.
        if (!isIdentifier(s.name) || s.name === 'None') {
            issues.push({ ...stateRef(s.id), message: `${where}: name must be a valid identifier.` });
        } else if (names.has(s.name)) {
            issues.push({ ...stateRef(s.id), message: `${where}: name is not unique (state names are global, even when nested).` });
        }
        names.add(s.name);
        if (!stateflow && (s.during ?? '').trim()) {
            issues.push({ ...stateRef(s.id), message: `${where}: during actions need Stateflow semantics.` });
        }
        // `index`, `parent` and `region` are placeholders here; they are filled in by the region assignment and
        // pre-order numbering below. Final states have no entry or exit actions.
        mstates.set(s.id, {
            id: s.id,
            name: s.name,
            index: 0,
            parent: null,
            children: [],
            isFinal: s.kind === 'final',
            entry: s.kind === 'state' ? parseActions(s.entry, `${where} entry`, stateRef(s.id), issues) : [],
            exit: s.kind === 'state' ? parseActions(s.exit, `${where} exit`, stateRef(s.id), issues) : [],
            during: s.kind === 'state' ? parseActions(s.during, `${where} during`, stateRef(s.id), issues) : [],
            region: undefined as unknown as MRegion,
            regions: []
        });
    }
    // Create the top-level region and the explicit regions first, so that orthogonal regions keep diagram
    // order; implicit regions are created lazily when their first substate is seen.
    const regionsByKey = new Map<string, MRegion>();
    const rootRegion: MRegion = { index: 0, id: '#root', name: '', owner: null, states: [] };
    regionsByKey.set('#root', rootRegion);
    for (const [ownerId, list] of explicit) {
        const owner = mstates.get(ownerId);
        for (const r of list) {
            const region: MRegion = { index: 0, id: r.id, name: r.name ?? '', owner: owner ?? null, states: [] };
            regionsByKey.set(r.id, region);
            owner?.regions.push(region);
        }
    }
    // Place every real state in its region and link it to its parent: the parent of a state is the owner of
    // its region, so a state inside an explicit region gets the region's owning state as parent.
    for (const s of d.states) {
        const m = mstates.get(s.id);
        if (!m) {
            continue;
        }
        const key = regionKey(s);
        let region = regionsByKey.get(key);
        if (!region) {
            const owner = mstates.get(parent(s)!) ?? null;
            region = { index: 0, id: key, name: '', owner, states: [] };
            regionsByKey.set(key, region);
            owner?.regions.push(region);
        }
        m.region = region;
        region.states.push(m);
        m.parent = region.owner;
        m.parent?.children.push(m);
    }
    for (const region of regionsByKey.values()) {
        if (region.states.length === 0 && region !== rootRegion) {
            issues.push({ ...stateRef(region.id), message: `A region of '${region.owner?.name}' contains no states.` });
        }
    }

    // Number the states in pre-order (each state before its substates, regions in order). The generated
    // enumeration uses these indices, and a parent always has a smaller index than its descendants, which the
    // engine relies on to run completions of outer states first.
    const ordered: MState[] = [];
    const visit = (s: MState) => {
        s.index = ordered.length;
        ordered.push(s);
        s.regions.forEach(r => r.states.forEach(visit));
    };
    rootRegion.states.forEach(visit);
    // Region indices: 0 for the top level, then the regions of each state in state order, so that the regions
    // of one orthogonal state are consecutive (generated code stores the first index and the count).
    const regionList: MRegion[] = [rootRegion, ...ordered.flatMap(s => s.regions)];
    regionList.forEach((r, i) => (r.index = i));

    if (ordered.length === 0) {
        issues.push({ message: 'The diagram has no states.' });
    }

    // True if `anc` strictly contains `s`; null (the top level) contains every state.
    const isProperAncestor = (anc: MState | null, s: MState): boolean => {
        for (let p = s.parent; p; p = p.parent) {
            if (p === anc) {
                return true;
            }
        }
        return anc === null;
    };
    // Least common *proper* ancestor: the innermost state that strictly contains both `a` and `b`, or null for
    // the top level. Because the search starts at a's parent, a self transition gets the source's parent as
    // LCA (so the state is exited and re-entered), and a transition between a composite state and one of its
    // own substates exits and re-enters the composite too: all non-internal transitions are external.
    const lca = (a: MState, b: MState): MState | null => {
        for (let p = a.parent; p; p = p.parent) {
            if (isProperAncestor(p, b)) {
                return p;
            }
        }
        return null;
    };

    // True if `s` lies in `region` at any depth (s itself or one of its ancestors is a direct member).
    const inRegion = (s: MState, region: MRegion): boolean => {
        for (let x: MState | null = s; x; x = x.parent) {
            if (x.region === region) {
                return true;
            }
        }
        return false;
    };
    /** Region of `anc` that contains `s` (s must be a proper descendant of anc). */
    const regionBelow = (anc: MState | null, s: MState): MRegion => {
        let x = s;
        while (x.parent !== anc) {
            x = x.parent!;
        }
        return x.region;
    };
    // True if a transition between `a` and `b` would connect two different regions of the same orthogonal
    // state (their LCA `common`). Such a transition would have to exit one region while keeping the orthogonal
    // state active, which is not supported.
    const crossesRegions = (a: MState, b: MState, common: MState | null) =>
        common !== null && common.regions.length > 1 && regionBelow(common, a) !== regionBelow(common, b);

    // Initial pseudostates: exactly one per region that contains states.
    const initialsByRegion = new Map<string, StateNode[]>();
    for (const s of d.states.filter(x => x.kind === 'initial')) {
        const key = regionKey(s);
        initialsByRegion.set(key, [...(initialsByRegion.get(key) ?? []), s]);
    }
    for (const region of regionList) {
        const initials = initialsByRegion.get(region.id) ?? [];
        const owner = region.owner;
        const label = !owner ? 'Top level' : owner.regions.length > 1 ? `Region '${region.name || region.index}' of '${owner.name}'` : `Composite state '${owner.name}'`;
        if (initials.length === 0) {
            // An empty top level is already reported as "no states". For a composite state with a single
            // region the issue is attached to the state, since an implicit region has no diagram element; the
            // top level is no element at all, so its issue has no id.
            if (owner) {
                issues.push({ ...stateRef(owner.regions.length === 1 ? owner.id : region.id), message: `${label} needs an initial pseudostate.` });
            } else if (ordered.length > 0) {
                issues.push({ message: `${label} needs an initial pseudostate.` });
            }
            continue;
        }
        if (initials.length > 1) {
            issues.push({ ...stateRef(initials[1].id), message: `${label} has more than one initial pseudostate.` });
        }
        const init = initials[0];
        const out = d.transitions.filter(t => t.source === init.id);
        if (out.length !== 1) {
            issues.push({ ...stateRef(init.id), message: `${label}: initial pseudostate must have exactly one outgoing transition.` });
            continue;
        }
        const t = out[0];
        const target = mstates.get(t.target);
        // The default target may be nested deeper than the region's direct substates; entering it then enters
        // every state on the path (and default-enters sibling regions of orthogonal states on the way).
        if (!target || !inRegion(target, region)) {
            issues.push({ ...transitionRef(t.id), message: `${label}: initial transition must target a state inside the same region.` });
            continue;
        }
        if ((t.event ?? '').trim() || (t.guard ?? '').trim()) {
            issues.push({ ...transitionRef(t.id), message: `${label}: initial transition cannot have an event or guard.` });
        }
        region.initial = { target, actions: parseActions(t.action, `${label} initial transition`, transitionRef(t.id), issues) };
        if (owner && owner.regions.length === 1) {
            owner.initial = region.initial;
        }
    }
    const rootInitial = rootRegion.initial;
    // Initial pseudostates whose region key never got a region: they sit in a composite state (or region)
    // that contains no real states, so there is nothing for them to enter.
    for (const [key, initials] of initialsByRegion) {
        const region = regionsByKey.get(key);
        if (!region) {
            const owner = mstates.get(key.replace(/#region$/, ''));
            issues.push({ ...stateRef(initials[0].id), message: `Initial pseudostate in '${owner?.name ?? '?'}' has no sibling states to enter.` });
        }
    }

    // Composite state that owns a history pseudostate: its parent state, or the owner of the region element it
    // sits in (a state with a single explicit region behaves like an ordinary composite, and its substates,
    // the history pseudostate included, are drawn inside that region). Undefined when it is not inside a state.
    const historyOwner = (h: StateNode): MState | undefined => {
        const p = parent(h);
        const container = p ? nodes.get(p) : undefined;
        return container?.kind === 'region' ? mstates.get(parent(container) ?? '') : mstates.get(p ?? '');
    };
    // History pseudostates: at most one per non-orthogonal composite state, no outgoing transitions. History
    // is recorded on the owning state (`MState.history`); the pseudostate itself disappears and transitions
    // targeting it are resolved to the owner with `history: true` (see resolveTarget). A state with several
    // regions cannot have one (which region it would belong to is ambiguous); a state with exactly one
    // region, implicit or explicit, can.
    for (const h of d.states.filter(x => x.kind === 'history')) {
        const owner = historyOwner(h);
        if (!owner || owner.children.length === 0) {
            issues.push({ ...stateRef(h.id), message: 'A history pseudostate must be placed inside a composite state.' });
            continue;
        }
        if (owner.regions.length > 1) {
            issues.push({ ...stateRef(h.id), message: `History pseudostates are not supported in orthogonal states ('${owner.name}').` });
            continue;
        }
        if (owner.history) {
            issues.push({ ...stateRef(h.id), message: `Composite state '${owner.name}' has more than one history pseudostate.` });
            continue;
        }
        owner.history = h.deep ? 'deep' : 'shallow';
    }

    // Resolves the target of a transition or branch: a state, a composite entered through its history, or invalid.
    // A transition into a history pseudostate targets its owning composite for LCA purposes; at run time the
    // remembered configuration is restored if there is one, otherwise the composite's default entry applies.
    // Other non-state targets (a region element, or a history pseudostate outside any state) resolve to no
    // target and an explanation, which the caller reports before dropping the transition.
    const resolveTarget = (dst: StateNode): { target?: MState; history: boolean; problem?: string } => {
        if (dst.kind === 'history') {
            const owner = historyOwner(dst);
            return { target: owner, history: true, problem: owner ? undefined : 'the target history pseudostate is not inside a composite state' };
        }
        const target = mstates.get(dst.id);
        return { target, history: false, problem: target ? undefined : dst.kind === 'region' ? 'a region cannot be a target; target a state inside it' : 'invalid target' };
    };

    // Choice points: branches are resolved per incoming transition because the LCA depends on the source.
    // The result is a tree: a branch leading into another choice point carries that point's branches instead
    // of a target. `chain` holds the choice points already on the current path, to detect cycles. Branches are
    // returned guarded first (in diagram order) and the [else] branch last, which is the order in which the
    // engine and the generated code evaluate them. Returns undefined when the choice point (or a nested one)
    // is unusable; the issue has then been reported and the incoming transition is dropped.
    const resolveChoice = (choice: StateNode, source: MState, chain: string[]): MBranch[] | undefined => {
        if (chain.includes(choice.id)) {
            issues.push({ ...stateRef(choice.id), message: 'Choice points form a cycle.' });
            return undefined;
        }
        const out = d.transitions.filter(t => t.source === choice.id);
        if (out.length === 0) {
            issues.push({ ...stateRef(choice.id), message: 'A choice point needs at least one outgoing branch.' });
            return undefined;
        }
        const branches: MBranch[] = [];
        let elseCount = 0;
        for (const t of out) {
            const where = 'Choice branch';
            // The event belongs to the incoming transition; branches are only selected by their guards.
            if ((t.event ?? '').trim()) {
                issues.push({ ...transitionRef(t.id), message: `${where}: branches leaving a choice point cannot have an event.` });
            }
            // An empty guard and `else` are equivalent: the branch is taken when no guarded sibling is enabled.
            const guardText = (t.guard ?? '').trim();
            const isElse = guardText === '' || guardText === 'else';
            if (isElse) {
                elseCount++;
            }
            const guard = isElse ? undefined : parseGuard(guardText, where, t.id, issues);
            const actions = parseActions(t.action, where, transitionRef(t.id), issues);
            const dst = nodes.get(t.target);
            if (!dst || dst.kind === 'initial') {
                issues.push({ ...transitionRef(t.id), message: `${where}: invalid target.` });
                continue;
            }
            if (dst.kind === 'choice') {
                const nested = resolveChoice(dst, source, [...chain, choice.id]);
                if (!nested) {
                    return undefined;
                }
                branches.push({ id: t.id, guard, actions, history: false, lca: null, branches: nested });
                continue;
            }
            const { target, history, problem } = resolveTarget(dst);
            if (!target) {
                issues.push({ ...transitionRef(t.id), message: `${where}: ${problem}.` });
                continue;
            }
            // The compound transition is fired as a whole from the original source, so the LCA (and the region
            // check) is computed between the source state and this branch's final target.
            const common = lca(source, target);
            if (crossesRegions(source, target, common)) {
                issues.push({ ...transitionRef(t.id), message: `${where}: transitions between orthogonal regions are not allowed.` });
                continue;
            }
            branches.push({ id: t.id, guard, actions, target, history, lca: common });
        }
        if (elseCount > 1) {
            issues.push({ ...stateRef(choice.id), message: 'A choice point can have at most one [else] (unguarded) branch.' });
        }
        // Array.prototype.sort is stable, so guarded branches keep their diagram order.
        return branches.sort((a, b) => (a.guard ? 0 : 1) - (b.guard ? 0 : 1));
    };

    // Transitions leaving states.
    const transitions: MTransition[] = [];
    const userEvents: string[] = [];
    const timers: MTimer[] = [];
    for (const t of d.transitions) {
        const src = nodes.get(t.source);
        const dst = nodes.get(t.target);
        if (!src || !dst) {
            issues.push({ ...transitionRef(t.id), message: 'Transition references a missing state.' });
            continue;
        }
        if (dst.kind === 'initial') {
            issues.push({ ...transitionRef(t.id), message: 'Transitions cannot target an initial pseudostate.' });
            continue;
        }
        // Transitions leaving initial pseudostates and choice points were handled above (as region defaults and
        // as branches of the incoming transitions); they are not transitions of their own.
        if (src.kind === 'initial' || src.kind === 'choice') {
            continue;
        }
        if (src.kind === 'history') {
            issues.push({ ...transitionRef(t.id), message: 'History pseudostates cannot have outgoing transitions; the composite state\'s initial state is used when no history exists.' });
            continue;
        }
        if (src.kind === 'final') {
            issues.push({ ...transitionRef(t.id), message: `Final state '${src.name}' cannot have outgoing transitions.` });
            continue;
        }
        // The remaining non-state source is a region element (unknown kinds are treated as states).
        const source = mstates.get(src.id);
        if (!source) {
            issues.push({ ...transitionRef(t.id), message: `Transitions cannot start at a region ('${src.name}'); draw them from a state.` });
            continue;
        }
        const where = `Transition from ${src.name}`;
        const eventText = (t.event ?? '').trim();
        const internal = t.internal === true;
        // Classify the trigger. An empty event makes a completion transition. A timeout gets a generated event
        // name that is unique per state and duration, and one timer per such event (several transitions with
        // the same timeout on one state, e.g. with different guards, share the timer).
        let kind: TransitionKind = 'event';
        let event = eventText;
        let ticks: number | undefined;
        const timeout = eventText ? parseTimeout(eventText) : undefined;
        const steps = eventText ? parseSteps(eventText) : undefined;
        if (!eventText) {
            kind = 'completion';
            event = COMPLETION_EVENT;
        } else if (steps !== undefined && !stateflow) {
            issues.push({ ...transitionRef(t.id), message: `${where}: after(... steps) needs Stateflow semantics; use a time such as after(5s).` });
            continue;
        } else if (stateflow && (timeout !== undefined || steps !== undefined)) {
            // Stateflow semantics: no timer; the transition is a candidate for the step event, enabled once the
            // source has been active for `ticks` steps. A time is rounded up to whole periods.
            if (steps !== undefined) {
                ticks = steps;
            } else if (period !== undefined && typeof period === 'number' && period > 0) {
                ticks = Math.max(1, Math.ceil(timeout! / period - 1e-9));
            } else {
                issues.push({ ...transitionRef(t.id), message: `${where}: after(${eventText.replace(/^after\s*\(|\)\s*$/g, '').trim()}) needs a step period to be counted in steps; set the step period or write after(n steps).` });
                continue;
            }
            if (!Number.isInteger(ticks) || ticks <= 0) {
                issues.push({ ...transitionRef(t.id), message: `${where}: after(...) must be a positive whole number of steps.` });
                continue;
            }
            kind = 'temporal';
            event = stepEvent!;
        } else if (timeout !== undefined) {
            if (!Number.isInteger(timeout) || timeout <= 0) {
                issues.push({ ...transitionRef(t.id), message: `${where}: timeout must be a positive whole number of milliseconds.` });
                continue;
            }
            kind = 'timeout';
            event = `${source.name}_After${timeout}ms`;
            if (!timers.some(x => x.event === event)) {
                timers.push({ index: timers.length, state: source, event, milliseconds: timeout });
            }
        } else if (!isIdentifier(eventText) || eventText === 'None' || eventText === COMPLETION_EVENT) {
            // `None` and `Completion` are generated members of the Event enumeration.
            issues.push({ ...transitionRef(t.id), message: `${where}: event '${eventText}' is not a valid identifier (or is reserved).` });
            continue;
        } else if (!userEvents.includes(eventText)) {
            userEvents.push(eventText);
        }
        // Internal transitions never leave their state, so they must be self transitions, and they must be
        // triggered by an event or timeout (completion transitions cannot be internal).
        if (internal && (src.id !== dst.id || kind === 'completion')) {
            issues.push({ ...transitionRef(t.id), message: `${where}: only self transitions with an event can be internal.` });
            continue;
        }
        const guard = parseGuard(t.guard, where, t.id, issues);
        const actions = parseActions(t.action, where, transitionRef(t.id), issues);
        if (dst.kind === 'choice') {
            // Compound transition: the real targets and LCAs live in the branches, so `target` is set to the
            // source and `lca` to null as placeholders that consumers must not use.
            const branches = resolveChoice(dst, source, []);
            if (branches) {
                transitions.push({ id: t.id, source, target: source, event, kind, guard, actions, lca: null, internal: false, history: false, branches, ...(ticks !== undefined ? { ticks } : {}) });
            }
            continue;
        }
        const { target, history, problem } = resolveTarget(dst);
        if (!target) {
            issues.push({ ...transitionRef(t.id), message: `${where}: ${problem}.` });
            continue;
        }
        // Internal transitions exit and enter nothing (their LCA is not used when they fire), and as self
        // transitions they cannot cross regions.
        const common = internal ? source.parent : lca(source, target);
        if (!internal && crossesRegions(source, target, common)) {
            issues.push({ ...transitionRef(t.id), message: `${where}: transitions between orthogonal regions are not allowed.` });
            continue;
        }
        transitions.push({ id: t.id, source, target, event, kind, guard, actions, lca: common, internal, history, ...(ticks !== undefined ? { ticks } : {}) });
    }
    // Priority within a source state: candidates that may not fire (guarded, or with a non-exhaustive choice)
    // are tried before those that always fire, otherwise in diagram order (the sort is stable). Sorting by
    // source index also groups the transitions of each state together, in state (pre-order) order.
    const priority = (t: MTransition) => (alwaysFires(t) ? 1 : 0);
    transitions.sort((a, b) => a.source.index - b.source.index || priority(a) - priority(b));
    // Two always-firing transitions for the same event on the same state: only the first could ever fire. The
    // sorted list groups transitions by source but not by event, so every (source, event) pair seen so far is
    // remembered; each later duplicate is reported on its own transition.
    const alwaysFiring = new Set<string>();
    for (const t of transitions.filter(alwaysFires)) {
        const key = `${t.source.index}:${t.event}`;
        if (alwaysFiring.has(key)) {
            const what = t.kind === 'completion' ? 'completion transition' : `transition for event '${t.event}'`;
            issues.push({ ...transitionRef(t.id), message: `State '${t.source.name}' has more than one unguarded ${what}.` });
        }
        alwaysFiring.add(key);
    }
    reportCompletionLoops(transitions, issues);
    // A user event named like a generated timeout event would produce a duplicate enumerator.
    for (const timer of timers) {
        if (userEvents.includes(timer.event)) {
            issues.push({ message: `Event '${timer.event}' clashes with a generated timeout event.` });
        }
    }
    const completion = transitions.some(t => t.kind === 'completion');
    // Under Stateflow semantics the step event always exists (it drives during actions and temporal
    // transitions even when no transition names it) and comes first.
    if (stepEvent !== undefined && isIdentifier(stepEvent)) {
        const at = userEvents.indexOf(stepEvent);
        if (at >= 0) {
            userEvents.splice(at, 1);
        }
        userEvents.unshift(stepEvent);
        if ((d.events?.[stepEvent] ?? '').trim()) {
            issues.push({ message: `The step event '${stepEvent}' cannot have parameters.` });
        }
    }
    const events = [...userEvents, ...timers.map(x => x.event), ...(completion ? [COMPLETION_EVENT] : [])];

    // Hooks (guards / actions) must not collide with each other or generated members.
    // Each hook becomes one abstract method of the generated class, so a name is listed once however often it
    // is used; the lists keep first-use order.
    const branchGuards: string[] = [];
    const branchActions: string[] = [];
    for (const t of transitions) {
        forEachBranch(t.branches, b => {
            if (b.guard) {
                branchGuards.push(b.guard.name);
            }
            branchActions.push(...b.actions);
        });
    }
    const guards = [...new Set([...transitions.filter(t => t.guard).map(t => t.guard!.name), ...branchGuards])];
    // Actions owned by a state: its entry, exit (and during) actions plus the initial-transition actions of its
    // regions. During actions are always empty under UML semantics, so they do not change the list there.
    const stateHooks = (s: MState) => [...s.entry, ...s.exit, ...s.during, ...s.regions.flatMap(r => r.initial?.actions ?? [])];
    const actions = [
        ...new Set([
            ...(rootInitial?.actions ?? []),
            ...ordered.flatMap(stateHooks),
            ...transitions.flatMap(t => t.actions),
            ...branchActions
        ])
    ];
    // A guard returns bool and an action returns void, so one name cannot be both.
    for (const g of guards) {
        if (actions.includes(g)) {
            issues.push({ message: `'${g}' is used both as a guard and as an action.` });
        }
    }
    for (const h of [...guards, ...actions]) {
        if (RESERVED_MEMBERS.has(h) || h === d.name || RESERVED_PREFIX.test(h) || (stateflow && (STATEFLOW_MEMBERS.has(h) || /^During_/.test(h)))) {
            issues.push({ message: `'${h}' clashes with a generated member name.` });
        }
    }

    // Event parameters are passed to the guards and actions of transitions (and choice branches) triggered by that event.
    // Only user events can have parameters; timeouts and completions have none. A declaration for any other
    // event name has no effect and is reported as a warning (an event that no transition uses any more, or a
    // generated event).
    const declared = (e: string) => {
        const text = d.events?.[e];
        return typeof text === 'string' ? text : '';
    };
    const params = new Map<string, Param[]>(events.map(e => [e, userEvents.includes(e) ? parseParams(declared(e), e, issues) : []]));
    for (const e of Object.keys(d.events ?? {})) {
        if (!userEvents.includes(e) && declared(e).trim()) {
            const why = events.includes(e) ? 'is generated and cannot have parameters' : 'is not used by any transition';
            issues.push({ severity: 'warning', message: `Parameters are declared for event '${e}', which ${why}; the declaration is ignored.` });
        }
    }
    // Every hook has a single signature in the generated class, so all its uses must agree on the parameter
    // list. `bind` records the list for a hook and reports a mismatch with an earlier use (compared by the
    // declarations as written).
    const hookParams = new Map<string, Param[]>();
    const bind = (hook: string, list: Param[], where: string) => {
        const previous = hookParams.get(hook);
        if (previous && previous.map(p => p.decl).join(',') !== list.map(p => p.decl).join(',')) {
            issues.push({ message: `'${hook}' is used with different parameter lists (${where}).` });
        }
        hookParams.set(hook, list);
    };
    // Entry, exit and initial actions run outside the context of a single event (and also during Start), so
    // they never receive parameters.
    for (const a of [...(rootInitial?.actions ?? []), ...ordered.flatMap(stateHooks)]) {
        bind(a, [], 'entry/exit/initial actions take no parameters');
    }
    for (const t of transitions) {
        const list = params.get(t.event) ?? [];
        const where = `event '${t.event}'`;
        for (const h of [...(t.guard ? [t.guard.name] : []), ...t.actions]) {
            bind(h, list, where);
        }
        forEachBranch(t.branches, b => [...(b.guard ? [b.guard.name] : []), ...b.actions].forEach(h => bind(h, list, where)));
    }

    // A choice point is only analysed through the transitions that lead into it (its branches are resolved per
    // incoming transition), so one without any incoming transition would go unchecked and has no effect.
    for (const c of d.states.filter(x => x.kind === 'choice')) {
        if (!d.transitions.some(t => t.target === c.id)) {
            issues.push({ ...stateRef(c.id), severity: 'warning', message: 'Choice point has no incoming transition, so it is never used.' });
        }
    }

    // The capacity is validated even when the queue is disabled, so that a bad stored value is noticed.
    const capacity = d.codegen?.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65535) {
        issues.push({ message: 'Queue capacity must be a whole number between 1 and 65535.' });
    }

    // The same problem can be found more than once (e.g. a bad choice branch reached by several incoming
    // transitions, or a hook clash per use); report each message/element pair once.
    const unique = issues.filter((x, i) => issues.findIndex(y => y.message === x.message && y.id === x.id && y.element === x.element) === i);
    if (unique.some(isError) || !rootInitial) {
        return { issues: unique };
    }
    return {
        issues: unique,
        machine: {
            name: d.name,
            namespace: ns,
            states: ordered,
            regions: regionList,
            events,
            transitions,
            initial: rootInitial,
            guards,
            actions,
            params,
            hookParams,
            timers,
            completion,
            semantics: stateflow ? 'stateflow' : 'uml',
            stepEvent,
            temporal: transitions.some(t => t.ticks !== undefined),
            trace: d.codegen?.trace === true,
            threadSafe: d.codegen?.threadSafe === true,
            queue: d.codegen?.queue === true,
            queueCapacity: capacity
        }
    };
}
