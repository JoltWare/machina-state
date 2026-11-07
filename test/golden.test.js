// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Golden-file tests: generated code must match test/golden exactly. Run `npm run test:update` to accept changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CONFIGS, STYLES, LANGUAGES, exampleNames, loadExample, machineFor, generate } = require('./helpers');

const goldenDir = path.join(__dirname, 'golden');
const update = process.env.UPDATE_GOLDEN === '1';

for (const name of exampleNames()) {
    for (const [configName, config] of Object.entries(CONFIGS)) {
        for (const language of LANGUAGES) {
            for (const style of STYLES) {
                const files = generate(machineFor(loadExample(name), config), language, style);
                for (const { extension, code } of files) {
                    // The C header does not depend on the style.
                    if (extension === '.h' && style !== STYLES[0]) {
                        continue;
                    }
                    const file = extension === '.h' ? `${name}.${configName}${extension}` : `${name}.${configName}.${style}${extension}`;
                    test(`golden ${file}`, () => {
                        const goldenPath = path.join(goldenDir, file);
                        if (update || !fs.existsSync(goldenPath)) {
                            fs.mkdirSync(goldenDir, { recursive: true });
                            fs.writeFileSync(goldenPath, code);
                            if (!update) {
                                assert.fail(`Golden file ${file} was missing and has been created; review and commit it.`);
                            }
                            return;
                        }
                        assert.equal(code, fs.readFileSync(goldenPath, 'utf8'), `${file} differs from the golden file`);
                    });
                }
            }
        }
    }
}
