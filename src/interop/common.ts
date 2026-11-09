// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Helpers shared by the PlantUML, Mermaid and SCXML converters.
//
// The converters face the same two problems, which are solved here once:
//
//  - Transition labels. MachinaState keeps a transition's event, guard and action in separate fields, while
//    PlantUML (and the text drawn on the canvas) uses the single UML label `event [guard] / action`.
//    `parseLabel` and `formatLabel` convert between the two forms; `splitActions` turns an action text
//    (`a; b, c()`) into a list of hook names, which is how both exporters and importers treat actions
//    (separators inside parentheses or strings, as in `f(a, b)`, do not split an action).
//  - Building a diagram from a foreign file. `DiagramBuilder` creates states and transitions with ids that are
//    unique and safe, state names that do not clash (state names are global in a diagram, even when nested),
//    and the bookkeeping fields every node needs. Imported nodes get x/y/w/h = 0: neither format carries
//    MachinaState's geometry in a usable form, so the import command runs the auto-layout (`autoLayout` in
//    src/layout.ts) on the result before saving it, which assigns positions, sizes and transition bends.
//
// Timeouts are written as `after(<n>ms|s|min)` events in MachinaState (see `parseTimeout` in src/model.ts);
// `timeoutEvent` is the inverse used when a format stores a plain millisecond count.
import { Diagram, StateKind, StateNode, TransitionNode } from '../model';

/** The three parts of a UML transition label; each part is trimmed and empty when absent. */
export interface Label {
    /** Event name, `after(...)` timeout, or empty for a completion transition / choice branch. */
    event: string;
    /** Guard text without the square brackets, e.g. `isReady` or `!isLocked`. */
    guard: string;
    /** Action text after the slash, possibly a list such as `a; b`. */
    action: string;
}

/**
 * Parses a transition label `event [guard] / action` (every part optional).
 *
 * The parts must appear in that order. Text that does not fit the pattern (for example `a [b] c`, with text
 * after the guard that is not introduced by a slash) does not match at all, and the result is then an
 * all-empty label rather than an error, so callers can test `label.event` etc. to decide what to do.
 *
 * @param text Label as written in PlantUML or on the canvas; surrounding whitespace is ignored.
 * @returns The trimmed event, guard (without brackets) and action (without the slash).
 */
export function parseLabel(text: string): Label {
    // ^\s*                 leading whitespace
    // ([^[/]*?)            group 1, event: anything up to the first `[` or `/` (lazy, so the trailing \s* below
    //                      takes the spaces before the guard). An event can therefore never contain `[` or `/`;
    //                      parentheses are fine, which keeps `after(5s)` intact.
    // \s*(?:\[([^\]]*)\])? optional group 2, guard: the text between `[` and the first `]`
    // \s*(?:\/\s*(.*?))?   optional group 3, action: everything after the slash (it may contain anything,
    //                      including `[`, `]` and further slashes)
    // \s*$                 trailing whitespace up to the end
    // `?? []` turns a failed match into an empty array so the three lookups below yield ''.
    const m = /^\s*([^[/]*?)\s*(?:\[([^\]]*)\])?\s*(?:\/\s*(.*?))?\s*$/.exec(text) ?? [];
    return { event: (m[1] ?? '').trim(), guard: (m[2] ?? '').trim(), action: (m[3] ?? '').trim() };
}

/**
 * Formats a transition label `event [guard] / action`, the inverse of `parseLabel`. Empty parts are left out
 * together with their brackets or slash, and the remaining parts are separated by single spaces, so for
 * example ('', 'ok', '') gives `[ok]` and ('', '', 'reset') gives `/ reset`.
 */
export function formatLabel(event: string, guard: string, action: string): string {
    return [event.trim(), guard.trim() ? `[${guard.trim()}]` : '', action.trim() ? `/ ${action.trim()}` : ''].filter(Boolean).join(' ');
}

/**
 * Splits an action list `a; b, c()` into hook names.
 *
 * Semicolons, commas and newlines all separate actions, but only at the top level: inside parentheses,
 * brackets or braces and inside single- or double-quoted strings (where a backslash escapes the next
 * character) they are part of the action, so an action with arguments such as `f(a, b)` or `log("x; y")` stays
 * in one piece. Each entry is trimmed and a trailing empty argument list `()` is removed, so SCXML
 * `<script>a(); b();</script>` and MachinaState `a; b` give the same list. Empty entries (e.g. from a trailing
 * `;`) are dropped. Unbalanced closing brackets are ignored; an unclosed bracket or string runs to the end of
 * the text. (Actions with arguments are kept as written for the analysis to report: hooks take none.)
 *
 * @returns The action names (or calls, as written) in order; an empty array for blank text.
 */
export function splitActions(text: string): string[] {
    const parts: string[] = [];
    let depth = 0; // nesting of (), [] and {}
    let quote = ''; // the open quote character while inside a string literal
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') {
                // An escaped character (e.g. `\"`) cannot end the string; copy both characters.
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
    return (
        parts
            // `\(\s*\)$`: an empty call suffix `()` (optionally with spaces inside) at the end of the entry.
            .map(a => a.trim().replace(/\(\s*\)$/, '').trim())
            .filter(Boolean)
    );
}

/**
 * Children of a diagram node (or the top level for null), in document order.
 *
 * A missing `parent` (undefined) counts as top level, like an explicit null. Regions are returned like any
 * other child, so for a state with regions this gives the regions, not the states inside them.
 *
 * @param id Id of the containing state or region, or null for the top level.
 */
export const childrenOf = (d: Diagram, id: string | null) => d.states.filter(s => (s.parent ?? null) === id);

/**
 * Collects states and transitions for an imported diagram; positions are filled in by the auto-layout.
 *
 * The importers create nodes in the order they meet them in the source file and may patch them afterwards
 * (re-parenting states into a region, changing a forward-referenced state into a final state, and so on);
 * the builder only guarantees unique ids and names and the default fields. Problems that do not stop the
 * import are collected in `warnings` and shown to the user after the import.
 */
export class DiagramBuilder {
    /** The diagram under construction; importers read and modify it directly. */
    readonly diagram: Diagram;
    /** Human-readable notes about input that was skipped or changed during the import. */
    readonly warnings: string[] = [];
    /** Counter for the suffix of clashing ids (shared by all bases, so the suffixes are not consecutive). */
    private ids = 0;

    /**
     * Starts an empty diagram with no namespace and no event parameters.
     * @param name Diagram (state machine class) name.
     */
    constructor(name: string) {
        this.diagram = { name, namespace: '', states: [], transitions: [], events: {} };
    }

    /**
     * An id that no state uses yet, derived from `base`: every non-word character becomes `_` (an empty result
     * becomes `n`), and on a clash `_<counter>` is appended until the id is free.
     */
    private uniqueId(base: string): string {
        const taken = new Set(this.diagram.states.map(s => s.id));
        // `[^\w]`: anything other than a letter, digit or underscore.
        const clean = base.replace(/[^\w]/g, '_') || 'n';
        let id = clean;
        while (taken.has(id)) {
            id = `${clean}_${++this.ids}`;
        }
        return id;
    }

    /**
     * A state name that is not used yet (state names must be unique in a diagram).
     *
     * Only ordinary and final states are considered: pseudostates and regions have names too (`Initial`,
     * `History`, `Choice`, region names) but those are not required to be unique. On a clash a number is
     * appended directly (`Final`, `Final1`, `Final2`, ...). The name is not otherwise sanitised; the analysis
     * reports it if it is not a valid identifier.
     */
    uniqueName(base: string): string {
        const taken = new Set(this.diagram.states.filter(s => s.kind === 'state' || s.kind === 'final').map(s => s.name));
        let name = base;
        for (let i = 1; taken.has(name); i++) {
            name = `${base}${i}`;
        }
        return name;
    }

    /**
     * Adds a state, pseudostate or region and returns it.
     *
     * The id is derived from the name for ordinary and final states and from `<kind>_<name>` for the other
     * kinds (e.g. `initial_Initial`), then made unique. The geometry is zero until the auto-layout runs.
     * Ordinary states get empty `entry` and `exit` fields, as states created in the editor have.
     *
     * @param name Display name; callers pass it through `uniqueName` first where uniqueness matters.
     * @param parent Id of the containing state or region, or null for the top level.
     * @param extra Further fields to set, e.g. `{ deep: true }` for a deep history pseudostate.
     */
    addState(kind: StateKind, name: string, parent: string | null, extra: Partial<StateNode> = {}): StateNode {
        const s: StateNode = { id: this.uniqueId(kind === 'state' || kind === 'final' ? name : `${kind}_${name}`), name, kind, parent, x: 0, y: 0, w: 0, h: 0, ...extra };
        if (kind === 'state') {
            s.entry = s.entry ?? '';
            s.exit = s.exit ?? '';
        }
        this.diagram.states.push(s);
        return s;
    }

    /**
     * Adds a transition between two existing nodes and returns it. Ids are `t0`, `t1`, ... in creation order
     * (the builder never removes transitions, so they stay unique).
     *
     * @param source Id of the source node.
     * @param target Id of the target node (the source itself for self and internal transitions).
     * @param label Event, guard and action; missing parts become empty strings.
     * @param extra Further fields, e.g. `{ internal: true }`.
     */
    addTransition(source: string, target: string, label: Partial<Label> = {}, extra: Partial<TransitionNode> = {}): TransitionNode {
        const t: TransitionNode = {
            id: `t${this.diagram.transitions.length}`,
            source,
            target,
            event: label.event ?? '',
            guard: label.guard ?? '',
            action: label.action ?? '',
            ...extra
        };
        this.diagram.transitions.push(t);
        return t;
    }

    /**
     * Appends an action list to a state's entry or exit actions (or, with `atStart`, puts it in front of them).
     *
     * The result is in normalised form (the existing text split with `splitActions`, then joined with `; `), so
     * a state described on several lines, or with several <onentry> blocks, ends up with one list. Nothing
     * changes when `actions` is empty.
     */
    static appendActions(s: StateNode, field: 'entry' | 'exit', actions: string[], atStart = false): void {
        if (actions.length) {
            const existing = splitActions(s[field] ?? '');
            s[field] = (atStart ? [...actions, ...existing] : [...existing, ...actions]).join('; ');
        }
    }
}

/**
 * What an export to PlantUML, SCXML or Mermaid cannot carry over, as a sentence for the user, or undefined
 * when the export is faithful. Those formats have UML semantics only: a diagram with Stateflow semantics
 * loses its outer-first dispatch, its during actions and its step-counted after(...).
 */
export function exportLimitations(d: Diagram): string | undefined {
    if (d.semantics !== 'stateflow') {
        return undefined;
    }
    const during = d.states.filter(s => (s.during ?? '').trim()).length;
    return `the diagram uses Stateflow semantics, which the export cannot express: it describes UML behaviour (innermost state first, after(...) as timers)${during ? ` and leaves out the during actions of ${during} state(s)` : ''}`;
}

/** The interchange formats MachinaState imports and exports. */
export type InterchangeFormat = 'plantuml' | 'scxml' | 'mermaid';

/**
 * Decides which importer reads a file: by its extension when that is one of the known ones, otherwise by its
 * content (`<` first: XML, so SCXML; `@startuml`: PlantUML; a `stateDiagram` header, possibly after front
 * matter or comments, or a ```mermaid fence: Mermaid). Anything else is tried as PlantUML, whose importer
 * reports what it does not understand.
 *
 * @param fileName The file name or path (only its extension is used).
 * @param text     The file content.
 */
export function detectFormat(fileName: string, text: string): InterchangeFormat {
    // \.(\w+)$: the extension, without the dot.
    const ext = (/\.(\w+)$/.exec(fileName)?.[1] ?? '').toLowerCase();
    if (['puml', 'plantuml', 'pu', 'wsd', 'iuml'].includes(ext)) {
        return 'plantuml';
    }
    if (['mmd', 'mermaid', 'md', 'markdown'].includes(ext)) {
        return 'mermaid';
    }
    if (ext === 'scxml') {
        return 'scxml';
    }
    const start = text.trimStart();
    if (start.startsWith('<')) {
        return 'scxml';
    }
    if (/@startuml/.test(text)) {
        return 'plantuml';
    }
    // ^(---[\s\S]*?---\s*)?(%%[^\n]*\s*)*stateDiagram: optional front matter and comment lines, then the
    // diagram type. ^\s*(`{3,}|~{3,})\s*mermaid: a Markdown fence for Mermaid.
    if (/^(---[\s\S]*?---\s*)?(%%[^\n]*\s*)*stateDiagram/.test(start) || /^\s*(`{3,}|~{3,})\s*mermaid/m.test(text)) {
        return 'mermaid';
    }
    return 'plantuml';
}

/**
 * Formats milliseconds as an `after(...)` timeout, using the largest unit that divides the value exactly:
 * 120000 gives `after(2min)`, 5000 gives `after(5s)` and 1500 gives `after(1500ms)`.
 * `parseTimeout` in src/model.ts reads the result back to the same number of milliseconds.
 */
export const timeoutEvent = (ms: number) => `after(${ms % 60000 === 0 ? `${ms / 60000}min` : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`})`;
