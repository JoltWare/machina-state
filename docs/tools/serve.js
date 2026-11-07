// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Static server for screenshot capture: serves the repository and saves POSTed PNGs to docs/images.
// Usage: node docs/tools/serve.js   ->  http://localhost:8765/docs/tools/harness.html?shot=tour
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const images = path.join(root, 'docs', 'images');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/save') {
        const name = (url.searchParams.get('name') || '').replace(/[^\w-]/g, '');
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            fs.mkdirSync(images, { recursive: true });
            fs.writeFileSync(path.join(images, `${name}.png`), Buffer.from(body, 'base64'));
            res.end('ok');
        });
        return;
    }
    const file = path.join(root, path.normalize(decodeURIComponent(url.pathname)).replace(/^([\\/]\.\.)+/, ''));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
}).listen(8765, '127.0.0.1', () => console.log('serving on http://localhost:8765'));
