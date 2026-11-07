// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, loadTestDiagram } = require('./helpers');
const { parseTimeout, isExhaustive, alwaysFires } = require('../out/model.js');
const { Engine, CompletionLoopError } = require('../out/engine.js');
const { storageType, indexType } = require('../out/generators/cpp.js');

const S = (id, kind = 'state', parent = null, extra = {}) => ({ id, name: id, kind, parent, x: 0, y: 0, w: 10, h: 10, ...extra });
const T = (id, source, target, event = '', extra = {}) => ({ id, source, target, event, guard: '', action: '', ...extra });
const diagram = (states = [], transitions = [], extra = {}) => ({
    name: 'M',
    namespace: '',
    states: [S('i0', 'initial'), S('A'), ...states],
    transitions: [T('t0', 'i0', 'A'), ...transitions],
    ...extra
});
const hasIssue = (d, pattern) => analyze(d).issues.some(i => pattern.test(i.message));

test('completion transitions', () => {
    const { machine, issues } = analyze(diagram([S('B')], [T('t1', 'A', 'B')]));
    assert.deepEqual(issues, []);
    assert.equal(machine.completion, true);
    assert.equal(machine.transitions[0].kind, 'completion');
    assert.equal(machine.events.at(-1), 'Completion');
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B'), T('t2', 'A', 'A')]), /more than one unguarded completion/));
    assert.ok(hasIssue(diagram([], [T('t1', 'A', 'A', '', { internal: true })]), /internal/));
});

test('timeouts', () => {
    assert.equal(parseTimeout('after(500ms)'), 500);
    assert.equal(parseTimeout('after( 2 s )'), 2000);
    assert.equal(parseTimeout('after(1min)'), 60000);
    assert.equal(parseTimeout('after(250)'), 250);
    assert.equal(parseTimeout('Tick'), undefined);
    const { machine, issues } = analyze(diagram([S('B')], [T('t1', 'A', 'B', 'after(2s)'), T('t2', 'A', 'B', 'after(2s)', { guard: 'ready' })]));
    assert.deepEqual(issues, []);
    assert.deepEqual(machine.timers.map(x => [x.state.name, x.event, x.milliseconds]), [['A', 'A_After2000ms', 2000]]);
    assert.ok(machine.events.includes('A_After2000ms'));
    assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'after(0.5ms)')]), /whole number/));
});

test('choice points resolve per source with else last', () => {
    const states = [S('B'), S('C'), S('ch', 'choice')];
    const d = diagram(states, [
        T('t1', 'A', 'ch', 'Go', { action: 'first' }),
        T('b1', 'ch', 'C', '', { guard: 'else' }),
        T('b2', 'ch', 'B', '', { guard: 'isB', action: 'second' })
    ]);
    const { machine, issues } = analyze(d);
    assert.deepEqual(issues, []);
    const t = machine.transitions[0];
    assert.equal(t.branches.length, 2);
    assert.equal(t.branches[0].guard.name, 'isB');
    assert.equal(t.branches[0].target.name, 'B');
    assert.equal(t.branches[1].guard, undefined);
    assert.ok(isExhaustive(t.branches));
    assert.ok(alwaysFires(t));
    assert.deepEqual(machine.guards, ['isB']);
    assert.ok(machine.actions.includes('second'));
});

test('choice point validation', () => {
    const base = [S('B'), S('ch', 'choice')];
    assert.ok(hasIssue(diagram(base, [T('t1', 'A', 'ch', 'Go')]), /at least one outgoing/));
    assert.ok(hasIssue(diagram(base, [T('t1', 'A', 'ch', 'Go'), T('b1', 'ch', 'B'), T('b2', 'ch', 'A')]), /at most one \[else\]/));
    assert.ok(hasIssue(diagram(base, [T('t1', 'A', 'ch', 'Go'), T('b1', 'ch', 'B', 'X')]), /cannot have an event/));
    assert.ok(
        hasIssue(diagram([...base, S('ch2', 'choice')], [T('t1', 'A', 'ch', 'Go'), T('b1', 'ch', 'ch2'), T('b2', 'ch2', 'ch')]), /cycle/)
    );
    const nested = analyze(
        diagram([...base, S('ch2', 'choice')], [T('t1', 'A', 'ch', 'Go'), T('b1', 'ch', 'ch2', '', { guard: 'x' }), T('b2', 'ch2', 'B'), T('b3', 'ch', 'A')])
    );
    assert.deepEqual(nested.issues, []);
    assert.equal(nested.machine.transitions[0].branches[0].branches[0].target.name, 'B');
});

test('event parameters reach choice branch hooks', () => {
    const d = diagram([S('B'), S('ch', 'choice')], [T('t1', 'A', 'ch', 'Set'), T('b1', 'ch', 'B', '', { guard: 'ok', action: 'use' }), T('b2', 'ch', 'A')], {
        events: { Set: 'int v' }
    });
    const { machine, issues } = analyze(d);
    assert.deepEqual(issues, []);
    assert.deepEqual(machine.hookParams.get('ok').map(p => p.name), ['v']);
    assert.deepEqual(machine.hookParams.get('use').map(p => p.name), ['v']);
});

test('queue options', () => {
    const { machine } = analyze({ ...diagram(), codegen: { queue: true } });
    assert.equal(machine.queue, true);
    assert.equal(machine.queueCapacity, 16);
    assert.ok(hasIssue({ ...diagram(), codegen: { queue: true, queueCapacity: 0 } }, /Queue capacity/));
});

test('hooks may not use generated names', () => {
    for (const name of ['Post', 'PostX', 'StartTimer', 'Fire_1', 'RunCompletions']) {
        assert.ok(hasIssue(diagram([S('B')], [T('t1', 'A', 'B', 'Go', { action: name })]), /clashes/), name);
    }
});

test('orthogonal regions', () => {
    const regions = [
        S('P', 'state'),
        S('r1', 'region', 'P'),
        S('i1', 'initial', 'r1'),
        S('X', 'state', 'r1'),
        S('r2', 'region', 'P'),
        S('i2', 'initial', 'r2'),
        S('Y', 'state', 'r2')
    ];
    const links = [T('a', 'A', 'P', 'Go'), T('b', 'i1', 'X'), T('c', 'i2', 'Y', '', { action: 'prepare' })];
    const { machine, issues } = analyze(diagram(regions, links));
    assert.deepEqual(issues, []);
    const P = machine.states.find(s => s.name === 'P');
    assert.equal(P.regions.length, 2);
    assert.deepEqual(P.regions.map(r => r.index), [1, 2]);
    assert.deepEqual(P.regions.map(r => r.initial.target.name), ['X', 'Y']);
    assert.equal(P.initial, undefined);
    assert.ok(machine.actions.includes('prepare'));
    assert.equal(machine.states.find(s => s.name === 'Y').parent, P);

    assert.ok(hasIssue(diagram(regions, [...links, T('d', 'X', 'Y', 'Hop')]), /orthogonal regions/));
    assert.ok(hasIssue(diagram([...regions, S('Z', 'state', 'P')], links), /inside one of the regions/));
    assert.ok(hasIssue(diagram([S('r3', 'region')], []), /region must be placed inside a state/));
    assert.ok(hasIssue(diagram([...regions, S('r4', 'region', 'P')], links), /contains no states/));
    assert.ok(hasIssue(diagram(regions, links.slice(0, 2)), /exactly one outgoing transition/));
    assert.ok(hasIssue(diagram(regions.filter(s => s.id !== 'i2'), links.slice(0, 2)), /needs an initial pseudostate/));
});

/**
 * Runs the engine on a machine with hooks that record actions, entries/exits and timer calls. `step(...)` runs
 * a call and returns what it logged; `active()` lists the active states; `generation(e)` is the generation of
 * the latest StartTimer for timeout event `e`.
 */
function engineFor(machine, guards = {}) {
    let log = [];
    const generations = {};
    const engine = new Engine(machine, {
        guard: name => guards[name] !== false,
        action: name => log.push(name),
        trace: (kind, name) => (kind === 'Enter' || kind === 'Exit') && log.push(`${kind.toLowerCase()} ${name}`),
        startTimer: (event, ms, generation) => {
            generations[event] = generation;
            log.push(`start ${event}`);
        },
        cancelTimer: event => log.push(`cancel ${event}`)
    });
    const step = f => {
        log = [];
        const result = f(engine);
        return { result, log };
    };
    const active = () => engine.activeStates().map(s => s.name);
    return { engine, step, active, generation: e => generations[e] };
}
const lab = () => engineFor(analyze(loadTestDiagram('HistoryLab')).machine);

test('deep history restores every region of a nested orthogonal state', () => {
    const { step, active } = lab();
    step(e => e.start());
    step(e => e.dispatch('Go')); // no history yet: default entry
    assert.deepEqual(active(), ['Work', 'Ortho', 'A1', 'B1']);
    step(e => e.dispatch('Next')); // both regions move on
    assert.deepEqual(active(), ['Work', 'Ortho', 'A2', 'B2']);
    step(e => e.dispatch('Pause'));
    const { log } = step(e => e.dispatch('Go'));
    assert.deepEqual(active(), ['Work', 'Ortho', 'A2', 'B2']);
    // Restored regions in order, without their initial transitions' actions (prepareRight).
    assert.deepEqual(log, ['exit Idle', 'resume', 'enter Work', 'workOn', 'enter Ortho', 'orthoOn', 'enter A2', 'a2On', 'enter B2', 'b2On', 'start B2_After200ms']);
});

test('regions are entered in order even when the target is in a later region', () => {
    const { step, active } = lab();
    step(e => e.start());
    const { log } = step(e => e.dispatch('Into'));
    assert.deepEqual(active(), ['Work', 'Ortho', 'A1', 'B2']);
    assert.deepEqual(log.filter(l => l.startsWith('enter')), ['enter Work', 'enter Ortho', 'enter A1', 'enter B2']);
});

test('a transition that exits an orthogonal state ends the step for its other regions, even if it re-enters it', () => {
    const { step, active } = lab();
    step(e => e.start());
    step(e => e.dispatch('Go'));
    step(e => e.dispatch('Next'));
    step(e => e.dispatch('Back')); // A2 | B1
    // A2's Jump exits and re-enters Ortho; the freshly entered B1 must not take Jump as well (rightJump).
    const { log } = step(e => e.dispatch('Jump'));
    assert.ok(log.includes('jump'));
    assert.ok(!log.includes('rightJump'));
    assert.deepEqual(active(), ['Work', 'Ortho', 'A1', 'B1']);
    // B1 alone handles Jump when the left region does not.
    assert.ok(step(e => e.dispatch('Jump')).log.includes('rightJump'));
});

test('shallow history in a state with one explicit region', () => {
    const { step, active } = lab();
    step(e => e.start());
    step(e => e.dispatch('Enter'));
    assert.deepEqual(active(), ['Single', 'S1']);
    step(e => e.dispatch('Next'));
    step(e => e.dispatch('Pause'));
    step(e => e.dispatch('Enter'));
    assert.deepEqual(active(), ['Single', 'S2']);
});

test('timers are one-shot, also when the timeout is dispatched directly', () => {
    const { engine, step, generation } = lab();
    step(e => e.start());
    step(e => e.dispatch('Into')); // B2 starts its 200 ms timer (an internal transition)
    const g = generation('B2_After200ms');
    assert.equal(step(e => e.dispatchTimeout('B2_After200ms', g)).result, true);
    // The internal transition did not restart the timer, and the timeout was consumed.
    assert.equal(step(e => e.dispatchTimeout('B2_After200ms', g)).result, false);
    // Re-entering B2 starts it again; dispatching the timeout by hand disarms it as well.
    step(e => e.dispatch('Back'));
    step(e => e.dispatch('Next'));
    const g2 = generation('B2_After200ms');
    assert.notEqual(g2, g);
    assert.equal(step(e => e.dispatch('B2_After200ms')).result, true);
    assert.equal(step(e => e.dispatchTimeout('B2_After200ms', g2)).result, false);
    assert.ok(engine.isIn(engine.machine.states.find(s => s.name === 'B2')));
});

test('a timeout whose guard is false still consumes the timer', () => {
    const { machine } = analyze(loadTestDiagram('HistoryLab'));
    const { step, active, generation } = engineFor(machine, { ready: false });
    step(e => e.start());
    step(e => e.dispatch('Enter'));
    step(e => e.dispatch('Next')); // S2 starts its guarded 100 ms timer
    const g = generation('S2_After100ms');
    assert.equal(step(e => e.dispatchTimeout('S2_After100ms', g)).result, false);
    assert.deepEqual(active(), ['Single', 'S2']);
    // Not armed any more: a repeated report is ignored without even evaluating the guard.
    assert.deepEqual(step(e => e.dispatchTimeout('S2_After100ms', g)).log, []);
});

test('Start is a full reset', () => {
    const { step, active, generation } = lab();
    step(e => e.start());
    step(e => e.dispatch('Go'));
    step(e => e.dispatch('Next')); // A2 | B2, B2's timer running
    step(e => e.dispatch('Pause')); // history recorded
    step(e => e.dispatch('Into')); // B2's timer running again
    const g = generation('B2_After200ms');
    // The running timer is cancelled, but the active states are not exited (no exit actions).
    assert.deepEqual(step(e => e.start()).log, ['cancel B2_After200ms', 'enter Idle', 'idleOn']);
    assert.deepEqual(active(), ['Idle']);
    assert.equal(step(e => e.dispatchTimeout('B2_After200ms', g)).result, false);
    // History is forgotten: Go enters Work by default.
    step(e => e.dispatch('Go'));
    assert.deepEqual(active(), ['Work', 'Ortho', 'A1', 'B1']);
});

test('post is refused without the queue option', () => {
    const d = diagram([S('B')], [T('t1', 'A', 'B', 'Go')]);
    const off = new Engine(analyze(d).machine, { guard: () => true, action: () => {} });
    off.start();
    assert.equal(off.post('Go'), false);
    const on = new Engine(analyze({ ...d, codegen: { queue: true } }).machine, { guard: () => true, action: () => {} });
    on.start();
    assert.equal(on.post('Go'), true);
});

test('the engine stops a guarded completion loop', () => {
    const d = diagram([S('B')], [T('t1', 'A', 'B', '', { guard: 'again' }), T('t2', 'B', 'A')]);
    const { machine, issues } = analyze(d);
    assert.deepEqual(issues, []);
    const engine = new Engine(machine, { guard: () => true, action: () => {} });
    assert.throws(() => engine.start(), CompletionLoopError);
    // The machine can continue afterwards.
    assert.equal(engine.activeStates().length, 1);
});

test('stored copies of event parameters drop references and top-level const only', () => {
    assert.equal(storageType('const std::string&'), 'std::string');
    assert.equal(storageType('const int'), 'int');
    assert.equal(storageType('int const'), 'int');
    assert.equal(storageType('const char*'), 'const char*');
    assert.equal(storageType('char* const'), 'char*');
    assert.equal(storageType('const char* const&'), 'const char*');
    assert.equal(storageType('std::vector<const int*>&&'), 'std::vector<const int*>');
    assert.equal(storageType('const std::map<int, const char*>&'), 'std::map<int, const char*>');
    assert.equal(storageType('unsigned long'), 'unsigned long');
    assert.equal(indexType(255), 'unsigned char');
    assert.equal(indexType(256), 'unsigned short');
    assert.equal(indexType(70000), 'unsigned long');
});
