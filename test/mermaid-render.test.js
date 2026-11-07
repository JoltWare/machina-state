// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Renders exported Mermaid diagrams with Mermaid itself (the mermaid dev dependency, in a browser driven by
// Playwright, as in test/ui.test.js): every example and test diagram must render without errors, show every
// state name, and show escaped label text decoded. test/interop.test.js covers the round trips.
//
// Without playwright-core, mermaid or a browser the tests are skipped, unless MACHINA_UI_REQUIRED=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { exampleNames, loadExample, testDiagramNames, loadTestDiagram, root } = require('./helpers');
const { exportMermaid } = require(path.join(root, 'out', 'interop', 'mermaid.js'));

const mermaidScript = path.join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
let chromium = null;
try {
    ({ chromium } = require('playwright-core'));
} catch {
    // Not installed: every test is skipped below.
}

let browser = null;
let page = null;
let skip = !chromium ? 'playwright-core is not installed' : !fs.existsSync(mermaidScript) ? 'mermaid is not installed' : false;

test.before(async () => {
    if (skip) {
        return;
    }
    const choice = process.env.MACHINA_BROWSER;
    const options = choice ? [/[\\/]/.test(choice) ? { executablePath: choice } : { channel: choice }] : [{}, { channel: 'msedge' }, { channel: 'chrome' }, { channel: 'chromium' }];
    for (const o of options) {
        try {
            browser = await chromium.launch(o);
            break;
        } catch {
            // Try the next browser.
        }
    }
    if (!browser) {
        if (process.env.MACHINA_UI_REQUIRED === '1') {
            throw new Error('no browser could be launched');
        }
        skip = 'no browser could be launched';
        return;
    }
    page = await browser.newPage();
    await page.setContent('<!DOCTYPE html><html><body></body></html>');
    await page.addScriptTag({ path: mermaidScript });
    await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }));
});

test.after(async () => {
    if (browser) {
        await browser.close();
    }
});

let renders = 0;
/** Renders Mermaid text and returns the texts of the drawn labels, or throws Mermaid's error. */
async function render(text) {
    const result = await page.evaluate(
        async ([t, n]) => {
            try {
                const { svg } = await window.mermaid.render(`d${n}`, t);
                const div = document.createElement('div');
                div.innerHTML = svg;
                return { texts: [...div.querySelectorAll('.nodeLabel, .edgeLabel, text, p')].map(e => e.textContent.trim()).filter(Boolean) };
            } catch (err) {
                return { error: String(err && err.message ? err.message : err) };
            }
        },
        [text, renders++]
    );
    if (result.error) {
        throw new Error(`${result.error}\n${text}`);
    }
    return result.texts;
}

const subjects = [...exampleNames().map(name => [name, () => loadExample(name)]), ...testDiagramNames().map(name => [name, () => loadTestDiagram(name)])];
for (const [name, load] of subjects) {
    test(`Mermaid renders the export of ${name}`, async t => {
        if (skip) {
            t.skip(skip);
            return;
        }
        const diagram = load();
        const text = exportMermaid(diagram);
        const texts = await render(text);
        // Every state is shown by its name (not replaced by its first description line).
        for (const s of diagram.states.filter(s => s.kind === 'state')) {
            assert.ok(texts.includes(s.name), `${s.name} missing in ${JSON.stringify(texts)}`);
        }
        // Escaped characters come back; no label was cut at a semicolon.
        assert.ok(!texts.some(x => x === ';' || /#\d+;/.test(x)), JSON.stringify(texts));
    });
}

test('Mermaid renders escaped labels and reserved names', async t => {
    if (skip) {
        t.skip(skip);
        return;
    }
    const node = (id, kind, extra = {}) => ({ id, name: id, kind, parent: null, x: 0, y: 0, w: 0, h: 0, ...extra });
    const texts = await render(
        exportMermaid({
            name: 'Edge',
            namespace: '',
            events: {},
            states: [node('i', 'initial'), node('A', 'state', { entry: 'f(a, b); g', color: '#e06c75' }), node('n', 'state', { name: 'Note' }), node('s', 'state', { name: 'Default' }), node('F', 'final'), node('G', 'final')],
            transitions: [
                { id: 't0', source: 'i', target: 'A' },
                { id: 't1', source: 'A', target: 'n', event: 'Go', guard: 'x > 1 && y < 2', action: 'a; b' },
                { id: 't2', source: 'n', target: 's', event: 'Next', action: 'log("<<#1>>")' },
                { id: 't3', source: 's', target: 'F', event: 'Done' },
                { id: 't4', source: 's', target: 'G', event: 'Abort' }
            ]
        })
    );
    for (const expected of ['A', 'entry / f(a, b); g', 'Note', 'Default', 'Go [x > 1 && y < 2] / a; b', 'Next / log("<<#1>>")', 'G']) {
        assert.ok(texts.includes(expected), `${expected} missing in ${JSON.stringify(texts)}`);
    }
});
