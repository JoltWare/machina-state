// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// SCXML (W3C State Chart XML) export and import.
// Guards become `cond="name()"`, actions `<script>name();</script>`, timeouts a delayed <send> on entry
// with a <cancel> on exit, choice points eventless transient states, orthogonal states <parallel>.
// MachinaState-specific details (event parameters, namespace, choice points) use the `machina` namespace.
//
// Mapping between MachinaState and SCXML (as written by the exporter and understood by the importer):
//
//   diagram name            <scxml name="..."> (non-word characters are removed on import)
//   namespace               <scxml machina:namespace="...">
//   event parameters        <scxml machina:events='{"Play":"int track"}'> (JSON; events without parameters
//                           are left out)
//   state                   <state id="Name">; SCXML ids are the state names, made unique and restricted to
//                           letters, digits, `_`, `.` and `-`
//   composite state         <state> containing its substates; a single explicit region is not written, its
//                           contents go directly into the <state>
//   orthogonal regions      <parallel id="Name"> with one <state id="Name_Region"> per region; on import every
//                           child <state> of a <parallel> becomes a region (the `Name_` prefix is removed).
//                           Regions have no actions or transitions of their own: on import a region's
//                           <onentry>/<onexit> actions are moved to the entry/exit actions of the parallel
//                           state (they run at the same moments, but before/after the substates of all regions
//                           rather than just their own) and its transitions are dropped, each with a warning
//   initial pseudostate     the `initial` attribute of the enclosing <state>/<scxml> when its transition has no
//                           action, otherwise <initial><transition target="..."><script>...</script>...;
//                           on import the first child state is used when neither is present, as in SCXML
//   final state             <final id="Name">
//   history pseudostate     <history id="history_Owner" type="shallow|deep"> with a default <transition> to the
//                           owner's initial target (the default history configuration of SCXML; MachinaState
//                           uses the initial state in that case anyway, so it is ignored on import)
//   choice point            <state id="choice_Owner" machina:kind="choice"> whose eventless transitions are
//                           tried in document order: guarded branches first, the unguarded (else) branch last
//   entry / exit actions    <onentry> / <onexit> with <script>a(); b();</script>
//   transition              <transition event="E" cond="g()" target="T"> with the action as a <script> child
//   guard                   cond="name()" or cond="!name()"
//   internal transition     a <transition> without target, with type="internal". On import every transition
//                           without a target is internal (SCXML exits and enters nothing for it, whatever its
//                           type). A transition with a target is external, except that type="internal" with a
//                           compound source and targets inside it (an SCXML "local" transition, which does not
//                           exit the source) has no MachinaState equivalent: it is imported as an external
//                           transition (the source is exited and re-entered) with a warning
//   completion transition   eventless on a simple state; event="done.state.<id>" on a composite state (the
//                           event SCXML raises when the state's final state is reached)
//   timeout after(5s)       event="timeout.<id>.5000" on the transition, plus <send event="timeout.<id>.5000"
//                           id="timeout.<id>.5000" delay="5000ms"/> in <onentry> and <cancel sendid="..."/> in
//                           <onexit>, once per distinct duration of the state's timeouts
//
// The `machina` attributes are in the namespace `urn:machinastate:scxml` (declared as xmlns:machina on the
// root); other SCXML processors ignore attributes in foreign namespaces. The importer resolves namespace
// prefixes (see xml.ts), so it honours these attributes under any prefix bound to that URI and ignores
// attributes with the same local names in other namespaces; likewise only elements in the SCXML namespace
// (or in no namespace, for documents without the xmlns declaration) are read. The values of machina:events
// must be strings; other entries (or a value that is not a JSON object) are ignored with a warning.
// Guards and actions are written as calls of argument-less functions (an action already written as a call,
// such as `f(a, b)`, is kept as is); the exporter declares no datamodel, so whether a processor can evaluate
// them depends on how it binds those names.
//
// Lost on a round trip: positions, sizes, colours and bends, the code generation options and recorded scenarios,
// and the names of choice and history pseudostates (they come back as `Choice` and `History`). On import every
// node is created at 0,0 with no size; the import command runs the auto-layout before saving the diagram.
// Unsupported SCXML on import: <datamodel>, <invoke>, <donedata>, and executable content other than <script>
// (<raise>, <log> and <assign> produce a warning, others such as <if> are skipped silently); only the first id
// of a multi-target transition or initial is used; scripts are only split into hook names, never evaluated.
import { Diagram, parseTimeout, StateNode, TransitionNode } from '../model';
import { childrenOf, DiagramBuilder, splitActions, timeoutEvent } from './common';
import { attrNS, escapeXml, localName, parseXml, XmlElement } from './xml';

/** Namespace URI of the extension attributes `machina:kind`, `machina:namespace` and `machina:events`. */
const MACHINA_NS = 'urn:machinastate:scxml';
/** Namespace URI of SCXML elements. */
const SCXML_NS = 'http://www.w3.org/2005/07/scxml';

/**
 * Converts a diagram to an SCXML document (with XML declaration and trailing newline).
 *
 * The document is written by a recursive walk over the containment tree, each element on its own line with
 * two spaces of indentation per level. Transitions are written inside the element of their source state.
 */
export function exportScxml(d: Diagram): string {
    const byId = new Map(d.states.map(s => [s.id, s]));
    const isInternal = (t: TransitionNode) => t.internal === true && t.source === t.target;
    // SCXML ids must be unique: states keep their names, other nodes get derived ids.
    // Ordinary and final states claim first so that they keep their names where possible; regions become
    // `<owner>_<region>`, choice and history pseudostates `choice_<owner>` / `history_<owner>` (`top` at the
    // top level). Initial pseudostates get no id: they become `initial` attributes or <initial> elements.
    const ids = new Map<string, string>();
    const used = new Set<string>();
    /** Gives node `s` an SCXML id based on `base`, numbered `_1`, `_2`, ... if already used. */
    const claim = (s: StateNode, base: string) => {
        // `[^\w.-]`: characters other than letters, digits, `_`, `.` and `-` are replaced by `_`. The numbered
        // alternatives are built from the sanitised id, so they are valid ids too.
        const clean = base.replace(/[^\w.-]/g, '_');
        let id = clean;
        for (let i = 1; used.has(id); i++) {
            id = `${clean}_${i}`;
        }
        used.add(id);
        ids.set(s.id, id);
    };
    d.states.filter(s => s.kind === 'state' || s.kind === 'final').forEach(s => claim(s, s.name));
    const ownerOf = (s: StateNode) => (s.parent ? byId.get(s.parent) : undefined);
    d.states.filter(s => s.kind === 'region').forEach(s => claim(s, `${ownerOf(s)?.name ?? ''}_${s.name || 'Region'}`));
    d.states.filter(s => s.kind === 'choice' || s.kind === 'history').forEach(s => claim(s, `${s.kind}_${ownerOf(s)?.name ?? 'top'}`));
    /**
     * Event name (and <send>/<cancel> id) of the timer of state `s` for a timeout of `ms` milliseconds, e.g.
     * `timeout.Washing.30000`. The importer recognises this form and turns it back into `after(...)`.
     */
    const timerId = (s: StateNode, ms: number) => `timeout.${ids.get(s.id)}.${ms}`;
    /** The distinct timeout durations (ms) of the transitions leaving `s`; each needs one timer. */
    const timers = (s: StateNode) => [...new Set(d.transitions.filter(t => t.source === s.id).map(t => parseTimeout(t.event ?? '')).filter((x): x is number => x !== undefined))];

    const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
    /** Formats attributes as ` name="value"`..., escaped; undefined and empty values are left out. */
    const attrs = (a: Record<string, string | undefined>) =>
        Object.entries(a)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => ` ${k}="${escapeXml(v!)}"`)
            .join('');
    /**
     * Writes an action list as one <script> element (`a(); b();`); nothing for an empty list. A hook name gets
     * an empty argument list; an action that is already written as a call (`f(a, b)`, which the analysis does
     * not accept but which can still be exported) is kept as it is, so the importer reads back the same text.
     */
    const script = (actions: string, indent: string) => {
        const list = splitActions(actions);
        if (list.length) {
            out.push(`${indent}<script>${escapeXml(list.map(a => (a.endsWith(')') ? `${a};` : `${a}();`)).join(' '))}</script>`);
        }
    };
    /**
     * The `cond` expression of a guard: `name()` or `!name()` for a negated guard. No guard, or `else`, gives
     * undefined, so the attribute is left out (an else branch is simply an unconditional transition that is
     * written after the guarded ones).
     */
    const cond = (guard: string) => {
        const g = guard.trim();
        return g && g !== 'else' ? (g.startsWith('!') ? `!${g.slice(1).trim()}()` : `${g}()`) : undefined;
    };
    /** The initial pseudostate directly inside a container (a state, a region, or the top level for null). */
    const initialOf = (container: string | null) => childrenOf(d, container).find(k => k.kind === 'initial');
    /**
     * Writes an <initial> element for the container when its initial transition has actions (an `initial`
     * attribute cannot carry actions). See `initialAttr` for the other case; only one of the two is written.
     */
    const initialElement = (container: string | null, indent: string) => {
        const init = initialOf(container);
        const t = init && d.transitions.find(x => x.source === init.id);
        if (t && (t.action ?? '').trim()) {
            out.push(`${indent}<initial>`, `${indent}  <transition${attrs({ target: ids.get(t.target) })}>`);
            script(t.action ?? '', `${indent}    `);
            out.push(`${indent}  </transition>`, `${indent}</initial>`);
        }
    };
    /** The container's `initial` attribute: the initial target, if the initial transition has no actions. */
    const initialAttr = (container: string | null) => {
        const init = initialOf(container);
        const t = init && d.transitions.find(x => x.source === init.id);
        return t && !(t.action ?? '').trim() ? ids.get(t.target) : undefined;
    };
    /** Writes one <transition> element for `t`, which leaves `source`. */
    const transition = (t: TransitionNode, source: StateNode, indent: string) => {
        const target = byId.get(t.target);
        const ms = parseTimeout(t.event ?? '');
        let event = (t.event ?? '').trim();
        if (ms !== undefined) {
            // Timeout: the transition waits for the event of the timer started on entry.
            event = timerId(source, ms);
        } else if (!event && source.kind === 'state' && childrenOf(d, source.id).some(k => k.kind !== 'history')) {
            // Completion transition of a composite state: it fires when the state is done, which SCXML signals
            // with the done.state.<id> event. A simple state's completion transition stays eventless, which
            // SCXML takes as soon as the state has been entered.
            event = `done.state.${ids.get(source.id)}`;
        }
        // An internal transition has no target, which in SCXML means the state is neither exited nor
        // re-entered; type="internal" is written as well to make the intent explicit.
        const a = {
            event: event || undefined,
            cond: cond(t.guard ?? ''),
            target: isInternal(t) ? undefined : target ? ids.get(target.id) : undefined,
            type: isInternal(t) ? 'internal' : undefined
        };
        if ((t.action ?? '').trim()) {
            out.push(`${indent}<transition${attrs(a)}>`);
            script(t.action ?? '', `${indent}  `);
            out.push(`${indent}</transition>`);
        } else {
            out.push(`${indent}<transition${attrs(a)}/>`);
        }
    };
    /** Writes the element for node `s` (any kind except initial) and, recursively, its contents. */
    const node = (s: StateNode, indent: string) => {
        const id = ids.get(s.id);
        const kids = childrenOf(d, s.id);
        const outgoing = d.transitions.filter(t => t.source === s.id);
        if (s.kind === 'final') {
            out.push(`${indent}<final${attrs({ id })}/>`);
            return;
        }
        if (s.kind === 'history') {
            // The default history transition (used when the owner has not been active yet) goes to the target
            // of the owner's initial transition, which is what MachinaState does in that case.
            const owner = ownerOf(s);
            const target = owner ? initialOf(owner.id) && d.transitions.find(t => t.source === initialOf(owner.id)!.id)?.target : undefined;
            out.push(`${indent}<history${attrs({ id, type: s.deep ? 'deep' : 'shallow' })}>`);
            if (target) {
                out.push(`${indent}  <transition${attrs({ target: ids.get(target) })}/>`);
            }
            out.push(`${indent}</history>`);
            return;
        }
        if (s.kind === 'choice') {
            // A choice point becomes a transient state: its transitions have no event, so the processor
            // leaves it immediately through the first branch whose condition holds (document order).
            // Branches without a guard ("else") go last, as in MachinaState.
            out.push(`${indent}<state${attrs({ id, 'machina:kind': 'choice' })}>`);
            [...outgoing.filter(t => cond(t.guard ?? '')), ...outgoing.filter(t => !cond(t.guard ?? ''))].forEach(t => transition(t, s, `${indent}  `));
            out.push(`${indent}</state>`);
            return;
        }
        // Ordinary states and regions. A state with two or more regions is a <parallel>, whose regions are
        // written as child <state> elements by the recursion below (a region is a node of kind 'region', so it
        // gets no actions or transitions, just its initial state and contents).
        const regions = kids.filter(k => k.kind === 'region');
        const tag = regions.length > 1 ? 'parallel' : 'state';
        // A single explicit region is just the content of the state.
        const container = regions.length === 1 ? regions[0].id : s.id;
        // <parallel> has no initial state: all its regions are entered.
        out.push(`${indent}<${tag}${attrs({ id, initial: tag === 'state' ? initialAttr(container) : undefined })}>`);
        const inner = `${indent}  `;
        if (tag === 'state') {
            initialElement(container, inner);
        }
        if (s.kind === 'state') {
            // Each timer is started on entry and cancelled on exit, so a timeout only fires while the state is
            // still active. The cancels come before the exit actions.
            const ms = timers(s);
            if ((s.entry ?? '').trim() || ms.length) {
                out.push(`${inner}<onentry>`);
                script(s.entry ?? '', `${inner}  `);
                ms.forEach(x => out.push(`${inner}  <send${attrs({ event: timerId(s, x), delay: `${x}ms`, id: timerId(s, x) })}/>`));
                out.push(`${inner}</onentry>`);
            }
            if ((s.exit ?? '').trim() || ms.length) {
                out.push(`${inner}<onexit>`);
                ms.forEach(x => out.push(`${inner}  <cancel${attrs({ sendid: timerId(s, x) })}/>`));
                script(s.exit ?? '', `${inner}  `);
                out.push(`${inner}</onexit>`);
            }
            outgoing.forEach(t => transition(t, s, inner));
        }
        // Children (of the single region, if there is one); initial pseudostates were written as attribute or
        // <initial> element above.
        childrenOf(d, container)
            .filter(k => k.kind !== 'initial')
            .forEach(k => node(k, inner));
        out.push(`${indent}</${tag}>`);
    };

    // Event parameter lists for the machina:events attribute; events without parameters are left out.
    const params = Object.fromEntries(Object.entries(d.events ?? {}).filter(([, p]) => p.trim()));
    out.push(
        `<scxml${attrs({
            xmlns: SCXML_NS,
            'xmlns:machina': MACHINA_NS,
            version: '1.0',
            name: d.name,
            initial: initialAttr(null),
            'machina:namespace': d.namespace || undefined,
            'machina:events': Object.keys(params).length ? JSON.stringify(params) : undefined
        })}>`
    );
    initialElement(null, '  ');
    childrenOf(d, null)
        .filter(k => k.kind !== 'initial')
        .forEach(k => node(k, '  '));
    out.push('</scxml>', '');
    return out.join('\n');
}

/**
 * Parses an SCXML document into a diagram (positions are left to the auto-layout).
 *
 * The import runs in two passes. The first walks the element tree and creates a node for every <state>,
 * <parallel>, <final> and <history>, remembering each by its SCXML id; transitions and initial targets are
 * only collected, because they may refer to states that come later in the document. The second pass creates
 * the initial pseudostates and the transitions.
 *
 * @param text The SCXML document.
 * @returns The diagram (all positions zero, to be laid out by the caller) and any warnings.
 * @throws Error when the XML is malformed (see `parseXml`) or the root element is not <scxml>.
 */
export function importScxml(text: string): { diagram: Diagram; warnings: string[] } {
    const root = parseXml(text);
    /**
     * True for an SCXML element: one in the SCXML namespace, or in no namespace at all (documents that omit the
     * xmlns declaration are accepted). Elements of other vocabularies, such as `<x:state xmlns:x="urn:other">`,
     * are skipped even when their local name is that of an SCXML element.
     */
    const isScxml = (e: XmlElement) => e.namespace === SCXML_NS || e.namespace === '';
    if (localName(root.name) !== 'scxml' || !isScxml(root)) {
        throw new Error('The root element is not <scxml>.');
    }
    // The diagram name must be an identifier: `\W` removes every non-word character.
    const b = new DiagramBuilder((root.attrs.name ?? '').replace(/\W/g, '') || 'StateMachine');
    const d = b.diagram;
    /** An unprefixed attribute. */
    const attr = (e: XmlElement, name: string): string | undefined => e.attrs[name];
    /**
     * A MachinaState extension attribute: the attribute with the given local name in the MACHINA_NS namespace,
     * whatever prefix the document binds to it. An attribute such as `other:kind` in another namespace (or a
     * `machina:` prefix bound to another URI) is not one.
     */
    const machina = (e: XmlElement, name: string) => attrNS(e, MACHINA_NS, name);
    d.namespace = machina(root, 'namespace') ?? '';
    // machina:events is the JSON object the exporter writes: event name -> parameter list (a string such as
    // `int track`). Anything else is reported and ignored: a value that is not an object drops the whole
    // attribute; an entry whose value is not a string, or whose name is blank, drops that entry. The result is
    // built with Object.fromEntries, which defines own properties, so a key such as `__proto__` cannot change
    // the object's prototype.
    const eventsText = machina(root, 'events');
    if (eventsText !== undefined) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(eventsText);
        } catch {
            b.warnings.push('machina:events is not valid JSON; event parameters ignored');
        }
        if (parsed !== undefined) {
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                b.warnings.push('machina:events is not a JSON object mapping event names to parameter lists; event parameters ignored');
            } else {
                const entries = Object.entries(parsed as Record<string, unknown>);
                const valid = entries.filter(([k, v]) => k.trim() && typeof v === 'string');
                for (const [k] of entries.filter(x => !valid.includes(x))) {
                    b.warnings.push(`machina:events: the parameters of event '${k}' are not a string; ignored`);
                }
                d.events = Object.fromEntries(valid.map(([k, v]) => [k.trim(), v as string]));
            }
        }
    }

    // SCXML id -> created node (regions included, so transitions to them can be resolved).
    const byScxmlId = new Map<string, StateNode>();
    // Transitions to create in the second pass: the source node, the <transition> element and the element that
    // contains it (needed to recognise its own done.state.<id> event).
    const pending: { source: StateNode; element: XmlElement; owner: XmlElement }[] = [];
    // Initial pseudostates to create in the second pass: container id, SCXML id of the target, initial actions.
    const initialTargets: { container: string | null; target: string; actions: string[] }[] = [];
    /** SCXML child elements of `e` with one of the given local names, in document order. */
    const kids = (e: XmlElement, ...names: string[]) => e.children.filter(c => isScxml(c) && names.includes(localName(c.name)));
    /** The hook names called by the executable content of `e` (<onentry>, <onexit>, <transition>). */
    const actionsOf = (e: XmlElement): string[] => {
        const result: string[] = [];
        for (const c of e.children.filter(isScxml)) {
            const n = localName(c.name);
            if (n === 'script') {
                // `a(); b();` gives ['a', 'b'] (see splitActions).
                result.push(...splitActions(c.text));
            } else if (n === 'send' || n === 'cancel') {
                // Timers are recreated from the after(...) transitions.
            } else if (n === 'raise' || n === 'log' || n === 'assign') {
                b.warnings.push(`<${n}> is not supported and was skipped`);
            }
        }
        return result;
    };

    /**
     * Converts the child states of element `e` into nodes inside `container` (a state or region id, or null
     * for the top level) and records the container's initial target.
     */
    const convertChildren = (e: XmlElement, container: string | null) => {
        for (const c of kids(e, 'state', 'parallel', 'final', 'history')) {
            convert(c, container, e);
        }
        if (localName(e.name) === 'parallel') {
            return; // the regions start in their own initial states
        }
        // The initial target, in SCXML's order of precedence: the <initial> element's transition, the `initial`
        // attribute, or else the first child state in document order. Elements without child states (simple
        // states) get none.
        const initialEl = kids(e, 'initial')[0];
        const initialTransition = initialEl && kids(initialEl, 'transition')[0];
        const first = kids(e, 'state', 'parallel', 'final')[0];
        const target = (initialTransition && attr(initialTransition, 'target')) || attr(e, 'initial') || (first && attr(first, 'id'));
        if (target) {
            // The target may be a space-separated list of ids; MachinaState supports a single initial target.
            initialTargets.push({ container, target: target.split(/\s+/)[0], actions: initialTransition ? actionsOf(initialTransition) : [] });
        }
    };
    /**
     * Converts one <state>, <parallel>, <final> or <history> element (child of `parent`) into a node inside
     * `container`, recursing into its children.
     */
    const convert = (e: XmlElement, container: string | null, parent: XmlElement) => {
        const tag = localName(e.name);
        // SCXML ids are optional; an element without one gets a generated id (and name), e.g. `state3`.
        const id = attr(e, 'id') ?? `${tag}${d.states.length}`;
        if (tag === 'history') {
            // The history's default transition is not imported (MachinaState uses the owner's initial state).
            const s = b.addState('history', 'History', container, { deep: attr(e, 'type') === 'deep' });
            byScxmlId.set(id, s);
            return;
        }
        if (tag === 'final') {
            byScxmlId.set(id, b.addState('final', b.uniqueName(id), container));
            return;
        }
        if (localName(parent.name) === 'parallel') {
            // A child state of <parallel> is a region. Its name is the id without the `<parallel id>_` prefix
            // that the exporter adds (unless nothing would remain). Regions carry no behaviour of their own:
            // their transitions are dropped with a warning.
            const prefix = `${attr(parent, 'id') ?? ''}_`;
            const region = b.addState('region', id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : id, container);
            byScxmlId.set(id, region);
            if (kids(e, 'transition').length) {
                b.warnings.push(`transitions of region '${id}' were dropped (regions cannot have transitions)`);
            }
            // A region is entered and exited exactly when its parallel state is (MachinaState does not allow
            // transitions between regions, and the region's own transitions are dropped above), so its
            // <onentry>/<onexit> actions are moved to the parallel state, which is `container` here. Only their
            // order relative to the substates changes: SCXML enters region 1 with its substates before region 2,
            // MachinaState runs the parallel state's entry actions before entering any region. Entry actions go
            // after the state's own (the regions are converted after the state's <onentry>, in document order);
            // exit actions go before the state's own, last region first, because SCXML exits in reverse
            // document order (each region's actions are put in front of those collected so far). The move is
            // reported because of that difference in order.
            const owner = d.states.find(x => x.id === container);
            for (const [tagName, field] of [['onentry', 'entry'], ['onexit', 'exit']] as const) {
                const actions = kids(e, tagName).flatMap(x => actionsOf(x));
                if (owner && actions.length) {
                    DiagramBuilder.appendActions(owner, field, actions, field === 'exit');
                    b.warnings.push(`<${tagName}> actions of region '${id}' were moved to the ${field} actions of '${owner.name}' (regions cannot have actions)`);
                }
            }
            convertChildren(e, region.id);
            return;
        }
        // An ordinary state, a <parallel> (an ordinary state whose children become regions), or a choice point
        // written by the exporter. Ids become state names, made unique; choice points are all named `Choice`.
        const choice = machina(e, 'kind') === 'choice';
        const s = choice ? b.addState('choice', 'Choice', container) : b.addState('state', b.uniqueName(id), container);
        byScxmlId.set(id, s);
        if (!choice) {
            // Several <onentry>/<onexit> blocks are allowed in SCXML; their actions are concatenated.
            kids(e, 'onentry').forEach(x => DiagramBuilder.appendActions(s, 'entry', actionsOf(x)));
            kids(e, 'onexit').forEach(x => DiagramBuilder.appendActions(s, 'exit', actionsOf(x)));
        }
        kids(e, 'transition').forEach(t => pending.push({ source: s, element: t, owner: e }));
        convertChildren(e, s.id);
    };
    convertChildren(root, null);

    // Second pass, part 1: an initial pseudostate per container, with a transition to the recorded target.
    for (const { container, target, actions } of initialTargets) {
        const t = byScxmlId.get(target);
        if (!t) {
            b.warnings.push(`initial target '${target}' not found`);
            continue;
        }
        const init = b.addState('initial', 'Initial', container);
        b.addTransition(init.id, t.id, { action: actions.join('; ') });
    }
    // Second pass, part 2: the transitions.
    for (const { source, element, owner } of pending) {
        // cond="!isLocked()" -> guard `!isLocked`: `\(\s*\)` removes every empty argument list and `^!\s*`
        // closes the gap after a leading negation. Other expressions are kept as text (the analysis reports
        // guards that are not a plain or negated name).
        const condition = (attr(element, 'cond') ?? '').trim();
        const guard = condition.replace(/\(\s*\)/g, '').replace(/^!\s*/, '!');
        const actions = actionsOf(element).join('; ');
        // Only the first of several space-separated targets is used. No target at all means a targetless
        // (internal) transition, which in MachinaState is a self transition with the internal flag.
        const targetId = (attr(element, 'target') ?? '').split(/\s+/)[0];
        const target = targetId ? byScxmlId.get(targetId) : source;
        if (!target) {
            b.warnings.push(`transition target '${targetId}' not found`);
            continue;
        }
        // Internal or external. A targetless transition exits and enters nothing in SCXML, whatever its `type`:
        // that is exactly a MachinaState internal (self) transition. With a target, type="internal" only makes a
        // difference when the source is a compound <state> (one with child states; not a <parallel>) and the
        // target lies strictly inside it: SCXML then does not exit the source (a "local" transition). That has
        // no MachinaState equivalent, so it becomes an external transition, which also exits and re-enters
        // the source, and the difference is reported. In every other case (including type="internal" with
        // the source itself as target) SCXML treats the transition as external, which is what it becomes here.
        const internal = !targetId;
        if (targetId && attr(element, 'type') === 'internal' && localName(owner.name) === 'state' && target !== source) {
            // `target` is strictly inside `source` when `source` is one of its ancestors (through regions too).
            let inside = false;
            for (let p = target.parent; p && !inside; p = d.states.find(x => x.id === p)?.parent ?? null) {
                inside = p === source.id;
            }
            if (inside) {
                b.warnings.push(
                    `transition from '${attr(owner, 'id') ?? source.name}' to '${targetId}' has type="internal"; MachinaState has no local transitions, so it was imported as an external transition (the source state is exited and re-entered)`
                );
            }
        }
        // The `event` attribute is a space-separated list of event descriptors; an empty list means eventless.
        const events = (attr(element, 'event') ?? '').split(/\s+/).filter(Boolean);
        const ownId = attr(owner, 'id');
        /**
         * `timeout.<state id>.<ms>` (the exporter's timer events) back to `after(...)`. `(.+)` is greedy, so the
         * state id may contain dots and `(\d+)` takes the last segment; the state id itself is not checked.
         */
        const timeout = (ev: string) => {
            const m = /^timeout\.(.+)\.(\d+)$/.exec(ev);
            return m ? timeoutEvent(Number(m[2])) : undefined;
        };
        // One MachinaState transition per event descriptor (sharing guard, actions and target). The state's own
        // done.state.<id> event becomes a completion transition (empty event); a timer event becomes after(...);
        // anything else becomes an identifier: `\.\*$` removes a trailing wildcard `.*` and `\W` turns the
        // remaining dots (and other non-word characters) into `_`, so `door.open` becomes `door_open`.
        for (const ev of events.length ? events : ['']) {
            const event = ev === `done.state.${ownId}` ? '' : timeout(ev) ?? ev.replace(/\.\*$/, '').replace(/\W/g, '_');
            b.addTransition(source.id, target.id, { event, guard, action: actions }, internal ? { internal: true } : {});
        }
    }
    return { diagram: d, warnings: b.warnings };
}
