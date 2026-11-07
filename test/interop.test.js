// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// PlantUML / SCXML / Mermaid round trips: exporting an example and importing it again must give a valid
// diagram with exactly the same behaviour (identical engine traces for the same event sequence).
// test/mermaid-render.test.js checks that Mermaid itself renders the exported diagrams.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { CONFIGS, exampleNames, loadExample, testDiagramNames, loadTestDiagram, machineFor, analyze, root } = require('./helpers');
const { runEngine, script, scenarioEvents, postedEvent } = require('./engine-harness');
const { exportPlantUml, importPlantUml } = require(path.join(root, 'out', 'interop', 'plantuml.js'));
const { exportScxml, importScxml } = require(path.join(root, 'out', 'interop', 'scxml.js'));
const { exportMermaid, importMermaid, mermaidMarkdown, decodeMermaidText } = require(path.join(root, 'out', 'interop', 'mermaid.js'));
const { parseXml, decodeEntities, attrNS } = require(path.join(root, 'out', 'interop', 'xml.js'));
const { splitActions, detectFormat } = require(path.join(root, 'out', 'interop', 'common.js'));
const { autoLayout } = require(path.join(root, 'out', 'layout.js'));

const formats = {
    PlantUML: { exporter: exportPlantUml, importer: importPlantUml },
    SCXML: { exporter: exportScxml, importer: importScxml },
    Mermaid: { exporter: exportMermaid, importer: importMermaid }
};

// The examples in every format; the test-only diagrams (deep history in regions, const parameters) in Mermaid.
const roundTrips = [
    ...exampleNames().flatMap(name => Object.keys(formats).map(format => [format, name, () => loadExample(name)])),
    ...testDiagramNames().map(name => ['Mermaid', name, () => loadTestDiagram(name)])
];
for (const [format, name, load] of roundTrips) {
    const { exporter, importer } = formats[format];
    {
        test(`${format} round trip of ${name}`, () => {
            const original = load();
            const text = exporter(original);
            const { diagram, warnings } = importer(text);
            assert.deepEqual(warnings, []);
            const { issues } = analyze(JSON.parse(JSON.stringify(diagram)));
            assert.deepEqual(issues, [], text);
            const before = machineFor(original, CONFIGS.full, 'X');
            const after = machineFor(diagram, CONFIGS.full, 'X');
            const options = { directed: script(before, 120, scenarioEvents(original)).map(s => s.event), posted: postedEvent(before) };
            assert.equal(runEngine(after, 0, options), runEngine(before, 0, options), text);
        });
    }
}

test('SCXML export is well-formed and uses parallel states for regions', () => {
    const xml = exportScxml(loadExample('Washer'));
    const rootElement = parseXml(xml);
    assert.equal(rootElement.name, 'scxml');
    assert.match(xml, /<parallel id="Running">/);
    assert.match(xml, /<send event="timeout\.Washing\.30000" delay="30000ms"/);
});

test('PlantUML import of hand-written diagrams', () => {
    const { diagram, warnings } = importPlantUml(`@startuml Door
' a comment
skinparam monochrome true
[*] --> Closed
state Closed : entry / lockDoor
Closed --> Open : Push [isUnlocked] / beep
Open -right-> Closed : after(5s)
state Open {
  [*] --> Swinging
  Swinging --> [*]
}
note left of Open
  multi-line note
end note
Open --> Closed
@enduml`);
    assert.deepEqual(warnings, []);
    const { machine, issues } = analyze(JSON.parse(JSON.stringify(diagram)));
    assert.deepEqual(issues, []);
    assert.equal(machine.name, 'Door');
    assert.deepEqual(machine.states.map(s => s.name).sort(), ['Closed', 'Final', 'Open', 'Swinging']);
    assert.deepEqual(machine.timers.map(t => t.event), ['Open_After5000ms']);
    assert.ok(machine.transitions.some(t => t.kind === 'completion' && t.source.name === 'Open'));
});

test('SCXML import of a hand-written document', () => {
    const { diagram, warnings } = importScxml(`<?xml version="1.0"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" initial="off" name="Lamp">
  <state id="off">
    <transition event="toggle" target="on"/>
  </state>
  <state id="on">
    <onentry><script>lightOn();</script></onentry>
    <onexit><script>lightOff();</script></onexit>
    <transition event="toggle" cond="!isLocked()" target="off"/>
    <transition event="dim" type="internal"><script>dim();</script></transition>
  </state>
</scxml>`);
    assert.deepEqual(warnings, []);
    const { machine, issues } = analyze(JSON.parse(JSON.stringify(diagram)));
    assert.deepEqual(issues, []);
    assert.deepEqual(machine.actions.sort(), ['dim', 'lightOff', 'lightOn']);
    assert.ok(machine.transitions.some(t => t.internal && t.event === 'dim'));
    assert.ok(machine.transitions.some(t => t.guard && t.guard.negate && t.guard.name === 'isLocked'));
});

test('auto-layout places every state inside its parent', async () => {
    for (const name of exampleNames()) {
        const d = loadExample(name);
        await autoLayout(d);
        const byId = new Map(d.states.map(s => [s.id, s]));
        for (const s of d.states) {
            assert.ok(s.w > 0 && s.h > 0, `${name}/${s.name} has no size`);
            const p = s.parent && byId.get(s.parent);
            if (p) {
                assert.ok(s.x >= p.x && s.y >= p.y && s.x + s.w <= p.x + p.w && s.y + s.h <= p.y + p.h, `${name}/${s.name} outside ${p.name}`);
            }
        }
        // Siblings must not overlap.
        for (const a of d.states) {
            for (const b of d.states) {
                if (a !== b && a.parent === b.parent) {
                    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
                    assert.ok(!overlap, `${name}: ${a.name} overlaps ${b.name}`);
                }
            }
        }
        assert.deepEqual(analyze(JSON.parse(JSON.stringify(d))).issues, []);
    }
});

// ---------------------------------------------------------------------------------------------------------------
// Regression tests for specific import/export details.

/** A node for a hand-built diagram (name = id, no geometry). */
const node = (id, kind, parent = null, extra = {}) => ({ id, name: id, kind, parent, x: 0, y: 0, w: 0, h: 0, ...(kind === 'state' ? { entry: '', exit: '' } : {}), ...extra });
/** A transition for a hand-built diagram. */
const edge = (id, source, target, event = '', extra = {}) => ({ id, source, target, event, guard: '', action: '', ...extra });
/** Region names per owning state name, e.g. { Running: ['Program', 'Heater'] }, for comparing diagrams. */
const regionNames = d => {
    const byId = new Map(d.states.map(s => [s.id, s]));
    const result = {};
    for (const r of d.states.filter(s => s.kind === 'region')) {
        (result[byId.get(r.parent).name] ??= []).push(r.name);
    }
    return result;
};

test('region names survive PlantUML and SCXML round trips', () => {
    const d = {
        name: 'Regions',
        namespace: '',
        events: {},
        states: [
            node('init', 'initial'),
            node('Run', 'state'),
            node('rA', 'region', 'Run', { name: 'Alpha' }),
            node('rB', 'region', 'Run', { name: 'Beta' }),
            node('rC', 'region', 'Run', { name: 'Gamma' }),
            node('iA', 'initial', 'rA'),
            node('A1', 'state', 'rA'),
            node('iB', 'initial', 'rB'),
            node('B1', 'state', 'rB'),
            node('iC', 'initial', 'rC'),
            node('C1', 'state', 'rC')
        ],
        transitions: [edge('t0', 'init', 'Run'), edge('t1', 'iA', 'A1'), edge('t2', 'iB', 'B1'), edge('t3', 'iC', 'C1'), edge('t4', 'A1', 'A1', 'Go')]
    };
    for (const original of [d, loadExample('Washer')]) {
        for (const [format, { exporter, importer }] of Object.entries(formats)) {
            const { diagram, warnings } = importer(exporter(original));
            assert.deepEqual(warnings, [], format);
            assert.deepEqual(regionNames(diagram), regionNames(original), format);
        }
    }
});

test('PlantUML import: a region comment names the region it is in', () => {
    const { diagram, warnings } = importPlantUml(`@startuml
state S {
  ' @region First
  [*] --> A
  --
  ' @region Second
  [*] --> B
  --
  [*] --> C
}
[*] --> S
@enduml`);
    assert.deepEqual(warnings, []);
    assert.deepEqual(regionNames(diagram), { S: ['First', 'Second', 'Region3'] });
});

test('XML character references to characters that XML does not allow are parse errors', () => {
    assert.equal(decodeEntities('&#x41;&#66;&#x1F600;&amp;&unknown;'), 'AB\u{1F600}&&unknown;');
    for (const ref of ['&#x110000;', '&#0;', '&#xD800;', '&#xFFFE;', '&#1;', '&#99999999999999999999999;']) {
        assert.throws(() => decodeEntities(`a${ref}`), { message: `invalid character reference ${ref}` });
        assert.throws(() => parseXml(`<a>\n<b>x${ref}</b></a>`), { message: `XML line 2: invalid character reference ${ref}` });
        assert.throws(() => parseXml(`<a>\n<b\n c="${ref}"/></a>`), { message: `XML line 3: invalid character reference ${ref}` });
    }
    // Tab, line feed and carriage return are allowed.
    assert.equal(parseXml('<a b="&#9;&#xA;&#13;"/>').attrs.b, '\t\n\r');
});

test('XML reader skips a DOCTYPE with an internal subset and reports unterminated end tags', () => {
    const doc = parseXml(`<?xml version="1.0"?>
<!DOCTYPE scxml [
  <!ENTITY x "a > b">
  <!-- a comment with > and ] and ' -->
  <!ELEMENT scxml ANY>
]>
<scxml><state id="s"/></scxml>`);
    assert.equal(doc.name, 'scxml');
    assert.equal(doc.children[0].attrs.id, 's');
    assert.equal(parseXml('<!DOCTYPE a SYSTEM "x>y.dtd"><a/>').name, 'a');
    assert.throws(() => parseXml('<a></a'), { message: 'XML line 1: unterminated end tag' });
    assert.throws(() => parseXml('<a>\n</a\n'), { message: 'XML line 2: unterminated end tag' });
    assert.throws(() => parseXml('<a><b></b <c/>></a>'), { message: 'XML line 1: malformed end tag' });
    assert.throws(() => parseXml('<a></b>'), { message: 'XML line 1: unexpected </b>' });
    assert.throws(() => parseXml('<!DOCTYPE a [ <!ENTITY x "y">\n<a/>'), { message: 'XML line 1: unterminated <!' });
});

test('XML reader resolves namespace prefixes with scoping', () => {
    const doc = parseXml(`<r xmlns="urn:d" xmlns:p="urn:p1" p:a="1" b="2">
  <p:x xmlns:p="urn:p2" p:a="3"><y p:a="4"/></p:x>
  <z xmlns="" p:a="5"/>
</r>`);
    assert.equal(doc.namespace, 'urn:d');
    assert.equal(attrNS(doc, 'urn:p1', 'a'), '1');
    // Unprefixed attributes are in no namespace, not in the default namespace.
    assert.equal(attrNS(doc, '', 'b'), '2');
    assert.equal(attrNS(doc, 'urn:d', 'b'), undefined);
    const [x, z] = doc.children;
    assert.equal(x.namespace, 'urn:p2');
    assert.equal(attrNS(x, 'urn:p2', 'a'), '3');
    assert.equal(attrNS(x, 'urn:p1', 'a'), undefined);
    // The inner binding of `p` applies to the descendants of <p:x> too, and the default namespace is inherited.
    assert.equal(x.children[0].namespace, 'urn:d');
    assert.equal(attrNS(x.children[0], 'urn:p2', 'a'), '4');
    // Outside <p:x> the outer binding is back; xmlns="" removes the default namespace.
    assert.equal(z.namespace, '');
    assert.equal(attrNS(z, 'urn:p1', 'a'), '5');
    assert.deepEqual(doc.nsAttrs.map(a => a.local), ['a', 'b']);
    assert.equal(attrNS(parseXml('<a xml:lang="en"/>'), 'http://www.w3.org/XML/1998/namespace', 'lang'), 'en');
    assert.throws(() => parseXml('<a>\n<b q:c="1"/></a>'), { message: "XML line 2: undeclared namespace prefix 'q' in 'q:c'" });
    assert.throws(() => parseXml('<q:a/>'), { message: "XML line 1: undeclared namespace prefix 'q' in 'q:a'" });
    assert.throws(() => parseXml('<a><b xmlns:q="urn:q"/><q:c/></a>'), /undeclared namespace prefix 'q'/);
});

test('SCXML import honours machina attributes only in the MachinaState namespace', () => {
    const doc = (decl, prefix) => `<scxml xmlns="http://www.w3.org/2005/07/scxml" ${decl} ${prefix}:namespace="Ns" initial="a">
  <state id="a"><transition event="go" target="c"/></state>
  <state id="c" ${prefix}:kind="choice"><transition cond="ok()" target="a"/><transition target="b"/></state>
  <state id="b"/>
</scxml>`;
    // Any prefix bound to the MachinaState namespace works.
    const ok = importScxml(doc('xmlns:m="urn:machinastate:scxml"', 'm'));
    assert.deepEqual(ok.warnings, []);
    assert.equal(ok.diagram.namespace, 'Ns');
    assert.ok(ok.diagram.states.some(s => s.kind === 'choice'));
    // The `machina` prefix bound to another namespace, or another prefix, is not MachinaState's.
    for (const [decl, prefix] of [['xmlns:machina="urn:other"', 'machina'], ['xmlns:o="urn:other"', 'o']]) {
        const { diagram } = importScxml(doc(decl, prefix));
        assert.equal(diagram.namespace, '');
        assert.ok(!diagram.states.some(s => s.kind === 'choice'));
        assert.ok(diagram.states.some(s => s.kind === 'state' && s.name === 'c'));
    }
    // A prefix that is not declared at all makes the document malformed.
    assert.throws(() => importScxml(doc('', 'machina')), /undeclared namespace prefix 'machina'/);
    // Elements of other vocabularies are not SCXML elements, even with SCXML local names.
    const foreign = importScxml(`<s:scxml xmlns:s="http://www.w3.org/2005/07/scxml" xmlns:x="urn:other" initial="a">
  <s:state id="a"><s:onentry><s:script>go();</s:script><x:script>no();</x:script></s:onentry></s:state>
  <x:state id="b"/>
</s:scxml>`);
    assert.deepEqual(foreign.diagram.states.filter(s => s.kind === 'state').map(s => [s.name, s.entry]), [['a', 'go']]);
    assert.throws(() => importScxml('<scxml xmlns="urn:other"/>'), /not <scxml>/);
});

test('SCXML import maps type="internal" transitions as closely as possible', () => {
    const { diagram, warnings } = importScxml(`<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="p">
  <state id="p" initial="a">
    <transition event="toChild" type="internal" target="b"/>
    <transition event="self" type="internal" target="p"/>
    <transition event="stay" type="internal"><script>count();</script></transition>
    <transition event="stay2"/>
    <state id="a"><transition event="sib" type="internal" target="b"/></state>
    <state id="b"/>
  </state>
</scxml>`);
    const byId = new Map(diagram.states.map(s => [s.id, s]));
    const find = ev => diagram.transitions.find(t => t.event === ev);
    const ends = t => [byId.get(t.source).name, byId.get(t.target).name];
    // A local transition (compound source, target inside it) cannot be represented: external, with a warning.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /from 'p' to 'b' has type="internal"/);
    assert.deepEqual(ends(find('toChild')), ['p', 'b']);
    assert.ok(!find('toChild').internal);
    // type="internal" targeting the source itself, or from an atomic state, is external in SCXML too.
    assert.deepEqual(ends(find('self')), ['p', 'p']);
    assert.ok(!find('self').internal);
    assert.deepEqual(ends(find('sib')), ['a', 'b']);
    assert.ok(!find('sib').internal);
    // Targetless transitions are internal self transitions, with or without type="internal".
    for (const ev of ['stay', 'stay2']) {
        assert.deepEqual(ends(find(ev)), ['p', 'p']);
        assert.equal(find(ev).internal, true);
    }
    assert.equal(find('stay').action, 'count');
    assert.deepEqual(analyze(JSON.parse(JSON.stringify(diagram))).issues, []);
});

test('SCXML import moves region entry/exit actions to the parallel state', () => {
    const { diagram, warnings } = importScxml(`<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="P">
  <parallel id="P">
    <onentry><script>pIn();</script></onentry>
    <onexit><script>pOut();</script></onexit>
    <state id="P_R1"><onentry><script>r1In();</script></onentry><onexit><script>r1Out();</script></onexit><state id="a"/></state>
    <state id="P_R2"><onentry><script>r2In();</script></onentry><onexit><script>r2Out();</script></onexit><state id="b"/></state>
  </parallel>
</scxml>`);
    const p = diagram.states.find(s => s.name === 'P');
    // Entry in document order after the state's own; exit in reverse document order before the state's own.
    assert.equal(p.entry, 'pIn; r1In; r2In');
    assert.equal(p.exit, 'r2Out; r1Out; pOut');
    assert.equal(warnings.length, 4);
    assert.ok(warnings.every(w => /region 'P_R\d' were moved to the (entry|exit) actions of 'P'/.test(w)), warnings.join('\n'));
    assert.deepEqual(regionNames(diagram), { P: ['R1', 'R2'] });
    assert.deepEqual(analyze(JSON.parse(JSON.stringify(diagram))).issues, []);
});

test('SCXML export keeps fallback ids sanitised', () => {
    // The region id `Run_My_Region` is taken by a state, so the region needs a numbered id.
    const d = {
        name: 'Ids',
        namespace: '',
        events: {},
        states: [
            node('init', 'initial'),
            node('Run', 'state'),
            node('rA', 'region', 'Run', { name: 'My Region' }),
            node('rB', 'region', 'Run', { name: 'Other' }),
            node('iA', 'initial', 'rA'),
            node('Run_My_Region', 'state', 'rA'),
            node('iB', 'initial', 'rB'),
            node('B1', 'state', 'rB')
        ],
        transitions: [edge('t0', 'init', 'Run'), edge('t1', 'iA', 'Run_My_Region'), edge('t2', 'iB', 'B1')]
    };
    const ids = [];
    const walk = e => {
        if (e.attrs.id) {
            ids.push(e.attrs.id);
        }
        e.children.forEach(walk);
    };
    walk(parseXml(exportScxml(d)));
    assert.ok(ids.includes('Run_My_Region_1'), ids.join(' '));
    assert.ok(ids.every(id => /^[\w.-]+$/.test(id)), ids.join(' '));
    assert.equal(new Set(ids).size, ids.length);
});

test('PlantUML import skips single-line and unterminated notes', () => {
    const { diagram, warnings } = importPlantUml(`@startuml
[*] --> A
note left of A : a single-line note
note right of "A" #yellow : another one
note "a floating note" as N1
note on link : about the link
A --> B : Go
note as N2
  this note is never closed
B --> A : Back
@enduml`);
    assert.deepEqual(warnings, ["line 8: note without 'end note' ignored: note as N2", 'line 9: not understood: this note is never closed']);
    // The lines after the unterminated note are still read.
    assert.deepEqual(diagram.states.filter(s => s.kind === 'state').map(s => s.name).sort(), ['A', 'B']);
    assert.deepEqual(diagram.transitions.map(t => t.event).filter(Boolean).sort(), ['Back', 'Go']);
    const legend = importPlantUml('@startuml\n[*] --> A\nlegend right\n  A --> B\nendlegend\n@enduml');
    assert.deepEqual(legend.warnings, []);
    assert.equal(legend.diagram.states.filter(s => s.kind === 'state').length, 1);
});

test('PlantUML import accepts history references to dotted state names', () => {
    const { diagram, warnings } = importPlantUml(`@startuml
[*] --> Outer.Inner
state Outer.Inner {
  [*] --> A
  A --> B : Next
}
state Off
Outer.Inner --> Off : Pause
Off --> Outer.Inner[H*] : Resume
@enduml`);
    assert.deepEqual(warnings, []);
    const owner = diagram.states.find(s => s.name === 'Outer.Inner');
    const history = diagram.states.find(s => s.kind === 'history');
    assert.ok(history && history.deep);
    assert.equal(history.parent, owner.id);
    assert.ok(!diagram.states.some(s => s.name.includes('[')));
});

test('internal transitions with only an event survive a PlantUML round trip', () => {
    const d = {
        name: 'Internal',
        namespace: '',
        events: {},
        states: [node('init', 'initial'), node('A', 'state', null, { entry: 'enterA' }), node('B', 'state')],
        transitions: [
            edge('t0', 'init', 'A'),
            edge('t1', 'A', 'A', 'Tick', { internal: true }),
            edge('t2', 'A', 'A', 'after(2s)', { internal: true }),
            edge('t3', 'A', 'A', 'Poke', { internal: true, guard: 'ready' }),
            edge('t4', 'A', 'B', 'Go')
        ]
    };
    const text = exportPlantUml(d);
    assert.match(text, /^A : Tick \/$/m);
    const { diagram, warnings } = importPlantUml(text);
    assert.deepEqual(warnings, []);
    const internal = diagram.transitions.filter(t => t.internal).map(t => `${t.event}|${t.guard}|${t.action}`).sort();
    assert.deepEqual(internal, ['Poke|ready|', 'Tick||', 'after(2s)||']);
    assert.ok(diagram.transitions.filter(t => t.internal).every(t => t.source === t.target));
    // A bare word is still a free description, not a transition.
    assert.equal(importPlantUml('@startuml\n[*] --> A\nA : Waiting\n@enduml').diagram.transitions.length, 1);
    const before = machineFor(d, CONFIGS.full, 'X');
    const after = machineFor(diagram, CONFIGS.full, 'X');
    const options = { directed: ['Tick', 'Poke', 'Tick', 'Go'] };
    assert.equal(runEngine(after, 0, options), runEngine(before, 0, options));
});

test('action lists split only at top-level separators', () => {
    assert.deepEqual(splitActions('a; b, c()\nd();'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(splitActions('f(a, b); g("x, y; z"), h(), k(\'it\\\'s; ok\'), m([1, 2], {p: 1})'), [
        'f(a, b)',
        'g("x, y; z")',
        'h',
        "k('it\\'s; ok')",
        'm([1, 2], {p: 1})'
    ]);
    assert.deepEqual(splitActions(' ; , '), []);
    // An action with arguments is exported as a call and comes back unchanged.
    const d = {
        name: 'Calls',
        namespace: '',
        events: {},
        states: [node('init', 'initial'), node('A', 'state', null, { entry: 'f(a, b); g' })],
        transitions: [edge('t0', 'init', 'A')]
    };
    const xml = exportScxml(d);
    assert.match(xml, /<script>f\(a, b\); g\(\);<\/script>/);
    assert.equal(importScxml(xml).diagram.states.find(s => s.name === 'A').entry, 'f(a, b); g');
    assert.equal(importPlantUml(exportPlantUml(d)).diagram.states.find(s => s.name === 'A').entry, 'f(a, b); g');
});

// ---------------------------------------------------------------------------------------------------------------
// Mermaid

test('Mermaid export escapes label text, aliases reserved names and keeps colours', () => {
    const d = {
        name: 'Edge cases',
        namespace: 'Ns',
        events: { Go: 'int n' },
        states: [
            node('init', 'initial'),
            node('A', 'state', null, { entry: 'f(a, b); g', color: '#E06C75' }),
            node('n1', 'state', null, { name: 'Note', exit: 'h' }),
            node('n2', 'state', null, { name: 'state' }),
            node('F1', 'final', null, { name: 'Done' }),
            node('F2', 'final', null, { name: 'Aborted' })
        ],
        transitions: [
            edge('t0', 'init', 'A', '', { action: 'boot' }),
            edge('t1', 'A', 'n1', 'Go', { guard: 'n > 1 && n < 9', action: 'x; y' }),
            edge('t2', 'n1', 'n2', 'after(2s)'),
            edge('t3', 'n2', 'F1', 'Finish'),
            edge('t4', 'n2', 'F2', 'Abort'),
            edge('t5', 'A', 'A', 'Tick', { internal: true })
        ]
    };
    const text = exportMermaid(d);
    assert.match(text, /^---\ntitle: "Edge cases"\n---\nstateDiagram-v2\n/);
    assert.match(text, /A --> Note_1 : Go \[n #62; 1 && n #60; 9\] \/ x#59; y$/m);
    assert.match(text, /^ {2}state "A" as A\n {2}A : entry \/ f\(a, b\)#59; g\n {2}A : Tick \/$/m);
    assert.match(text, /^ {2}state "Note" as Note_1$/m);
    assert.match(text, /^ {2}state "state" as state_1$/m);
    assert.match(text, /^ {2}%% @end Done\n {2}state_1 --> \[\*\] : Finish$/m);
    assert.match(text, /^ {2}%% @final Aborted\n {2}Aborted$/m);
    assert.match(text, /^ {2}classDef color_e06c75 fill:#e06c7538,stroke:#e06c75\n {2}class A color_e06c75$/m);
    // Nothing outside comments and the front matter uses a raw `;`.
    assert.ok(text.split('\n').filter(l => !/^\s*%%/.test(l)).every(l => !l.includes(';') || /#\d+;/.test(l)), text);

    const { diagram, warnings } = importMermaid(text);
    assert.deepEqual(warnings, []);
    assert.equal(diagram.name, 'EdgeCases');
    assert.equal(diagram.namespace, 'Ns');
    assert.deepEqual(diagram.events, { Go: 'int n' });
    const byName = n => diagram.states.find(s => s.name === n);
    assert.equal(byName('A').entry, 'f(a, b); g');
    assert.equal(byName('A').color, '#e06c75');
    assert.equal(byName('Note').exit, 'h');
    assert.ok(byName('state'));
    assert.deepEqual(diagram.states.filter(s => s.kind === 'final').map(s => s.name).sort(), ['Aborted', 'Done']);
    const go = diagram.transitions.find(t => t.event === 'Go');
    assert.deepEqual([go.guard, go.action], ['n > 1 && n < 9', 'x; y']);
    assert.equal(diagram.transitions.find(t => byName('A').id === t.target && diagram.states.find(s => s.id === t.source).kind === 'initial').action, 'boot');
    assert.ok(diagram.transitions.some(t => t.internal && t.event === 'Tick'));
});

test('Mermaid export writes composite state actions as a note and history as a marked state', () => {
    const text = exportMermaid(loadExample('MediaPlayer'));
    assert.match(text, /^ {2}%% @describe Active\n {2}note right of Active\n {4}entry \/ powerOnAmp\n {4}exit \/ powerOffAmp\n {2}end note$/m);
    assert.match(text, /^ {4}%% @history Active_H\n {4}state "H" as Active_H$/m);
    assert.match(text, /^ {2}Stopped --> Active_H : Resume$/m);
    assert.equal(mermaidMarkdown(text), '```mermaid\n' + text + '```\n');
});

test('Mermaid import of a hand-written diagram', () => {
    const { diagram, warnings } = importMermaid(`%%{init: {"theme": "dark"}}%%
---
title: Traffic light
config:
  look: handDrawn
---
stateDiagram-v2
    direction LR
    accTitle: A traffic light
    accDescr {
        Red, green and yellow
    }
    %% an ordinary comment
    [*] --> Red
    state "Green light" as Green
    Red --> Green : Timer
    Green --> Yellow : Timer [!rush] / beep#59; blink
    Yellow:::warn --> Red : Timer
    Red : entry / redOn
    Red : Shows the colour red
    note right of Red : stop
    note left of Yellow
        careful
    end note
    state Maintenance {
        [*] --> Checking
        Checking --> [*]
    }
    Red --> Maintenance : Service
    Maintenance --> Red
    state split <<fork>>
    classDef warn fill:#e5c07b,color:black
    style Red fill:#f00
    click Red "https://example.com"
`);
    assert.deepEqual(warnings, ["line 31: MachinaState has no fork pseudostate; 'split' imported as a state"]);
    assert.equal(diagram.name, 'TrafficLight');
    const byName = n => diagram.states.find(s => s.name === n);
    // "Green light" is not an identifier, so the state keeps its id.
    assert.ok(byName('Green'));
    assert.equal(byName('Red').entry, 'redOn');
    assert.equal(byName('Yellow').color, '#e5c07b');
    assert.equal(byName('Checking').parent, byName('Maintenance').id);
    const beep = diagram.transitions.find(t => t.guard === '!rush');
    assert.equal(beep.action, 'beep; blink');
    // The prose description line adds nothing.
    assert.equal(diagram.transitions.filter(t => t.source === byName('Red').id).length, 2);
    const { issues } = analyze(JSON.parse(JSON.stringify({ ...diagram, states: diagram.states.filter(s => s.name !== 'split') })));
    assert.deepEqual(issues, []);
});

test('Mermaid import reads the first state diagram of a Markdown document', () => {
    const md = `# Door

Some text.

\`\`\`mermaid
flowchart LR
  a --> b
\`\`\`

\`\`\`mermaid
stateDiagram-v2
  [*] --> Closed
  Closed --> Open : Push
\`\`\`

~~~mermaid
stateDiagram
  [*] --> X
~~~
`;
    const { diagram, warnings } = importMermaid(md);
    assert.deepEqual(warnings, ['the document holds 2 state diagrams; only the first was imported']);
    assert.deepEqual(diagram.states.filter(s => s.kind === 'state').map(s => s.name).sort(), ['Closed', 'Open']);
    assert.equal(importMermaid(mermaidMarkdown(exportMermaid(loadExample('Washer')))).diagram.name, 'Washer');
    assert.throws(() => importMermaid('flowchart LR\n  a --> b'), /Not a Mermaid state diagram/);
    assert.throws(() => importMermaid('stateDiagram-v2\n  %% nothing'), /No states found/);
});

test('Mermaid entity codes are decoded', () => {
    assert.equal(decodeMermaidText('a#59; b #35;1 #lt;x#gt; #x3B; #quot;q#quot; #unknown; #0; #9999999;'), 'a; b #1 <x> ; "q" #unknown; #0; #9999999;');
});

test('import format detection', () => {
    assert.equal(detectFormat('/a/door.puml', ''), 'plantuml');
    assert.equal(detectFormat('/a/door.scxml', ''), 'scxml');
    assert.equal(detectFormat('/a/door.mmd', ''), 'mermaid');
    assert.equal(detectFormat('/a/README.md', ''), 'mermaid');
    assert.equal(detectFormat('/a/door.xml', '<?xml version="1.0"?><scxml/>'), 'scxml');
    assert.equal(detectFormat('/a/door.txt', '@startuml\n[*] --> A\n@enduml'), 'plantuml');
    assert.equal(detectFormat('/a/door.txt', '---\ntitle: X\n---\n%% c\nstateDiagram-v2\n'), 'mermaid');
    assert.equal(detectFormat('/a/door.txt', 'text\n```mermaid\nstateDiagram\n```'), 'mermaid');
    assert.equal(detectFormat('/a/door', '[*] --> A'), 'plantuml');
});

test('SCXML import validates machina:events', () => {
    const doc = events => `<scxml xmlns="http://www.w3.org/2005/07/scxml" xmlns:machina="urn:machinastate:scxml" machina:events='${events}' initial="a">
  <state id="a"><transition event="Play" target="a"/></state>
</scxml>`;
    const ok = importScxml(doc('{"Play":"int track","Stop":""}'));
    assert.deepEqual(ok.warnings, []);
    assert.deepEqual(ok.diagram.events, { Play: 'int track', Stop: '' });
    for (const bad of ['[1,2]', 'null', '"text"', '42']) {
        const { diagram, warnings } = importScxml(doc(bad));
        assert.deepEqual(diagram.events, {}, bad);
        assert.equal(warnings.length, 1, bad);
        assert.match(warnings[0], /not a JSON object/);
    }
    const mixed = importScxml(doc('{"Play":"int track","Seek":5,"Skip":{"a":1},"__proto__":"int x"}'));
    assert.deepEqual(mixed.warnings, ["machina:events: the parameters of event 'Seek' are not a string; ignored", "machina:events: the parameters of event 'Skip' are not a string; ignored"]);
    assert.deepEqual(Object.keys(mixed.diagram.events), ['Play', '__proto__']);
    assert.equal(Object.getPrototypeOf(mixed.diagram.events), Object.prototype);
    assert.deepEqual(importScxml(doc('{oops')).warnings, ['machina:events is not valid JSON; event parameters ignored']);
});
