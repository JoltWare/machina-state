// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Regenerates test/golden from the current generators. Review the diff before committing.
const { spawnSync } = require('child_process');
const path = require('path');

const result = spawnSync(process.execPath, ['--test', path.join(__dirname, 'golden.test.js')], {
    stdio: 'inherit',
    env: { ...process.env, UPDATE_GOLDEN: '1' }
});
process.exit(result.status ?? 1);
