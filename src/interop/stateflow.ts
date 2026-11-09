// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// MATLAB Stateflow import (.slx packages). See the "Stateflow Import" section of docs/manual.tex and the
// design notes in docs/stateflow-import.md.
//
// An .slx file is an OPC (zip) package. Each Stateflow chart is stored in `simulink/stateflow/chart_<id>.xml`
// as a tree of <state>, <junction>, <transition>, <data> and <event> elements whose properties are
// `<P Name="...">value</P>` children. Charts used through a library link live in a different .slx (the
// library), which the caller supplies through `resolveLibrary`; models that only reference a chart (the
// chart block is a library link) are followed to the library.
//
// The result uses Stateflow semantics (`semantics: "stateflow"`, see model.ts): the host dispatches the step
// event once per sample period, outer states see every event first, states have during actions and
// `after(...)` is counted in steps. The step period comes from `periodMs`, else from the sample time of the
// chart's block in the model, else from the model's fixed solver step (resolved through `parameters`).
// Comments are removed from labels: `//` and `/* */`, and for charts in the MATLAB action language `%` and
// `%{ %}`.
//
// Mapping (Stateflow -> MachinaState):
//
//   chart                          diagram (name sanitised to an identifier)
//   OR state, subchart             state (a subchart is only a different view of a composite state)
//   AND (parallel) decomposition   one region per AND state, holding a single state of the same name that
//                                  carries the AND state's actions, transitions and substates
//   box (GROUP_STATE)              flattened: its contents go into the enclosing state
//   graphical / MATLAB function    skipped (the actions that call it become hooks anyway)
//   atomic subchart (library link) the library chart's contents, imported into the state (recursively)
//   parallel chart (top level)     a top-level state `Chart` holding one region per parallel state
//   default transition             initial pseudostate; into a junction: initial -> transient `<State>Start`
//                                  state -> completion transition into the choice point; a junction flow
//                                  chart whose paths all end in terminal junctions (a state without
//                                  substates) becomes conditional entry code of its state instead
//   missing default transition     added when the container has a single substate (Stateflow enters it)
//   connective junction            choice point
//   terminal junction (dead end)   the path becomes an internal transition of its source state
//   history junction               shallow history pseudostate
//   SUPER transition               transition (the SUB segments are only the stubs drawn in each subchart view)
//   event trigger E                event E; `E1 | E2` gives one transition per event
//   send(E, ...) in actions        local event E, raised by the hook with Post(E): the queue is enabled
//   condition-only / empty trigger the step event (default `Step`)
//   after(n, sec|msec|usec)        after(<n>ms|s); a symbolic `n` is looked up in `parameters` (seconds),
//                                  otherwise a 1 s placeholder is used and reported
//   after(n, tick)                 after(<n> steps)
//   [c || after(...)]              split into a `Step [c]` transition and an after(...) transition
//   [expression]                   guard hook `guard<SSID>`, unless it is already a (negated) identifier
//   {cond action} / trans action   action hook `action<SSID>`, unless it is a list of identifiers
//   entry / during / exit code     action hooks `<State>Entry`, `<State>During`, `<State>Exit`
//   data (input, output, ...)      `data` entries (declared in the hook stub)
//
// Every synthesised hook is recorded in `hooks` (and the diagram's `hooks`) with the Stateflow code it
// replaces, so that the hook stub (src/generators/stub.ts) can carry the code over.
import { inflateRawSync } from 'zlib';
import { DataItem, Diagram, FORMAT_VERSION, HookInfo, StateNode } from '../model';
import { DiagramBuilder, splitActions } from './common';
import { parseXml, XmlElement } from './xml';


export interface StateflowImportOptions {
    /** Event that drives condition-only transitions and during actions. Default `Step`. */
    stepEvent?: string;
    /** Step period in milliseconds; default: the sample time of the chart's block, if it can be resolved. */
    periodMs?: number;
    /** Values (in seconds) of symbolic durations used in after(...) operators. */
    parameters?: Record<string, number>;
    /** Returns the content of a Simulink library (`<name>.slx`), or undefined when it cannot be found. */
    resolveLibrary?: (name: string) => Buffer | undefined;
    /** Chart to import when the package contains several (by name). Default: the first one. */
    chart?: string;
}

export interface StateflowImportResult {
    diagram: Diagram;
    warnings: string[];
    /** The same object as `diagram.hooks`. */
    hooks: Record<string, HookInfo>;
    /** Names of all charts found, for a picker. */
    charts: string[];
}

/**
 * Reads numeric parameters from a MATLAB script, such as the one a model's PreLoadFcn runs: every statement
 * `name = <number>;` or `name = <type>(<number>);` (`single`, `double`, `int32`, ...), optionally followed by
 * a `%` comment. Anything computed (`a = b * 2;`), structure fields and non-numeric values are skipped, and a
 * later assignment of the same name wins, as in MATLAB.
 *
 * @returns Parameter name -> value (in the script's own units; durations of `after(n, sec)` are seconds).
 */
export function parseMatlabParameters(text: string): Record<string, number> {
    const result: Record<string, number> = {};
    // ^\s*name\s*=\s*  optional  type(  number  optional )  \s*;   (one statement per line)
    const re = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*(?:(?:single|double|u?int(?:8|16|32|64))[ \t]*\([ \t]*)?([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)[ \t]*\)?[ \t]*;/gm;
    for (const m of text.matchAll(re)) {
        result[m[1]] = Number(m[2]);
    }
    return result;
}

// ---------------------------------------------------------------------------------------------------------
// Zip (OPC package) reading. Only what .slx files use: stored and deflated entries, no zip64, no encryption.
// ---------------------------------------------------------------------------------------------------------

/** Reads every entry of a zip archive into a map from entry name to content. */
export function readZip(buf: Buffer): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    // The End Of Central Directory record is at the end, followed by a comment of at most 64 KiB.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('Not a zip archive (no end of central directory record).');
    }
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) {
            throw new Error('Corrupt zip central directory.');
        }
        const method = buf.readUInt16LE(p + 10);
        const compressed = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;
        if (compressed === 0xffffffff || local === 0xffffffff) {
            throw new Error(`Zip64 entry '${name}' is not supported.`);
        }
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + compressed);
        if (method === 0) {
            files.set(name, data);
        } else if (method === 8) {
            files.set(name, inflateRawSync(data));
        } else {
            throw new Error(`Zip entry '${name}' uses unsupported compression method ${method}.`);
        }
    }
    return files;
}

// ---------------------------------------------------------------------------------------------------------
// Stateflow XML helpers
// ---------------------------------------------------------------------------------------------------------

/** The value of property `<P Name="name">`, or undefined. */
const prop = (e: XmlElement, name: string): string | undefined => e.children.find(c => c.name === 'P' && c.attrs.Name === name)?.text;
/** Child elements of `<Children>`. */
const kids = (e: XmlElement): XmlElement[] => e.children.find(c => c.name === 'Children')?.children ?? [];
const child = (e: XmlElement, name: string) => e.children.find(c => c.name === name);

/** A package (model or library) opened for reading. */
interface Package {
    files: Map<string, Buffer>;
    /** chart name -> chart element. */
    charts: Map<string, XmlElement>;
    /** Simulink block name (path inside the chart, e.g. `Running.Heater`) -> library SourceBlock. */
    references: Map<string, string>;
    /** Library SourceBlock -> the referencing block's sample time as written (a number or a parameter name). */
    sampleTimes: Map<string, string>;
    /** Name of a chart block embedded in the model -> its sample time as written (absent: inherited). */
    chartBlocks: Map<string, string | undefined>;
    /** The model's fixed solver step as written, if the solver is a fixed-step one. */
    fixedStep?: string;
}

/** Fixed-step solvers of Simulink (any other solver is variable-step, which gives no step period). */
const FIXED_STEP_SOLVERS = /^(FixedStep\w*|ode1|ode2|ode3|ode4|ode5|ode8|ode14x|ode1be)$/;

function openPackage(buf: Buffer): Package {
    const files = readZip(buf);
    const charts = new Map<string, XmlElement>();
    const references = new Map<string, string>();
    const sampleTimes = new Map<string, string>();
    const chartBlocks = new Map<string, string | undefined>();
    let fixedStep: string | undefined;
    for (const [name, data] of files) {
        if (/^simulink\/stateflow\/chart_\d+\.xml$/.test(name) || /^stateflow\/chart_\d+\.xml$/.test(name)) {
            const chart = parseXml(data.toString('utf8'));
            charts.set(prop(chart, 'name') ?? name, chart);
        } else if (/^simulink\/systems\/system_\w+\.xml$/.test(name)) {
            const sys = parseXml(data.toString('utf8'));
            for (const block of sys.children.filter(c => c.name === 'Block' && prop(c, 'SFBlockType') === 'Chart')) {
                chartBlocks.set(block.attrs.Name ?? '', prop(block, 'SystemSampleTime') ?? prop(child(block, 'InstanceData') ?? block, 'SystemSampleTime'));
            }
            for (const block of sys.children.filter(c => c.name === 'Block' && c.attrs.BlockType === 'Reference')) {
                const source = prop(block, 'SourceBlock');
                if (source) {
                    references.set(block.attrs.Name ?? '', source);
                    const time = prop(child(block, 'InstanceData') ?? block, 'SystemSampleTime');
                    if (time) {
                        sampleTimes.set(source, time);
                    }
                }
            }
        } else if (/^simulink\/configSet\d+\.xml$/.test(name) && fixedStep === undefined) {
            // The solver settings are nested in the configuration set; only their P elements matter here.
            const text = data.toString('utf8');
            const value = (key: string) => new RegExp(`<P Name="${key}"[^>]*>([^<]*)</P>`).exec(text)?.[1]?.trim();
            const solver = value('SolverName') ?? value('Solver') ?? '';
            if (value('SolverType') === 'Fixed-step' || FIXED_STEP_SOLVERS.test(solver)) {
                fixedStep = value('FixedStep');
            }
        }
    }
    return { files, charts, references, sampleTimes, chartBlocks, fixedStep };
}

// ---------------------------------------------------------------------------------------------------------
// Label parsing
// ---------------------------------------------------------------------------------------------------------

/** A Stateflow transition label `trigger[condition]{conditionAction}/transitionAction`. */
interface SfLabel {
    trigger: string;
    condition: string;
    conditionAction: string;
    transitionAction: string;
}

/** Index just past the bracket that closes the one at `start` (strings and nesting respected). */
function matchBracket(s: string, start: number): number {
    const open = s[start];
    const close = open === '[' ? ']' : open === '{' ? '}' : ')';
    let depth = 0;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
            const end = s.indexOf(ch, i + 1);
            i = end < 0 ? s.length : end;
        } else if (ch === open) {
            depth++;
        } else if (ch === close && --depth === 0) {
            return i + 1;
        }
    }
    return s.length;
}

/**
 * Removes comments: `//` line comments and `/* *\/` block comments, and for the MATLAB action language also
 * `%{ ... %}` block comments and `%` line comments (`%` is the modulo operator in the C action language).
 */
function stripComments(s: string, matlab = false): string {
    const c = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    return matlab ? c.replace(/^[ \t]*%\{[\s\S]*?^[ \t]*%\}[^\n]*/gm, '').replace(/%[^\n]*/g, '') : c;
}

/** Parses a transition label; `matlab` selects the comment syntax of the MATLAB action language. */
export function parseSfLabel(text: string, matlab = false): SfLabel {
    const s = stripComments(text, matlab);
    const r: SfLabel = { trigger: '', condition: '', conditionAction: '', transitionAction: '' };
    let i = 0;
    const skip = () => {
        while (i < s.length && /\s/.test(s[i])) {
            i++;
        }
    };
    skip();
    // Trigger: up to the first top-level `[`, `{` or `/` (parentheses, as in after(5,sec), are skipped over).
    const t0 = i;
    while (i < s.length && !'[{/'.includes(s[i])) {
        i = s[i] === '(' ? matchBracket(s, i) : i + 1;
    }
    r.trigger = s.slice(t0, i).trim();
    skip();
    if (s[i] === '[') {
        const end = matchBracket(s, i);
        r.condition = s.slice(i + 1, end - 1).trim();
        i = end;
        skip();
    }
    if (s[i] === '{') {
        const end = matchBracket(s, i);
        r.conditionAction = s.slice(i + 1, end - 1).trim();
        i = end;
        skip();
    }
    if (s[i] === '/') {
        let rest = s.slice(i + 1).trim();
        if (rest.startsWith('{') && matchBracket(rest, 0) === rest.length) {
            rest = rest.slice(1, -1).trim();
        }
        r.transitionAction = rest;
    }
    return r;
}

/** The sections of a state label: name plus entry/during/exit code (and `on` handlers, unsupported). */
interface SfStateLabel {
    name: string;
    entry: string;
    during: string;
    exit: string;
    /** `on <event>:` and `bind:` sections, which have no MachinaState equivalent. */
    other: string[];
}

/** Parses a state label; `matlab` selects the comment syntax of the MATLAB action language. */
export function parseSfStateLabel(text: string, matlab = false): SfStateLabel {
    const s = stripComments(text, matlab);
    // The name is the first token; it may be followed by `/` and an implicit entry action.
    const m = /^\s*([A-Za-z_]\w*)\s*\/?/.exec(s);
    const r: SfStateLabel = { name: m?.[1] ?? '', entry: '', during: '', exit: '', other: [] };
    let body = s.slice(m ? m[0].length : 0);
    // Section keywords, possibly combined (`en, du:`), at the start of a line or after the name.
    const kw = /(^|\n)\s*((?:entry|en|during|du|exit|ex|bind|on\s+[^:\n]+)(?:\s*,\s*(?:entry|en|during|du|exit|ex))*)\s*:/g;
    const marks: { at: number; end: number; keys: string[] }[] = [];
    for (let k; (k = kw.exec(body)); ) {
        marks.push({ at: k.index, end: k.index + k[0].length, keys: k[2].split(',').map(x => x.trim()) });
    }
    // Text before the first keyword is an implicit entry action.
    const implicit = body.slice(0, marks[0]?.at ?? body.length).trim();
    if (implicit) {
        r.entry += implicit + '\n';
    }
    marks.forEach((mk, n) => {
        const code = body.slice(mk.end, marks[n + 1]?.at ?? body.length).trim();
        for (const key of mk.keys) {
            if (key === 'entry' || key === 'en') {
                r.entry += code + '\n';
            } else if (key === 'during' || key === 'du') {
                r.during += code + '\n';
            } else if (key === 'exit' || key === 'ex') {
                r.exit += code + '\n';
            } else {
                r.other.push(`${key}: ${code}`);
            }
        }
    });
    r.entry = r.entry.trim();
    r.during = r.during.trim();
    r.exit = r.exit.trim();
    return r;
}

/** Splits an expression at top-level `||`. */
function splitOr(expr: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if ('([{'.includes(ch)) {
            depth++;
        } else if (')]}'.includes(ch)) {
            depth--;
        } else if (depth === 0 && ch === '|' && expr[i + 1] === '|') {
            parts.push(cur);
            cur = '';
            i++;
            continue;
        }
        cur += ch;
    }
    parts.push(cur);
    return parts.map(p => p.trim()).filter(Boolean);
}

/** Removes redundant outer parentheses. */
function unparen(e: string): string {
    let s = e.trim();
    while (s.startsWith('(') && matchBracket(s, 0) === s.length) {
        s = s.slice(1, -1).trim();
    }
    return s;
}

const IDENT = /^[A-Za-z_]\w*$/;
/** after(n, sec|msec|usec) -> [n, unit] */
const AFTER = /^after\s*\(\s*([^,]+?)\s*,\s*(sec|msec|usec|tick)\s*\)$/;

/**
 * Terminal junctions: a Stateflow path that ends in a junction without outgoing transitions runs its
 * condition actions and leaves the source state active (a flow chart inside a state). MachinaState choice
 * branches must end in a state, so every such path is removed from its choice tree and becomes an internal
 * transition of the source state instead, with the conjunction of the path's guards and its actions. It is
 * placed right after the transition it came from, so it is tried when no complete path of that transition is
 * enabled (an `[else]` into a dead end therefore keeps its meaning). Approximation: a dead-end branch that is
 * not last among its siblings is now tried after them rather than before.
 */
function rewriteDeadEnds(b: DiagramBuilder, hooks: Record<string, HookInfo>, warnings: string[], transients: Set<string>, matlab: boolean): void {
    const d = b.diagram;
    const kind = new Map(d.states.map(s => [s.id, s.kind]));
    const out = (id: string) => d.transitions.filter(t => t.source === id);
    const dead = new Set(d.states.filter(s => s.kind === 'choice' && out(s.id).length === 0).map(s => s.id));
    if (!dead.size) {
        return;
    }
    /** Code of a guard for combining: the hook's code, or the identifier itself. */
    const code = (g: string) => (hooks[g.replace(/^!/, '')] ? `${g.startsWith('!') ? '!' : ''}(${hooks[g.replace(/^!/, '')].code})` : g);
    // A transient `<State>Start` state whose flow chart only ends in terminal junctions: the flow chart runs
    // once, when the owner is entered, and leaves no substate active. It becomes conditional entry code of the
    // owner (in the chart's action language) and the transient state disappears.
    const flowCode = (choice: string, seen: Set<string>): string[] | undefined => {
        if (dead.has(choice)) {
            return [];
        }
        if (kind.get(choice) !== 'choice' || seen.has(choice)) {
            return undefined;
        }
        const branches = out(choice);
        const ordered = [...branches.filter(x => x.guard), ...branches.filter(x => !x.guard)];
        const body = (br: (typeof branches)[number]): string[] | undefined => {
            const next = flowCode(br.target, new Set([...seen, choice]));
            const actions = (br.action ?? '').split(/;\s*/).filter(Boolean).map(a => hooks[a]?.code ?? `${a}();`);
            return next && [...actions.flatMap(a => a.split('\n')), ...next];
        };
        if (ordered.length === 1 && !ordered[0].guard) {
            return body(ordered[0]);
        }
        const lines: string[] = [];
        for (let i = 0; i < ordered.length; i++) {
            const br = ordered[i];
            const inner = body(br);
            if (!inner) {
                return undefined;
            }
            const g = br.guard ? code(br.guard).replace(/^!/, matlab ? '~' : '!') : '';
            const head = !br.guard ? (matlab ? 'else' : '} else {') : matlab ? `${i ? 'elseif' : 'if'} ${g}` : `${i ? '} else if' : 'if'} (${g}) {`;
            // The C form opens each later branch on the closing line of the previous one (`} else if (...) {`).
            lines.push(head, ...inner.map(l => `    ${l}`));
        }
        lines.push(matlab ? 'end' : '}');
        return lines;
    };
    for (const t of [...d.transitions].filter(t => transients.has(t.source) && kind.get(t.target) === 'choice')) {
        const lines = flowCode(t.target, new Set());
        const transient = d.states.find(s => s.id === t.source)!;
        const owner = d.states.find(s => s.id === transient.parent && s.kind === 'state');
        if (!lines || !owner) {
            continue;
        }
        const init = d.transitions.find(x => x.target === transient.id && kind.get(x.source) === 'initial')!;
        const before = (init.action ?? '').split(/;\s*/).filter(Boolean).map(a => hooks[a]?.code ?? `${a}();`);
        const name = `${owner.name}EntryFlow`;
        hooks[name] = { code: [...before, ...lines].join('\n'), origin: `default flow chart of state ${owner.name}` };
        owner.entry = [owner.entry, name].filter(Boolean).join('; ');
        d.transitions = d.transitions.filter(x => x !== t && x !== init);
        d.states = d.states.filter(s => s !== transient && s.id !== init.source);
        warnings.push(`the default flow chart of '${owner.name}' became entry code (hook ${name})`);
    }
    const replacements = new Map<string, typeof d.transitions>();
    for (const t of d.transitions.filter(t => kind.get(t.source) === 'state' && kind.get(t.target) === 'choice' && d.states.some(s => s.id === t.source))) {
        const paths: { guards: string[]; actions: string[]; ids: string[] }[] = [];
        const dfs = (node: string, guards: string[], actions: string[], ids: string[], seen: Set<string>) => {
            if (dead.has(node)) {
                paths.push({ guards, actions, ids });
                return;
            }
            if (kind.get(node) !== 'choice' || seen.has(node)) {
                return;
            }
            for (const br of out(node)) {
                dfs(br.target, [...guards, ...(br.guard ? [br.guard] : [])], [...actions, ...(br.action ? [br.action] : [])], [...ids, br.id], new Set([...seen, node]));
            }
        };
        dfs(t.target, t.guard ? [t.guard] : [], t.action ? [t.action] : [], [t.id], new Set());
        replacements.set(
            t.id,
            paths.map(p => {
                const name = `guard_${p.ids.join('_')}`;
                const guard = p.guards.length <= 1 ? p.guards[0] ?? '' : name;
                if (p.guards.length > 1) {
                    hooks[name] = { code: p.guards.map(code).join(' && '), origin: `path ${p.ids.join(' -> ')} into a terminal junction` };
                }
                return { id: `${t.id}_${p.ids.length}`, source: t.source, target: t.source, event: t.event, guard, action: p.actions.join('; '), internal: true };
            })
        );
    }
    // Cut the dead ends (and choices that only led into dead ends) out of the choice graph.
    const original = [...d.transitions];
    let removed = true;
    while (removed) {
        removed = false;
        for (const t of [...d.transitions]) {
            if (dead.has(t.target)) {
                d.transitions.splice(d.transitions.indexOf(t), 1);
                removed = true;
                if (kind.get(t.source) === 'choice' && out(t.source).length === 0) {
                    dead.add(t.source);
                }
            }
        }
    }
    d.states = d.states.filter(s => !dead.has(s.id));
    // Insert each internal transition right after its origin (in its place, if nothing of the origin survived).
    const kept = new Set(d.transitions);
    const result = original.flatMap(t => [...(kept.has(t) ? [t] : []), ...(replacements.get(t.id) ?? [])]);
    const n = result.length - d.transitions.length;
    d.transitions = result;
    d.transitions.forEach((t, i) => (t.id = `t${i}`));
    if (n > 0) {
        warnings.push(`${n} path(s) into terminal junctions became internal transitions of their source state`);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------------------

/**
 * Imports a Stateflow chart from an .slx/.sfx package.
 * @throws Error when the file is not a zip package or contains no chart (directly or through library links).
 */
export function importStateflow(slx: Buffer, options: StateflowImportOptions = {}): StateflowImportResult {
    const step = options.stepEvent ?? 'Step';
    const warnings: string[] = [];
    const hooks: Record<string, HookInfo> = {};
    const data: DataItem[] = [];
    const pkg = openPackage(slx);
    let chartPkg = pkg;
    let sampleTime: string | undefined;

    // A model that only references a chart from a library (a common way to share charts) has no chart of its own:
    // follow the Reference blocks whose library contains charts.
    if (pkg.charts.size === 0) {
        for (const source of pkg.references.values()) {
            const lib = source.split('/')[0];
            const buf = options.resolveLibrary?.(lib);
            if (!buf) {
                warnings.push(`library '${lib}' (block ${source}) not found`);
                continue;
            }
            const libPkg = openPackage(buf);
            if (libPkg.charts.size) {
                chartPkg = libPkg;
                sampleTime = pkg.sampleTimes.get(source);
                break;
            }
        }
    }
    const names = [...chartPkg.charts.keys()];
    if (!names.length) {
        throw new Error('No Stateflow chart found in the package or in the libraries it references.');
    }
    const chartName = options.chart && chartPkg.charts.has(options.chart) ? options.chart : names[0];
    const chart = chartPkg.charts.get(chartName)!;

    const b = new DiagramBuilder(chartName.replace(/\W/g, '') || 'StateMachine');
    const d = b.diagram;
    const matlab = prop(chart, 'actionLanguage') === '2';
    if (matlab) {
        warnings.push('the chart uses the MATLAB action language; hook code is MATLAB, not C');
    }

    /** True when `code` is just a list of argument-less calls/identifiers, so it can stay as hook names. */
    const plainActions = (code: string) => splitActions(code).every(a => IDENT.test(a)) && !/[=+\-*]/.test(code.replace(/\(\s*\)/g, ''));
    const actionHook = (code: string, name: string, origin: string): string => {
        const c = code.trim();
        if (!c) {
            return '';
        }
        if (plainActions(c)) {
            return splitActions(c).join('; ');
        }
        hooks[name] = { code: c, origin };
        return name;
    };
    const guardHook = (expr: string, name: string, origin: string): string => {
        const e = unparen(expr);
        if (!e) {
            return '';
        }
        const neg = /^!\s*([A-Za-z_]\w*)$/.exec(e);
        if (IDENT.test(e) || neg) {
            return neg ? `!${neg[1]}` : e;
        }
        hooks[name] = { code: e, origin };
        return name;
    };
    /** A number literal, or the value of a known parameter; undefined otherwise. */
    const valueOf = (n: string): number | undefined => (/^[\d.]+(e[-+]?\d+)?$/i.test(n.trim()) ? Number(n) : options.parameters?.[n.trim()]);
    /**
     * The MachinaState event for `after(n, unit)`: `after(<n> steps)` for ticks, otherwise a time in ms or s.
     * An unresolvable `n` is reported and replaced by a 1 s (or 1 step) placeholder.
     */
    const afterEvent = (n: string, unit: string, where: string): string => {
        const v = valueOf(n);
        if (v === undefined) {
            warnings.push(`${where}: duration '${n}' is a parameter with no known value; using a 1 ${unit === 'tick' ? 'step' : 's'} placeholder`);
        }
        if (unit === 'tick') {
            return `after(${Math.max(1, Math.round(v ?? 1))} steps)`;
        }
        usesTime = true;
        const scale = unit === 'msec' ? 1e-3 : unit === 'usec' ? 1e-6 : 1;
        const ms = Math.max(1, Math.round((v === undefined ? 1 : v * scale) * 1000));
        return ms % 1000 === 0 ? `after(${ms / 1000}s)` : `after(${ms}ms)`;
    };
    // The step period: given; else the sample time of the chart's block (a referencing library block, or the
    // chart block embedded in the model), a number of seconds or a parameter, where -1 means inherited; else
    // the model's fixed solver step.
    sampleTime ??= pkg.chartBlocks.get(chartName);
    const seconds = (text: string | undefined) => {
        const v = text === undefined ? undefined : valueOf(/^\[\s*([^\s,\]]+)/.exec(text.trim())?.[1] ?? text);
        return v !== undefined && v > 0 ? v : undefined;
    };
    const sampleSeconds = seconds(sampleTime) ?? seconds(pkg.fixedStep);
    const periodMs = options.periodMs ?? (sampleSeconds !== undefined ? Math.round(sampleSeconds * 1e6) / 1e3 : undefined);
    let usesTime = false;

    // Stateflow names are unique among siblings only; MachinaState state names are global. Count them first
    // and qualify the duplicates with their parent's name.
    const nameCount = new Map<string, number>();
    const countNames = (e: XmlElement) => {
        for (const k of kids(e).filter(k => k.name === 'state')) {
            const n = parseSfStateLabel(prop(k, 'labelString') ?? '', matlab).name;
            nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
            countNames(k);
        }
    };
    countNames(chart);

    /** SSID -> created node (states, junctions); SSID -> the Stateflow element for every state. */
    const bySsid = new Map<string, StateNode>();
    const parentOf = new Map<string, string | null>(); // SSID -> parent state SSID (null = chart)
    /** Transitions to create once every node exists, with the container they were found in. */
    const pending: { t: XmlElement; container: string | null; ns: string }[] = [];
    const visitedLibs = new Set<string>();

    /**
     * Walks the children of a chart or state element.
     * @param container   MachinaState id of the enclosing state or region (null = top level).
     * @param ownerSsid   Stateflow SSID of the enclosing state (null = chart), for ancestry checks.
     * @param ownerName   Name of the enclosing state, for qualifying duplicate names.
     * @param path        Simulink block path of the enclosing state, for atomic subcharts.
     * @param ns          Prefix that keeps SSIDs of an imported library chart apart from the outer chart's.
     */
    const walk = (el: XmlElement, container: string | null, ownerSsid: string | null, ownerName: string, path: string, ns: string, owning: Package) => {
        const isParallel = /SET_(STATE|CHART)/.test(prop(el, 'decomposition') ?? '');
        for (const k of kids(el)) {
            const ssid = ns + (k.attrs.SSID ?? '');
            if (k.name === 'state') {
                const type = prop(k, 'type') ?? 'OR_STATE';
                const label = parseSfStateLabel(prop(k, 'labelString') ?? '', matlab);
                if (type === 'FUNC_STATE') {
                    warnings.push(`function '${label.name}' skipped (functions are called from hook code)`);
                    continue;
                }
                if (type === 'GROUP_STATE') {
                    // A box is not a state: its contents belong to the enclosing state.
                    warnings.push(`box '${label.name}' flattened into its parent`);
                    walk(k, container, ownerSsid, ownerName, path, ns, owning);
                    continue;
                }
                // A parallel (AND) state becomes a region holding one state of the same name, which carries the
                // AND state's actions, transitions and substates (regions themselves can have none of these).
                let into = container;
                if (isParallel || type === 'AND_STATE') {
                    into = b.addState('region', label.name, container).id;
                }
                const name = b.uniqueName((nameCount.get(label.name) ?? 0) > 1 && ownerName ? `${ownerName}_${label.name}` : label.name);
                const s = b.addState('state', name, into);
                if (into !== container) {
                    b.addTransition(b.addState('initial', 'Initial', into).id, s.id);
                }
                bySsid.set(ssid, s);
                parentOf.set(ssid, ownerSsid);
                s.entry = actionHook(label.entry, `${name}Entry`, `state ${name} entry`);
                s.exit = actionHook(label.exit, `${name}Exit`, `state ${name} exit`);
                if (label.during) {
                    s.during = actionHook(label.during, `${name}During`, `state ${name} during`);
                }
                for (const o of label.other) {
                    warnings.push(`state '${name}': '${o.split('\n')[0]}' section is not supported and was dropped`);
                }
                const blockPath = `${path}${path ? '.' : ''}${label.name}`;
                const sim = child(k, 'simulink');
                if (sim && prop(sim, 'isComponent') === '1') {
                    // Atomic subchart: the contents are in a library chart.
                    const source = owning.references.get(prop(sim, 'blockName') ?? blockPath);
                    const lib = source?.split('/')[0];
                    const buf = lib && !visitedLibs.has(lib) ? options.resolveLibrary?.(lib) : undefined;
                    const libPkg = buf ? openPackage(buf) : undefined;
                    const libChart = libPkg?.charts.values().next().value as XmlElement | undefined;
                    if (!libChart) {
                        warnings.push(`atomic subchart '${name}': library '${lib ?? '?'}' not found; imported as an empty state`);
                    } else {
                        visitedLibs.add(lib!);
                        walk(libChart, s.id, ssid, name, '', `${ssid}/`, libPkg!);
                        visitedLibs.delete(lib!);
                    }
                } else {
                    walk(k, s.id, ssid, name, blockPath, ns, owning);
                }
            } else if (k.name === 'data') {
                const scope = { INPUT_DATA: 'input', OUTPUT_DATA: 'output', LOCAL_DATA: 'local', PARAMETER_DATA: 'parameter', CONSTANT_DATA: 'constant' }[prop(k, 'scope') ?? ''];
                const name = k.attrs.name;
                if (scope && name && !data.some(x => x.name === name && x.scope === scope)) {
                    // `-1` means an inherited size and `1` a scalar; neither is an array size.
                    const raw = prop(child(child(k, 'props') ?? k, 'array') ?? k, 'size')?.trim();
                    const size = raw && raw !== '-1' && raw !== '1' ? raw : undefined;
                    data.push({ name, scope, type: prop(k, 'dataType') ?? 'double', ...(size ? { size } : {}) });
                }
            } else if (k.name === 'event') {
                // Stateflow events (input or local, at any level) become MachinaState events.
                const name = k.attrs.name ?? prop(k, 'name');
                if (name && IDENT.test(name)) {
                    d.events![name] = '';
                }
            } else if (k.name === 'junction') {
                const type = prop(k, 'type');
                const j = type === 'HISTORY_JUNCTION' ? b.addState('history', 'History', container) : b.addState('choice', 'Choice', container);
                bySsid.set(ssid, j);
                parentOf.set(ssid, ownerSsid);
            } else if (k.name === 'transition') {
                // SUB transitions are the stubs drawn inside each subchart view; the SUPER one is the real transition.
                if (prop(k, 'type') !== 'SUB') {
                    pending.push({ t: k, container, ns });
                }
            }
        }
    };
    // A chart with parallel decomposition has no state around its parallel states, but MachinaState regions
    // must be inside one: a top-level state `Chart` holds them.
    let top: string | null = null;
    if (/SET_CHART/.test(prop(chart, 'decomposition') ?? '')) {
        const wrapper = b.addState('state', b.uniqueName('Chart'), null);
        b.addTransition(b.addState('initial', 'Initial', null).id, wrapper.id);
        top = wrapper.id;
    }
    walk(chart, top, null, '', '', '', chartPkg);

    const isAncestor = (anc: string, ssid: string): boolean => {
        for (let p = parentOf.get(ssid); p; p = parentOf.get(p) ?? null) {
            if (p === anc) {
                return true;
            }
        }
        return false;
    };

    // Transitions, in execution order within each source (MachinaState uses diagram order for priority).
    // Stateflow tries a state's inner transitions (into its own substates or junctions) after its outer ones.
    const order = (t: XmlElement) => Number(prop(t, 'executionOrder') ?? 0);
    const endpoint = (p: (typeof pending)[number], end: 'src' | 'dst') => {
        const ssid = prop(child(p.t, end) ?? p.t, 'SSID');
        return ssid ? p.ns + ssid : undefined;
    };
    const inner = (p: (typeof pending)[number]) => {
        const src = endpoint(p, 'src');
        const dst = endpoint(p, 'dst');
        return src && dst && bySsid.get(src)?.kind === 'state' && isAncestor(src, dst) ? 1 : 0;
    };
    pending.sort((a, b2) => inner(a) - inner(b2) || order(a.t) - order(b2.t));
    let conditionActionOnBranch = 0;
    const transients = new Set<string>();
    for (const p of pending) {
        const ns = p.ns;
        const id = p.t.attrs.SSID ?? '?';
        const srcSsid = prop(child(p.t, 'src') ?? p.t, 'SSID');
        const dstSsid = prop(child(p.t, 'dst') ?? p.t, 'SSID');
        const dst = dstSsid ? bySsid.get(ns + dstSsid) : undefined;
        if (!dst) {
            warnings.push(`transition ${id}: destination not imported; dropped`);
            continue;
        }
        const label = parseSfLabel(prop(p.t, 'labelString') ?? '', matlab);
        const code = [label.conditionAction, label.transitionAction].filter(Boolean).join('\n');
        const action = actionHook(code, `action${id}`, `transition ${id}`);

        if (!srcSsid) {
            // Default transition.
            if (label.condition || label.trigger) {
                warnings.push(`default transition ${id}: trigger/condition dropped`);
            }
            const init = b.addState('initial', 'Initial', p.container);
            if (dst.kind === 'choice') {
                // MachinaState initial transitions must end in a state: enter a transient state whose completion
                // transition (taken at once, in the same step) continues into the junction.
                const owner = d.states.find(s => s.id === p.container);
                const transient = b.addState('state', b.uniqueName(`${owner?.name ?? d.name}Start`), p.container);
                transients.add(transient.id);
                b.addTransition(init.id, transient.id, { action });
                b.addTransition(transient.id, dst.id);
            } else {
                b.addTransition(init.id, dst.id, { action });
            }
            continue;
        }
        const src = bySsid.get(ns + srcSsid);
        if (!src) {
            warnings.push(`transition ${id}: source not imported; dropped`);
            continue;
        }
        if (src.kind === 'state' && dst.kind === 'state' && isAncestor(ns + srcSsid, ns + dstSsid!)) {
            warnings.push(`inner transition ${id} ('${src.name}' to its own substate) is imported as an external transition, which exits '${src.name}'`);
        }
        if (src.kind === 'choice') {
            // Junction branch: only a condition.
            if (label.trigger) {
                warnings.push(`transition ${id}: trigger '${label.trigger}' on a junction branch dropped`);
            }
            if (label.conditionAction) {
                conditionActionOnBranch++;
            }
            if (AFTER.test(unparen(label.condition))) {
                warnings.push(`transition ${id}: after() on a junction branch kept as a guard hook`);
            }
            b.addTransition(src.id, dst.id, { guard: guardHook(label.condition, `guard${id}`, `transition ${id}`), action });
            continue;
        }

        // Transition from a state. Several events (`E1 | E2`) give one transition per event.
        let trigger = label.trigger;
        let triggers = [trigger];
        const triggerAfter = AFTER.exec(trigger);
        if (triggerAfter) {
            trigger = afterEvent(triggerAfter[1], triggerAfter[2], `transition ${id}`);
            triggers = [trigger];
        } else if (trigger && !IDENT.test(trigger)) {
            const events = trigger.split(/\s*\|\|?\s*/);
            if (events.every(e => IDENT.test(e))) {
                triggers = events;
            } else {
                warnings.push(`transition ${id}: trigger '${trigger}' is not supported (only events, E1 | E2 and after()); kept as written`);
            }
        }
        // Split `c1 || after(n,sec) || c2` into one timeout transition per after() term and one guarded rest.
        const terms = label.condition ? splitOr(unparen(label.condition)) : [];
        const temporal = trigger ? [] : terms.map(unparen).filter(t => AFTER.test(t));
        const rest = terms.filter(t => !temporal.includes(unparen(t)));
        for (const tt of temporal) {
            const m = AFTER.exec(tt)!;
            b.addTransition(src.id, dst.id, { event: afterEvent(m[1], m[2], `transition ${id}`), action });
        }
        if (!temporal.length || rest.length) {
            const guard = rest.length ? guardHook(rest.join(' || '), `guard${id}`, `transition ${id}`) : '';
            for (const e of triggers) {
                b.addTransition(src.id, dst.id, { event: e || step, guard, action });
            }
        }
    }
    rewriteDeadEnds(b, hooks, warnings, transients, matlab);

    // Stateflow enters a lone substate without a default transition (common in atomic subchart libraries,
    // whose content is wrapped in one state); MachinaState needs an explicit initial pseudostate.
    const containers = new Set<string | null>([null, ...d.states.filter(s => s.kind === 'state' || s.kind === 'region').map(s => s.id)]);
    for (const c of containers) {
        const inside = d.states.filter(s => (s.parent ?? null) === c);
        const real = inside.filter(s => s.kind === 'state' || s.kind === 'final');
        if (real.length && !inside.some(s => s.kind === 'initial') && !inside.some(s => s.kind === 'region')) {
            if (real.length === 1) {
                b.addTransition(b.addState('initial', 'Initial', c).id, real[0].id);
            } else {
                warnings.push(`'${d.states.find(s => s.id === c)?.name ?? d.name}' has no default transition`);
            }
        }
    }
    const routed = d.states.filter(s => transients.has(s.id)).length;
    if (routed) {
        warnings.push(`${routed} default transition(s) into junctions were routed through a transient '<State>Start' state`);
    }
    if (periodMs === undefined && usesTime) {
        warnings.push(`the step period is unknown${sampleTime ? ` (sample time '${sampleTime}' could not be resolved)` : ''}; set it in the diagram settings so that after() can be counted in steps`);
    }
    // Stateflow actions raise local events with send(); in MachinaState a hook does that with Post, which
    // needs the event queue.
    if (Object.values(hooks).some(h => /\bsend\s*\(/.test(h.code))) {
        d.codegen = { ...(d.codegen ?? {}), queue: true };
        warnings.push('actions raise events with send(): the event queue is enabled; implement send(E, ...) in the hooks with Post(E), which handles E after the current event instead of at once, and offers it to the whole machine rather than only to the state send() names');
    }
    if (conditionActionOnBranch) {
        warnings.push(`${conditionActionOnBranch} junction branch(es) have condition actions; they now run after the path is chosen, not while it is tested`);
    }
    const diagram: Diagram = {
        formatVersion: FORMAT_VERSION,
        semantics: 'stateflow',
        step: { event: step, ...(periodMs !== undefined ? { periodMs } : {}) },
        ...d,
        hooks,
        data
    };
    return { diagram, warnings, hooks, charts: names };
}
