// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Integration test: generates every example in every language/style/config, compiles the code with
// warnings as errors, drives it with the same pseudo-random event script and requires identical traces.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { CONFIGS, STYLES, compileSubjects, machineFor, generate, hasTool, freshDir, root } = require('./helpers');
const { cPrefix } = require(path.join(root, 'out', 'generators', 'c.js'));

const { TRACE_KINDS, paramKind, script: engineScript, scenarioEvents, postedEvent, runEngine } = require('./engine-harness');

const STEPS = 80;
// Every script restarts the machine halfway (Start is a full reset) and mixes stale and valid DispatchTimeout calls.
const script = variant => engineScript(variant.machine, STEPS, variant.directed, { restart: true });

function literal(param, i, lang) {
    switch (paramKind(param.type)) {
        case 'int':
            return String(i % 7);
        case 'bool':
            return i % 2 ? 'true' : 'false';
        case 'string':
            return `"s${i}"`;
        default:
            return lang === 'cpp' ? '{}' : lang === 'c' ? '0' : 'default';
    }
}

function printParam(param, lang) {
    const n = param.name;
    if (lang === 'c') {
        switch (paramKind(param.type)) {
            case 'int':
                return `printf(" %lld", (long long)${n});`;
            case 'bool':
                return `printf(" %s", ${n} ? "true" : "false");`;
            case 'string':
                return `printf(" %s", ${n});`;
            default:
                return '';
        }
    }
    switch (paramKind(param.type)) {
        case 'int':
            return lang === 'cpp' ? `std::printf(" %lld", static_cast<long long>(${n}));` : `Console.Write(" " + ${n});`;
        case 'bool':
            return lang === 'cpp' ? `std::printf(" %s", ${n} ? "true" : "false");` : `Console.Write(" " + (${n} ? "true" : "false"));`;
        case 'string':
            return lang === 'cpp' ? `std::printf(" %s", std::string(${n}).c_str());` : `Console.Write(" " + ${n});`;
        default:
            // Not printed (e.g. pointers); C++ would warn about the unused parameter.
            return lang === 'cpp' ? `(void)${n};` : '';
    }
}

function cppHarness(variants) {
    const lines = ['#include <cstdio>', '#include <cstring>', '#include <mutex>', '#include <string>'];
    variants.forEach(v => lines.push(`#include "${v.key}.hpp"`));
    lines.push('');
    const groups = new Map(variants.map(v => [v.group, v]));
    for (const v of groups.values()) {
        const m = v.machine;
        const hookDecl = h => (m.hookParams.get(h) ?? []).map(p => p.decl).join(', ');
        lines.push(`template <class Base> struct Impl_${v.group} : Base {`);
        if (m.guards.length) {
            lines.push('    int counter = 0;');
        }
        const posted = postedEvent(m);
        if (posted) {
            lines.push('    int posts = 0;');
        }
        if (m.timers.length) {
            lines.push(
                '    unsigned generations[Base::kEventCount] = {};   // latest StartTimer generation per timeout event',
                '    void StartTimer(typename Base::Event timeout, unsigned milliseconds, unsigned generation) override { generations[static_cast<int>(timeout)] = generation; std::printf("  StartTimer %s %u %u\\n", Base::EventName(timeout), milliseconds, generation); }',
                '    void CancelTimer(typename Base::Event timeout) override { std::printf("  CancelTimer %s\\n", Base::EventName(timeout)); }'
            );
        }
        if (m.threadSafe) {
            lines.push('    mutable std::recursive_mutex mutex;', '    void Lock() const override { mutex.lock(); }', '    void Unlock() const override { mutex.unlock(); }');
        }
        if (m.trace) {
            lines.push(
                '    void Trace(typename Base::TraceKind kind, const char* name) override {',
                `        static const char* const kinds[] = { ${TRACE_KINDS.map(k => `"${k}"`).join(', ')} };`,
                '        std::printf("[%s] %s\\n", kinds[static_cast<int>(kind)], name);',
                '    }'
            );
        }
        for (const g of m.guards) {
            const ps = m.hookParams.get(g) ?? [];
            lines.push(
                `    bool ${g}(${hookDecl(g)}) override {`,
                '        const bool result = (++counter % 3) != 0;',
                `        std::printf("  guard ${g}");`,
                ...ps.map(p => `        ${printParam(p, 'cpp')}`),
                '        std::printf(" -> %d\\n", result ? 1 : 0);',
                '        return result;',
                '    }'
            );
        }
        for (const a of m.actions) {
            const ps = m.hookParams.get(a) ?? [];
            lines.push(`    void ${a}(${hookDecl(a)}) override {`, `        std::printf("  ${a}");`, ...ps.map(p => `        ${printParam(p, 'cpp')}`), '        std::printf("\\n");');
            if (posted) {
                lines.push(`        if (++posts % 4 == 0) { std::printf("  post ${posted} %d\\n", this->Post(Base::Event::${posted}) ? 1 : 0); }`);
            }
            lines.push('    }');
        }
        lines.push('};', '');
        lines.push(`template <class M> void Run_${v.group}() {`, `    Impl_${v.group}<M> m;`, '    m.Start();', '    std::printf("-> %s\\n", M::StateName(m.Current()));');
        for (const s of script(v)) {
            if (s.restart) {
                lines.push('    m.Start();', '    std::printf("restart -> %s\\n", M::StateName(m.Current()));');
                continue;
            }
            const call = s.stale
                ? `m.DispatchTimeout(M::Event::${s.event}, 0u)`
                : s.valid
                  ? `m.DispatchTimeout(M::Event::${s.event}, m.generations[static_cast<int>(M::Event::${s.event})])`
                  : s.typed
                  ? `m.Dispatch${s.event}(${s.params.map(p => literal(p, s.i, 'cpp')).join(', ')})`
                  : `m.Dispatch(M::Event::${s.event})`;
            lines.push(
                `    { const bool h = ${call}; std::printf("${s.event} %d -> %s finished=%d\\n", h ? 1 : 0, M::StateName(m.Current()), m.IsFinished() ? 1 : 0); }`
            );
        }
        lines.push('}', '');
    }
    lines.push('int main(int argc, char** argv) {', '    if (argc < 2) return 2;');
    for (const v of variants) {
        lines.push(`    if (std::strcmp(argv[1], "${v.key}") == 0) { Run_${v.group}<${v.namespace}::${v.machine.name}>(); return 0; }`);
    }
    lines.push('    return 2;', '}', '');
    return lines.join('\n');
}

function csHarness(variants) {
    const lines = ['using System;', 'using System.Threading;', '', 'namespace Harness', '{'];
    for (const v of variants) {
        const m = v.machine;
        const hookDecl = h => (m.hookParams.get(h) ?? []).map(p => p.decl).join(', ');
        lines.push(`    sealed class Impl_${v.key} : ${v.namespace}.${m.name}`, '    {');
        if (m.guards.length) {
            lines.push('        private int counter;');
        }
        const posted = postedEvent(m);
        if (posted) {
            lines.push('        private int posts;');
        }
        if (m.timers.length) {
            lines.push(
                '        public readonly int[] generations = new int[Enum.GetValues(typeof(Event)).Length];',
                '        protected override void StartTimer(Event timeout, int milliseconds, int generation) { generations[(int)timeout] = generation; Console.Write($"  StartTimer {timeout} {milliseconds} {generation}\\n"); }',
                '        protected override void CancelTimer(Event timeout) => Console.Write($"  CancelTimer {timeout}\\n");'
            );
        }
        if (m.threadSafe) {
            lines.push(
                '        private readonly object gate = new object();',
                '        protected override void Lock() => Monitor.Enter(gate);',
                '        protected override void Unlock() => Monitor.Exit(gate);'
            );
        }
        if (m.trace) {
            lines.push('        protected override void Trace(TraceKind kind, string name) => Console.Write($"[{kind}] {name}\\n");');
        }
        for (const g of m.guards) {
            const ps = m.hookParams.get(g) ?? [];
            lines.push(
                `        protected override bool ${g}(${hookDecl(g)})`,
                '        {',
                '            var result = (++counter % 3) != 0;',
                `            Console.Write("  guard ${g}");`,
                ...ps.map(p => `            ${printParam(p, 'cs')}`),
                '            Console.Write($" -> {(result ? 1 : 0)}\\n");',
                '            return result;',
                '        }'
            );
        }
        for (const a of m.actions) {
            const ps = m.hookParams.get(a) ?? [];
            lines.push(`        protected override void ${a}(${hookDecl(a)})`, '        {', `            Console.Write("  ${a}");`, ...ps.map(p => `            ${printParam(p, 'cs')}`), '            Console.Write("\\n");');
            if (posted) {
                lines.push(`            if (++posts % 4 == 0) { Console.Write($"  post ${posted} {(Post(Event.${posted}) ? 1 : 0)}\\n"); }`);
            }
            lines.push('        }');
        }
        lines.push('    }', '');
    }
    lines.push('    static class Program', '    {');
    for (const v of variants) {
        const M = `${v.namespace}.${v.machine.name}`;
        lines.push(`        static void Run_${v.key}()`, '        {', `            var m = new Impl_${v.key}();`, '            m.Start();', '            Console.Write($"-> {m.Current}\\n");');
        for (const s of script(v)) {
            if (s.restart) {
                lines.push('            m.Start();', '            Console.Write($"restart -> {m.Current}\\n");');
                continue;
            }
            const call = s.stale
                ? `m.DispatchTimeout(${M}.Event.${s.event}, 0)`
                : s.valid
                  ? `m.DispatchTimeout(${M}.Event.${s.event}, m.generations[(int)${M}.Event.${s.event}])`
                  : s.typed
                  ? `m.Dispatch${s.event}(${s.params.map(p => literal(p, s.i, 'cs')).join(', ')})`
                  : `m.Dispatch(${M}.Event.${s.event})`;
            lines.push(`            { var h = ${call}; Console.Write($"${s.event} {(h ? 1 : 0)} -> {m.Current} finished={(m.IsFinished ? 1 : 0)}\\n"); }`);
        }
        lines.push('        }', '');
    }
    lines.push('        static int Main(string[] args)', '        {', '            switch (args.Length > 0 ? args[0] : "")', '            {');
    for (const v of variants) {
        lines.push(`                case "${v.key}": Run_${v.key}(); return 0;`);
    }
    lines.push('            }', '            return 2;', '        }', '    }', '}', '');
    return lines.join('\n');
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');

function cHarness(variants) {
    const lines = ['#include <stdbool.h>', '#include <stdio.h>', '#include <stdlib.h>', '#include <string.h>'];
    variants.forEach(v => lines.push(`#include "${v.key}/${v.machine.name}.h"`));
    lines.push('');
    for (const v of variants) {
        const m = v.machine;
        const P = cPrefix(m);
        const K = v.key;
        const posted = postedEvent(m);
        const params = h => m.hookParams.get(h) ?? [];
        const decl = h => ['void* context', ...params(h).map(p => p.decl)].join(', ');
        const voids = h => ['context', ...params(h).map(p => p.name)].map(n => `(void)${n};`).join(' ');
        const hooks = [];
        if (m.guards.length) {
            lines.push(`static int ${K}_counter;`);
        }
        if (posted) {
            lines.push(`static int ${K}_posts;`);
        }
        if (m.threadSafe) {
            lines.push(`static int ${K}_depth;`);
        }
        for (const g of m.guards) {
            hooks.push(`.${g} = ${K}_${g}`);
            lines.push(
                `static bool ${K}_${g}(${decl(g)}) {`,
                `    const bool result = (++${K}_counter % 3) != 0;`,
                `    ${voids(g)}`,
                `    printf("  guard ${g}");`,
                ...params(g).map(p => `    ${printParam(p, 'c')}`),
                '    printf(" -> %d\\n", result ? 1 : 0);',
                '    return result;',
                '}'
            );
        }
        for (const a of m.actions) {
            hooks.push(`.${a} = ${K}_${a}`);
            lines.push(`static void ${K}_${a}(${decl(a)}) {`, `    ${voids(a)}`, `    printf("  ${a}");`, ...params(a).map(p => `    ${printParam(p, 'c')}`), '    printf("\\n");');
            if (posted) {
                lines.push(`    if (++${K}_posts % 4 == 0) { printf("  post ${posted} %d\\n", ${P}_Post((${P}*)context, ${P}_Event_${posted}) ? 1 : 0); }`);
            }
            lines.push('}');
        }
        if (m.timers.length) {
            hooks.push(`.StartTimer = ${K}_StartTimer`, `.CancelTimer = ${K}_CancelTimer`);
            lines.push(
                `static unsigned ${K}_generations[${P}_EventCount];`,
                `static void ${K}_StartTimer(void* context, ${P}_Event timeout, unsigned milliseconds, unsigned generation) { (void)context; ${K}_generations[timeout] = generation; printf("  StartTimer %s %u %u\\n", ${P}_EventName(timeout), milliseconds, generation); }`,
                `static void ${K}_CancelTimer(void* context, ${P}_Event timeout) { (void)context; printf("  CancelTimer %s\\n", ${P}_EventName(timeout)); }`
            );
        }
        if (m.trace) {
            hooks.push(`.Trace = ${K}_Trace`);
            lines.push(
                `static void ${K}_Trace(void* context, ${P}_TraceKind kind, const char* name) {`,
                `    static const char* const kinds[] = { ${TRACE_KINDS.map(k => `"${k}"`).join(', ')} };`,
                '    (void)context;',
                '    printf("[%s] %s\\n", kinds[kind], name);',
                '}'
            );
        }
        if (m.threadSafe) {
            hooks.push(`.Lock = ${K}_Lock`, `.Unlock = ${K}_Unlock`);
            lines.push(
                `static void ${K}_Lock(void* context) { (void)context; if (${K}_depth++ != 0) { puts("recursive lock"); exit(3); } }`,
                `static void ${K}_Unlock(void* context) { (void)context; --${K}_depth; }`
            );
        }
        lines.push(`static const ${P}_Hooks ${K}_hooks = { ${hooks.length ? hooks.join(', ') : '0'} };`);
        lines.push(`static void Run_${K}(void) {`, `    ${P} m;`, `    ${P}_Init(&m, &${K}_hooks, &m);`, `    ${P}_Start(&m);`, `    printf("-> %s\\n", ${P}_StateName(${P}_Current(&m)));`);
        for (const s of script(v)) {
            if (s.restart) {
                lines.push(`    ${P}_Start(&m);`, `    printf("restart -> %s\\n", ${P}_StateName(${P}_Current(&m)));`);
                continue;
            }
            const call = s.stale
                ? `${P}_DispatchTimeout(&m, ${P}_Event_${s.event}, 0u)`
                : s.valid
                  ? `${P}_DispatchTimeout(&m, ${P}_Event_${s.event}, ${K}_generations[${P}_Event_${s.event}])`
                  : s.typed
                  ? `${P}_Dispatch${s.event}(&m${s.params.map(p => `, ${literal(p, s.i, 'c')}`).join('')})`
                  : `${P}_Dispatch(&m, ${P}_Event_${s.event})`;
            lines.push(`    { const bool h = ${call}; printf("${s.event} %d -> %s finished=%d\\n", h ? 1 : 0, ${P}_StateName(${P}_Current(&m)), ${P}_IsFinished(&m) ? 1 : 0); }`);
        }
        lines.push('}', '');
    }
    lines.push('int main(int argc, char** argv) {', '    if (argc < 2) return 2;');
    for (const v of variants) {
        lines.push(`    if (strcmp(argv[1], "${v.key}") == 0) { Run_${v.key}(); return 0; }`);
    }
    lines.push('    return 2;', '}', '');
    return lines.join('\n');
}

/** Every example and every test-only diagram valid for `language`, in every config and style. */
function variantsFor(language) {
    const variants = [];
    for (const { name, load } of compileSubjects().filter(x => x.languages.includes(language))) {
        for (const [configName, config] of Object.entries(CONFIGS)) {
            for (const style of STYLES) {
                const key = `${name}_${configName}_${style}`;
                const namespace = `T_${key}`;
                const diagram = load();
                const machine = machineFor(diagram, config, namespace);
                variants.push({ key, group: `${name}_${configName}`, namespace, machine, directed: scenarioEvents(diagram), files: generate(machine, language, style) });
            }
        }
    }
    return variants;
}

const outputs = { cpp: new Map(), csharp: new Map(), c: new Map() };

test('C++ variants compile with -Wall -Wextra -Werror and run', { skip: !hasTool('g++') && 'g++ not found', timeout: 300000 }, () => {
    const dir = freshDir('compile', 'cpp');
    const variants = variantsFor('cpp');
    variants.forEach(v => fs.writeFileSync(path.join(dir, `${v.key}.hpp`), v.files[0].code));
    fs.writeFileSync(path.join(dir, 'main.cpp'), cppHarness(variants));
    const exe = path.join(dir, process.platform === 'win32' ? 'harness.exe' : 'harness');
    run('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic', '-O1', 'main.cpp', '-o', exe], dir);
    for (const v of variants) {
        outputs.cpp.set(v.key, run(exe, [v.key], dir));
    }
});

test('C# variants compile with warnings as errors and run', { skip: !hasTool('dotnet') && 'dotnet not found', timeout: 300000 }, () => {
    const dir = freshDir('compile', 'csharp');
    const variants = variantsFor('csharp');
    variants.forEach(v => fs.writeFileSync(path.join(dir, `${v.key}.cs`), v.files[0].code));
    fs.writeFileSync(path.join(dir, 'Program.cs'), csHarness(variants));
    fs.writeFileSync(
        path.join(dir, 'harness.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework>' +
            '<Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors><RollForward>Major</RollForward>' +
            '<AssemblyName>harness</AssemblyName></PropertyGroup></Project>'
    );
    run('dotnet', ['build', '-c', 'Release', '-nologo', '-v', 'q', '-o', 'bin'], dir);
    for (const v of variants) {
        outputs.csharp.set(v.key, run('dotnet', [path.join('bin', 'harness.dll'), v.key], dir));
    }
});

test('C variants compile with -std=c99 -Wall -Wextra -Werror -pedantic and run', { skip: !hasTool('gcc') && 'gcc not found', timeout: 300000 }, () => {
    const dir = freshDir('compile', 'c');
    const variants = variantsFor('c');
    const sources = ['main.c'];
    for (const v of variants) {
        fs.mkdirSync(path.join(dir, v.key));
        v.files.forEach(f => fs.writeFileSync(path.join(dir, v.key, v.machine.name + f.extension), f.code));
        sources.push(`${v.key}/${v.machine.name}.c`);
    }
    fs.writeFileSync(path.join(dir, 'main.c'), cHarness(variants));
    const exe = path.join(dir, process.platform === 'win32' ? 'harness.exe' : 'harness');
    run('gcc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-pedantic', '-O1', ...sources, '-o', exe], dir);
    for (const v of variants) {
        outputs.c.set(v.key, run(exe, [v.key], dir));
    }
});

test('all variants of each machine produce identical traces', t => {
    if (outputs.cpp.size === 0 && outputs.csharp.size === 0 && outputs.c.size === 0) {
        t.skip('no compiler available');
        return;
    }
    for (const { name, load } of compileSubjects()) {
        for (const configName of Object.keys(CONFIGS)) {
            const results = [];
            for (const lang of ['cpp', 'csharp', 'c']) {
                for (const style of STYLES) {
                    const out = outputs[lang].get(`${name}_${configName}_${style}`);
                    if (out !== undefined) {
                        results.push({ label: `${lang}/${style}`, out });
                    }
                }
            }
            const diagram = load();
            const engine = runEngine(machineFor(diagram, CONFIGS[configName], 'Engine'), STEPS, { directed: scenarioEvents(diagram), restart: true });
            results.push({ label: 'engine', out: engine });
            assert.ok(results.length > 1);
            assert.ok(results[0].out.split('\n').filter(l => l.includes(' -> ')).length > STEPS / 2, `${name}/${configName}: too little output`);
            for (const r of results.slice(1)) {
                assert.equal(r.out, results[0].out, `${name}/${configName}: ${r.label} differs from ${results[0].label}`);
            }
        }
    }
});
