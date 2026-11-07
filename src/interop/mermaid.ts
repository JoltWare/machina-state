// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Mermaid state diagram (`stateDiagram-v2`) export and import.
//
// Mermaid diagrams render directly in GitHub and GitLab Markdown, many wikis and documentation generators, so
// the export is mainly meant for documentation: `exportMermaid` writes the diagram, and `mermaidMarkdown`
// wraps it in a ```mermaid fence ready to paste into a Markdown file. Everything MachinaState needs that
// Mermaid cannot show travels in `%%` comments, which Mermaid ignores, so an exported diagram imports again
// with the same behaviour.
//
// Mapping between MachinaState and Mermaid (as written by the exporter and understood by the importer):
//
//   diagram name              front matter `title: <name>`
//   namespace                 `%% @namespace <ns>`
//   event parameters          `%% @event <Event>(<params>)`, one comment per event with parameters
//   state                     `<Name>`; `state <Name> { ... }` when it has substates. Names that Mermaid reserves
//                             (`note`, `state`, `class`, `default`, ... in any case) or that are not plain words
//                             are declared with an alias: `state "note" as note_1`
//   entry / exit actions      `<Name> : entry / a#59; b` and `<Name> : exit / c` (description lines)
//   internal transition       `<Name> : event [guard] / action`; one with neither guard nor action is written
//                             `<Name> : event /`, so that the slash tells it apart from a free-text description
//                             (Mermaid allows no description lines on composite states: there the same lines go
//                             into a `note right of <Name>` preceded by `%% @describe <Name>`)
//   initial pseudostate       `[*] --> <Target>`, with the action as `: / action`, inside the container's block
//   final state               `<Source> --> [*]` inside the container's block, which Mermaid draws as the
//                             container's end node; `%% @end <Name>` before it keeps the name. Mermaid has one
//                             end node per block, so further final states in the same block are declared as
//                             ordinary states marked `%% @final <id>`
//   history pseudostate       Mermaid has none: a state `state "H" as <Owner>_H` (`"H*"` when deep) in the
//                             owner's block, marked `%% @history <alias>` or `%% @history* <alias>`
//   choice point              `state <Alias> <<choice>>`; branches without a guard get `[else]`
//   orthogonal regions        the region contents in the state's block, separated by `--`, each preceded by
//                             `%% @region <Name>` (for every region but the first, after the `--`)
//   transition                `<Source> --> <Target> : event [guard] / action`
//   state colour              `classDef` with the colour as stroke and a light fill, applied with `class`
//
// Label text is escaped with Mermaid's entity codes: `;` (which would end the statement), `#` (which starts an
// entity code) and `<` / `>` (which Mermaid's HTML sanitiser would treat as tags) become `#59;`, `#35;`,
// `#60;` and `#62;`. The importer decodes numeric and the common named entity codes.
//
// Not represented (lost on a round trip): positions, sizes and transition bends, transition colours, the
// code generation options and recorded scenarios. On import every node is created at 0,0 with no size; the
// import command runs the auto-layout before saving the diagram. Further import limitations are described at
// `importMermaid`.
import { Diagram, StateNode } from '../model';
import { childrenOf, DiagramBuilder, formatLabel, parseLabel, splitActions } from './common';

/**
 * Words that Mermaid's state diagram grammar reserves (compared without regard to case). A state with such a
 * name cannot be referenced by its name and is given an alias. Found by trying every keyword of the grammar
 * against Mermaid 12; `accTitle` and `accDescr` parse as names, but description lines of such a state are
 * taken as accessibility text.
 */
const RESERVED = new Set(['note', 'state', 'class', 'classdef', 'default', 'style', 'click', 'scale', 'statediagram', 'acctitle', 'accdescr']);

/** Characters escaped in label and description text, with their Mermaid entity codes. */
const ESCAPES: Record<string, string> = { '#': '#35;', ';': '#59;', '<': '#60;', '>': '#62;' };

/** Escapes text for a Mermaid label or description line (see `ESCAPES`); line breaks become spaces. */
const escapeText = (text: string) => text.replace(/\s*\r?\n\s*/g, ' ').replace(/[#;<>]/g, ch => ESCAPES[ch]);

/** Named entity codes the importer decodes (Mermaid accepts any HTML entity name; these are the useful ones). */
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', semi: ';', num: '#', colon: ':' };

/**
 * Decodes Mermaid entity codes in label text: `#59;` and `#x3B;` (numeric) and `#lt;` (named, see `NAMED`).
 * Unknown names and invalid code points are left as written.
 */
export function decodeMermaidText(text: string): string {
    // #(?:x([0-9a-f]+)|(\d+)|([a-z]+));  a hexadecimal (group 1), decimal (group 2) or named (group 3) code.
    return text.replace(/#(?:x([0-9a-f]+)|(\d+)|([a-z]+));/gi, (all, hex: string, dec: string, name: string) => {
        if (name) {
            return NAMED[name.toLowerCase()] ?? all;
        }
        const code = parseInt(hex ?? dec, hex ? 16 : 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    });
}

/** A colour the exporter can write: `#rrggbb`, as the editor's colour picker stores it. */
const isHexColour = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/**
 * Converts a diagram to a Mermaid state diagram (front matter with the title, then `stateDiagram-v2`; with a
 * trailing newline).
 *
 * Like the PlantUML exporter, a recursive walk (`emit`) writes the containment structure: the declarations of
 * a container's states, choice points and history pseudostates, each state's description lines, the
 * container's initial transitions and the transitions into its final states (both use the block-local
 * `[*]`). All other transitions follow at the top level, which works because Mermaid state names are global.
 * Colour classes come last.
 */
export function exportMermaid(d: Diagram): string {
    // The title is YAML: anything but a plain word is quoted.
    const lines = ['---', `title: ${/^\w+$/.test(d.name) ? d.name : JSON.stringify(d.name)}`, '---', 'stateDiagram-v2'];
    const indent0 = '  ';
    if (d.namespace) {
        lines.push(`${indent0}%% @namespace ${d.namespace}`);
    }
    for (const [event, params] of Object.entries(d.events ?? {})) {
        if (params.trim()) {
            lines.push(`${indent0}%% @event ${event}(${params.trim()})`);
        }
    }
    const byId = new Map(d.states.map(s => [s.id, s]));

    // Mermaid ids. Ordinary and final states use their name when it is a plain word Mermaid does not reserve;
    // everything else (other names, choice points, history pseudostates) gets a word id that does not clash with
    // any other, and states whose id differs from their name are declared with the name as display text.
    const alias = new Map<string, string>();
    const used = new Set<string>();
    const usable = (name: string) => /^\w+$/.test(name) && !RESERVED.has(name.toLowerCase());
    const take = (base: string) => {
        let id = base;
        for (let i = 1; used.has(id) || RESERVED.has(id.toLowerCase()); i++) {
            id = `${base}_${i}`;
        }
        used.add(id);
        return id;
    };
    // Usable state names first, so that they keep their name even when a generated id would have taken it.
    for (const s of d.states) {
        if ((s.kind === 'state' || s.kind === 'final') && usable(s.name) && !used.has(s.name)) {
            alias.set(s.id, s.name);
            used.add(s.name);
        }
    }
    /** The state that contains `s`, skipping regions (undefined at the top level). */
    const owner = (s: StateNode) => {
        let p = s.parent ? byId.get(s.parent) : undefined;
        while (p && p.kind === 'region') {
            p = p.parent ? byId.get(p.parent) : undefined;
        }
        return p;
    };
    for (const s of d.states) {
        if (alias.has(s.id)) {
            continue;
        }
        // `\W`: any non-word character, removed to form a word id.
        const word = s.name.replace(/\W/g, '');
        if (s.kind === 'state' || s.kind === 'final') {
            alias.set(s.id, take(word || 'State'));
        } else if (s.kind === 'choice') {
            alias.set(s.id, take(word || 'Choice'));
        } else if (s.kind === 'history') {
            const o = owner(s);
            alias.set(s.id, take(`${o ? alias.get(o.id) ?? o.name.replace(/\W/g, '') : ''}_H${s.deep ? 'deep' : ''}`));
        }
    }
    /** How a node is referenced in a transition: its id, `[*]` for initial (and named end) pseudostates. */
    const ref = (s: StateNode) => (s.kind === 'initial' ? '[*]' : alias.get(s.id)!);
    // Final states that are drawn as their block's `[*]` end node: the first final of each container.
    const endNode = new Set<string>();
    for (const s of d.states) {
        if (s.kind === 'final' && !d.states.some(o => o.kind === 'final' && endNode.has(o.id) && (o.parent ?? null) === (s.parent ?? null))) {
            endNode.add(s.id);
        }
    }
    const isInternal = (t: { internal?: boolean; source: string; target: string }) => t.internal === true && t.source === t.target;
    /** ` : label` for a transition, or nothing for an empty label. */
    const labelOf = (event: string, guard: string, action: string) => {
        const text = formatLabel(event, guard, action);
        return text ? ` : ${escapeText(text)}` : '';
    };
    /** Declaration of a state that is not a block: its bare id, or `state "Name" as id` when they differ. */
    const declare = (s: StateNode, text = s.name) => (alias.get(s.id) === text ? alias.get(s.id)! : `state "${text.replace(/"/g, "'")}" as ${alias.get(s.id)}`);

    const emit = (parent: string | null, indent: string) => {
        const kids = childrenOf(d, parent);
        const regions = kids.filter(k => k.kind === 'region');
        if (regions.length) {
            // Orthogonal state: each region's contents in turn, separated by `--`, with the region names in
            // `%% @region` comments. Other children of a state with regions are not written.
            regions.forEach((r, i) => {
                if (i > 0) {
                    lines.push(`${indent}--`);
                }
                lines.push(`${indent}%% @region ${r.name}`);
                emit(r.id, indent);
            });
            return;
        }
        for (const k of kids) {
            const id = alias.get(k.id)!;
            if (k.kind === 'choice') {
                lines.push(`${indent}state ${id} <<choice>>`);
            } else if (k.kind === 'history') {
                lines.push(`${indent}%% @history${k.deep ? '*' : ''} ${id}`);
                lines.push(`${indent}${declare(k, k.deep ? 'H*' : 'H')}`);
            } else if (k.kind === 'final' && !endNode.has(k.id)) {
                lines.push(`${indent}%% @final ${id}`);
                lines.push(`${indent}${declare(k)}`);
            } else if (k.kind === 'state') {
                const description: string[] = [];
                if ((k.entry ?? '').trim()) {
                    description.push(`entry / ${escapeText(k.entry!.trim())}`);
                }
                if ((k.exit ?? '').trim()) {
                    description.push(`exit / ${escapeText(k.exit!.trim())}`);
                }
                for (const t of d.transitions.filter(x => x.source === k.id && isInternal(x))) {
                    const text = formatLabel(t.event ?? '', t.guard ?? '', t.action ?? '');
                    description.push(`${escapeText(text)}${(t.guard ?? '').trim() || (t.action ?? '').trim() ? '' : ' /'}`);
                }
                if (childrenOf(d, k.id).length) {
                    // A block has no display text of its own, so an aliased composite state gets it from a
                    // declaration in front of the block.
                    if (id !== k.name) {
                        lines.push(`${indent}${declare(k)}`);
                    }
                    lines.push(`${indent}state ${id} {`);
                    emit(k.id, indent + '  ');
                    lines.push(`${indent}}`);
                    // Mermaid rejects description lines on composite states ("Group nodes can only have label"),
                    // so they go into a note beside the state, marked for the importer.
                    if (description.length) {
                        lines.push(`${indent}%% @describe ${id}`, `${indent}note right of ${id}`, ...description.map(x => `${indent}  ${x}`), `${indent}end note`);
                    }
                } else {
                    // Mermaid draws the first description line of a state in place of its name unless the name is
                    // given as display text, so a state with description lines always gets one.
                    lines.push(`${indent}${description.length ? `state "${k.name.replace(/"/g, "'")}" as ${id}` : declare(k)}`);
                    lines.push(...description.map(x => `${indent}${id} : ${x}`));
                }
            }
        }
        // Initial transitions: `[*]` as a source is the initial pseudostate of the enclosing block. Only the
        // action can be written (initial transitions have no event or guard).
        for (const k of kids.filter(x => x.kind === 'initial')) {
            for (const t of d.transitions.filter(x => x.source === k.id)) {
                const target = byId.get(t.target);
                if (target) {
                    lines.push(`${indent}[*] --> ${ref(target)}${labelOf('', '', t.action ?? '')}`);
                }
            }
        }
        // Transitions into the block's end node: `[*]` as a target is the end node of the enclosing block.
        for (const f of kids.filter(x => endNode.has(x.id))) {
            lines.push(`${indent}%% @end ${f.name}`);
            for (const t of d.transitions.filter(x => x.target === f.id)) {
                const source = byId.get(t.source);
                if (source && source.kind !== 'initial') {
                    lines.push(`${indent}${ref(source)} --> [*]${transitionLabel(source, t)}`);
                }
            }
        }
    };
    /** The label of an ordinary transition; an unguarded branch of a choice point is its `[else]` branch. */
    const transitionLabel = (s: StateNode, t: { event?: string; guard?: string; action?: string }) =>
        labelOf(t.event ?? '', s.kind === 'choice' && !(t.guard ?? '').trim() ? 'else' : t.guard ?? '', t.action ?? '');

    emit(null, indent0);
    // All remaining transitions at the top level: not those with a missing end, initial transitions, internal
    // transitions (description lines) and transitions into end nodes (written in their block).
    for (const t of d.transitions) {
        const s = byId.get(t.source);
        const e = byId.get(t.target);
        if (!s || !e || s.kind === 'initial' || isInternal(t) || endNode.has(e.id)) {
            continue;
        }
        lines.push(`${indent0}${ref(s)} --> ${ref(e)}${transitionLabel(s, t)}`);
    }
    // State colours: one class per colour, drawn like the editor draws them (coloured border, light fill:
    // `38` is an alpha of about 22 %).
    const colours = new Map<string, string[]>();
    for (const s of d.states) {
        if (s.kind === 'state' && isHexColour(s.color)) {
            const c = s.color.toLowerCase();
            colours.set(c, [...(colours.get(c) ?? []), alias.get(s.id)!]);
        }
    }
    for (const [c, ids] of colours) {
        const name = `color_${c.slice(1)}`;
        lines.push(`${indent0}classDef ${name} fill:${c}38,stroke:${c}`, `${indent0}class ${ids.join(',')} ${name}`);
    }
    lines.push('');
    return lines.join('\n');
}

/** Wraps Mermaid text in a Markdown code fence (```mermaid), as GitHub, GitLab and most wikis render it. */
export const mermaidMarkdown = (mermaid: string) => '```mermaid\n' + mermaid + (mermaid.endsWith('\n') ? '' : '\n') + '```\n';

/** One open block during the import; see `Scope` in plantuml.ts, which works the same way. */
interface Scope {
    state: string | null;
    region: string | null;
    regionCount: number;
    regionName: string;
    first: string[];
}

/**
 * The Mermaid state diagram in `text`: the text itself, or the first ```mermaid (or ~~~mermaid) fence of a
 * Markdown document that holds a state diagram. Also returns how many further state diagram fences were
 * skipped.
 */
function extractMermaid(text: string): { source: string; skipped: number } {
    // (`{3,}|~{3,})\s*mermaid\b[^\n]*\n  the opening fence (group 1) with the language `mermaid`
    // ([\s\S]*?)                         group 2, the diagram (lazy, up to the first closing fence)
    // \n\s*\1                            a closing fence of the same kind at the start of a line
    const fences = [...text.matchAll(/^[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\r?\n([\s\S]*?)\r?\n[ \t]*\1/gm)].map(m => m[2]).filter(b => /^\s*stateDiagram/m.test(b));
    if (fences.length) {
        return { source: fences[0], skipped: fences.length - 1 };
    }
    return { source: text, skipped: 0 };
}

/**
 * A diagram name from a Mermaid title: kept when it is an identifier, otherwise its words joined in
 * PascalCase (`Traffic light` gives `TrafficLight`); `StateMachine` when nothing usable is left.
 */
function nameFromTitle(title: string): string {
    // `^(["'])(.*)\1$`: a quoted YAML scalar; the quotes are removed.
    const t = title.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (/^[A-Za-z_]\w*$/.test(t)) {
        return t;
    }
    const words = t.split(/\W+/).filter(Boolean);
    const name = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
    return /^[A-Za-z_]/.test(name) ? name : name ? `_${name}` : 'StateMachine';
}

/**
 * Parses a Mermaid state diagram (`stateDiagram-v2` or `stateDiagram`), on its own or as the first ```mermaid
 * state diagram fence in a Markdown document. Throws on input that is not a state diagram.
 *
 * The text is read line by line with a stack of open blocks, like the PlantUML importer: magic comments
 * (`%% @...`), ignored lines (other comments, directives, `direction`, accessibility titles, `hide`, `scale`,
 * `click`), notes (single-line and `note ... end note`), class definitions and assignments (which give state
 * colours), block ends, region separators, `state` declarations, transitions and `Name : text` description
 * lines. Anything else produces a warning and is skipped.
 *
 * States are created on their first mention, in the block where that mention occurs, and names are global.
 * A state declared with display text (`state "Text" as id`) is named after the text if it is an identifier,
 * otherwise after the id.
 *
 * Limitations: `<<fork>>` and `<<join>>` give an ordinary state (with a warning), since MachinaState has no
 * fork or join; description lines that are neither entry/exit actions nor an internal transition (an event
 * with a guard, an action or a trailing slash) are ignored; events and guards on transitions leaving `[*]` are
 * dropped; `style` statements and classes other than a fill or stroke colour are ignored.
 *
 * @param text The Mermaid source, or a Markdown document containing it.
 * @returns The diagram (all positions zero, to be laid out by the caller) and any warnings.
 * @throws Error when the text is not a state diagram or no ordinary state was found.
 */
export function importMermaid(text: string): { diagram: Diagram; warnings: string[] } {
    const { source, skipped } = extractMermaid(text);
    const all = source.split(/\r?\n/);
    // Front matter: `---` lines around YAML, of which only the title is used. Mermaid requires it on the first
    // line; blank lines and comments before it are tolerated here.
    let n = 0;
    let title = '';
    while (n < all.length && (!all[n].trim() || all[n].trim().startsWith('%%'))) {
        n++;
    }
    if (all[n]?.trim() === '---') {
        let k = n + 1;
        while (k < all.length && all[k].trim() !== '---') {
            // ^title:\s*(.*)$  the title (group 1); other keys (config, ...) are ignored.
            const m = /^title:\s*(.*)$/.exec(all[k].trim());
            if (m) {
                title = m[1];
            }
            k++;
        }
        n = k + 1;
    }
    // The diagram type line, after blank lines, comments and directives.
    while (n < all.length && (!all[n].trim() || all[n].trim().startsWith('%%'))) {
        n++;
    }
    if (n >= all.length || !/^stateDiagram(-v2)?\b/.test(all[n].trim())) {
        throw new Error('Not a Mermaid state diagram: expected stateDiagram-v2 (or a Markdown ```mermaid block with one).');
    }
    const b = new DiagramBuilder(title ? nameFromTitle(title) : 'StateMachine');
    if (skipped) {
        b.warnings.push(`the document holds ${skipped + 1} state diagrams; only the first was imported`);
    }
    const d = b.diagram;
    const names = new Map<string, StateNode>(); // Mermaid id -> state
    const initials = new Map<string, StateNode>(); // container id -> initial pseudostate
    const finals = new Map<string, StateNode>(); // container id -> end node (`--> [*]`)
    const endNames = new Map<string, string>(); // container id -> name from `%% @end`
    const historyIds = new Map<string, boolean>(); // Mermaid id from `%% @history` -> deep
    const finalIds = new Set<string>(); // Mermaid ids from `%% @final`
    let describeNext = ''; // Mermaid id from `%% @describe`: the next note holds the state's description lines
    const classes = new Map<string, string>(); // class name -> colour
    const scopes: Scope[] = [{ state: null, region: null, regionCount: 0, regionName: '', first: [] }];
    const scope = () => scopes[scopes.length - 1];
    const container = () => scope().region ?? scope().state;
    const key = () => container() ?? '#root';
    const created = (s: StateNode) => {
        if (scope().regionCount === 0) {
            scope().first.push(s.id);
        }
        return s;
    };

    /**
     * The state with Mermaid id `id`, created in the current container on first use. `display` is the display
     * text of a `state "Text" as id` declaration; it names the state when it is an identifier. Ids marked by a
     * `%% @history` or `%% @final` comment become history pseudostates or final states.
     */
    const state = (id: string, kind: 'state' | 'choice' = 'state', display?: string): StateNode => {
        let s = names.get(id);
        const name = display !== undefined && /^[A-Za-z_]\w*$/.test(display) ? display : id;
        if (!s) {
            if (historyIds.has(id)) {
                s = created(b.addState('history', 'History', container(), { deep: historyIds.get(id) }));
            } else if (finalIds.has(id)) {
                s = created(b.addState('final', b.uniqueName(name), container()));
            } else {
                s = created(b.addState(kind, kind === 'choice' ? name : b.uniqueName(name), container()));
            }
            names.set(id, s);
        } else {
            if (kind === 'choice' && s.kind === 'state') {
                s.kind = 'choice';
                delete s.entry;
                delete s.exit;
            }
            // A later declaration with display text renames a state first seen in a transition.
            if (display !== undefined && name !== s.name && (s.kind === 'state' || s.kind === 'final')) {
                s.name = b.uniqueName(name);
            }
        }
        return s;
    };
    /** `[*]` as a source (the container's initial pseudostate) or a target (its end node), or a state id. */
    const endpoint = (token: string, asSource: boolean): StateNode => {
        if (token !== '[*]') {
            return state(token);
        }
        const map = asSource ? initials : finals;
        if (!map.has(key())) {
            const s = asSource ? b.addState('initial', 'Initial', container()) : b.addState('final', b.uniqueName(endNames.get(key()) ?? 'Final'), container());
            map.set(key(), created(s));
        }
        return map.get(key())!;
    };
    /** A description line of state `s`: entry/exit actions or an internal transition, as in plantuml.ts. */
    const describe = (s: StateNode, raw: string) => {
        const text = decodeMermaidText(raw);
        // ^(entry|exit)\s*\/\s*(.*)$: the keyword, a slash, then the action list.
        const m = /^(entry|exit)\s*\/\s*(.*)$/.exec(text.trim());
        if (m) {
            if (s.kind === 'state') {
                DiagramBuilder.appendActions(s, m[1] as 'entry' | 'exit', splitActions(m[2]));
            }
            return;
        }
        const label = parseLabel(text);
        // An event that looks like an event name or `after(...)`, with a guard, an action or at least the slash.
        if (s.kind === 'state' && label.event && /^[\w()\s.]+$/.test(label.event) && (label.action || label.guard || /\//.test(text))) {
            b.addTransition(s.id, s.id, label, { internal: true });
        }
    };
    /** Applies class `cls` to the states with the given Mermaid ids (a colour if the class defines one). */
    const applyClass = (ids: string[], cls: string) => {
        const colour = classes.get(cls);
        for (const id of ids) {
            const s = names.get(id);
            if (colour && s && s.kind === 'state') {
                s.color = colour;
            }
        }
    };
    // `:::cls` suffixes on state ids in transitions and declarations, applied once all states exist.
    const shorthand: [string, string][] = [];
    /** Strips a `:::class` suffix from a state token, remembering the class. */
    const bare = (token: string) => {
        const [id, cls] = token.split(':::');
        if (cls) {
            shorthand.push([id, cls]);
        }
        return id;
    };

    // ID: a word with dots (like PlantUML names), optionally followed by `:::class`.
    const ID = '[\\w.]+(?::::\\w+)?';
    for (n++; n < all.length; n++) {
        const line = all[n].trim();
        let m: RegExpExecArray | null;
        // Magic comments written by the exporter (tested before ordinary comments are skipped).
        if ((m = /^%%\s*@namespace\s+(\S+)/.exec(line))) {
            d.namespace = m[1];
        } else if ((m = /^%%\s*@event\s+(\w+)\s*\((.*)\)\s*$/.exec(line))) {
            d.events![m[1]] = m[2].trim();
        } else if ((m = /^%%\s*@region\s+(.+)$/.exec(line))) {
            const sc = scope();
            const region = sc.region ? d.states.find(s => s.id === sc.region) : undefined;
            if (region) {
                region.name = m[1].trim();
            } else {
                sc.regionName = m[1].trim();
            }
        } else if ((m = /^%%\s*@history(\*?)\s+(\w+)$/.exec(line))) {
            historyIds.set(m[2], m[1] === '*');
        } else if ((m = /^%%\s*@final\s+(\w+)$/.exec(line))) {
            finalIds.add(m[1]);
        } else if ((m = /^%%\s*@describe\s+(\w+)$/.exec(line))) {
            describeNext = m[1];
        } else if ((m = /^%%\s*@end\s+(\w+)$/.exec(line))) {
            // Names the block's end node, now if it exists already, otherwise when it is created.
            const end = finals.get(key());
            if (end) {
                end.name = b.uniqueName(m[1]);
            } else {
                endNames.set(key(), m[1]);
            }
        // Ignored: blank lines, comments and directives (`%%{init: ...}%%`), layout and accessibility lines.
        } else if (!line || line.startsWith('%%') || /^(direction\s|hide\b|scale\b|click\s|accTitle\s*:|accDescr\s*:)/.test(line)) {
            continue;
        // A multi-line accessibility description `accDescr { ... }`: skip to its closing brace.
        } else if (/^accDescr\s*\{/.test(line)) {
            while (n < all.length && !all[n].includes('}')) {
                n++;
            }
        // Notes: `note left of X : text` on one line, otherwise up to `end note`. A note right after a
        // `%% @describe X` comment holds the description lines of X (a composite state); other notes are skipped.
        } else if ((m = /^note\s+(?:left|right)\s+of\s+([\w.]+)\s*(:)?/i.exec(line))) {
            const describing = describeNext && m[1] === describeNext ? state(describeNext) : undefined;
            describeNext = '';
            if (!m[2]) {
                let k = n + 1;
                while (k < all.length && !/^end\s*note\b/i.test(all[k].trim())) {
                    k++;
                }
                if (k < all.length) {
                    if (describing) {
                        all.slice(n + 1, k).filter(x => x.trim()).forEach(x => describe(describing, x));
                    }
                    n = k;
                } else {
                    b.warnings.push(`line ${n + 1}: note without 'end note' ignored: ${line}`);
                }
            }
        } else if (/^note\s/i.test(line)) {
            b.warnings.push(`line ${n + 1}: not understood: ${line}`);
        // `classDef name fill:#f00,stroke:#333`: a stroke colour wins over a fill colour (the exporter writes the
        // editor colour as the stroke and a translucent fill).
        } else if ((m = /^classDef\s+(\w+)\s+(.*)$/i.exec(line))) {
            const styles = new Map(m[2].replace(/;\s*$/, '').split(',').map(p => p.split(':').map(x => x.trim()) as [string, string]));
            const colour = [styles.get('stroke'), styles.get('fill')].map(c => /^#[0-9a-f]{6}/i.exec(c ?? '')?.[0]).find(Boolean);
            if (colour) {
                classes.set(m[1], colour.toLowerCase());
            }
        // `class a,b name`.
        } else if ((m = /^class\s+([\w.,\s]+?)\s+(\w+)\s*;?$/i.exec(line))) {
            shorthand.push(...m[1].split(',').map(id => [id.trim(), m![2]] as [string, string]));
        } else if (/^style\s/i.test(line)) {
            continue;
        } else if (line === '}' || line === '};') {
            if (scopes.length > 1) {
                scopes.pop();
            }
        } else if (line === '--') {
            const sc = scope();
            if (!sc.state) {
                b.warnings.push(`line ${n + 1}: region separator outside a composite state ignored`);
                continue;
            }
            if (sc.regionCount === 0) {
                const first = b.addState('region', sc.regionName || 'Region1', sc.state);
                d.states.filter(s => sc.first.includes(s.id)).forEach(s => (s.parent = first.id));
                sc.regionCount = 1;
                sc.regionName = '';
            }
            sc.regionCount++;
            sc.region = b.addState('region', `Region${sc.regionCount}`, sc.state).id;
        // State declaration:
        //   ^state\s+
        //   (?:"([^"]*)"\s+as\s+)?         group 1: optional display text, `state "Text" as id`
        //   (ID)                           group 2: the id (with an optional :::class)
        //   \s*(?:<<\s*(\w+)\s*>>)?        group 3: optional stereotype (choice, fork, join)
        //   \s*(\{)?                       group 4: `{` when a block of substates follows
        //   \s*(?::\s*(.*))?$              group 5: optional description after `:`
        } else if ((m = new RegExp(`^state\\s+(?:"([^"]*)"\\s+as\\s+)?(${ID})\\s*(?:<<\\s*(\\w+)\\s*>>)?\\s*(\\{)?\\s*(?::\\s*(.*))?$`).exec(line))) {
            const id = bare(m[2]);
            const stereo = (m[3] ?? '').toLowerCase();
            if (stereo === 'fork' || stereo === 'join') {
                b.warnings.push(`line ${n + 1}: MachinaState has no ${stereo} pseudostate; '${id}' imported as a state`);
            }
            const s = state(id, stereo === 'choice' ? 'choice' : 'state', m[1]);
            if (m[5]) {
                describe(s, m[5]);
            }
            if (m[4]) {
                scopes.push({ state: s.id, region: null, regionCount: 0, regionName: '', first: [] });
            }
        // `state "Text" as id` is also written with the text second in some diagrams: `state id as "Text"` is
        // not Mermaid syntax and falls through to the warning below.
        //
        // Transition: (END) --> (END) with an optional label after `:`, where END is `[*]` or an id.
        } else if ((m = new RegExp(`^(\\[\\*\\]|${ID})\\s*-->\\s*(\\[\\*\\]|${ID})\\s*(?::\\s*(.*))?$`).exec(line))) {
            const source = endpoint(bare(m[1]), true);
            const target = endpoint(bare(m[2]), false);
            const label = parseLabel(decodeMermaidText(m[3] ?? ''));
            if (source.kind === 'choice' && label.guard === 'else') {
                label.guard = '';
            }
            b.addTransition(source.id, target.id, source.kind === 'initial' ? { action: label.action } : label);
        // Description line `id : text`.
        } else if ((m = new RegExp(`^(${ID})\\s*:\\s*(.*)$`).exec(line))) {
            describe(state(bare(m[1])), m[2]);
        // A bare id declares a state.
        } else if ((m = new RegExp(`^(${ID})$`).exec(line))) {
            state(bare(m[1]));
        } else {
            b.warnings.push(`line ${n + 1}: not understood: ${line}`);
        }
    }
    for (const [id, cls] of shorthand) {
        applyClass([id], cls);
    }
    if (!d.states.some(s => s.kind === 'state')) {
        throw new Error('No states found; is this a Mermaid state diagram?');
    }
    return { diagram: d, warnings: b.warnings };
}
