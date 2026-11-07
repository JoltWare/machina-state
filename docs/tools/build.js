// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Builds the documentation assets: example diagrams, screenshot scenarios and generated code.
// Usage: node docs/tools/build.js   (after `npm run compile`)
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const { analyze } = require(path.join(root, 'out', 'model.js'));
const { generateCode } = require(path.join(root, 'out', 'generators', 'index.js'));

const S = (id, name, kind, parent, x, y, w, h, extra = {}) => ({ id, name, kind, parent, x, y, w, h, ...extra });
const state = (id, parent, x, y, w, h, entry = '', exit = '', extra = {}) => S(id, id, 'state', parent, x, y, w, h, { entry, exit, ...extra });
const initial = (id, parent, x, y) => S(id, 'Initial', 'initial', parent, x, y, 24, 24);
const T = (id, source, target, event = '', guard = '', action = '', extra = {}) => ({ id, source, target, event, guard, action, ...extra });
const clone = o => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- Tutorial 1: flat traffic light

const t1 = {
    name: 'TrafficLight',
    namespace: 'Demo',
    states: [
        initial('init', null, 60, 168),
        state('Red', null, 140, 140, 140, 80, 'redOn', 'redOff'),
        state('Green', null, 460, 140, 140, 80, 'greenOn', 'greenOff'),
        state('Yellow', null, 300, 330, 140, 80, 'yellowOn', 'yellowOff')
    ],
    transitions: [
        T('t0', 'init', 'Red'),
        T('t1', 'Red', 'Green', 'Timer'),
        T('t2', 'Green', 'Yellow', 'Timer'),
        T('t3', 'Yellow', 'Red', 'Timer')
    ],
    events: {},
    codegen: { language: 'cpp', style: 'switch', trace: false, threadSafe: false }
};

const t1Step1 = clone(t1);
t1Step1.states = t1Step1.states.filter(s => s.id === 'init' || s.id === 'Red').map(s => ({ ...s, entry: s.entry === undefined ? undefined : '', exit: s.exit === undefined ? undefined : '' }));
t1Step1.transitions = [T('t0', 'init', 'Red')];

const t1Step2 = clone(t1);
t1Step2.states.forEach(s => {
    if (s.kind === 'state') {
        s.entry = '';
        s.exit = '';
    }
});
t1Step2.transitions = [T('t0', 'init', 'Red')];

const t1Step3 = clone(t1Step2);
t1Step3.transitions = clone(t1.transitions);

// ---------------------------------------------------------------- Tutorial 2: hierarchical traffic light

const t2 = {
    name: 'TrafficLight',
    namespace: 'Demo',
    states: [
        initial('init', null, 88, 150),
        state('Off', null, 40, 210, 120, 60),
        state('Operating', null, 230, 40, 610, 370),
        initial('initOp', 'Operating', 256, 128),
        state('Red', 'Operating', 310, 100, 140, 80, 'redOn', 'redOff'),
        state('Green', 'Operating', 570, 100, 240, 96, 'greenOn', 'greenOff'),
        state('Yellow', 'Operating', 460, 290, 140, 80, 'yellowOn', 'yellowOff'),
        S('hist', 'History', 'history', 'Operating', 795, 365, 26, 26, { deep: false }),
        state('Flashing', null, 380, 480, 160, 70, 'flashOn', 'flashOff')
    ],
    transitions: [
        T('t0', 'init', 'Off'),
        T('t1', 'initOp', 'Red'),
        T('t2', 'Red', 'Green', 'Timer'),
        T('t3', 'Green', 'Yellow', 'Timer'),
        T('t4', 'Yellow', 'Red', 'Timer'),
        T('t5', 'Green', 'Green', 'PedestrianRequest', '', 'shortenGreen', { internal: true }),
        T('t6', 'Off', 'Operating', 'PowerOn', '', '', { bend: -30 }),
        T('t7', 'Operating', 'Off', 'PowerOff', '', '', { bend: -30 }),
        T('t8', 'Operating', 'Flashing', 'Fault', '', 'logFault', { bend: 40 }),
        T('t9', 'Flashing', 'hist', 'Repair', '', '', { bend: 30 }),
        T('t10', 'Flashing', 'Off', 'PowerOff', '', '', { bend: -40 })
    ],
    events: {},
    codegen: { language: 'cpp', style: 'table', trace: true, threadSafe: false }
};

// ---------------------------------------------------------------- Tutorial 3: door lock (C#)

const t3 = {
    name: 'DoorLock',
    namespace: 'Security',
    states: [
        initial('init', null, 60, 168),
        state('Locked', null, 140, 130, 210, 100, 'engageBolt'),
        state('Unlocked', null, 560, 140, 160, 80, 'releaseBolt'),
        state('Alarm', null, 360, 360, 160, 80, 'sirenOn', 'sirenOff')
    ],
    transitions: [
        T('t0', 'init', 'Locked'),
        T('t1', 'Locked', 'Unlocked', 'EnterCode', 'isValidCode', 'resetAttempts', { bend: -30 }),
        T('t2', 'Locked', 'Alarm', 'EnterCode', 'tooManyAttempts', '', { bend: 70 }),
        T('t3', 'Locked', 'Locked', 'EnterCode', '', 'countFailure', { internal: true }),
        T('t4', 'Unlocked', 'Locked', 'Lock', '', '', { bend: -30 }),
        T('t5', 'Unlocked', 'Locked', 'Timeout', '', '', { bend: -80 }),
        T('t6', 'Alarm', 'Locked', 'Reset', 'isAdminCode', 'resetAttempts', { bend: 70 })
    ],
    events: { EnterCode: 'int code', Reset: 'int code' },
    codegen: { language: 'csharp', style: 'table', trace: true, threadSafe: true }
};

// ---------------------------------------------------------------- Reference screenshots

const problems = clone(t1Step3);
problems.states.push(state('Orphan', null, 640, 330, 140, 70));
problems.transitions[1].event = '';
problems.transitions.push(T('tx', 'Green', 'Red', 'Timer', '', '', { bend: 40 }));

const colored = clone(t2);
const paint = { Off: '#9aa5b1', Red: '#e06c75', Green: '#98c379', Yellow: '#e5a50a', Flashing: '#c678dd', Operating: '#61afef' };
colored.states.forEach(s => paint[s.id] && (s.color = paint[s.id]));
colored.transitions.find(t => t.id === 't8').color = '#e06c75';
colored.transitions.find(t => t.id === 't9').color = '#56b6c2';

const mediaPlayer = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'MediaPlayer.machina'), 'utf8'));
const vending = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'VendingMachine.machina'), 'utf8'));
const washer = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'Washer.machina'), 'utf8'));

// ---------------------------------------------------------------- output

const text = d => JSON.stringify(d, null, 2);
fs.writeFileSync(path.join(root, 'examples', 'TrafficLight.machina'), text(t2) + '\n');
fs.writeFileSync(path.join(root, 'examples', 'DoorLock.machina'), text(t3) + '\n');

const shotDir = path.join(__dirname, 'shots');
fs.mkdirSync(shotDir, { recursive: true });
const shots = {
    'tour': { diagram: mediaPlayer },
    // Only the toolbar strip is captured (docs/images/toolbar.png), with these code generation options.
    'toolbar': { diagram: { ...mediaPlayer, codegen: { language: 'csharp', style: 'table', trace: true, threadSafe: true, queue: false } } },
    't1-step1': { diagram: t1Step1, select: 'Red', mode: 'state' },
    't1-step2': { diagram: t1Step2, select: 'Yellow' },
    't1-step3': { diagram: t1Step3, select: 't1' },
    't1-step4': { diagram: t1, select: 'Red' },
    't1-sim': { diagram: t1, sim: ['Timer', 'Timer'] },
    't2-final': { diagram: t2 },
    't2-history': { diagram: t2, select: 'hist' },
    't2-internal': { diagram: t2, select: 't5' },
    't2-sim': { diagram: t2, sim: ['PowerOn', 'Timer', 'Fault', 'Repair'] },
    't3-params': { diagram: t3 },
    't3-guard': { diagram: t3, select: 't1' },
    't3-sim': { diagram: t3, sim: ['-isValidCode', '-tooManyAttempts', 'EnterCode(1111)', 'EnterCode(2222)', '+isValidCode', 'EnterCode(1234)'] },
    'ref-problems': { diagram: problems },
    'ref-colors': { diagram: colored, select: 'Flashing' },
    't4-overview': { diagram: vending },
    't4-choice': { diagram: vending, select: 't5' },
    't4-timeout': { diagram: vending, select: 't6' },
    't4-sim-choice': { diagram: vending, sim: ['-hasEnoughCredit', 'Coin(100)'] },
    't4-sim-completion': { diagram: vending, sim: ['-hasEnoughCredit', 'Coin(100)', '+hasEnoughCredit', 'Coin(50)', 'Select(1)', 'after 2 s'], coverage: true },
    't4-group': { diagram: vending, selectMany: ['Collecting', 'Ready', 'Boot'] },
    't5-overview': { diagram: washer },
    't5-region': { diagram: washer, select: 'rHeater' },
    't5-sim': { diagram: washer, sim: ['Start', 'TempReached', 'after 30 s'] },
    't5-scenario': { diagram: washer, sim: ['Run'], coverage: true }
};
for (const [name, shot] of Object.entries(shots)) {
    const { issues } = analyze(JSON.parse(text(shot.diagram)));
    fs.writeFileSync(path.join(shotDir, `${name}.json`), JSON.stringify({ ...shot, diagram: text(shot.diagram), issues }));
}

// Generated code shown in the manual.
const genDir = path.join(root, 'docs', 'generated');
fs.mkdirSync(genDir, { recursive: true });
const emit = (d, file, language, style, options = {}) => {
    const copy = JSON.parse(text(d));
    copy.codegen = { ...copy.codegen, ...options };
    const { machine, issues } = analyze(copy);
    if (!machine) {
        throw new Error(`${file}: ${issues.map(i => i.message).join('; ')}`);
    }
    fs.writeFileSync(path.join(genDir, file), generateCode(machine, language, style)[0].code);
};
emit(t1, 'TrafficLightFlat_switch.hpp', 'cpp', 'switch', { trace: false, threadSafe: false });
emit(t1, 'TrafficLightFlat_table.hpp', 'cpp', 'table', { trace: false, threadSafe: false });
emit(t1, 'TrafficLightFlat_switch.cs', 'csharp', 'switch', { trace: false, threadSafe: false });
emit(t1, 'TrafficLightFlat_table.cs', 'csharp', 'table', { trace: false, threadSafe: false });
emit(t2, 'TrafficLight.hpp', 'cpp', 'table');
emit(t3, 'DoorLock.cs', 'csharp', 'table');
emit(vending, 'VendingMachine.hpp', 'cpp', 'switch', { trace: true, threadSafe: false, queue: true });

// The C target writes a header and a source file, used by docs/examples/traffic_flat.c.
{
    const copy = JSON.parse(text(t1));
    copy.codegen = { ...copy.codegen, trace: true, threadSafe: false };
    for (const file of generateCode(analyze(copy).machine, 'c', 'switch')) {
        fs.writeFileSync(path.join(genDir, `${t1.name}${file.extension}`), file.code);
    }
}

// Excerpts of the generated code quoted in the manual. Each starts at the first line matching `start`
// and runs to the end of the brace block opened there (or of `blocks` consecutive blocks), or to the
// line matching `end`. Extracting by pattern keeps the excerpts right when the generators change.
const snippetDir = path.join(genDir, 'snippets');
fs.mkdirSync(snippetDir, { recursive: true });
const snippet = (name, file, start, { blocks = 1, end } = {}) => {
    const lines = fs.readFileSync(path.join(genDir, file), 'utf8').split('\n');
    const first = lines.findIndex(l => start.test(l));
    if (first < 0) {
        throw new Error(`snippet ${name}: ${start} not found in ${file}`);
    }
    let last = first;
    if (end) {
        last = lines.findIndex((l, i) => i > first && end.test(l));
    } else {
        let depth = 0;
        let opened = 0;
        for (let i = first; i < lines.length && opened <= blocks; i++) {
            for (const ch of lines[i]) {
                if (ch === '{') {
                    if (depth++ === 0) {
                        opened++;
                    }
                } else if (ch === '}') {
                    depth--;
                }
            }
            last = i;
            if (depth === 0 && opened === blocks) {
                break;
            }
        }
    }
    if (last < first) {
        throw new Error(`snippet ${name}: end of block not found in ${file}`);
    }
    const excerpt = lines.slice(first, last + 1);
    const indent = Math.min(...excerpt.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
    fs.writeFileSync(path.join(snippetDir, name), excerpt.map(l => l.slice(indent)).join('\n') + '\n');
};
snippet('table-handle.hpp', 'TrafficLightFlat_table.hpp', /bool HandleEvent\(/);
snippet('table-tryrow.hpp', 'TrafficLightFlat_table.hpp', /bool TryRow\(/);
snippet('table-rows.hpp', 'TrafficLightFlat_table.hpp', /^\s*\/\/ source, event, guard/);
snippet('switch-handle.hpp', 'TrafficLightFlat_switch.hpp', /bool HandleEvent\(/);
snippet('history.hpp', 'TrafficLight.hpp', /void EnterHistory\(/);
snippet('doorlock-table.cs', 'DoorLock.cs', /protected DoorLock\(\)/);
snippet('doorlock-dispatch.cs', 'DoorLock.cs', /public bool DispatchEnterCode\(/, { blocks: 2 });
snippet('doorlock-hooks.cs', 'DoorLock.cs', /<summary>Acquires mutual exclusion/, { end: /abstract void countFailure/ });
snippet('vending-timers.hpp', 'VendingMachine.hpp', /bool DispatchTimeout\(/);
console.log(`wrote ${Object.keys(shots).length} screenshot scenarios and generated code`);
