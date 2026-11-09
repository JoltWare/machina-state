// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Hook stubs (src/generators/stub.ts): for every example and test diagram, without options and with all of
// them, the stub must compile against the generated machine (C++ and C#: the stub class can be instantiated,
// so every hook is implemented; C: the hooks struct is complete), and imported hook code and data must show
// up in the stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { CONFIGS, compileSubjects, machineFor, generate, hasTool, freshDir, root, analyze, loadTestDiagram } = require('./helpers');
const { generateHookStub } = require(path.join(root, 'out', 'generators', 'stub.js'));
const { cPrefix } = require(path.join(root, 'out', 'generators', 'c.js'));

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Every subject in every language it supports, without options and with all of them, in its own namespace. */
function variants(language) {
    const result = [];
    for (const { name, load, languages } of compileSubjects().filter(x => x.languages.includes(language))) {
        for (const [configName, config] of [['plain', { trace: false, threadSafe: false, queue: false }], ['full', CONFIGS.full]]) {
            const diagram = load();
            const namespace = `Stub_${name}_${configName}`;
            const machine = machineFor(diagram, config, namespace);
            // Recorded hook code (an imported chart's) is in the source tool's language and not expected to
            // compile; the skeleton without it must.
            const skeleton = { ...diagram, hooks: undefined, data: undefined };
            result.push({ key: `${name}_${configName}`, namespace, machine, files: generate(machine, language, 'switch'), stub: generateHookStub(machine, skeleton, language) });
        }
    }
    return result;
}

test('hook stubs compile with the generated C++ (-Wall -Wextra -Werror)', { skip: !hasTool('g++') && 'g++ not found', timeout: 300000 }, () => {
    const dir = freshDir('stub', 'cpp');
    const list = variants('cpp');
    const main = [];
    for (const v of list) {
        fs.mkdirSync(path.join(dir, v.key));
        fs.writeFileSync(path.join(dir, v.key, `${v.machine.name}.hpp`), v.files[0].code);
        fs.writeFileSync(path.join(dir, v.key, `${v.machine.name}${v.stub.extension}`), v.stub.code);
        main.push(`#include "${v.key}/${v.machine.name}Hooks.hpp"`);
    }
    main.push('int main() {');
    list.forEach((v, i) => main.push(`    ${v.namespace}::${v.machine.name}Hooks m${i};`, `    m${i}.Start();`));
    main.push('    return 0;', '}');
    fs.writeFileSync(path.join(dir, 'main.cpp'), main.join('\n') + '\n');
    run('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic', '-fsyntax-only', 'main.cpp'], dir);
});

test('hook stubs compile with the generated C# (warnings as errors)', { skip: !hasTool('dotnet') && 'dotnet not found', timeout: 300000 }, () => {
    const dir = freshDir('stub', 'csharp');
    const list = variants('csharp');
    for (const v of list) {
        fs.writeFileSync(path.join(dir, `${v.key}.cs`), v.files[0].code);
        fs.writeFileSync(path.join(dir, `${v.key}Hooks.cs`), v.stub.code);
    }
    const body = list.map(v => `        new ${v.namespace}.${v.machine.name}Hooks().Start();`).join('\n');
    fs.writeFileSync(path.join(dir, 'Program.cs'), `public static class Program\n{\n    public static void Main()\n    {\n${body}\n    }\n}\n`);
    fs.writeFileSync(
        path.join(dir, 'stub.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework>' +
            '<Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><RollForward>Major</RollForward></PropertyGroup></Project>'
    );
    run('dotnet', ['build', '-c', 'Release', '-nologo', '-v', 'q', '-o', 'bin'], dir);
});

test('hook stubs compile with the generated C (-std=c99 -Wall -Wextra -Werror -pedantic)', { skip: !hasTool('gcc') && 'gcc not found', timeout: 300000 }, () => {
    const dir = freshDir('stub', 'c');
    const list = variants('c');
    const sources = ['main.c'];
    const main = [];
    for (const v of list) {
        fs.mkdirSync(path.join(dir, v.key));
        v.files.forEach(f => fs.writeFileSync(path.join(dir, v.key, v.machine.name + f.extension), f.code));
        fs.writeFileSync(path.join(dir, v.key, `${v.machine.name}${v.stub.extension}`), v.stub.code);
        sources.push(`${v.key}/${v.machine.name}.c`, `${v.key}/${v.machine.name}Hooks.c`);
        main.push(`#include "${v.key}/${v.machine.name}.h"`, `extern const ${cPrefix(v.machine)}_Hooks ${cPrefix(v.machine)}_HookImpl;`);
    }
    main.push('int main(void) {');
    list.forEach((v, i) => {
        const P = cPrefix(v.machine);
        main.push(`    static ${P} m${i};`, `    ${P}_Init(&m${i}, &${P}_HookImpl, NULL);`, `    ${P}_Start(&m${i});`);
    });
    main.push('    return 0;', '}');
    fs.writeFileSync(path.join(dir, 'main.c'), main.join('\n') + '\n');
    const exe = path.join(dir, process.platform === 'win32' ? 'stub.exe' : 'stub');
    run('gcc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-pedantic', ...sources, '-o', exe], dir);
});

test('hook stubs carry imported code and declare the data', () => {
    const d = {
        name: 'Tank',
        semantics: 'stateflow',
        step: { event: 'Step', periodMs: 1 },
        states: [
            { id: 'i', name: '', kind: 'initial', parent: null, x: 0, y: 0, w: 0, h: 0 },
            { id: 'A', name: 'A', kind: 'state', parent: null, x: 0, y: 0, w: 0, h: 0, entry: 'AEntry', during: 'ADuring' },
            { id: 'B', name: 'B', kind: 'state', parent: null, x: 0, y: 0, w: 0, h: 0 }
        ],
        transitions: [
            { id: 't0', source: 'i', target: 'A' },
            { id: 't1', source: 'A', target: 'B', event: 'Step', guard: 'guard7' }
        ],
        hooks: { AEntry: { code: 'count = 0;\nout.on = true;', origin: 'state A entry' }, guard7: { code: 'level > limit', origin: 'transition 7' } },
        data: [
            { name: 'level', scope: 'input', type: 'single' },
            { name: 'count', scope: 'local', type: 'uint8' },
            { name: 'out', scope: 'output', type: 'Bus: TankOutput' },
            { name: 'buffer', scope: 'local', type: 'double', size: '8' }
        ]
    };
    const { machine } = analyze(d);
    const cpp = generateHookStub(machine, d, 'cpp').code;
    assert.match(cpp, /class TankHooks : public Tank/);
    assert.match(cpp, /float level\{\};   \/\/ input, single/);
    assert.match(cpp, /std::uint8_t count\{\};/);
    assert.match(cpp, /TankOutput out\{\};/);
    assert.match(cpp, /double buffer\[8\]\{\};/);
    assert.match(cpp, /\/\/ transition 7\n {4}bool guard7\(\) override \{\n {8}return level > limit;/);
    assert.match(cpp, /void AEntry\(\) override \{\n {8}count = 0;\n {8}out\.on = true;\n/);
    assert.match(cpp, /void ADuring\(\) override \{\n {8}\/\/ TODO/);
    const cs = generateHookStub(machine, d, 'csharp').code;
    assert.match(cs, /protected byte count;/);
    assert.match(cs, /protected TankOutput out = new TankOutput\(\);/);
    assert.match(cs, /protected double\[\] buffer = new double\[8\];/);
    const c = generateHookStub(machine, d, 'c').code;
    assert.match(c, /static uint8_t count;/);
    assert.match(c, /const Tank_Hooks Tank_HookImpl =/);
    assert.match(c, /\.guard7 = Tank_guard7/);
    assert.match(c, /static bool Tank_guard7\(void\* context\) \{\n {4}\(void\)context;\n {4}return level > limit;/);
});

test('hook stubs of the Stateflow example keep its code and raise its events with Post', () => {
    const diagram = loadTestDiagram('Gear_Logic');
    const machine = machineFor(diagram, {});
    const cpp = generateHookStub(machine, diagram, 'cpp').code;
    assert.match(cpp, /void gear_stateDuring\(\) override \{\n {8}speed = max\(0,min\(speed\+delta,100\)\);/);
    assert.match(cpp, /void action27\(\) override \{\n {8}Post\(Event::UP\);/);
    assert.match(generateHookStub(machine, diagram, 'csharp').code, /Post\(Event\.DOWN\);/);
    // C hooks get no machine to post to: the call stays as written.
    assert.match(generateHookStub(machine, diagram, 'c').code, /send\(DOWN, gear_state\);/);
});
