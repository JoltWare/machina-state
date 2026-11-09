// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Prototype Stateflow importer (src/interop/stateflow.ts): label parsing, the zip reader and the mapping of
// small synthetic charts that use the constructs found in real Stateflow models.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyze, root } = require('./helpers');
const { importStateflow, parseMatlabParameters, parseSfLabel, parseSfStateLabel, readZip } = require(path.join(root, 'out', 'interop', 'stateflow.js'));

/** A zip archive with stored (uncompressed) entries; readZip does not check CRCs. */
function zip(files) {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
        const n = Buffer.from(name);
        const data = Buffer.from(text);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt32LE(data.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(n.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt32LE(data.length, 20);
        ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(n.length, 28);
        ch.writeUInt32LE(offset, 42);
        locals.push(lh, n, data);
        central.push(ch, n);
        offset += 30 + n.length + data.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const P = (name, value) => `<P Name="${name}">${esc(String(value))}</P>`;
const state = (ssid, label, children = '', extra = '') =>
    `<state SSID="${ssid}">${P('labelString', label)}${P('type', 'OR_STATE')}${extra}<Children>${children}</Children></state>`;
const junction = ssid => `<junction SSID="${ssid}">${P('type', 'CONNECTIVE_JUNCTION')}</junction>`;
const tr = (ssid, src, dst, label = '', order = 1, extra = '') =>
    `<transition SSID="${ssid}">${P('labelString', label)}<src>${src ? P('SSID', src) : ''}</src><dst>${P('SSID', dst)}</dst>${P('executionOrder', order)}${extra}</transition>`;

// Idle -> Run (default transition into a junction), a terminal junction inside Run, a condition that mixes
// a guard with after(), an event trigger, a during action and a lone substate without default transition.
const CHART = `<?xml version="1.0" encoding="utf-8"?>
<chart id="1">${P('name', 'Demo Chart')}${P('decomposition', 'CLUSTER_CHART')}<Children>
  ${state(2, 'Idle\nentry: ready = 1;')}
  ${state(
      3,
      'Run\nen: startMotor();\ndu: count++;\nex: stopMotor',
      `${state(5, 'Spin')}${state(6, 'Hold')}${junction(7)}${junction(8)}${junction(9)}
       ${tr(20, null, 7, '{ log(1); }')}
       ${tr(21, 7, 5, '[ speed > 3 ]', 1)}
       ${tr(22, 7, 6, '', 2)}
       ${tr(23, 5, 8, '[ over ]')}
       ${tr(24, 8, 9, '{ flag = 1; }')}`
  )}
  ${state(4, 'Done', state(10, 'Only'))}
  ${tr(30, null, 2)}
  ${tr(31, 2, 3, 'go')}
  ${tr(32, 3, 4, '[ pressure >= limit || after(2,sec) ]')}
  ${tr(33, 3, 4, '', 2, P('type', 'SUB'))}
</Children></chart>`;
const SLX = zip({ 'simulink/stateflow/chart_1.xml': CHART });

test('Stateflow: transition labels are split into trigger, condition and both kinds of action', () => {
    assert.deepEqual(parseSfLabel('E[a[1] > 0 && b]{x = f(1, 2);}/y++;'), { trigger: 'E', condition: 'a[1] > 0 && b', conditionAction: 'x = f(1, 2);', transitionAction: 'y++;' });
    assert.deepEqual(parseSfLabel('after(5,sec) // comment'), { trigger: 'after(5,sec)', condition: '', conditionAction: '', transitionAction: '' });
    assert.deepEqual(parseSfLabel('/{ done = 1; }'), { trigger: '', condition: '', conditionAction: '', transitionAction: 'done = 1;' });
});

test('Stateflow: state labels give the name and entry, during and exit code', () => {
    const l = parseSfStateLabel('Run/\nx = 1;\nen, du: tick();\nexit: y = 0;\non E: z();');
    assert.equal(l.name, 'Run');
    assert.equal(l.entry, 'x = 1;\ntick();');
    assert.equal(l.during, 'tick();');
    assert.equal(l.exit, 'y = 0;');
    assert.deepEqual(l.other, ['on E: z();']);
});

test('Stateflow: the zip reader returns every entry', () => {
    const files = readZip(zip({ a: 'one', 'dir/b.xml': '<x/>' }));
    assert.deepEqual([...files.keys()], ['a', 'dir/b.xml']);
    assert.equal(files.get('dir/b.xml').toString(), '<x/>');
});

test('Stateflow: a synthetic chart imports into a valid diagram with Stateflow semantics', () => {
    const { diagram: d, warnings, hooks } = importStateflow(SLX, { periodMs: 10 });
    const { machine, issues } = analyze(d);
    assert.deepEqual(issues, []);
    assert.ok(machine);
    assert.equal(d.name, 'DemoChart');
    assert.equal(d.semantics, 'stateflow');
    assert.equal(d.formatVersion, 2);
    assert.deepEqual(d.step, { event: 'Step', periodMs: 10 });
    assert.equal(d.hooks, hooks);
    const byName = n => d.states.find(s => s.name === n);
    const from = n => d.transitions.filter(t => t.source === byName(n).id);

    // Code becomes hooks that remember the original; plain call lists stay as they are.
    assert.equal(byName('Idle').entry, 'IdleEntry');
    assert.equal(hooks.IdleEntry.code, 'ready = 1;');
    assert.equal(byName('Run').entry, 'startMotor');
    assert.equal(byName('Run').exit, 'stopMotor');
    // During actions are a field of the state.
    assert.equal(byName('Run').during, 'RunDuring');
    assert.equal(hooks.RunDuring.code, 'count++;');
    // Event trigger, and `c || after()` split into a timeout and a Step transition (the SUB stub is ignored).
    assert.deepEqual(from('Idle').map(t => t.event), ['go']);
    assert.deepEqual(from('Run').map(t => [t.event, t.guard, !!t.internal]), [
        ['after(2s)', '', false],
        ['Step', 'guard32', false]
    ]);
    assert.equal(hooks.guard32.code, 'pressure >= limit');
    // The timeout is counted in steps of the period: 2 s / 10 ms.
    assert.equal(machine.transitions.find(t => t.source.name === 'Run' && t.kind === 'temporal').ticks, 200);
    // Default transition into a junction goes through a transient state with a completion transition.
    assert.ok(byName('RunStart'));
    assert.deepEqual(from('RunStart').map(t => t.event), ['']);
    // The path into the terminal junction became an internal transition of Spin with both actions.
    assert.deepEqual(from('Spin').map(t => [t.event, t.guard, t.action, t.internal]), [['Step', 'over', 'action24', true]]);
    // The lone substate of Done got an initial pseudostate.
    assert.ok(d.states.some(s => s.kind === 'initial' && s.parent === byName('Done').id));
    assert.ok(warnings.some(w => /terminal junctions/.test(w)));
});

test('Stateflow: without a step period a time-based after() is reported', () => {
    const { diagram, warnings } = importStateflow(SLX);
    assert.ok(warnings.some(w => /step period is unknown/.test(w)));
    assert.ok(analyze(diagram).issues.some(i => /needs a step period/.test(i.message)));
});

// A model whose chart block is a library link: the chart is read from the library, and the block's sample
// time (a parameter of the model) gives the step period.
const LIBRARY_CHART = `<chart id="1">${P('name', 'Lib Chart')}<Children>
  <data SSID="40" name="level">${P('scope', 'INPUT_DATA')}${P('dataType', 'single')}</data>
  <data SSID="41" name="buffer">${P('scope', 'LOCAL_DATA')}<props><array>${P('size', '8')}</array></props>${P('dataType', 'uint8')}</data>
  ${state(2, 'A')}${state(3, 'B')}
  ${tr(30, null, 2)}
  ${tr(31, 2, 3, 'after(3,tick)')}
  ${tr(32, 3, 2, '[ after(waitTime,sec) ]')}
</Children></chart>`;
const MODEL_SYSTEM = `<System><Block BlockType="Reference" Name="Chart" SID="1">${P('SourceBlock', 'lib_chart/Chart')}<InstanceData>${P('SystemSampleTime', 'sampleTime')}</InstanceData></Block></System>`;

test('Stateflow: a library-linked chart is followed, and its sample time sets the step period', () => {
    const library = zip({ 'simulink/stateflow/chart_1.xml': LIBRARY_CHART });
    const model = zip({ 'simulink/systems/system_root.xml': MODEL_SYSTEM });
    const requested = [];
    const { diagram: d, warnings } = importStateflow(model, {
        resolveLibrary: name => (requested.push(name), name === 'lib_chart' ? library : undefined),
        parameters: { sampleTime: 0.005, waitTime: 0.25 }
    });
    assert.deepEqual(requested, ['lib_chart']);
    assert.deepEqual(warnings, []);
    assert.equal(d.name, 'LibChart');
    assert.deepEqual(d.step, { event: 'Step', periodMs: 5 });
    // after(3, tick) counts steps; a parameter duration is resolved to a time.
    assert.deepEqual(d.transitions.filter(t => t.event).map(t => t.event), ['after(3 steps)', 'after(250ms)']);
    assert.deepEqual(d.data, [
        { name: 'level', scope: 'input', type: 'single' },
        { name: 'buffer', scope: 'local', type: 'uint8', size: '8' }
    ]);
    const { machine, issues } = analyze(d);
    assert.deepEqual(issues, []);
    assert.deepEqual(machine.transitions.filter(t => t.ticks).map(t => t.ticks), [3, 50]);
});

test('Stateflow: MATLAB parameter scripts give numeric parameters', () => {
    const text = [
        'sampleTime=0.001;',
        'holdTime = single(0.01);\t% seconds',
        '  cycles = uint8(3);',
        'gain = -1.5e-3;',
        'derived = holdTime * 2;',
        'cfg.limit = 4;',
        'name = "text";',
        'gain = 2;'
    ].join('\n');
    assert.deepEqual(parseMatlabParameters(text), { sampleTime: 0.001, holdTime: 0.01, cycles: 3, gain: 2 });
});

test('Stateflow: a package without a chart or resolvable library is an error', () => {
    assert.throws(() => importStateflow(zip({ 'simulink/systems/system_root.xml': MODEL_SYSTEM })), /No Stateflow chart/);
    assert.throws(() => importStateflow(Buffer.from('not a zip')), /Not a zip archive/);
});

// ------------------------------------------------------------------ the bundled example (examples/stateflow)

const exampleDir = path.join(root, 'examples', 'stateflow');

test('Stateflow: the gear shift example imports into a valid diagram', () => {
    const { diagram: d, warnings } = importStateflow(fs.readFileSync(path.join(exampleDir, 'gear_logic.slx')));
    const { machine, issues } = analyze(d);
    assert.deepEqual(issues, []);
    assert.equal(d.name, 'Gear_Logic');
    // The model's fixed solver step (0.01 s) is the step period; after(0.1, sec) is 10 steps.
    assert.deepEqual(d.step, { event: 'Step', periodMs: 10 });
    assert.deepEqual(machine.transitions.filter(t => t.kind === 'temporal').map(t => t.ticks), [10, 10]);
    // The parallel chart gets a top-level state holding one region per parallel state (the region and the
    // state inside it share the parallel state's name).
    const byName = n => d.states.find(s => s.name === n && s.kind === 'state');
    assert.deepEqual(d.states.filter(s => s.kind === 'region').map(s => [s.name, s.parent]), [
        ['gear_state', byName('Chart').id],
        ['selection_state', byName('Chart').id]
    ]);
    // MATLAB comments (`%on SlowDown: ...`) are not code; the during action is.
    assert.equal(byName('gear_state').entry, '');
    assert.equal(d.hooks.gear_stateDuring.code, 'speed = max(0,min(speed+delta,100));');
    // Local events sent with send() enable the queue.
    assert.deepEqual(Object.keys(d.events), ['UP', 'DOWN', 'SlowDown', 'Cruise', 'SpeedUp']);
    assert.equal(d.codegen.queue, true);
    assert.ok(warnings.some(w => /send\(\)/.test(w)));
    assert.deepEqual(d.data.map(x => `${x.scope} ${x.name}`), ['local down_th', 'local up_th', 'local delta', 'local speed', 'local gear']);
});

test('Stateflow: the committed example diagram matches a fresh import', () => {
    const fresh = importStateflow(fs.readFileSync(path.join(exampleDir, 'gear_logic.slx'))).diagram;
    const committed = JSON.parse(fs.readFileSync(path.join(exampleDir, 'Gear_Logic.machina'), 'utf8'));
    // Geometry comes from the auto-layout and the code generation defaults from the Import command.
    const strip = d => JSON.parse(JSON.stringify(d, (k, v) => (['x', 'y', 'w', 'h', 'bend', 'codegen'].includes(k) ? undefined : v)));
    assert.deepEqual(strip(committed), strip(fresh));
});

// ------------------------------------------------------------------ further constructs

test('Stateflow: several events, event names as properties and inner transitions', () => {
    const chart = `<chart id="1">${P('name', 'Multi')}<Children>
      <event SSID="50">${P('name', 'Go')}${P('scope', 'INPUT_EVENT')}</event>
      <event SSID="51" name="Halt">${P('scope', 'INPUT_EVENT')}</event>
      ${state(2, 'A', `${state(4, 'Inner')}${tr(41, null, 4)}`)}${state(3, 'B')}
      ${tr(30, null, 2)}
      ${tr(31, 2, 4, '[ deep ]', 1)}
      ${tr(32, 2, 3, 'Go | Halt', 2)}
      ${tr(33, 3, 2, 'Go || Halt')}
    </Children></chart>`;
    const { diagram: d, warnings } = importStateflow(zip({ 'simulink/stateflow/chart_1.xml': chart }));
    assert.deepEqual(d.events, { Go: '', Halt: '' });
    const from = n => d.transitions.filter(t => t.source === d.states.find(s => s.name === n).id).map(t => [t.event, d.states.find(s => s.id === t.target).name]);
    // The outer transitions of A (execution order 2) come before its inner one (execution order 1).
    assert.deepEqual(from('A'), [['Go', 'B'], ['Halt', 'B'], ['Step', 'Inner']]);
    assert.deepEqual(from('B'), [['Go', 'A'], ['Halt', 'A']]);
    assert.ok(warnings.some(w => /inner transition 31/.test(w)));
    assert.deepEqual(analyze(d).issues, []);
});

test('Stateflow: a default flow chart without substates becomes entry code', () => {
    const c = `<chart id="1">${P('name', 'Flow')}<Children>
      ${state(2, 'Busy', `${junction(7)}${junction(8)}${junction(9)}
        ${tr(20, null, 7, '{ n = 0; }')}
        ${tr(21, 7, 8, '[ hot ]{ fan = 1; }', 1)}
        ${tr(22, 7, 9, '{ fan = 0; }', 2)}`)}
      ${tr(30, null, 2)}
    </Children></chart>`;
    const { diagram: d } = importStateflow(zip({ 'simulink/stateflow/chart_1.xml': c }));
    assert.deepEqual(analyze(d).issues, []);
    const busy = d.states.find(s => s.name === 'Busy');
    assert.equal(busy.entry, 'BusyEntryFlow');
    assert.equal(d.hooks.BusyEntryFlow.code, ['n = 0;', 'if (hot) {', '    fan = 1;', '} else {', '    fan = 0;', '}'].join('\n'));
    // Nothing is left inside Busy.
    assert.deepEqual(d.states.filter(s => s.parent === busy.id), []);
});

test('Stateflow: MATLAB comments, and the sample time of an embedded chart block', () => {
    const c = `<chart id="1">${P('name', 'Mat')}${P('actionLanguage', '2')}<Children>
      ${state(2, 'A\nentry:\n% x = 1;\ny = 2; % set y\n%{\nz = 3;\n%}')}${state(3, 'B')}
      ${tr(30, null, 2)}${tr(31, 2, 3, 'after(1, sec) % one second')}
    </Children></chart>`;
    const system = `<System><Block BlockType="SubSystem" Name="Mat">${P('SFBlockType', 'Chart')}${P('SystemSampleTime', '0.05')}</Block></System>`;
    const { diagram: d } = importStateflow(zip({ 'simulink/stateflow/chart_1.xml': c, 'simulink/systems/system_root.xml': system }));
    assert.equal(d.hooks.AEntry.code, 'y = 2;');
    assert.deepEqual(d.step, { event: 'Step', periodMs: 50 });
    assert.deepEqual(d.transitions.filter(t => t.event).map(t => t.event), ['after(1s)']);
    // Without a sample time of its own, the chart uses the model's fixed solver step.
    const inherited = `<System><Block BlockType="SubSystem" Name="Mat">${P('SFBlockType', 'Chart')}</Block></System>`;
    const config = `<ConfigSet><P Name="SolverName">FixedStepDiscrete</P><P Name="FixedStep">0.002</P></ConfigSet>`;
    const fixed = importStateflow(zip({ 'simulink/stateflow/chart_1.xml': c, 'simulink/systems/system_root.xml': inherited, 'simulink/configSet0.xml': config }));
    assert.deepEqual(fixed.diagram.step, { event: 'Step', periodMs: 2 });
    // A variable-step solver gives no period.
    const variable = importStateflow(zip({ 'simulink/stateflow/chart_1.xml': c, 'simulink/configSet0.xml': config.replace('FixedStepDiscrete', 'ode45') }));
    assert.deepEqual(variable.diagram.step, { event: 'Step' });
});
