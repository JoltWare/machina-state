// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, parseDiagram, exampleNames, loadExample } = require('./helpers');

const S = (id, kind = 'state', parent = null, extra = {}) => ({ id, name: id, kind, parent, x: 0, y: 0, w: 10, h: 10, ...extra });
const T = (id, source, target, event = '', extra = {}) => ({ id, source, target, event, guard: '', action: '', ...extra });

/** Minimal valid diagram: Initial -> A, with optional extra states/transitions. */
function diagram(states = [], transitions = [], extra = {}) {
    return {
        name: 'M',
        namespace: '',
        states: [S('i0', 'initial'), S('A'), ...states],
        transitions: [T('t0', 'i0', 'A'), ...transitions],
        ...extra
    };
}

const messages = d => analyze(d).issues.map(i => i.message);
const hasIssue = (d, pattern) => messages(d).some(m => pattern.test(m));

test('all shipped examples are valid', () => {
    for (const name of exampleNames()) {
        const { machine, issues } = analyze(loadExample(name));
        assert.deepEqual(issues, [], name);
        assert.ok(machine, name);
    }
});

test('parseDiagram fills defaults and rejects non-objects', () => {
    const d = parseDiagram('{}');
    assert.equal(d.name, 'StateMachine');
    assert.deepEqual(d.states, []);
    assert.deepEqual(d.events, {});
    assert.throws(() => parseDiagram('[]'));
    assert.throws(() => parseDiagram('{ not json'));
});

test('minimal diagram analyzes to a machine', () => {
    const { machine, issues } = analyze(diagram());
    assert.deepEqual(issues, []);
    assert.equal(machine.states.length, 1);
    assert.equal(machine.initial.target.name, 'A');
});

test('identifier, uniqueness and reserved-name rules', () => {
    assert.ok(hasIssue({ ...diagram(), name: 'class' }, /not a valid class name/));
    assert.ok(hasIssue(diagram([S('1bad')]), /valid identifier/));
    assert.ok(hasIssue(diagram([{ ...S('B'), name: 'A' }]), /not unique/));
    assert.ok(hasIssue(diagram([S('None')]), /valid identifier/));
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'Go', { action: 'Dispatch' })]), /clashes/));
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'Go', { action: 'Entry_x' })]), /clashes/));
    assert.ok(hasIssue({ ...diagram(), namespace: 'a.1b' }, /Namespace/));
});

test('initial pseudostate rules', () => {
    assert.ok(hasIssue({ name: 'M', states: [S('A')], transitions: [] }, /Top level needs an initial/));
    assert.ok(hasIssue(diagram([S('i1', 'initial')], [T('t1', 'i1', 'A')]), /more than one initial/));
    assert.ok(hasIssue(diagram([S('C'), S('C1', 'state', 'C')]), /'C' needs an initial/));
    assert.ok(hasIssue(diagram([S('C'), S('C1', 'state', 'C'), S('ic', 'initial', 'C')], [T('t1', 'ic', 'A')]), /inside the same region/));
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'i0', 'Go')]), /cannot target an initial/));
});

test('transition rules', () => {
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', '1x')]), /not a valid identifier/));
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'Completion')]), /reserved/));
    assert.ok(hasIssue(diagram([S('F', 'final')], [T('t1', 'F', 'A', 'Go')]), /Final state 'F' cannot have outgoing/));
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'Go'), T('t2', 'A', 'A', 'Go')]), /more than one unguarded/));
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'Go', { guard: 'a && b' })]), /guard/));
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'Go', { action: 'f(1)' })]), /action/));
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'Go', { guard: 'x', action: 'x' })]), /both as a guard and as an action/));
});

test('transitions are ordered by source with guarded ones first', () => {
    const { machine } = analyze(
        diagram([S('B')], [T('t1', 'A', 'B', 'Go'), T('t2', 'A', 'A', 'Go', { guard: 'ok' }), T('t3', 'B', 'A', 'Back')])
    );
    assert.deepEqual(
        machine.transitions.map(t => `${t.source.name}:${t.event}:${t.guard ? t.guard.name : '-'}`),
        ['A:Go:ok', 'A:Go:-', 'B:Back:-']
    );
});

test('least common ancestor is the innermost proper common ancestor', () => {
    const states = [
        S('R'), S('ir', 'initial', 'R'), S('P', 'state', 'R'), S('ip', 'initial', 'P'), S('P1', 'state', 'P'), S('Q', 'state', 'R')
    ];
    const { machine, issues } = analyze(
        diagram(states, [
            T('a', 'ir', 'P'), T('b', 'ip', 'P1'),
            T('t1', 'P1', 'Q', 'X'), T('t2', 'P', 'P', 'Self'), T('t3', 'P', 'P1', 'Down'), T('t4', 'A', 'P1', 'Deep')
        ])
    );
    assert.deepEqual(issues, []);
    const lca = ev => machine.transitions.find(t => t.event === ev).lca;
    assert.equal(lca('X').name, 'R');
    assert.equal(lca('Self').name, 'R');
    assert.equal(lca('Down').name, 'R');
    assert.equal(lca('Deep'), null);
});

test('internal transitions', () => {
    const ok = analyze(diagram([], [T('t1', 'A', 'A', 'Tick', { internal: true, action: 'count' })]));
    assert.deepEqual(ok.issues, []);
    assert.equal(ok.machine.transitions[0].internal, true);
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'Go', { internal: true })]), /only self transitions/));
});

test('history pseudostates', () => {
    const base = [S('C'), S('ic', 'initial', 'C'), S('C1', 'state', 'C')];
    const good = analyze(diagram([...base, S('H', 'history', 'C', { deep: true })], [T('a', 'ic', 'C1'), T('t1', 'A', 'H', 'Resume')]));
    assert.deepEqual(good.issues, []);
    assert.equal(good.machine.states.find(s => s.name === 'C').history, 'deep');
    const t = good.machine.transitions[0];
    assert.equal(t.history, true);
    assert.equal(t.target.name, 'C');

    assert.ok(hasIssue(diagram([S('H', 'history')]), /inside a composite/));
    assert.ok(hasIssue(diagram([...base, S('H', 'history', 'C'), S('H2', 'history', 'C')], [T('a', 'ic', 'C1')]), /more than one history/));
    assert.ok(hasIssue(diagram([...base, S('H', 'history', 'C')], [T('a', 'ic', 'C1'), T('t1', 'H', 'C1', 'X')]), /cannot have outgoing/));
});

test('event parameters bind to hooks', () => {
    const d = diagram([S('B')], [T('t1', 'A', 'B', 'Set', { guard: 'valid', action: 'apply' })], { events: { Set: 'int level, const std::string& name' } });
    const { machine, issues } = analyze(d);
    assert.deepEqual(issues, []);
    assert.deepEqual(machine.params.get('Set').map(p => [p.type, p.name]), [['int', 'level'], ['const std::string&', 'name']]);
    assert.deepEqual(machine.hookParams.get('apply').map(p => p.name), ['level', 'name']);
    assert.deepEqual(machine.hookParams.get('valid').map(p => p.name), ['level', 'name']);

    assert.ok(hasIssue({ ...d, events: { Set: 'level' } }, /type name/));
    assert.ok(hasIssue({ ...d, events: { Set: 'int a, int a' } }, /declared twice/));
    const shared = diagram([S('B')], [T('t1', 'A', 'B', 'Set', { action: 'apply' }), T('t2', 'B', 'A', 'Other', { action: 'apply' })], {
        events: { Set: 'int level' }
    });
    assert.ok(hasIssue(shared, /different parameter lists/));
});

test('every duplicate unguarded transition is reported, whatever the event order', () => {
    const d = diagram([S('B')], [T('t1', 'A', 'B', 'Go'), T('t2', 'A', 'B', 'Other'), T('t3', 'A', 'A', 'Go')]);
    const dup = analyze(d).issues.filter(i => /more than one unguarded transition for event 'Go'/.test(i.message));
    assert.deepEqual(dup.map(i => [i.id, i.element]), [['t3', 'transition']]);
});

test('regions cannot be the source or target of transitions', () => {
    const regions = [S('P'), S('r1', 'region', 'P'), S('ip', 'initial', 'r1'), S('X', 'state', 'r1'), S('ch', 'choice')];
    const base = [T('a', 'ip', 'X')];
    // A region as source used to crash analyze with a TypeError.
    assert.ok(hasIssue(diagram(regions, [...base, T('t1', 'r1', 'A', 'Go')]), /cannot start at a region/));
    assert.ok(hasIssue(diagram(regions, [...base, T('t1', 'A', 'r1', 'Go')]), /region cannot be a target/));
    assert.ok(hasIssue(diagram(regions, [...base, T('t1', 'A', 'ch', 'Go'), T('b1', 'ch', 'r1')]), /Choice branch: a region cannot be a target/));
    // A history pseudostate outside any state is reported itself, and so is a transition into it.
    assert.ok(hasIssue(diagram([S('H', 'history')], [T('t1', 'A', 'H', 'Go')]), /target history pseudostate is not inside a composite/));
});

test('a state with a single explicit region accepts a history pseudostate', () => {
    const states = [S('C'), S('r', 'region', 'C'), S('ic', 'initial', 'r'), S('C1', 'state', 'r'), S('C2', 'state', 'r'), S('H', 'history', 'r')];
    const { machine, issues } = analyze(diagram(states, [T('a', 'ic', 'C1'), T('t1', 'A', 'H', 'Resume'), T('t2', 'C1', 'C2', 'Next')]));
    assert.deepEqual(issues, []);
    const C = machine.states.find(s => s.name === 'C');
    assert.equal(C.history, 'shallow');
    assert.equal(C.regions.length, 1);
    const t = machine.transitions.find(x => x.event === 'Resume');
    assert.equal(t.history, true);
    assert.equal(t.target, C);
    // Several regions: still rejected.
    const ortho = [...states, S('r2', 'region', 'C'), S('i2', 'initial', 'r2'), S('D1', 'state', 'r2')];
    assert.ok(hasIssue(diagram(ortho, [T('a', 'ic', 'C1'), T('b', 'i2', 'D1')]), /not supported in orthogonal states/));
});

test('a missing top-level initial pseudostate is not attached to a fake element id', () => {
    const issue = analyze({ name: 'M', states: [S('A')], transitions: [] }).issues.find(i => /Top level needs an initial/.test(i.message));
    assert.ok(issue);
    assert.equal(issue.id, undefined);
    assert.equal(issue.element, undefined);
});

test('analyze does not modify the diagram', () => {
    const d = diagram(
        [S('B', 'state', 'nowhere'), S('P'), S('r1', 'region', 'P'), S('i1', 'initial', 'r1'), S('X', 'state', 'r1'), S('Y', 'state', 'P')],
        [T('a', 'i1', 'X')]
    );
    const before = JSON.stringify(d);
    const found = messages(d);
    assert.ok(found.some(m => /'B' has an invalid parent/.test(m)));
    assert.ok(found.some(m => /must be placed inside one of the regions/.test(m)));
    assert.equal(JSON.stringify(d), before);
});

test('unused choice points and parameter declarations are warnings', () => {
    const d = diagram([S('B'), S('ch', 'choice')], [T('t1', 'A', 'B', 'Go'), T('b1', 'ch', 'B')], { events: { Gone: 'int x', Go: '' } });
    const { machine, issues } = analyze(d);
    assert.ok(machine, 'warnings do not prevent the machine');
    assert.deepEqual(
        issues.map(i => [i.severity, i.id, i.message]),
        [
            ['warning', undefined, "Parameters are declared for event 'Gone', which is not used by any transition; the declaration is ignored."],
            ['warning', 'ch', 'Choice point has no incoming transition, so it is never used.']
        ]
    );
    // Generated events cannot have parameters either.
    const timeout = diagram([S('B')], [T('t1', 'A', 'B', 'after(1s)')], { events: { A_After1000ms: 'int x' } });
    assert.ok(analyze(timeout).issues.some(i => i.severity === 'warning' && /'A_After1000ms', which is generated/.test(i.message)));
    // Errors still prevent the machine.
    const broken = { ...d, transitions: [...d.transitions, T('t2', 'A', 'B', '1x')] };
    assert.equal(analyze(broken).machine, undefined);
});

test('cycles of unguarded completion transitions are errors', () => {
    const loop = /form an endless loop/;
    // Two simple states completing into each other, and a state completing into itself.
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B'), T('t2', 'B', 'A')]), loop));
    assert.ok(hasIssue(diagram([], [T('t1', 'A', 'A')]), loop));
    // Through a composite that completes when its final state is reached by default.
    const composite = [S('C'), S('ic', 'initial', 'C'), S('F', 'final', 'C')];
    assert.ok(hasIssue(diagram(composite, [T('a', 'ic', 'F'), T('t1', 'A', 'C', 'Go'), T('t2', 'C', 'C')]), loop));
    // Through a choice point whose only branch is [else].
    assert.ok(hasIssue(diagram([S('B'), S('ch', 'choice')], [T('t1', 'A', 'ch'), T('b1', 'ch', 'B'), T('t2', 'B', 'A')]), loop));
    // A guard anywhere in the cycle, or an event, ends it: no error.
    assert.ok(!hasIssue(diagram([S('B')], [T('t1', 'A', 'B'), T('t2', 'B', 'A', '', { guard: 'again' })]), loop));
    assert.ok(!hasIssue(diagram([S('B')], [T('t1', 'A', 'B'), T('t2', 'B', 'A', 'Go')]), loop));
    // A history target is not known statically.
    assert.ok(!hasIssue(diagram([...composite, S('H', 'history', 'C')], [T('a', 'ic', 'F'), T('t1', 'A', 'C', 'Go'), T('t2', 'C', 'H')]), loop));
    // One issue per loop, on a transition.
    const issues = analyze(diagram([S('B')], [T('t1', 'A', 'B'), T('t2', 'B', 'A')])).issues.filter(i => loop.test(i.message));
    assert.deepEqual(
        issues.map(i => [i.id, i.element, i.message]),
        [['t1', 'transition', "Completion transitions of 'A', 'B' form an endless loop; give one of them a guard or an event."]]
    );
});

test('action lists are split outside parentheses and quotes', () => {
    // Call-style actions are not supported, but one with arguments is reported once, as written.
    const issues = analyze(diagram([S('B')], [T('t1', 'A', 'B', 'Go', { action: 'a; f(x, "y;z"), b' })])).issues;
    assert.deepEqual(
        issues.map(i => i.message),
        [`Transition from A: action 'f(x, "y;z")' must be a method name (e.g. 'doSomething').`]
    );
    const { machine } = analyze(diagram([S('B')], [T('t1', 'A', 'B', 'Go', { action: 'a(), b\nc' })]));
    assert.deepEqual(machine.transitions[0].actions, ['a', 'b', 'c']);
});

test('issues name the kind of element they refer to', () => {
    // A state and a transition that share an id.
    const d = diagram([S('B', 'state', null, { entry: 'x y' })], [T('B', 'A', 'B', 'Go', { guard: 'a b' })]);
    const all = analyze(d).issues;
    assert.deepEqual(all.filter(i => i.id === 'B').map(i => i.element).sort(), ['state', 'transition']);
    assert.ok(all.every(i => (i.id === undefined) === (i.element === undefined)));
});
