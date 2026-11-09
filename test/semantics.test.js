// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Stateflow semantics (Diagram.semantics = 'stateflow'): analysis rules, the file format version, and the
// engine's outer-first dispatch, during actions and step-counted after(). The generated code is checked
// against the engine by compile.test.js (test/diagrams/StateflowLab.machina).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { analyze, root } = require('./helpers');
const { parseDiagram, FORMAT_VERSION } = require(path.join(root, 'out', 'model.js'));
const { Engine } = require(path.join(root, 'out', 'engine.js'));

/** A diagram from compact lists: states as [id, parent, extra], transitions as [source, target, event, guard, action, extra]. */
function diagram(states, transitions, extra = {}) {
    return {
        name: 'M',
        states: states.map(([id, parent, more = {}]) => ({ id, name: id.startsWith('i_') ? '' : id, kind: id.startsWith('i_') ? 'initial' : 'state', parent, x: 0, y: 0, w: 0, h: 0, ...more })),
        transitions: transitions.map(([source, target, event = '', guard = '', action = '', more = {}], i) => ({ id: `t${i}`, source, target, event, guard, action, ...more })),
        ...extra
    };
}
const SF = { semantics: 'stateflow', step: { event: 'Step', periodMs: 10 } };
const messages = d => analyze(d).issues.map(i => i.message);

/** Runs the engine over `events`, logging guard calls (all true unless listed in `falseGuards`) and actions. */
function run(d, events, falseGuards = []) {
    const { machine, issues } = analyze(d);
    assert.deepEqual(issues, []);
    const log = [];
    const engine = new Engine(machine, {
        guard: name => (log.push(`?${name}`), !falseGuards.includes(name)),
        action: name => log.push(name)
    });
    engine.start();
    for (const e of events) {
        engine.dispatch(e);
        log.push(`| ${engine.activeStates().map(s => s.name).join(',')}`);
    }
    return log;
}

// Parent P (with during action) contains child C; both react to Step.
const NESTED = [
    [['i_0', null], ['P', null, { during: 'pDuring' }], ['i_1', 'P'], ['C', 'P', { during: 'cDuring' }], ['D', 'P'], ['Q', null]],
    [['i_0', 'P'], ['i_1', 'C'], ['P', 'Q', 'Step', 'leave'], ['C', 'D', 'Step', 'next']]
];

test('semantics: during actions and after(n steps) need Stateflow semantics', () => {
    const [states, transitions] = NESTED;
    assert.ok(messages(diagram(states, transitions)).some(m => /during actions need Stateflow semantics/.test(m)));
    const steps = diagram([['i_0', null], ['A', null], ['B', null]], [['i_0', 'A'], ['A', 'B', 'after(3 steps)']]);
    assert.ok(messages(steps).some(m => /needs Stateflow semantics/.test(m)));
    assert.deepEqual(messages({ ...steps, ...SF }), []);
});

test('semantics: Stateflow settings are validated', () => {
    const base = diagram([['i_0', null], ['A', null], ['B', null]], [['i_0', 'A'], ['A', 'B', 'after(25ms)']]);
    assert.ok(messages({ ...base, semantics: 'stateflow' }).some(m => /needs a step period/.test(m)));
    assert.ok(messages({ ...base, semantics: 'bogus' }).some(m => /Unknown semantics/.test(m)));
    assert.ok(messages({ ...base, ...SF, step: { event: 'Completion', periodMs: 10 } }).some(m => /Step event 'Completion'/.test(m)));
    assert.ok(messages({ ...base, ...SF, step: { periodMs: -1 } }).some(m => /step period must be a positive number/.test(m)));
    assert.ok(messages({ ...base, ...SF, events: { Step: 'int n' } }).some(m => /step event 'Step' cannot have parameters/.test(m)));
    // after(25ms) at 10 ms per step is rounded up to 3 steps; the step event exists and comes first.
    const { machine } = analyze({ ...base, ...SF });
    assert.equal(machine.transitions[0].kind, 'temporal');
    assert.equal(machine.transitions[0].ticks, 3);
    assert.deepEqual(machine.events, ['Step']);
    assert.equal(machine.timers.length, 0);
    // Under UML semantics the same diagram has a timer and no step event.
    const uml = analyze(base).machine;
    assert.equal(uml.semantics, 'uml');
    assert.deepEqual(uml.events, ['A_After25ms']);
    assert.equal(uml.stepEvent, undefined);
});

test('semantics: the format version is kept, and newer versions are refused', () => {
    const d = parseDiagram(JSON.stringify({ formatVersion: 2, semantics: 'stateflow', step: { event: 'Tick' }, hooks: { g: { code: 'x > 1' } }, data: [{ name: 'x', scope: 'input', type: 'double' }], name: 'M' }));
    assert.equal(d.formatVersion, 2);
    assert.equal(d.semantics, 'stateflow');
    assert.deepEqual(d.step, { event: 'Tick' });
    assert.deepEqual(d.hooks, { g: { code: 'x > 1' } });
    assert.equal(d.data.length, 1);
    assert.throws(() => parseDiagram(JSON.stringify({ formatVersion: FORMAT_VERSION + 1, name: 'M' })), /format version 3/);
    // A plain UML file gets none of the new members.
    assert.deepEqual(Object.keys(parseDiagram('{"name":"M"}')).sort(), ['codegen', 'events', 'name', 'namespace', 'scenarios', 'states', 'transitions']);
});

test('semantics: UML dispatches innermost first', () => {
    const [states, transitions] = NESTED;
    const uml = diagram(states.map(([id, parent]) => [id, parent]), transitions);
    // C handles Step (C -> D) and the parent never sees it.
    assert.deepEqual(run(uml, ['Step']), ['?next', '| P,D']);
});

test('semantics: Stateflow dispatches outer first, then during actions, then the substates', () => {
    const [states, transitions] = NESTED;
    const d = diagram(states, transitions, SF);
    // P's own transition is tried first and wins: C's guard is never asked and no during action runs.
    assert.deepEqual(run(d, ['Step']), ['?leave', '| Q']);
    // When P's transition is not enabled, P's during action runs, then C is offered the event.
    assert.deepEqual(run(d, ['Step'], ['leave']), ['?leave', 'pDuring', '?next', '| P,D']);
    // When nothing fires, every active state runs its during action after trying its own transitions, outer
    // first.
    assert.deepEqual(run(d, ['Step'], ['leave', 'next']), ['?leave', 'pDuring', '?next', 'cDuring', '| P,C']);
});

test('semantics: after(n steps) counts step events since the state was entered', () => {
    const d = diagram(
        [['i_0', null], ['A', null], ['B', null]],
        [['i_0', 'A'], ['A', 'B', 'after(2 steps)'], ['B', 'A', 'Go'], ['A', 'A', 'Poke', '', 'poked', { internal: true }]],
        SF
    );
    // Other events do not count; the second step fires the transition.
    assert.deepEqual(run(d, ['Poke', 'Step', 'Poke', 'Step']), ['poked', '| A', '| A', 'poked', '| A', '| B']);
    // Re-entering A starts counting again: the step during which A is entered does not count.
    assert.deepEqual(run(d, ['Step', 'Step', 'Go', 'Step', 'Step']), ['| A', '| B', '| A', '| A', '| B']);
});
