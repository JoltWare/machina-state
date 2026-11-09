// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Browser tests for the diagram editor and simulator (media/editor.js), driven with Playwright.
//
// The editor runs in docs/tools/harness.html, which stands in for the VS Code webview: it stubs
// acquireVsCodeApi() and records every message the editor posts in window.posted. The tests feed
// diagrams in with the same 'update' message the extension host sends and read edits back from
// the 'edit' messages.
//
// playwright-core does not download a browser; it drives an installed Chromium, Edge or Chrome.
// Set MACHINA_BROWSER to a channel name ('msedge', 'chrome') or an executable path to choose one.
// Without a browser the tests are skipped, unless MACHINA_UI_REQUIRED=1 (as in CI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const harness = pathToFileURL(path.join(root, 'docs', 'tools', 'harness.html')).href;
const example = name => fs.readFileSync(path.join(root, 'examples', `${name}.machina`), 'utf8');
const empty = JSON.stringify({ name: 'Machine', namespace: '', states: [], transitions: [], events: {} });

let chromium = null;
try {
    ({ chromium } = require('playwright-core'));
} catch {
    // Not installed: every test is skipped below.
}

async function launch() {
    const choice = process.env.MACHINA_BROWSER;
    const options = choice
        ? [/[\\/]/.test(choice) ? { executablePath: choice } : { channel: choice }]
        : [{}, { channel: 'msedge' }, { channel: 'chrome' }, { channel: 'chromium' }];
    const errors = [];
    for (const o of options) {
        try {
            return await chromium.launch(o);
        } catch (err) {
            errors.push(`${JSON.stringify(o)}: ${err.message.split('\n')[0]}`);
        }
    }
    throw new Error('no browser could be launched:\n  ' + errors.join('\n  '));
}

let browser = null;
let skip = chromium ? false : 'playwright-core is not installed';

test.before(async () => {
    if (skip) {
        return;
    }
    try {
        browser = await launch();
    } catch (err) {
        if (process.env.MACHINA_UI_REQUIRED === '1') {
            throw err;
        }
        skip = err.message;
    }
});

test.after(async () => {
    if (browser) {
        await browser.close();
    }
});

/** Opens the editor on a diagram and returns helpers bound to the page. */
async function open(text) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 650 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err));
    await page.goto(harness);
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    await page.evaluate(t => window.postMessage({ type: 'update', text: t }, '*'), text);
    await page.waitForFunction(() => document.querySelector('#panel').childElementCount > 0 || !document.querySelector('#parse-error').hidden);
    const canvas = await page.locator('#canvas').boundingBox();
    return {
        page,
        errors,
        /** Client coordinates of a diagram point, for the default view of an empty diagram (offset 40, scale 1). */
        at: (x, y) => ({ x: canvas.x + 40 + x, y: canvas.y + 40 + y }),
        /**
         * Client coordinates of a diagram point under the current view (whatever pan/zoom fit() or the test
         * left), from the screen transform of the viewport group.
         */
        screen: (x, y) =>
            page.evaluate(
                ([x, y]) => {
                    const m = document.getElementById('viewport').getScreenCTM();
                    return { x: m.a * x + m.e, y: m.d * y + m.f };
                },
                [x, y]
            ),
        /** The diagram as last sent to the extension host in an 'edit' message. */
        async edited() {
            const text = await page.evaluate(() => {
                const edits = window.posted.filter(m => m.type === 'edit');
                return edits.length ? edits[edits.length - 1].text : null;
            });
            return text && JSON.parse(text);
        },
        /** Number of 'edit' messages posted so far (each one is an undo step in VS Code). */
        edits: () => page.evaluate(() => window.posted.filter(m => m.type === 'edit').length),
        /** Waits until more than `count` 'edit' messages have been posted. */
        waitForEdit: count => page.waitForFunction(n => window.posted.filter(m => m.type === 'edit').length > n, count),
        /** Posts a message to the editor as the extension host does. */
        post: msg => page.evaluate(m => window.postMessage(m, '*'), msg),
        async centerOf(id) {
            const b = await page.locator(`g[data-id="${id}"]`).first().boundingBox();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        },
        async tool(name) {
            await page.click(`#tools button[data-mode="${name}"]`);
        },
        /** Clicks a client point, holding the given keys (mouse.click itself ignores modifiers). */
        async click(p, modifiers = []) {
            for (const key of modifiers) {
                await page.keyboard.down(key);
            }
            await page.mouse.click(p.x, p.y);
            for (const key of modifiers) {
                await page.keyboard.up(key);
            }
        },
        async drag(from, to) {
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
            await page.mouse.move(to.x, to.y, { steps: 4 });
            await page.mouse.up();
        },
        panelButton: label => page.locator('#panel button', { hasText: new RegExp(`^${label}`) }).first(),
        field: label => page.locator('#panel label.field', { has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) }).locator('input'),
        log: () => page.locator('#panel .log li').allTextContents(),
        active: () => page.locator('#panel p strong').first().textContent(),
        async close() {
            await page.close();
            assert.deepEqual(errors.map(e => e.message), [], 'no script errors in the editor');
        }
    };
}

const uiWith = (name, text, fn) =>
    test(name, { timeout: 60000 }, async t => {
        if (skip) {
            t.skip(skip);
            return;
        }
        const editor = await open(text);
        try {
            await fn(editor);
        } finally {
            await editor.close();
        }
    });

const ui = (name, fn) => uiWith(name, empty, fn);

// ------------------------------------------------------------------ editing

ui('state tools create states, initial pseudostates and final states', async e => {
    await e.tool('initial');
    await e.click(e.at(20, 100));
    await e.tool('state');
    await e.click(e.at(150, 100));
    await e.tool('state');
    await e.click(e.at(400, 100));
    await e.tool('final');
    await e.click(e.at(600, 100));

    const d = await e.edited();
    assert.deepEqual(d.states.map(s => [s.kind, s.name]), [
        ['initial', 'Initial'],
        ['state', 'State1'],
        ['state', 'State2'],
        ['final', 'Final1']
    ]);
    // Each new state is centred on the click and selected, and the tool returns to Select.
    const s1 = d.states[1];
    assert.equal(s1.x + s1.w / 2, 150);
    assert.equal(s1.y + s1.h / 2, 100);
    assert.equal(await e.page.locator('#tools button.on').getAttribute('data-mode'), 'select');
    assert.equal(await e.page.locator('g.node.selected').count(), 1);
    assert.equal(await e.field('Name').inputValue(), 'Final1');
});

ui('the properties panel renames a state', async e => {
    await e.tool('state');
    await e.click(e.at(200, 150));
    const name = e.page.locator('#prop-name');
    await name.fill('Idle');
    await name.press('Enter');
    const d = await e.edited();
    assert.equal(d.states[0].name, 'Idle');
    assert.equal(await e.page.locator('g.node.state text').first().textContent(), 'Idle');
});

ui('the transition tool connects states and the panel edits the event and guard', async e => {
    await e.tool('initial');
    await e.click(e.at(20, 100));
    await e.tool('state');
    await e.click(e.at(150, 100));
    await e.tool('state');
    await e.click(e.at(450, 100));
    let d = await e.edited();
    const [init, a, b] = d.states.map(s => s.id);

    await e.tool('transition');
    await e.drag(await e.centerOf(init), await e.centerOf(a));
    await e.tool('transition');
    await e.drag(await e.centerOf(a), await e.centerOf(b));

    // The new transition is selected: give it an event and a guard.
    await e.field('Event').fill('Go');
    await e.field('Event').press('Enter');
    await e.field('Guard').fill('isReady');
    await e.field('Guard').press('Enter');

    d = await e.edited();
    assert.deepEqual(
        d.transitions.map(t => [t.source, t.target, t.event, t.guard]),
        [
            [init, a, '', ''],
            [a, b, 'Go', 'isReady']
        ]
    );
    assert.equal(await e.page.locator('#viewport [data-kind="transition"]').count() >= 2, true);
});

ui('an initial pseudostate gets only one outgoing transition, and a final state none', async e => {
    await e.tool('initial');
    await e.click(e.at(20, 100));
    await e.tool('state');
    await e.click(e.at(150, 100));
    await e.tool('final');
    await e.click(e.at(400, 100));
    const [init, a, fin] = (await e.edited()).states.map(s => s.id);

    for (const [from, to] of [[init, a], [init, a], [fin, a]]) {
        await e.tool('transition');
        await e.drag(await e.centerOf(from), await e.centerOf(to));
    }
    assert.equal((await e.edited()).transitions.length, 1);
});

ui('dragging a state into another nests it, and moving the parent moves the child', async e => {
    await e.tool('state');
    await e.click(e.at(500, 300));
    await e.tool('state');
    await e.click(e.at(150, 100));
    let d = await e.edited();
    const [outer, inner] = d.states.map(s => s.id);

    // Select the outer state and drag its resize handle to make room for the other one.
    await e.click(await e.centerOf(outer));
    const hb = await e.page.locator(`[data-kind="handle"][data-id="${outer}"]`).boundingBox();
    const hc = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
    await e.drag(hc, { x: hc.x + 200, y: hc.y + 150 });
    d = await e.edited();
    const big = d.states.find(s => s.id === outer);
    assert.ok(big.w >= 300 && big.h >= 200, `resized to ${big.w}x${big.h}`);

    await e.drag(await e.centerOf(inner), e.at(big.x + big.w / 2, big.y + big.h / 2));
    d = await e.edited();
    assert.equal(d.states.find(s => s.id === inner).parent, outer);

    const before = d.states.find(s => s.id === inner);
    const title = e.at(big.x + 20, big.y + 12);
    await e.drag(title, { x: title.x - 100, y: title.y - 50 });
    d = await e.edited();
    const after = d.states.find(s => s.id === inner);
    assert.equal(after.x - before.x, d.states.find(s => s.id === outer).x - big.x);
    assert.equal(after.y - before.y, d.states.find(s => s.id === outer).y - big.y);
    assert.notEqual(after.x, before.x);
});

ui('a region can be added to a state and holds its own substates', async e => {
    await e.tool('state');
    await e.click(e.at(300, 200));
    let d = await e.edited();
    const owner = d.states[0].id;
    await e.page.evaluate(id => {
        // Enlarge the state through the same path as the text editor: an update message.
        const text = window.posted.filter(m => m.type === 'edit').pop().text;
        const diagram = JSON.parse(text);
        Object.assign(diagram.states.find(s => s.id === id), { x: 0, y: 0, w: 600, h: 400 });
        window.postMessage({ type: 'update', text: JSON.stringify(diagram, null, 2) }, '*');
    }, owner);
    await e.page.waitForTimeout(50);
    await e.tool('region');
    await e.click(e.at(300, 120));
    await e.tool('state');
    await e.click(e.at(300, 120));
    d = await e.edited();
    const region = d.states.find(s => s.kind === 'region');
    assert.ok(region, 'region created');
    assert.equal(region.parent, owner);
    assert.equal(d.states.find(s => s.name === 'State2').parent, region.id);
    assert.equal(await e.page.locator('g.node.region').count(), 1);
});

ui('shift+click selects several states; Delete removes them with their transitions', async e => {
    await e.tool('state');
    await e.click(e.at(100, 100));
    await e.tool('state');
    await e.click(e.at(350, 100));
    await e.tool('state');
    await e.click(e.at(600, 100));
    let d = await e.edited();
    const [a, b, c] = d.states.map(s => s.id);
    await e.tool('transition');
    await e.drag(await e.centerOf(a), await e.centerOf(b));
    await e.tool('transition');
    await e.drag(await e.centerOf(b), await e.centerOf(c));

    await e.click(await e.centerOf(a));
    await e.click(await e.centerOf(b), ['Shift']);
    assert.equal(await e.page.locator('#panel h3').textContent(), '2 states selected');
    assert.equal(await e.page.locator('g.node.selected').count(), 2);

    await e.page.keyboard.press('Delete');
    d = await e.edited();
    assert.deepEqual(d.states.map(s => s.id), [c]);
    assert.deepEqual(d.transitions, []);
});

ui('shift+drag on the canvas selects the states inside the marquee', async e => {
    for (const x of [100, 250, 600]) {
        await e.tool('state');
        await e.click(e.at(x, 100));
    }
    await e.page.keyboard.press('Escape'); // drop the selection of the last new state
    await e.page.keyboard.down('Shift');
    await e.drag(e.at(10, 40), e.at(340, 170));
    await e.page.keyboard.up('Shift');
    assert.equal(await e.page.locator('#panel h3').textContent(), '2 states selected');
});

ui('the align buttons line up the selected states', async e => {
    await e.tool('state');
    await e.click(e.at(100, 100));
    await e.tool('state');
    await e.click(e.at(350, 220));
    const [a, b] = (await e.edited()).states.map(s => s.id);
    await e.click(await e.centerOf(a));
    await e.click(await e.centerOf(b), ['Shift']);
    await e.panelButton('Top').click();
    const d = await e.edited();
    assert.equal(d.states[0].y, d.states[1].y);
});

ui('copy and paste duplicate states with their inner transitions and fresh names', async e => {
    await e.tool('state');
    await e.click(e.at(100, 100));
    await e.tool('state');
    await e.click(e.at(350, 100));
    const [a, b] = (await e.edited()).states.map(s => s.id);
    await e.tool('transition');
    await e.drag(await e.centerOf(a), await e.centerOf(b));
    await e.click(await e.centerOf(a));
    await e.click(await e.centerOf(b), ['Shift']);

    // Clipboard events as the webview receives them for Ctrl+C / Ctrl+V.
    const copied = await e.page.evaluate(() => {
        const data = new DataTransfer();
        document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true }));
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
        return data.getData('text/plain');
    });
    assert.equal(JSON.parse(copied).tag, 'machina-state/clipboard');

    const d = await e.edited();
    assert.deepEqual(d.states.map(s => s.name), ['State1', 'State2', 'State3', 'State4']);
    assert.equal(d.transitions.length, 2);
    const [orig, copy] = d.transitions;
    const ids = new Set(d.states.slice(2).map(s => s.id));
    assert.ok(ids.has(copy.source) && ids.has(copy.target), 'pasted transition connects the pasted states');
    assert.notEqual(copy.id, orig.id);
    assert.equal(d.states[2].x - d.states[0].x, 30, 'pasted with an offset');
    // The pasted states are the new selection.
    assert.equal(await e.page.locator('#panel h3').textContent(), '2 states selected');
});

ui('Ctrl+D duplicates and arrow keys nudge the selection', async e => {
    await e.tool('state');
    await e.click(e.at(100, 100));
    await e.page.locator('#canvas').focus();
    await e.page.keyboard.press('Control+d');
    let d = await e.edited();
    assert.equal(d.states.length, 2);
    const x = d.states[1].x;
    const count = await e.edits();
    await e.page.keyboard.press('ArrowRight');
    await e.page.keyboard.press('Shift+ArrowDown');
    // The burst of nudges is committed once, after a short idle time.
    assert.equal(await e.edits(), count, 'not committed while nudging');
    await e.waitForEdit(count);
    d = await e.edited();
    assert.equal(d.states[1].x, x + 1);
    assert.equal(d.states[1].y, d.states[0].y + 30 + 50);
    await e.page.waitForTimeout(600);
    assert.equal(await e.edits(), count + 1, 'one undo step for the burst');
});

// A big state with a small state to its right, for the nesting tests.
const nestDiagram = JSON.stringify({
    name: 'Nest',
    states: [
        { id: 'outer', name: 'Outer', kind: 'state', parent: null, x: 0, y: 0, w: 300, h: 200 },
        { id: 's', name: 'S', kind: 'state', parent: null, x: 330, y: 70, w: 100, h: 60 }
    ],
    transitions: []
});

uiWith('nudging a state into or out of another re-nests it', nestDiagram, async e => {
    await e.click(await e.centerOf('s'));
    let count = await e.edits();
    // Two large steps (50 units each) move the centre of S from x = 380 to 280, inside Outer.
    await e.page.keyboard.press('Shift+ArrowLeft');
    await e.page.keyboard.press('Shift+ArrowLeft');
    await e.waitForEdit(count);
    let d = await e.edited();
    assert.equal(d.states.find(s => s.id === 's').x, 230);
    assert.equal(d.states.find(s => s.id === 's').parent, 'outer');
    assert.equal(await e.edits(), count + 1);
    assert.match(await e.page.locator('#panel').textContent(), /Parent: Outer/);

    // Any other action commits a pending nudge first: here a click on the canvas right after the key.
    count = await e.edits();
    await e.page.keyboard.press('Shift+ArrowRight');
    await e.page.keyboard.press('Shift+ArrowRight');
    await e.click(await e.screen(200, 215));
    assert.equal(await e.edits(), count + 1);
    d = await e.edited();
    assert.equal(d.states.find(s => s.id === 's').parent, null);
});

uiWith('resizing releases children that end up outside and adopts states now inside', JSON.stringify({
    name: 'Resize',
    states: [
        { id: 'outer', name: 'Outer', kind: 'state', parent: null, x: 0, y: 0, w: 400, h: 300 },
        { id: 'c', name: 'C', kind: 'state', parent: 'outer', x: 300, y: 200, w: 80, h: 60 },
        { id: 'd', name: 'D', kind: 'state', parent: null, x: 500, y: 50, w: 60, h: 40 }
    ],
    transitions: []
}), async e => {
    await e.page.click('#btn-snap'); // edges snap to the grid, so the sizes are exact at any zoom
    await e.click(await e.screen(40, 10));
    // The handle's centre lies one unit inside the bottom-right corner.
    await e.drag(await e.screen(399, 299), await e.screen(249, 179));
    let d = await e.edited();
    const outer = d.states.find(s => s.id === 'outer');
    assert.deepEqual([outer.w, outer.h], [250, 180]);
    assert.equal(d.states.find(s => s.id === 'c').parent, null, 'C released by shrinking');

    await e.drag(await e.screen(249, 179), await e.screen(599, 299));
    d = await e.edited();
    assert.equal(d.states.find(s => s.id === 'outer').w, 600);
    assert.equal(d.states.find(s => s.id === 'c').parent, 'outer', 'C adopted by growing');
    assert.equal(d.states.find(s => s.id === 'd').parent, 'outer', 'D adopted by growing');
});

uiWith('Same width / height use the first real state and keep the minimum size', JSON.stringify({
    name: 'Sizes',
    states: [
        { id: 'p', name: 'Initial', kind: 'initial', parent: null, x: 0, y: 0, w: 24, h: 24 },
        { id: 'a', name: 'A', kind: 'state', parent: null, x: 100, y: 0, w: 50, h: 30 },
        { id: 'b', name: 'B', kind: 'state', parent: null, x: 250, y: 0, w: 140, h: 70 }
    ],
    transitions: []
}), async e => {
    await e.click(await e.centerOf('p'));
    await e.click(await e.centerOf('a'), ['Shift']);
    await e.click(await e.centerOf('b'), ['Shift']);
    assert.equal(await e.page.locator('#panel h3').textContent(), '3 states selected');
    await e.panelButton('Same width').click();
    await e.panelButton('Same height').click();
    const d = await e.edited();
    const size = id => {
        const s = d.states.find(x => x.id === id);
        return [s.w, s.h];
    };
    assert.deepEqual(size('p'), [24, 24], 'the pseudostate is neither the reference nor resized');
    assert.deepEqual(size('a'), [60, 40]);
    assert.deepEqual(size('b'), [60, 40]);
});

uiWith('unknown members of the file survive an edit', JSON.stringify({
    name: 'Extra',
    version: 3,
    'x-tool': { layout: 'manual' },
    codegen: 'not an object',
    states: [{ id: 'a', name: 'A', kind: 'state', parent: null, x: 0, y: 0, w: 100, h: 60, note: 'keep me' }],
    transitions: [],
    events: {}
}), async e => {
    await e.click(await e.centerOf('a'));
    await e.field('Name').fill('Renamed');
    await e.field('Name').press('Enter');
    const d = await e.edited();
    assert.equal(d.states[0].name, 'Renamed');
    assert.equal(d.version, 3);
    assert.deepEqual(d['x-tool'], { layout: 'manual' });
    assert.equal(d.states[0].note, 'keep me');
    assert.equal(d.codegen.language, 'cpp', 'an invalid codegen value is replaced by the defaults');
});

uiWith('clicking a problem selects only its element; problems without a known id are plain text', nestDiagram, async e => {
    await e.click(await e.centerOf('outer'));
    await e.click(await e.centerOf('s'), ['Shift']);
    assert.equal(await e.page.locator('g.node.selected').count(), 2);
    await e.post({
        type: 'validation',
        issues: [{ message: 'S problem', id: 's' }, { message: 'Machine problem' }, { message: 'Gone', id: 'deleted' }]
    });
    await e.page.waitForFunction(() => document.querySelectorAll('#issues li').length === 3);
    assert.equal(await e.page.locator('#issues li.link').count(), 1);
    await e.page.locator('#issues li', { hasText: 'S problem' }).click();
    assert.equal(await e.page.locator('g.node.selected').count(), 1);
    assert.equal(await e.page.locator('g.node.selected').getAttribute('data-id'), 's');
    await e.page.locator('#issues li', { hasText: 'Machine problem' }).click();
    await e.page.locator('#issues li', { hasText: 'Gone' }).click();
    assert.equal(await e.page.locator('g.node.selected').getAttribute('data-id'), 's', 'unchanged');
});

ui('malformed messages are ignored', async e => {
    for (const msg of [null, 'update', 42, { type: 'update' }, { type: 'update', text: 5 }, { type: 'validation', issues: 'x' }]) {
        await e.post(msg);
    }
    await e.post({ type: 'validation', issues: [null, 7, { message: 'Real problem', id: 3 }] });
    await e.page.waitForFunction(() => document.querySelector('#issues h4')?.textContent === 'Problems (1)');
    assert.equal(await e.page.locator('#issues li.link').count(), 0);
    await e.page.locator('#issues li').click();
});

ui('the dot grid follows pan and zoom on the snap grid', async e => {
    const grid = () =>
        e.page.evaluate(() => {
            const p = document.getElementById('grid');
            const m = document.getElementById('viewport').transform.baseVal.consolidate().matrix;
            const attr = n => Number(p.getAttribute(n));
            // Diagram coordinate of the dot in the tile at the pattern origin.
            const pitch = attr('width');
            return { pitch, x: attr('x'), scale: m.a, dot: (attr('x') + pitch / 2 - m.e) / m.a };
        });
    let g = await grid();
    assert.equal(g.pitch, 10);
    assert.equal(Math.abs(g.dot % 10), 0);

    // Pan by dragging the empty canvas: the dots move with the diagram.
    const x0 = g.x;
    await e.drag(e.at(300, 300), e.at(313, 307));
    g = await grid();
    assert.equal(g.x - x0, 13);
    assert.ok(Math.abs(g.dot - Math.round(g.dot / 10) * 10) < 1e-6, `dot at ${g.dot}`);

    // Zoom out: the pitch scales and coarsens to a multiple of the snap grid.
    await e.page.mouse.move(e.at(300, 300).x, e.at(300, 300).y);
    await e.page.mouse.wheel(0, 600);
    g = await grid();
    assert.ok(g.scale < 1);
    const units = g.pitch / g.scale;
    assert.ok([10, 20, 50, 100].some(u => Math.abs(units - u) < 1e-6), `pitch ${units} units`);
    assert.ok(g.pitch >= 10);
    assert.ok(Math.abs(g.dot / units - Math.round(g.dot / units)) < 1e-6, `dot at ${g.dot}`);
});

ui('invalid JSON shows no clickable problems', async e => {
    await e.post({ type: 'update', text: '{ "states": [' });
    await e.post({ type: 'validation', issues: [{ message: 'Parse error', id: 'a' }] });
    await e.page.waitForFunction(() => document.querySelector('#issues').textContent.includes('Parse error'));
    assert.equal(await e.page.locator('#issues li.link').count(), 0);
    await e.page.locator('#issues li').click();
});

ui('the code generation options are saved in the diagram', async e => {
    await e.page.selectOption('#sel-lang', 'c');
    await e.page.selectOption('#sel-style', 'table');
    await e.page.check('#chk-trace');
    await e.page.check('#chk-queue');
    const d = await e.edited();
    assert.deepEqual(
        { language: d.codegen.language, style: d.codegen.style, trace: d.codegen.trace, queue: d.codegen.queue, threadSafe: d.codegen.threadSafe },
        { language: 'c', style: 'table', trace: true, queue: true, threadSafe: false }
    );
    await e.page.click('#btn-gen');
    const posted = await e.page.evaluate(() => window.posted.filter(m => m.type === 'generate'));
    assert.deepEqual(posted, [{ type: 'generate', language: 'c', style: 'table' }]);
});

ui('validation issues are listed under the properties panel', async e => {
    await e.page.evaluate(() =>
        window.postMessage({ type: 'validation', issues: [{ severity: 'error', message: 'Region "Machine" has no initial pseudostate.' }] }, '*')
    );
    await e.page.waitForFunction(() => document.querySelector('#issues').textContent.includes('no initial pseudostate'));
});

ui('warnings are listed in the warning colour, errors in the error colour', async e => {
    await e.post({ type: 'validation', issues: [{ message: 'Unused choice', severity: 'warning' }, { message: 'Broken' }, { message: 'Odd', severity: 'bogus' }] });
    await e.page.waitForFunction(() => document.querySelectorAll('#issues li').length === 3);
    assert.equal(await e.page.locator('#issues li.warning').count(), 1);
    const colour = text => e.page.locator('#issues li', { hasText: text }).evaluate(li => getComputedStyle(li).color);
    assert.equal(await colour('Unused choice'), 'rgb(191, 136, 3)'); // --vscode-editorWarning-foreground in the harness
    assert.equal(await colour('Broken'), 'rgb(209, 52, 56)');
    assert.equal(await colour('Odd'), 'rgb(209, 52, 56)', 'an unknown severity counts as an error');
});

uiWith('a problem link follows the element kind named by the analyser', JSON.stringify({
    name: 'Shared',
    states: [
        { id: 'init', name: 'Initial', kind: 'initial', parent: null, x: 0, y: 30, w: 24, h: 24 },
        { id: 'x', name: 'A', kind: 'state', parent: null, x: 80, y: 0, w: 120, h: 80 }
    ],
    transitions: [{ id: 'x', source: 'init', target: 'x', event: '', guard: '', action: '' }]
}), async e => {
    await e.post({ type: 'validation', issues: [{ message: 'About the transition', id: 'x', element: 'transition' }] });
    await e.page.locator('#issues li', { hasText: 'About the transition' }).click();
    assert.equal(await e.page.locator('g.node.selected').count(), 0, 'the state with the same id is not selected');
    assert.equal(await e.page.locator('g.edge.selected').count(), 1);
});

uiWith('the simulator halts on an endless completion loop instead of hanging', JSON.stringify({
    name: 'Loop',
    states: [
        { id: 'init', name: 'Initial', kind: 'initial', parent: null, x: 0, y: 30, w: 24, h: 24 },
        { id: 'a', name: 'A', kind: 'state', parent: null, x: 80, y: 0, w: 120, h: 80 },
        { id: 'b', name: 'B', kind: 'state', parent: null, x: 320, y: 0, w: 120, h: 80 }
    ],
    // Guarded completion transitions, so the analyser cannot prove the loop; with the guards true it never settles.
    transitions: [
        { id: 't0', source: 'init', target: 'a', event: '', guard: '', action: '' },
        { id: 't1', source: 'a', target: 'b', event: '', guard: 'keepGoing', action: '' },
        { id: 't2', source: 'b', target: 'a', event: '', guard: 'keepGoing', action: '' }
    ]
}), async e => {
    await e.page.click('#btn-sim');
    await e.page.waitForFunction(() => document.querySelector('#panel .log') !== null);
    const log = await e.log();
    assert.ok(log.some(l => /endless loop/.test(l)), log.join('\n'));
    assert.ok(log.some(l => /simulation halted/.test(l)), log.join('\n'));
    // Further steps are refused rather than running the stuck engine; Reset starts a fresh engine (which halts again).
    await e.panelButton('Reset').click();
    assert.ok((await e.log()).some(l => /simulation halted/.test(l)));
});

// -------------------------------------------------------------------- help

ui('the help dialog opens from the toolbar and the ? key and blocks editing shortcuts', async e => {
    await e.tool('state');
    await e.click(e.at(100, 100));
    const edits = await e.edits();
    const dialog = e.page.locator('#help');

    await e.page.click('#btn-help');
    assert.equal(await dialog.isVisible(), true);
    assert.match(await dialog.textContent(), /Duplicate/);
    // Delete and Escape do not reach the diagram: the state stays and stays selected.
    await e.page.keyboard.press('Delete');
    await e.page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await e.edits(), edits);
    assert.equal(await e.page.locator('g.node.selected').count(), 1);

    await e.page.locator('#canvas').focus();
    await e.page.keyboard.press('?');
    assert.equal(await dialog.isVisible(), true);
    await dialog.locator('button', { hasText: 'Open User Manual' }).click();
    await dialog.locator('button', { hasText: 'Get Started' }).click();
    const posted = await e.page.evaluate(() => window.posted.filter(m => m.type === 'openManual' || m.type === 'getStarted').map(m => m.type));
    assert.deepEqual(posted, ['openManual', 'getStarted']);
    await e.page.keyboard.press('?');
    assert.equal(await dialog.isVisible(), false);
    assert.deepEqual(e.errors, []);
});

// --------------------------------------------------------------- simulator

uiWith('the simulator starts in the initial state and follows events', example('TrafficLight'), async e => {
    await e.page.click('#btn-sim');
    assert.equal(await e.page.locator('#btn-sim').textContent(), 'Stop Simulation');
    assert.match(await e.active(), /Off/);
    await e.panelButton('PowerOn').click();
    const start = await e.active();
    assert.match(start, /Red/);
    await e.panelButton('Timer').click();
    const next = await e.active();
    assert.notEqual(next, start);
    assert.ok((await e.log()).some(l => l.startsWith('transition')), 'trace shows the transition');
    assert.equal(await e.page.locator('g.node.active').count() >= 1, true);

    // Editing is disabled while simulating: Delete does nothing.
    await e.click(await e.centerOf((await e.page.locator('g.node.active').first().getAttribute('data-id'))));
    await e.page.keyboard.press('Delete');
    assert.equal(await e.page.evaluate(() => window.posted.filter(m => m.type === 'edit').length), 0);

    await e.panelButton('Reset').click();
    assert.match(await e.active(), /Off/);
    await e.page.click('#btn-sim');
    assert.equal(await e.page.locator('#btn-sim').textContent(), 'Simulate');
    assert.equal(await e.page.locator('g.node.active').count(), 0);
});

uiWith('the simulator runs both regions of an orthogonal state', example('Washer'), async e => {
    await e.page.click('#btn-sim');
    await e.panelButton('Start').click();
    const active = await e.active();
    assert.match(active, /Washing/);
    assert.match(active, /Heating/);
    assert.match(active, /\|/, 'one leaf per region');
    // A timeout becomes a "Running timers" button.
    assert.equal(await e.page.locator('#panel h4', { hasText: 'Running timers' }).count(), 1);
    await e.panelButton('after 30 s').click();
    assert.match(await e.active(), /Rinsing/);
});

uiWith('guard checkboxes decide guarded transitions', example('Washer'), async e => {
    await e.page.click('#btn-sim');
    for (const ev of ['QuickRinse', 'Overheat']) {
        await e.panelButton(ev).click();
    }
    assert.match(await e.active(), /Error/);
    const isCool = e.page.locator('.guards label', { hasText: 'isCool' }).locator('input');
    await isCool.uncheck();
    await e.page.locator('#panel .events button', { hasText: /^Reset$/ }).click();
    assert.match(await e.active(), /Error/, 'guard false: stays');
    await isCool.check();
    await e.page.locator('#panel .events button', { hasText: /^Reset$/ }).click();
    assert.match(await e.active(), /Idle/, 'guard true: leaves');
});

uiWith('scenarios replay, and coverage counts the transitions taken', example('Washer'), async e => {
    await e.page.click('#btn-sim');
    const coverage = () => e.page.locator('#panel h4', { hasText: 'Coverage' }).textContent();
    assert.match(await coverage(), /^Coverage: 0\/\d+ transitions$/);
    const scenario = e.page.locator('#panel .scenario').first();
    await scenario.locator('button', { hasText: /^Run$/ }).click();
    assert.ok((await e.log()).some(l => l === 'replay "Full program"'));
    const [, taken, total] = /(\d+)\/(\d+)/.exec(await coverage()).map(Number);
    assert.ok(taken > 5 && taken <= total, `coverage ${taken}/${total}`);

    await e.page.locator('#panel label', { hasText: 'Highlight untaken' }).locator('input').check();
    assert.ok((await e.page.locator('#viewport .uncovered').count()) > 0, 'untaken transitions highlighted');

    // Stepping replays one event at a time.
    await scenario.locator('button', { hasText: /^Step$/ }).click();
    await e.page.locator('#panel .scenario').first().locator('button', { hasText: /^Step 1\// }).click();
    assert.match(await e.active(), /Washing/);
});

uiWith('recording saves the fired events as a new scenario', example('TrafficLight'), async e => {
    await e.page.click('#btn-sim');
    await e.panelButton('Record').click();
    await e.panelButton('PowerOn').click();
    await e.panelButton('Timer').click();
    await e.panelButton('Timer').click();
    await e.panelButton('Save').click();
    const d = await e.edited();
    const saved = d.scenarios[d.scenarios.length - 1];
    assert.match(saved.name, /^Scenario \d+$/);
    assert.deepEqual(saved.steps, [{ event: 'PowerOn' }, { event: 'Timer' }, { event: 'Timer' }]);
});

uiWith('events with parameters take arguments in the simulator', example('Washer'), async e => {
    await e.page.click('#btn-sim');
    await e.panelButton('Start').click();
    await e.panelButton('TempReached').click();
    const input = e.page.locator('#panel .with-args', { has: e.page.locator('button', { hasText: /^SetTemp$/ }) }).locator('input');
    await input.fill('75');
    await e.panelButton('SetTemp').click();
    assert.ok((await e.log()).some(l => /adjust\(75\)/.test(l)), (await e.log()).join('\n'));
});

uiWith('a replayed timeout whose timer is not running is stale and not dispatched', JSON.stringify({
    name: 'Stale',
    states: [
        { id: 'init', name: 'Initial', kind: 'initial', parent: null, x: 0, y: 30, w: 24, h: 24 },
        { id: 'a', name: 'A', kind: 'state', parent: null, x: 80, y: 0, w: 120, h: 80 },
        { id: 'b', name: 'B', kind: 'state', parent: null, x: 320, y: 0, w: 120, h: 80 }
    ],
    transitions: [
        { id: 't0', source: 'init', target: 'a', event: '', guard: '', action: '' },
        { id: 't1', source: 'a', target: 'b', event: 'after(1s)', guard: 'isReady', action: '' }
    ],
    // The first timeout fires with the guard false (A stays, the one-shot timer is spent); the second one
    // would take the transition if it were dispatched.
    scenarios: [{ name: 'Twice', steps: [{ event: 'A_After1000ms', guards: { isReady: false } }, { event: 'A_After1000ms' }] }]
}), async e => {
    await e.page.click('#btn-sim');
    const timers = () => e.page.locator('#panel h4', { hasText: 'Running timers' }).count();
    assert.equal(await timers(), 1);
    await e.page.locator('#panel .scenario').first().locator('button', { hasText: /^Step$/ }).click();
    await e.page.locator('#panel .scenario button', { hasText: /^Step 1\// }).click();
    assert.match(await e.active(), /^A$/);
    assert.equal(await timers(), 0, 'a fired timer is no longer running');
    await e.page.locator('#panel .scenario button', { hasText: /^Step 2\// }).click();
    assert.match(await e.active(), /^A$/, 'the stale timeout did not fire');
    const log = await e.log();
    assert.ok(log.some(l => /stale timeout A_After1000ms/.test(l)), log.join('\n'));
    assert.equal(await e.page.locator('#panel .log li.error', { hasText: 'stale timeout' }).count(), 1);
});

// Initial -> A, A -Go-> B (user colour), B -Back-> A.
const colourDiagram = JSON.stringify({
    name: 'Colours',
    states: [
        { id: 'init', name: 'Initial', kind: 'initial', parent: null, x: 0, y: 30, w: 24, h: 24 },
        { id: 'a', name: 'A', kind: 'state', parent: null, x: 80, y: 0, w: 120, h: 80 },
        { id: 'b', name: 'B', kind: 'state', parent: null, x: 360, y: 0, w: 120, h: 80 }
    ],
    transitions: [
        { id: 't0', source: 'init', target: 'a', event: '', guard: '', action: '' },
        { id: 't1', source: 'a', target: 'b', event: 'Go', guard: '', action: '', color: '#e06c75', bend: 40 },
        { id: 't2', source: 'b', target: 'a', event: 'Back', guard: '', action: '', bend: 40 }
    ]
});

/** Stroke of a transition's line, its marker reference and the fill of that marker's arrowhead. */
const edgeLook = (page, id) =>
    page.evaluate(id => {
        const line = document.querySelector(`g.edge[data-id="${id}"] .line`);
        const marker = line.getAttribute('marker-end');
        const head = document.querySelector(`${marker.slice(4, -1)} path`);
        return { stroke: getComputedStyle(line).stroke, marker, fill: getComputedStyle(head).fill };
    }, id);
const RED = 'rgb(209, 52, 56)'; // --vscode-errorForeground in the harness
const GREEN = 'rgb(56, 138, 52)'; // --vscode-testing-iconPassed
const BLUE = 'rgb(0, 95, 184)'; // --vscode-focusBorder
const USER = 'rgb(224, 108, 117)'; // #e06c75

uiWith('untaken, fired and selected transitions colour their line and arrowhead', colourDiagram, async e => {
    assert.deepEqual(await edgeLook(e.page, 't1'), { stroke: USER, marker: 'url(#arrow-e06c75)', fill: USER });
    await e.page.locator('g.edge[data-id="t1"] .label').click();
    assert.deepEqual(await edgeLook(e.page, 't1'), { stroke: BLUE, marker: 'url(#arrow-selected)', fill: BLUE });

    await e.page.click('#btn-sim');
    await e.page.locator('#panel label', { hasText: 'Highlight untaken' }).locator('input').check();
    // Untaken wins over the user colour.
    assert.deepEqual(await edgeLook(e.page, 't1'), { stroke: RED, marker: 'url(#arrow-uncovered)', fill: RED });
    assert.deepEqual(await edgeLook(e.page, 't2'), { stroke: RED, marker: 'url(#arrow-uncovered)', fill: RED });
    await e.panelButton('Go').click();
    assert.deepEqual(await edgeLook(e.page, 't1'), { stroke: GREEN, marker: 'url(#arrow-fired)', fill: GREEN });
});

uiWith('exports show the plain diagram while simulating', colourDiagram, async e => {
    await e.page.click('#btn-sim');
    await e.page.locator('#panel label', { hasText: 'Highlight untaken' }).locator('input').check();
    await e.panelButton('Go').click();
    await e.page.click('#btn-svg');
    const data = await e.page.evaluate(() => window.posted.find(m => m.type === 'exportSvg').data);
    assert.doesNotMatch(data, /class="[^"]*\b(active|fired|uncovered|selected)\b/);
    assert.match(data, /marker-end="url\(#arrow-e06c75\)"/, 'the user colour is exported');
    assert.doesNotMatch(data, /id="grid"/, 'no grid pattern');
    // The simulation itself carries on.
    assert.match(await e.active(), /^B$/);
    assert.equal(await e.page.locator('g.node.active').count(), 1);
    assert.equal(await e.page.locator('g.edge.fired').count(), 1);
});

uiWith('a diagram with problems cannot be simulated', JSON.stringify({ name: 'Broken', states: [{ id: 'a', name: 'A', kind: 'state', parent: null, x: 0, y: 0, w: 100, h: 50 }], transitions: [] }), async e => {
    await e.page.click('#btn-sim');
    assert.equal(await e.page.locator('#panel .problems li').count() >= 1, true);
});

uiWith('invalid JSON shows an error instead of the diagram', '{ "states": [', async e => {
    assert.equal(await e.page.locator('#parse-error').isVisible(), true);
    assert.match(await e.page.locator('#parse-error').textContent(), /not valid JSON/);
});

// --------------------------------------------------------------- Stateflow semantics

const stateflowLab = fs.readFileSync(path.join(root, 'test', 'diagrams', 'StateflowLab.machina'), 'utf8');

uiWith('a Stateflow diagram shows its semantics, step settings and during actions', stateflowLab, async e => {
    assert.equal(await e.page.locator('#panel select').first().inputValue(), 'stateflow');
    assert.equal(await e.field('Step event').inputValue(), 'Step');
    assert.equal(await e.field('Step period \\(ms\\)').inputValue(), '10');
    // Event parameter fields for the other events, but none for the step event.
    assert.equal(await e.field('Go').count(), 1);
    assert.equal(await e.field('Step').count(), 0);
    assert.ok((await e.page.locator('#canvas text').allTextContents()).includes('during / idleTick'));
    await e.click(await e.centerOf('Idle'));
    assert.equal(await e.field('During actions').inputValue(), 'idleTick');
    await e.field('During actions').fill('idleTick; sample');
    await e.field('During actions').press('Enter');
    assert.equal((await e.edited()).states.find(s => s.id === 'Idle').during, 'idleTick; sample');
});

uiWith('switching a diagram to Stateflow semantics and back', example('TrafficLight'), async e => {
    // A UML diagram has no During field.
    await e.click(await e.centerOf((await e.page.locator('g.node').nth(1).getAttribute('data-id'))));
    assert.equal(await e.field('During actions').count(), 0);
    await e.click(e.at(-30, -30));
    await e.page.locator('#panel select').first().selectOption('stateflow');
    let d = await e.edited();
    assert.equal(d.semantics, 'stateflow');
    assert.equal(d.formatVersion, 2);
    assert.deepEqual(d.step, { event: 'Step' });
    await e.page.locator('#panel select').first().selectOption('uml');
    d = await e.edited();
    assert.equal(d.semantics, undefined);
    assert.equal(d.step, undefined);
    assert.equal(d.formatVersion, undefined);
});

uiWith(
    'the code behind imported hooks is shown with the state',
    JSON.stringify({
        name: 'M',
        semantics: 'stateflow',
        step: { event: 'Step' },
        states: [
            { id: 'i', name: '', kind: 'initial', parent: null, x: 0, y: 40, w: 24, h: 24 },
            { id: 'A', name: 'A', kind: 'state', parent: null, x: 80, y: 20, w: 140, h: 70, entry: 'AEntry', exit: '' }
        ],
        transitions: [{ id: 't0', source: 'i', target: 'A' }],
        hooks: { AEntry: { code: 'count = 0;', origin: 'state A entry' } }
    }),
    async e => {
        await e.click(await e.centerOf('A'));
        assert.equal(await e.page.locator('#panel .hook-code pre').textContent(), 'count = 0;');
        assert.match(await e.page.locator('#panel .hook-code span').textContent(), /AEntry \(state A entry\)/);
    }
);

uiWith('a diagram with a newer format version is not opened for editing', JSON.stringify({ formatVersion: 99, name: 'M', states: [], transitions: [] }), async e => {
    assert.equal(await e.page.locator('#parse-error').isVisible(), true);
    assert.match(await e.page.locator('#parse-error').textContent(), /format version 99/);
});

uiWith('the simulator counts steps for after() under Stateflow semantics', stateflowLab, async e => {
    await e.page.click('#btn-sim');
    assert.match(await e.active(), /Idle/);
    // Idle -> Active after(30ms) at 10 ms per step: the third step fires it.
    await e.panelButton('Step').click();
    await e.panelButton('Step').click();
    assert.match(await e.active(), /Idle/);
    await e.panelButton('Step').click();
    assert.match(await e.active(), /Fill/);
    assert.ok((await e.log()).some(l => /idleTick/.test(l)), 'the during action of Idle ran');
});

// A -Go [ok] / run-> B (straight, horizontal) and A -Down-> C (straight, vertical).
const labelDiagram = JSON.stringify({
    name: 'Labels',
    states: [
        { id: 'init', name: 'Initial', kind: 'initial', parent: null, x: 0, y: 200, w: 24, h: 24 },
        { id: 'a', name: 'A', kind: 'state', parent: null, x: 60, y: 0, w: 120, h: 60 },
        { id: 'b', name: 'B', kind: 'state', parent: null, x: 460, y: 0, w: 120, h: 60 },
        { id: 'c', name: 'C', kind: 'state', parent: null, x: 60, y: 300, w: 120, h: 60 }
    ],
    transitions: [
        { id: 't0', source: 'init', target: 'a', event: '', guard: '', action: '' },
        { id: 't1', source: 'a', target: 'b', event: 'Go', guard: 'ok', action: 'run' },
        { id: 't2', source: 'a', target: 'c', event: 'Down', guard: '', action: '' }
    ]
});

uiWith('transition labels have a line per part, beside the arrow', labelDiagram, async e => {
    assert.deepEqual(await e.page.locator('g.edge[data-id="t1"] .label tspan').allTextContents(), ['Go', '[ok]', '/ run']);
    assert.deepEqual(await e.page.locator('g.edge[data-id="t2"] .label tspan').allTextContents(), ['Down']);
    const box = (id, part) => e.page.locator(`g.edge[data-id="${id}"] .${part}`).boundingBox();
    const [label1, line1, label2, line2] = [await box('t1', 'label'), await box('t1', 'line'), await box('t2', 'label'), await box('t2', 'line')];
    // The box of a line includes its arrowhead, so the straight line itself runs through the middle.
    assert.ok(label1.y + label1.height < line1.y + line1.height / 2, 'the label of a horizontal arrow lies above it');
    assert.ok(label2.x > line2.x + line2.width / 2, 'the label of a vertical arrow lies to its right');
});

uiWith('grabbing a label does not bend its transition until the pointer moves', labelDiagram, async e => {
    // Grab the top line of the label, well away from the arrow, move away and back, and let go.
    const top = await e.page.locator('g.edge[data-id="t1"] .label tspan').first().boundingBox();
    const p = { x: top.x + top.width / 2, y: top.y + top.height / 2 };
    const count = await e.edits();
    await e.page.mouse.move(p.x, p.y);
    await e.page.mouse.down();
    await e.page.mouse.move(p.x, p.y + 40, { steps: 4 });
    await e.page.mouse.move(p.x, p.y, { steps: 4 });
    await e.page.mouse.up();
    await e.waitForEdit(count);
    assert.equal((await e.edited()).transitions.find(t => t.id === 't1').bend || 0, 0);
});

// Initial -> A, and a self loop on A.
const loopDiagram = JSON.stringify({
    name: 'Loop',
    states: [
        { id: 'init', name: 'Initial', kind: 'initial', parent: null, x: 0, y: 120, w: 24, h: 24 },
        { id: 'a', name: 'A', kind: 'state', parent: null, x: 200, y: 100, w: 140, h: 70 }
    ],
    transitions: [
        { id: 't0', source: 'init', target: 'a', event: '', guard: '', action: '' },
        { id: 'tl', source: 'a', target: 'a', event: 'Tick', guard: '', action: '' }
    ]
});

uiWith('dragging a self loop moves it round its state, and Reset loop puts it back', loopDiagram, async e => {
    const label = () => e.page.locator('g.edge[data-id="tl"] .label').boundingBox();
    const before = await label();
    // Drag the loop by its label (top right of A) to well left of A.
    let count = await e.edits();
    await e.drag({ x: before.x + before.width / 2, y: before.y + before.height / 2 }, await e.screen(100, 135));
    await e.waitForEdit(count);
    const loop = (await e.edited()).transitions.find(t => t.id === 'tl').loop;
    assert.ok(loop && Math.abs(loop.angle) > 150 && loop.size > 40, JSON.stringify(loop));
    const after = await label();
    assert.ok(after.x + after.width < (await e.screen(200, 0)).x, 'the label is left of the state');

    count = await e.edits();
    await e.panelButton('Reset loop').click();
    await e.waitForEdit(count);
    assert.equal((await e.edited()).transitions.find(t => t.id === 'tl').loop, undefined);
    assert.deepEqual(await label(), before);
});
