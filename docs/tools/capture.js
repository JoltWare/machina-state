// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Captures the manual's screenshots: renders each docs/tools/shots/<name>.json in harness.html and
// saves docs/images/<name>.png (1100x650 at 1.5x), plus docs/images/toolbar.png.
// Usage: npm run compile && node docs/tools/build.js && node docs/tools/capture.js [name ...] [--out dir]
// Needs playwright-core and an installed Chromium, Edge or Chrome (MACHINA_BROWSER picks one, as in test/ui.test.js).
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..', '..');
const shotsDir = path.join(__dirname, 'shots');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? path.resolve(args.splice(outIndex, 2)[1]) : path.join(root, 'docs', 'images');
const all = fs.readdirSync(shotsDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
// The 'toolbar' scenario is captured as the toolbar strip only.
const names = (args.length ? args : all).filter(n => n !== 'toolbar');
const withToolbar = !args.length || args.includes('toolbar');

async function launch() {
    const choice = process.env.MACHINA_BROWSER;
    const options = choice ? [/[\\/]/.test(choice) ? { executablePath: choice } : { channel: choice }] : [{}, { channel: 'msedge' }, { channel: 'chrome' }];
    for (const o of options) {
        try {
            return await chromium.launch(o);
        } catch {
            // Try the next browser.
        }
    }
    throw new Error('no browser could be launched; set MACHINA_BROWSER');
}

(async () => {
    // Static server: harness.html fetches the shot JSON, which file:// URLs do not allow.
    const server = http.createServer((req, res) => {
        const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/docs/tools/harness.html`;

    const browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 650 }, deviceScaleFactor: 1.5 });
    fs.mkdirSync(outDir, { recursive: true });
    let failed = 0;
    for (const name of names) {
        await page.goto(`${base}?shot=${name}`);
        await page.waitForFunction(() => document.body.dataset.ready);
        const ready = await page.evaluate(() => document.body.dataset.ready);
        if (ready !== 'true') {
            console.error(`${name}: ${ready}`);
            failed++;
            continue;
        }
        // A long simulator panel (events, timers, guards, scenarios, coverage and trace) makes the page
        // taller instead of scrolling out of the picture.
        const extra = await page.evaluate(() => {
            const p = document.getElementById('panel');
            return document.body.classList.contains('simulating') ? p.scrollHeight - p.clientHeight : 0;
        });
        const height = extra > 0 ? Math.min(1200, 650 + extra + 4) : 650;
        await page.setViewportSize({ width: 1100, height });
        await page.evaluate(h => {
            document.documentElement.style.height = document.body.style.height = `${h}px`;
            document.getElementById('btn-fit').click();
            const log = document.querySelector('.log');
            if (log) {
                log.scrollTop = log.scrollHeight;
            }
        }, height);
        await page.mouse.move(1099, height - 1); // no hover highlight
        await page.screenshot({ path: path.join(outDir, `${name}.png`) });
        console.log(`${name}.png`);
    }
    if (withToolbar) {
        await page.setViewportSize({ width: 1100, height: 650 });
        await page.goto(`${base}?shot=toolbar`);
        await page.waitForFunction(() => document.body.dataset.ready);
        await page.locator('#toolbar').screenshot({ path: path.join(outDir, 'toolbar.png') });
        console.log('toolbar.png');
    }
    // The Get Started walkthrough (package.json "walkthroughs") shows some of these screenshots; docs/ is not
    // packaged, so they are kept as copies in media/walkthrough/. Refresh them when capturing into docs/images.
    if (outDir === path.join(root, 'docs', 'images')) {
        const walkthrough = { create: 't1-step1', draw: 't1-step3', simulate: 't1-sim', generate: 'toolbar', manual: 'tour' };
        for (const [target, source] of Object.entries(walkthrough)) {
            const from = path.join(outDir, `${source}.png`);
            if (fs.existsSync(from)) {
                fs.copyFileSync(from, path.join(root, 'media', 'walkthrough', `${target}.png`));
            }
        }
    }
    await browser.close();
    server.close();
    process.exitCode = failed ? 1 : 0;
})().catch(err => {
    console.error(err);
    process.exit(1);
});
