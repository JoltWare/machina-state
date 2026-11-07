// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Shared helpers for the MachinaState test suite (run with `npm test`).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const { parseDiagram, analyze } = require(path.join(root, 'out', 'model.js'));
const { generateCode } = require(path.join(root, 'out', 'generators', 'index.js'));

const examplesDir = path.join(root, 'examples');
const diagramsDir = path.join(__dirname, 'diagrams');
const outputDir = path.join(root, 'test-output');

/**
 * Test-only diagrams (test/diagrams) that the compile test runs in addition to the examples, with the target
 * languages each one is valid for (their event parameter types are language specific).
 */
const TEST_DIAGRAMS = {
    HistoryLab: ['cpp', 'csharp', 'c'],
    ConstArgs: ['cpp', 'c']
};

/** Code generation options exercised by the golden and compile tests. */
const CONFIGS = {
    trace: { trace: true, threadSafe: false, queue: false },
    locked: { trace: false, threadSafe: true, queue: false },
    full: { trace: true, threadSafe: true, queue: true }
};
const STYLES = ['switch', 'table'];
const LANGUAGES = ['cpp', 'csharp', 'c'];

function exampleNames() {
    return fs
        .readdirSync(examplesDir)
        .filter(f => f.endsWith('.machina'))
        .map(f => f.replace(/\.machina$/, ''))
        .sort();
}

function loadExample(name) {
    return parseDiagram(fs.readFileSync(path.join(examplesDir, `${name}.machina`), 'utf8'));
}

/** Names of the test-only diagrams. */
function testDiagramNames() {
    return Object.keys(TEST_DIAGRAMS);
}

/** Loads a test-only diagram. */
function loadTestDiagram(name) {
    return parseDiagram(fs.readFileSync(path.join(diagramsDir, `${name}.machina`), 'utf8'));
}

/**
 * Every diagram the compile test runs: the examples (all languages) and the test-only diagrams, as
 * { name, load(), languages }.
 */
function compileSubjects() {
    return [
        ...exampleNames().map(name => ({ name, load: () => loadExample(name), languages: LANGUAGES })),
        ...testDiagramNames().map(name => ({ name, load: () => loadTestDiagram(name), languages: TEST_DIAGRAMS[name] }))
    ];
}

/** Analyzes a diagram with the given codegen options and optional namespace override; throws on validation issues. */
function machineFor(diagram, config, namespace) {
    const d = JSON.parse(JSON.stringify(diagram));
    d.codegen = { ...(d.codegen || {}), ...config };
    if (namespace !== undefined) {
        d.namespace = namespace;
    }
    const { machine, issues } = analyze(d);
    if (!machine) {
        throw new Error(`Diagram '${d.name}' has problems:\n${issues.map(i => '  ' + i.message).join('\n')}`);
    }
    return machine;
}

/** Generated files ({ extension, code }) for a machine; the first one is the main file. */
function generate(machine, language, style) {
    return generateCode(machine, language, style);
}

function hasTool(command, args = ['--version']) {
    try {
        execFileSync(command, args, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function freshDir(...parts) {
    const dir = path.join(outputDir, ...parts);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

module.exports = {
    root,
    examplesDir,
    outputDir,
    CONFIGS,
    STYLES,
    LANGUAGES,
    exampleNames,
    loadExample,
    testDiagramNames,
    loadTestDiagram,
    compileSubjects,
    machineFor,
    generate,
    hasTool,
    freshDir,
    analyze,
    parseDiagram
};
