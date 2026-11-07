// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// PlantUML state diagram export and import.
// Export writes declarations (with entry/exit actions and internal transitions) in nested blocks and
// all other transitions at the top level. Import reads the common subset of the PlantUML state syntax.
//
// Mapping between MachinaState and PlantUML (as written by the exporter and understood by the importer):
//
//   diagram name              `@startuml <name>`
//   namespace                 `' @namespace <ns>` (a PlantUML comment, so PlantUML ignores it)
//   event parameters          `' @event <Event>(<params>)`, one comment per event with parameters
//   state                     `state <Name>`; `state <Name> { ... }` when it has substates
//   entry / exit actions      `<Name> : entry / a; b` and `<Name> : exit / c`
//   internal transition       `<Name> : event [guard] / action` (a line of the state's description); one with
//                             neither guard nor action is written `<Name> : event /`, so that the slash tells
//                             it apart from a free-text description
//   final state               `state <Name> <<end>>`; on import `--> [*]` also creates one (`Final`, `Final1`)
//   initial pseudostate       `[*] --> <Target>`, with the action as `: / action`, inside the container's block
//   history pseudostate       `<Owner>[H]` / `<Owner>[H*]` (shallow / deep) as a transition target; it is not
//                             declared. Import also accepts `state X <<history>>` / `<<history*>>`.
//   choice point              `state <Alias> <<choice>>`; branches without a guard get `[else]`
//   orthogonal regions        the region contents in the state's block, separated by `--` (import also
//                             accepts `||`), each preceded by `' @region <Name>` (for every region but the
//                             first, the comment follows the `--` that starts the region); on import the comment
//                             names the region it is in
//   transition                `<Source> --> <Target> : event [guard] / action`
//
// Not represented (lost on a round trip): positions, sizes, colours and transition bends, the code generation
// options and recorded scenarios. On import every node is created at 0,0 with no size; the import command
// runs the auto-layout before saving the diagram. Further import limitations are described at
// `importPlantUml`.
import { Diagram, StateNode } from '../model';
import { childrenOf, DiagramBuilder, formatLabel, parseLabel, splitActions } from './common';

/**
 * Converts a diagram to PlantUML state diagram text (`@startuml` ... `@enduml`, with a trailing newline).
 *
 * The output has two parts. First a recursive walk (`emit`) writes the containment structure: one
 * declaration per state, choice point and final state in its container's block, followed by the state's
 * entry/exit lines and internal transitions, then the container's initial transitions. Then every other
 * transition is written at the top level, which works because PlantUML state names are global: a nested
 * state can be referenced from anywhere once it has been declared in its block.
 *
 * State and final state names are written unquoted; they are valid identifiers in a diagram that passes the
 * analysis.
 */
export function exportPlantUml(d: Diagram): string {
    const lines = [`@startuml ${d.name}`];
    // MachinaState-specific information that PlantUML has no syntax for travels in magic comments.
    if (d.namespace) {
        lines.push(`' @namespace ${d.namespace}`);
    }
    for (const [event, params] of Object.entries(d.events ?? {})) {
        if (params.trim()) {
            lines.push(`' @event ${event}(${params.trim()})`);
        }
    }
    const byId = new Map(d.states.map(s => [s.id, s]));
    // PlantUML identifiers: state names, and unique aliases for pseudostates that need a declaration.
    // Ordinary and final states use their (already unique) names. Choice points are declared as named
    // `<<choice>>` states, so they need a name that is a valid identifier and does not clash with any state or
    // other choice point: the choice's name with non-word characters removed (or `Choice`), plus a number if
    // taken. Initial and history pseudostates and regions get no alias: they are written as `[*]`, `X[H]` and
    // `--` separators instead.
    const alias = new Map<string, string>();
    const used = new Set(d.states.filter(s => s.kind === 'state' || s.kind === 'final').map(s => s.name));
    for (const s of d.states) {
        if (s.kind === 'state' || s.kind === 'final') {
            alias.set(s.id, s.name);
        } else if (s.kind === 'choice') {
            // `\W`: any non-word character (PlantUML names here are plain identifiers).
            let name = s.name.replace(/\W/g, '') || 'Choice';
            for (let i = 1; used.has(name); i++) {
                name = `${s.name.replace(/\W/g, '') || 'Choice'}${i}`;
            }
            used.add(name);
            alias.set(s.id, name);
        }
    }
    /** The state that contains `s`, skipping regions (undefined at the top level). */
    const owner = (s: StateNode) => {
        // History pseudostates and initial transitions belong to the state that owns their region.
        let p = s.parent ? byId.get(s.parent) : undefined;
        while (p && p.kind === 'region') {
            p = p.parent ? byId.get(p.parent) : undefined;
        }
        return p;
    };
    /**
     * How a node is referenced in a transition: `[*]` for an initial pseudostate, `Owner[H]` / `Owner[H*]` for
     * a history pseudostate (`[H]` alone at the top level), otherwise the alias.
     */
    const ref = (s: StateNode): string => {
        if (s.kind === 'history') {
            const o = owner(s);
            return `${o ? alias.get(o.id) : ''}[${s.deep ? 'H*' : 'H'}]`;
        }
        return s.kind === 'initial' ? '[*]' : alias.get(s.id)!;
    };
    // Internal transitions are written as description lines of their state, not as arrows. The flag only
    // counts on self transitions, as in the rest of MachinaState.
    const isInternal = (t: { internal?: boolean; source: string; target: string }) => t.internal === true && t.source === t.target;

    /**
     * Writes the contents of one container (a state, a region, or the top level for null), indented by
     * `indent`, recursing into composite states.
     */
    const emit = (parent: string | null, indent: string) => {
        const kids = childrenOf(d, parent);
        const regions = kids.filter(k => k.kind === 'region');
        if (regions.length) {
            // Orthogonal state: write each region's contents in turn, separated by `--`, and keep the region
            // names in `' @region` comments. Other children of a state with regions are not written.
            regions.forEach((r, i) => {
                if (i > 0) {
                    lines.push(`${indent}--`);
                }
                lines.push(`${indent}' @region ${r.name}`);
                emit(r.id, indent);
            });
            return;
        }
        for (const k of kids) {
            const name = alias.get(k.id);
            if (k.kind === 'choice') {
                lines.push(`${indent}state ${name} <<choice>>`);
            } else if (k.kind === 'final') {
                lines.push(`${indent}state ${name} <<end>>`);
            } else if (k.kind === 'state') {
                // A state whose only child is a history pseudostate is still written as a simple state: the
                // history is not declared but referenced as `Name[H]`, which needs no block.
                if (childrenOf(d, k.id).some(c => c.kind !== 'history')) {
                    lines.push(`${indent}state ${name} {`);
                    emit(k.id, indent + '  ');
                    lines.push(`${indent}}`);
                } else {
                    lines.push(`${indent}state ${name}`);
                }
                // Description lines follow the declaration (after the closing brace for a composite state).
                if ((k.entry ?? '').trim()) {
                    lines.push(`${indent}${name} : entry / ${k.entry!.trim()}`);
                }
                if ((k.exit ?? '').trim()) {
                    lines.push(`${indent}${name} : exit / ${k.exit!.trim()}`);
                }
                // `Name : event` alone would read back as a free description, so an internal transition with
                // neither guard nor action gets a trailing slash (an empty action), which the importer accepts.
                for (const t of d.transitions.filter(x => x.source === k.id && isInternal(x))) {
                    const label = formatLabel(t.event ?? '', t.guard ?? '', t.action ?? '');
                    lines.push(`${indent}${name} : ${label}${(t.guard ?? '').trim() || (t.action ?? '').trim() ? '' : ' /'}`);
                }
            }
            // Initial and history pseudostates need no declaration (see `ref`).
        }
        // Initial transitions are written inside the container's block because `[*]` means "the initial
        // pseudostate of the enclosing block" in PlantUML. Only the action can be written (initial transitions
        // have no event or guard), as `: / action`.
        for (const k of kids.filter(x => x.kind === 'initial')) {
            for (const t of d.transitions.filter(x => x.source === k.id)) {
                const target = byId.get(t.target);
                if (target) {
                    lines.push(`${indent}[*] --> ${ref(target)}${(t.action ?? '').trim() ? ` : / ${t.action!.trim()}` : ''}`);
                }
            }
        }
    };
    emit(null, '');
    // All remaining transitions, at the top level. Transitions with a missing end, initial transitions
    // (already written) and internal transitions (written as description lines) are skipped.
    for (const t of d.transitions) {
        const s = byId.get(t.source);
        const e = byId.get(t.target);
        if (!s || !e || s.kind === 'initial' || isInternal(t)) {
            continue;
        }
        // An unguarded branch of a choice point is its default branch; UML writes it as `[else]`.
        const guard = s.kind === 'choice' && !(t.guard ?? '').trim() ? 'else' : t.guard ?? '';
        const label = formatLabel(t.event ?? '', guard, t.action ?? '');
        lines.push(`${ref(s)} --> ${ref(e)}${label ? ` : ${label}` : ''}`);
    }
    lines.push('@enduml', '');
    return lines.join('\n');
}

/**
 * One open block (`{ ... }`) during the import; the bottom entry stands for the top level of the diagram.
 *
 * Regions are discovered late in PlantUML: the first `--` separator appears only after the contents of the
 * first region have been read. Until then the block's states are created directly inside the state and
 * their ids are remembered in `first`; at the first separator a region is created for them and they are
 * moved into it.
 */
interface Scope {
    state: string | null; // owning state id (null = top level)
    region: string | null; // current region id inside the state, if it has regions
    /** Number of regions created so far in this block (0 until the first `--`). */
    regionCount: number;
    /**
     * Name from a `' @region` comment read before the first `--`, i.e. the name of the first region, which is
     * only created at that separator. Later `' @region` comments rename the current region directly.
     */
    regionName: string;
    first: string[]; // ids created in the first segment, moved into a region when `--` appears
}

/**
 * Parses a PlantUML state diagram. Throws on input that is not a state diagram.
 *
 * The text is read line by line, keeping a stack of open blocks (`Scope`). Every line is classified by the
 * first rule that matches: magic comments (`' @namespace`, `' @event`, `' @region`), lines that are ignored
 * (comments, `@startuml`/`@enduml`, layout and styling commands, preprocessor directives, notes and
 * legends), block ends `}`, region separators, `state` declarations, transitions (arrows), and
 * `Name : text` description lines. Anything else produces a warning and is skipped.
 *
 * States are created on their first mention, in the block where that mention occurs, so a state that is
 * used in a transition before it is declared in a nested block ends up at the place of the first use.
 * Names are global, as in PlantUML: the same name always refers to the same state.
 *
 * Limitations: display names (`state "Long name" as X`), colours and notes are dropped; stereotypes other
 * than `<<choice>>`, `<<end>>`, `<<start>>`, `<<history>>` and `<<history*>>` (fork, join, entry and exit
 * points, ...) give an ordinary state; description lines that are neither entry/exit actions nor an
 * internal transition (an event with a guard, an action or a trailing slash) are ignored; events and guards
 * on transitions leaving `[*]` are dropped. Notes and legends are skipped silently; a multi-line note without
 * its `end note` is reported and only its first line skipped.
 *
 * @param text The PlantUML source.
 * @returns The diagram (all positions zero, to be laid out by the caller) and any warnings.
 * @throws Error when no ordinary state was found.
 */
export function importPlantUml(text: string): { diagram: Diagram; warnings: string[] } {
    // `@startuml\s*(\w*)`: the optional diagram name after @startuml (a word, possibly empty).
    const start = /@startuml\s*(\w*)/.exec(text);
    const b = new DiagramBuilder(start?.[1] || 'StateMachine');
    const d = b.diagram;
    const names = new Map<string, StateNode>(); // PlantUML name -> state
    const initials = new Map<string, StateNode>(); // container id -> initial pseudostate
    const histories = new Map<string, StateNode>(); // `${state}|${deep}` -> history pseudostate
    const finals = new Map<string, StateNode>(); // container id -> final created for `--> [*]`
    const scopes: Scope[] = [{ state: null, region: null, regionCount: 0, regionName: '', first: [] }];
    const scope = () => scopes[scopes.length - 1];
    // Where new nodes go: the current region if the block has regions, else the block's state (null = top).
    const container = () => scope().region ?? scope().state;
    // Records a node created in the current block before its first region separator (see `Scope.first`).
    const created = (s: StateNode) => {
        if (scope().regionCount === 0) {
            scope().first.push(s.id);
        }
        return s;
    };

    /**
     * The state with PlantUML name `name`, created in the current container on first use.
     *
     * A name first seen in a transition is created as an ordinary state; when a later declaration gives it
     * the `<<end>>` or `<<choice>>` stereotype, the existing node is changed to that kind (losing the
     * entry/exit fields, which pseudostates and final states do not have). Ordinary and final state names
     * go through `uniqueName` in case an automatically created `Final` already uses the name; choice point
     * names need not be unique.
     */
    const state = (name: string, kind: 'state' | 'final' | 'choice' = 'state'): StateNode => {
        let s = names.get(name);
        if (!s) {
            s = created(b.addState(kind, kind === 'choice' ? name : b.uniqueName(name), container()));
            names.set(name, s);
        } else if (kind !== 'state' && s.kind === 'state') {
            s.kind = kind;
            delete s.entry;
            delete s.exit;
        }
        return s;
    };
    /**
     * The shallow or deep history pseudostate of `owner`, created on first use. Callers pass no owner only
     * at the top level, where the history then goes into the current container (null); the analysis reports
     * such a history as misplaced. There is at most one history of each depth per parent.
     */
    const historyOf = (owner: StateNode | undefined, deep: boolean): StateNode => {
        const parent = owner ? owner.id : container();
        const key = `${parent}|${deep}`;
        if (!histories.has(key)) {
            histories.set(key, b.addState('history', 'History', owner ? owner.id : container(), { deep }));
        }
        return histories.get(key)!;
    };
    /**
     * Resolves one end of a transition: a state name (optionally quoted), `[*]`, or a history reference
     * `[H]`, `[H*]`, `Name[H]`, `Name[H*]`.
     *
     * `[*]` means the initial pseudostate of the current container when it is the source and a final state of
     * the current container when it is the target; both are created once per container and reused.
     *
     * @param asSource True for the source end of the arrow, false for the target end.
     */
    const endpoint = (token: string, asSource: boolean): StateNode => {
        const c = container();
        if (token === '[*]') {
            const map = asSource ? initials : finals;
            // `#root` stands for the top level, whose container id is null.
            const key = c ?? '#root';
            if (!map.has(key)) {
                map.set(key, created(asSource ? b.addState('initial', 'Initial', c) : b.addState('final', b.uniqueName('Final'), c)));
            }
            return map.get(key)!;
        }
        // ^([\w.]*)\[(H\*?)\]$: group 1 the optional owner name (word characters and dots, like a plain name
        // in the transition pattern below), group 2 `H` (shallow) or `H*` (deep).
        const h = /^([\w.]*)\[(H\*?)\]$/.exec(token);
        if (h) {
            // A bare `[H]` refers to the history of the state whose block we are in.
            return historyOf(h[1] ? state(h[1]) : scope().state ? d.states.find(s => s.id === scope().state) : undefined, h[2] === 'H*');
        }
        // `^"|"$`: the quotes around a quoted name.
        return state(token.replace(/^"|"$/g, ''));
    };
    /**
     * Interprets one description line of state `s` (the text after `Name :`): `entry / ...` and `exit / ...`
     * add entry and exit actions; a label with an event and a guard, an action or at least the slash of an
     * (empty) action (`event /`, as the exporter writes an internal transition with neither) becomes an
     * internal transition. Any other text is a free description, which MachinaState has no field for, and is
     * ignored.
     */
    const describe = (s: StateNode, text: string) => {
        // ^(entry|exit)\s*\/\s*(.*)$: the keyword (lower case only), a slash, then the action list.
        const m = /^(entry|exit)\s*\/\s*(.*)$/.exec(text.trim());
        if (m) {
            DiagramBuilder.appendActions(s, m[1] as 'entry' | 'exit', splitActions(m[2]));
            return;
        }
        const label = parseLabel(text);
        // ^[\w()\s.]+$: the event looks like an event name or `after(...)` timeout (word characters,
        // parentheses, spaces and dots only), which tells an internal transition apart from prose. A bare
        // event without guard or slash (`Name : Pause`) is still taken as prose, and a label without an event
        // is not an internal transition (MachinaState requires an event for those).
        // `\/`: a slash anywhere in the text; parseLabel puts the text after the first one into the action,
        // and the event cannot contain one, so it marks an (empty) action here.
        if (label.event && /^[\w()\s.]+$/.test(label.event) && (label.action || label.guard || /\//.test(text))) {
            b.addTransition(s.id, s.id, label, { internal: true });
        }
    };

    // Block comments `/' ... '/` are removed first (they can span lines); `[\s\S]*?` is a lazy match of any
    // character including newlines. Then the text is split into lines, accepting both LF and CRLF.
    const lines = text.replace(/\/'[\s\S]*?'\//g, '').split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
        const line = lines[n].trim();
        let m: RegExpExecArray | null;
        // Magic comments written by the exporter. They must be tested before ordinary `'` comments are skipped.
        // `' @namespace <ns>`: group 1 the namespace (everything up to the next whitespace).
        if ((m = /^'\s*@namespace\s+(\S+)/.exec(line))) {
            d.namespace = m[1];
        // `' @event <Name>(<params>)`: group 1 the event name, group 2 the parameter list (up to the last `)`).
        } else if ((m = /^'\s*@event\s+(\w+)\s*\((.*)\)\s*$/.exec(line))) {
            d.events![m[1]] = m[2].trim();
        // `' @region <Name>`: names the region the comment is in. Before the first `--` of the block that region
        // does not exist yet (see `Scope`), so the name is kept for the separator that creates it; after a
        // separator the current region is renamed (the exporter writes the comment right after the `--`).
        } else if ((m = /^'\s*@region\s+(.+)$/.exec(line))) {
            const sc = scope();
            const region = sc.region ? d.states.find(s => s.id === sc.region) : undefined;
            if (region) {
                region.name = m[1].trim();
            } else {
                sc.regionName = m[1].trim();
            }
        // Ignored lines: blank lines, `'` comments, @startuml/@enduml, and commands that only affect the
        // rendering (skinparam, hide/show, title, direction, scale) or the preprocessor (`!include`, ...).
        } else if (!line || line.startsWith("'") || /^@(start|end)uml/.test(line) || /^(skinparam|hide|show|title|left to right|top to bottom|scale|!)/.test(line)) {
            continue;
        // Single-line notes, ignored like all notes: `note left of X : text` (the text after a `:` outside
        // quotes; `"[^"]*"` removes quoted names first, which may contain a colon) and the floating
        // `note "text" as N1` (`^note\s+"[^"]*"\s+as\s+\S+`, optionally followed by a colour).
        } else if (/^note\b/.test(line) && (/:/.test(line.replace(/"[^"]*"/g, '')) || /^note\s+"[^"]*"\s+as\s+\S+(\s+#\S+)?$/.test(line))) {
            continue;
        // A multi-line note or legend: skip up to its end line (`end note` / `endnote` for a note, `end legend` /
        // `endlegend` for a legend; `\s*` allows both spellings). The loop's n++ then steps over the end line.
        // When there is no end line before `@enduml` (or the end of the text), the line was probably a note form
        // that is not recognised above; it is reported and the following lines are read normally instead of
        // being swallowed.
        } else if ((m = /^(note|legend)\b/.exec(line))) {
            const end = new RegExp(`^end\\s*${m[1]}\\b`);
            let k = n + 1;
            while (k < lines.length && !end.test(lines[k].trim()) && !/^@enduml/.test(lines[k].trim())) {
                k++;
            }
            if (k < lines.length && end.test(lines[k].trim())) {
                n = k;
            } else {
                b.warnings.push(`line ${n + 1}: ${m[1]} without 'end ${m[1]}' ignored: ${line}`);
            }
        // End of a `state X {` block; a stray `}` at the top level is ignored.
        } else if (line === '}') {
            if (scopes.length > 1) {
                scopes.pop();
            }
        // Region separator (`--` for horizontal, `||` for vertical layout in PlantUML; the same here).
        } else if (line === '--' || line === '||') {
            const sc = scope();
            if (!sc.state) {
                b.warnings.push(`line ${n + 1}: region separator outside a composite state ignored`);
                continue;
            }
            // First separator: the block's contents so far become the first region. A `' @region` comment
            // read before them names it.
            if (sc.regionCount === 0) {
                const first = b.addState('region', sc.regionName || 'Region1', sc.state);
                d.states.filter(s => sc.first.includes(s.id)).forEach(s => (s.parent = first.id));
                sc.regionCount = 1;
                sc.regionName = '';
            }
            // Open the next region; new nodes go into it until the next separator or the end of the block. It is
            // named `Region2`, `Region3`, ... until a `' @region` comment after the separator renames it.
            sc.regionCount++;
            sc.region = b.addState('region', `Region${sc.regionCount}`, sc.state).id;
        // State declaration:
        //   ^state\s+
        //   (?:"[^"]*"\s+as\s+)?          optional display name first: `state "Long name" as X`
        //   ("[^"]+"|[\w.]+)              group 1: the name, quoted or a word (dots allowed)
        //   (?:\s+as\s+"[^"]*")?          optional display name last: `state X as "Long name"`
        //   \s*(<<\s*(\w+\*?)\s*>>)?      group 2: optional stereotype, group 3 its word (`history*` included)
        //   \s*(#\S+)?                    group 4: optional colour, e.g. `#pink` (ignored)
        //   \s*(\{)?                      group 5: `{` when a block of substates follows
        //   \s*(?::\s*(.*))?$             group 6: optional description after `:`
        } else if ((m = /^state\s+(?:"[^"]*"\s+as\s+)?("[^"]+"|[\w.]+)(?:\s+as\s+"[^"]*")?\s*(<<\s*(\w+\*?)\s*>>)?\s*(#\S+)?\s*(\{)?\s*(?::\s*(.*))?$/.exec(line))) {
            const name = m[1].replace(/^"|"$/g, '');
            const stereo = (m[3] ?? '').toLowerCase();
            let s: StateNode;
            if (stereo === 'choice') {
                s = state(name, 'choice');
            } else if (stereo === 'end') {
                s = state(name, 'final');
            } else if (stereo === 'history' || stereo === 'history*') {
                // A declared history pseudostate belongs to the enclosing state; its name becomes an alias.
                s = historyOf(scope().state ? d.states.find(x => x.id === scope().state) : undefined, stereo === 'history*');
                names.set(name, s);
            } else if (stereo === 'start') {
                // A declared start node is the container's initial pseudostate, reachable by its name.
                s = endpoint('[*]', true);
                names.set(name, s);
            } else {
                s = state(name);
            }
            if (m[6]) {
                describe(s, m[6]);
            }
            if (m[5]) {
                scopes.push({ state: s.id, region: null, regionCount: 0, regionName: '', first: [] });
            }
        // Transition:
        //   ^(END)\s*                     group 1: source
        //   (<?)                          group 2: `<` for an arrow pointing left
        //   -[-\w[\]#,=]*                 the arrow body: a `-` followed by more dashes, direction keywords
        //                                 (`-left->`, `-up->`, `-d->`) and style brackets (`-[#red,bold]->`)
        //   (>?)                          group 3: `>` for an arrow pointing right
        //   \s*(END)\s*                   group 4: target
        //   (?::\s*(.*))?$                group 5: optional label after `:`
        // where END is ("[^"]+"|\[\*\]|[\w.]*\[H\*?\]|[\w.]+): a quoted name, `[*]`, a history reference
        // (`[H]`, `Name[H*]`, ...) or a plain name. Arrows with dots (`-.->`) are not recognised.
        } else if ((m = /^("[^"]+"|\[\*\]|[\w.]*\[H\*?\]|[\w.]+)\s*(<?)-[-\w[\]#,=]*(>?)\s*("[^"]+"|\[\*\]|[\w.]*\[H\*?\]|[\w.]+)\s*(?::\s*(.*))?$/.exec(line))) {
            // `B <-- A` goes from A to B. An arrow with heads at both ends (or none) is read left to right.
            const reverse = m[2] === '<' && m[3] !== '>';
            const [from, to] = reverse ? [m[4], m[1]] : [m[1], m[4]];
            const source = endpoint(from, true);
            const target = endpoint(to, false);
            const label = parseLabel(m[5] ?? '');
            // MachinaState stores the default branch of a choice point as an unguarded branch, not `else`.
            if (source.kind === 'choice' && label.guard === 'else') {
                label.guard = '';
            }
            // Initial transitions can only carry an action.
            b.addTransition(source.id, target.id, source.kind === 'initial' ? { action: label.action } : label);
        // Description line `Name : text` (group 1 the name, quoted or a word; group 2 the text). It also
        // creates the state if this is its first mention.
        } else if ((m = /^("[^"]+"|[\w.]+)\s*:\s*(.*)$/.exec(line))) {
            describe(state(m[1].replace(/^"|"$/g, '')), m[2]);
        } else {
            b.warnings.push(`line ${n + 1}: not understood: ${line}`);
        }
    }
    // A file without a single ordinary state is most likely another kind of PlantUML diagram.
    if (!d.states.some(s => s.kind === 'state')) {
        throw new Error('No states found; is this a PlantUML state diagram?');
    }
    return { diagram: d, warnings: b.warnings };
}
