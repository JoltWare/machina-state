// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Tests of the extension-host logic that does not need VS Code: locating elements in the JSON text for the
// Problems panel, the stored code generation settings, the auto-layout's transition geometry (checked
// against the webview's own functions, extracted from media/editor.js) and the webview bundle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { analyze, loadExample, exampleNames, root } = require('./helpers');
const { locateElement, locateTopLevelKey, jsonErrorOffset, storedCodegen, importCodegen, manualUrl } = require('../out/hostUtil.js');
const { autoLayout, boundaryPoint, curveMidpoint, bendThrough, polylineMidpoint } = require('../out/layout.js');

const S = (id, kind = 'state', parent = null, extra = {}) => ({ id, name: id, kind, parent, x: 0, y: 0, w: 10, h: 10, ...extra });
const T = (id, source, target, event = '', extra = {}) => ({ id, source, target, event, guard: '', action: '', ...extra });
/** The text covered by a span. */
const slice = (text, span) => text.slice(span.start, span.end);

// ------------------------------------------------------------------ locating elements

test('locateElement finds the id property of the element, in its own array', () => {
    const d = { name: 'M', states: [S('a'), S('shared')], transitions: [T('t1', 'a', 'shared'), T('shared', 'shared', 'a')] };
    const text = JSON.stringify(d, null, 2);
    // States first by default (as the webview does), the transition when asked for.
    const state = locateElement(text, 'shared');
    const transition = locateElement(text, 'shared', 'transitions');
    assert.equal(slice(text, state), '"id": "shared"');
    assert.equal(slice(text, transition), '"id": "shared"');
    assert.ok(state.start < text.indexOf('"transitions"') && transition.start > text.indexOf('"transitions"'));
    // A transition-only id is found among the transitions without a hint.
    assert.ok(locateElement(text, 't1').start > text.indexOf('"transitions"'));
    assert.equal(locateElement(text, 'missing'), undefined);
});

test('locateElement compares decoded ids and ignores ids outside the element arrays', () => {
    const odd = 'a"b\\c/é';
    const d = {
        name: 'M',
        // An "id" property in another top-level member and inside an element's nested object come first.
        scenarios: [{ name: 's', steps: [], id: 'x' }],
        states: [S('y', 'state', null, { meta: { id: 'x' } }), S(odd), S('x')],
        transitions: []
    };
    const text = JSON.stringify(d);
    assert.equal(slice(text, locateElement(text, 'x')), '"id":"x"');
    assert.equal(locateElement(text, 'x').start, text.lastIndexOf('"id":"x"'));
    assert.equal(slice(text, locateElement(text, odd)), `"id":${JSON.stringify(odd)}`);
    // Escapes that JSON.stringify would not produce are decoded as well.
    const escaped = '{"states":[{"id":"\\u0041\\/B","kind":"state"}],"transitions":[]}';
    assert.equal(slice(escaped, locateElement(escaped, 'A/B')), '"id":"\\u0041\\/B"');
});

test('locateElement and locateTopLevelKey tolerate odd documents', () => {
    assert.equal(locateElement('', 'a'), undefined);
    assert.equal(locateElement('[1, 2]', 'a'), undefined);
    assert.equal(locateElement('{"states": {"id": "a"}}', 'a'), undefined);
    assert.equal(locateElement('{"states": [1, null, "a", {"id": 5}, {"id": "a"}]}', 'a').start, 38);
    assert.equal(locateElement('{"states": [{"id": "a"}', 'a'), undefined); // unterminated
    const text = '{\n  "name": "M",\n  "states": [],\n  "transitions": []\n}';
    assert.equal(slice(text, locateTopLevelKey(text, 'states')), '"states"');
    assert.equal(locateTopLevelKey(text, 'events'), undefined);
});

test('jsonErrorOffset extracts the position of a JSON.parse error', () => {
    const text = '{"a": 1,, }';
    let message = '';
    try {
        JSON.parse(text);
    } catch (err) {
        message = err.message;
    }
    const offset = jsonErrorOffset(message, text.length);
    assert.equal(offset, 8, message);
    assert.equal(jsonErrorOffset('Unexpected token in JSON at position 99', 10), 10);
    assert.equal(jsonErrorOffset('Unexpected end of JSON input', 10), undefined);
});

// ------------------------------------------------------------------ stored code generation settings

test('storedCodegen accepts only known languages and styles', () => {
    assert.deepEqual(storedCodegen({ language: 'c', style: 'table' }), { language: 'c', style: 'table' });
    assert.deepEqual(storedCodegen({ language: 'java', style: 'switch' }), { language: undefined, style: 'switch' });
    assert.deepEqual(storedCodegen(undefined), { language: undefined, style: undefined });
});

test('importCodegen fills in defaults without clobbering imported settings', () => {
    assert.deepEqual(importCodegen(undefined), { language: 'cpp', style: 'switch' });
    assert.deepEqual(importCodegen({ language: 'csharp', trace: true, queueCapacity: 8 }), { language: 'csharp', style: 'switch', trace: true, queueCapacity: 8 });
    assert.deepEqual(importCodegen({ style: 'bogus' }, { language: 'c', style: 'table' }), { language: 'c', style: 'table' });
});

// ------------------------------------------------------------------ help

test('manualUrl points at the manual of the release tag', () => {
    assert.equal(manualUrl('0.4.0'), 'https://github.com/JoltWare/machina-state/blob/v0.4.0/docs/manual.pdf');
    assert.equal(manualUrl('1.0.0-beta'), 'https://github.com/JoltWare/machina-state/blob/main/docs/manual.pdf');
    assert.equal(manualUrl(undefined), 'https://github.com/JoltWare/machina-state/blob/main/docs/manual.pdf');
});

// ------------------------------------------------------------------ transition geometry

/**
 * The webview's geometry functions, taken verbatim from media/editor.js and evaluated against a given
 * diagram, so that layout.ts is compared with the real implementation rather than a copy that could drift.
 */
function webviewGeometry(diagram) {
    const source = fs.readFileSync(path.join(root, 'media', 'editor.js'), 'utf8');
    const extract = name => {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `media/editor.js has no function ${name}`);
        let depth = 0;
        for (let i = source.indexOf('{', start); i < source.length; i++) {
            depth += source[i] === '{' ? 1 : source[i] === '}' ? -1 : 0;
            if (depth === 0) {
                return source.slice(start, i + 1);
            }
        }
        throw new Error(`unbalanced function ${name}`);
    };
    const context = {
        diagram,
        byId: id => diagram.states.find(s => s.id === id),
        center: s => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 }),
        isInternal: t => t.internal === true && t.source === t.target
    };
    vm.createContext(context);
    vm.runInContext(['boundaryPoint', 'frame', 'transitionGeometry'].map(extract).join('\n'), context);
    return context;
}

/** Midpoint (t = 0.5) of the quadratic curve in an SVG path `M x y Q cx cy x y`. */
function pathMidpoint(d) {
    const [x1, y1, cx, cy, x2, y2] = /^M (\S+) (\S+) Q (\S+) (\S+) (\S+) (\S+)$/.exec(d).slice(1).map(Number);
    return { x: x1 / 4 + cx / 2 + x2 / 4, y: y1 / 4 + cy / 2 + y2 / 4 };
}

// Pairs of shapes in different relative positions, including a pseudostate (circle outline).
const shapes = [
    [S('a', 'state', null, { x: 0, y: 0, w: 120, h: 60 }), S('b', 'state', null, { x: 300, y: 40, w: 140, h: 80 })],
    [S('a', 'state', null, { x: 0, y: 0, w: 300, h: 200 }), S('b', 'state', null, { x: 80, y: 320, w: 120, h: 60 })],
    [S('a', 'initial', null, { x: 10, y: 10, w: 24, h: 24 }), S('b', 'state', null, { x: 200, y: -100, w: 120, h: 60 })],
    [S('a', 'state', null, { x: 400, y: 300, w: 120, h: 60 }), S('b', 'choice', null, { x: 0, y: 0, w: 30, h: 30 })]
];

test('layout geometry matches the webview', () => {
    for (const [a, b] of shapes) {
        const diagram = { states: [a, b], transitions: [] };
        const web = webviewGeometry(diagram);
        for (const toward of [{ x: 1000, y: 3 }, { x: -5, y: -700 }, { x: a.x + a.w / 2, y: a.y + a.h / 2 }]) {
            assert.deepEqual(boundaryPoint(a, toward), { ...web.boundaryPoint(a, toward) });
        }
        for (const bend of [0, 7, -40, 133, -250]) {
            const t = T('t', 'a', 'b', 'e', { bend });
            diagram.transitions = [t];
            const expected = pathMidpoint(web.transitionGeometry(t).path);
            const actual = curveMidpoint(a, b, bend);
            assert.ok(Math.hypot(expected.x - actual.x, expected.y - actual.y) < 1e-9, `bend ${bend}`);
        }
    }
});

test('bendThrough inverts the webview curve', () => {
    for (const [a, b] of shapes) {
        for (const bend of [0, 15, -15, 90, -180, 249]) {
            assert.ok(Math.abs(bendThrough(a, b, curveMidpoint(a, b, bend)) - bend) <= 1, `bend ${bend}`);
        }
        // Beyond the limit the bend is clamped.
        assert.equal(bendThrough(a, b, curveMidpoint(a, b, 600)), 250);
        assert.equal(bendThrough(a, b, curveMidpoint(a, b, -600)), -250);
        assert.equal(bendThrough(a, b, curveMidpoint(a, b, 80), 50), 50);
    }
});

test('polylineMidpoint walks half the arc length', () => {
    assert.deepEqual(polylineMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }]), { x: 5, y: 0 });
    assert.deepEqual(polylineMidpoint([{ x: 0, y: 0 }, { x: 0, y: 30 }, { x: 10, y: 30 }]), { x: 0, y: 20 });
    assert.deepEqual(polylineMidpoint([{ x: 3, y: 4 }, { x: 3, y: 4 }]), { x: 3, y: 4 });
});

test('auto-layout bends are whole numbers within the limit', async () => {
    for (const name of exampleNames()) {
        const d = loadExample(name);
        await autoLayout(d);
        for (const t of d.transitions) {
            assert.ok(t.bend === undefined || (Number.isInteger(t.bend) && Math.abs(t.bend) <= 250), `${name}/${t.id}: ${t.bend}`);
        }
    }
});

test('auto-layout gives misplaced children of a state with regions a position inside it', async () => {
    const d = {
        name: 'M',
        states: [
            S('i0', 'initial'),
            S('P'),
            S('r1', 'region', 'P'),
            S('i1', 'initial', 'r1'),
            S('A', 'state', 'r1'),
            S('r2', 'region', 'P'),
            S('i2', 'initial', 'r2'),
            S('B', 'state', 'r2'),
            // Invalid: directly inside P although P has regions.
            S('Stray', 'state', 'P'),
            S('Stray2', 'state', 'P', { entry: 'aVeryLongEntryActionName' })
        ],
        transitions: [T('t0', 'i0', 'P'), T('t1', 'i1', 'A'), T('t2', 'i2', 'B')]
    };
    assert.ok(analyze(JSON.parse(JSON.stringify(d))).issues.some(i => i.id === 'Stray'));
    await autoLayout(d);
    const byId = new Map(d.states.map(s => [s.id, s]));
    const P = byId.get('P');
    const inside = (s, p) => s.x >= p.x && s.y >= p.y && s.x + s.w <= p.x + p.w && s.y + s.h <= p.y + p.h;
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (const id of ['r1', 'r2', 'Stray', 'Stray2']) {
        assert.ok(inside(byId.get(id), P), `${id} outside P`);
    }
    for (const a of ['r1', 'r2', 'Stray', 'Stray2']) {
        for (const b of ['r1', 'r2', 'Stray', 'Stray2']) {
            assert.ok(a === b || !overlap(byId.get(a), byId.get(b)), `${a} overlaps ${b}`);
        }
    }
});

// ------------------------------------------------------------------ webview bundle

test('the webview bundle exposes every export of model and engine', () => {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'media', 'machina.js'), 'utf8'), context);
    const expected = [...Object.keys(require('../out/model.js')), ...Object.keys(require('../out/engine.js'))].sort();
    assert.deepEqual(Object.keys(context.window.Machina).sort(), expected);
    assert.equal(typeof context.window.Machina.Engine, 'function');
});
