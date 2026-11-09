// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0
//
// Hook stub generator: a starting point for the user's implementation of the hooks of a machine, written
// once next to the diagram (`<Name>Hooks.hpp`, `<Name>Hooks.cs` or `<Name>Hooks.c`) and never overwritten.
//
//   C++   class <Name>Hooks : public <Name> with an `override` for every guard and action (and Lock/Unlock,
//         StartTimer/CancelTimer when the machine needs them)
//   C#    class <Name>Hooks : <Name> with the same overrides
//   C     a static function per hook and `const <P>_Hooks <P>_HookImpl`, to pass to <P>_Init
//
// A hook whose code is known (Diagram.hooks, filled by the Stateflow import) gets that code as its body: a
// guard returns the expression, an action runs the statements. The code is copied verbatim, so it usually
// needs adapting (Stateflow's C action language is close to C/C++, but its functions, buses and literals are
// not). Variables listed in Diagram.data are declared as members (C++, C#) or file-scope statics (C) with
// the corresponding types. Hooks without known code get an empty body (guards return false), so the stub of
// any diagram compiles as it is.
import { Diagram, Language, Machine, Param } from '../model';
import { cPrefix } from './c';
import { GeneratedFile } from './index';
import { Writer } from './writer';

/** Integer and floating-point types of Simulink, by language. */
const TYPES: Record<string, { cpp: string; csharp: string; c: string }> = {
    double: { cpp: 'double', csharp: 'double', c: 'double' },
    single: { cpp: 'float', csharp: 'float', c: 'float' },
    boolean: { cpp: 'bool', csharp: 'bool', c: 'bool' },
    int8: { cpp: 'std::int8_t', csharp: 'sbyte', c: 'int8_t' },
    uint8: { cpp: 'std::uint8_t', csharp: 'byte', c: 'uint8_t' },
    int16: { cpp: 'std::int16_t', csharp: 'short', c: 'int16_t' },
    uint16: { cpp: 'std::uint16_t', csharp: 'ushort', c: 'uint16_t' },
    int32: { cpp: 'std::int32_t', csharp: 'int', c: 'int32_t' },
    uint32: { cpp: 'std::uint32_t', csharp: 'uint', c: 'uint32_t' },
    int64: { cpp: 'std::int64_t', csharp: 'long', c: 'int64_t' },
    uint64: { cpp: 'std::uint64_t', csharp: 'ulong', c: 'uint64_t' }
};

/**
 * Type of a data item in `language`: a Simulink built-in type maps to the corresponding type, a bus or
 * enumeration (`Bus: X`, `Enum: X`) to `X` (which the user defines), anything else (inherited types) to
 * double.
 */
function dataType(type: string, language: Language): string {
    const named = /^(?:Bus|Enum):\s*([A-Za-z_]\w*)$/.exec(type.trim());
    if (named) {
        return named[1];
    }
    return (TYPES[type.trim()] ?? TYPES.double)[language];
}

/** The lines of `code` with common leading whitespace removed and trailing blank lines dropped. */
function codeLines(code: string): string[] {
    const lines = code.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
    const indent = Math.min(...lines.filter(l => l.trim()).map(l => /^\s*/.exec(l)![0].length));
    return lines.map(l => l.slice(Number.isFinite(indent) ? indent : 0).replace(/\s+$/, ''));
}

/**
 * Stateflow's `send(E)` / `send(E, target)` raises local event E. In C++ and C# a hook raises an event with
 * Post (the Stateflow import enables the event queue for such charts), so the call is translated; the
 * target state is dropped because Post offers the event to the whole machine.
 */
function translateSend(line: string, language: 'cpp' | 'csharp'): string {
    return line.replace(/\bsend\s*\(\s*([A-Za-z_]\w*)\s*(?:,[^()]*)?\)/g, (_, e: string) => `Post(Event${language === 'cpp' ? '::' : '.'}${e})`);
}

/** File name of the stub for a language. */
export function stubFileName(m: Machine, language: Language): string {
    return `${m.name}Hooks${language === 'cpp' ? '.hpp' : language === 'csharp' ? '.cs' : '.c'}`;
}

/**
 * Generates the hook stub of a machine.
 *
 * @param m       analysed, error-free machine (its hook lists and signatures are used)
 * @param d       the diagram, for `hooks` (code per hook) and `data` (variables to declare)
 * @param language target language of the generated machine the stub derives from
 */
export function generateHookStub(m: Machine, d: Diagram, language: Language): GeneratedFile {
    const hooks = d.hooks ?? {};
    // Data items with a valid name, first occurrence of each name only.
    const data = (d.data ?? []).filter((x, i, all) => /^[A-Za-z_]\w*$/.test(x.name) && all.findIndex(y => y.name === x.name) === i);
    const params = (hook: string): Param[] => m.hookParams.get(hook) ?? [];
    const imported = Object.keys(hooks).length > 0;
    const w = new Writer(false);
    const intro = [
        `${m.name}Hooks: implementation of the hooks of ${m.name}, generated once by MachinaState.`,
        'This file is yours: MachinaState never overwrites it.',
        ...(imported
            ? ['Hook bodies hold the code each hook replaced on import, copied as written; adapt it where needed', '(helper functions, bus types and literals of the source tool are not translated).']
            : [])
    ];

    if (language === 'cpp') {
        intro.forEach(l => w.line(`// ${l}`));
        w.line('#pragma once');
        w.line('');
        if (data.some(x => /^std::/.test(dataType(x.type, 'cpp')))) {
            w.line('#include <cstdint>');
        }
        w.line(`#include "${m.name}.hpp"`);
        w.line('');
        if (m.namespace) {
            w.open(`namespace ${m.namespace.replace(/\./g, '::')}`);
            w.line('');
        }
        w.open(`class ${m.name}Hooks : public ${m.name}`);
        w.label('protected:');
        if (data.length) {
            w.line('// Variables used by the hook code.');
            for (const x of data) {
                const size = x.size && /^\w+$/.test(x.size) ? `[${x.size}]` : '';
                w.line(`${dataType(x.type, 'cpp')} ${x.name}${size}{};   // ${x.scope}, ${x.type}${x.size && !size ? `, size ${x.size}` : ''}`);
            }
            w.line('');
        }
        if (m.threadSafe) {
            w.line('void Lock() const override {}     // TODO: acquire a lock');
            w.line('void Unlock() const override {}   // TODO: release it');
            w.line('');
        }
        if (m.timers.length) {
            w.open('void StartTimer(Event timeout, unsigned milliseconds, unsigned generation) override');
            w.line('// TODO: start a one-shot timer; when it elapses, call DispatchTimeout(timeout, generation).');
            w.line('(void)timeout;');
            w.line('(void)milliseconds;');
            w.line('(void)generation;');
            w.close();
            w.line('');
            w.open('void CancelTimer(Event timeout) override');
            w.line('(void)timeout;');
            w.close();
            w.line('');
        }
        const body = (hook: string, guard: boolean) => {
            const info = hooks[hook];
            if (info?.origin) {
                w.line(`// ${info.origin}`);
            }
            w.open(`${guard ? 'bool' : 'void'} ${hook}(${params(hook).map(p => p.decl).join(', ')}) override`);
            if (!info) {
                params(hook).forEach(p => w.line(`(void)${p.name};`));
            }
            if (guard) {
                w.line(info ? `return ${codeLines(info.code).join('\n').replace(/\n/g, ' ')};` : 'return false;   // TODO');
            } else if (info) {
                codeLines(info.code).forEach(l => w.line(m.queue ? translateSend(l, 'cpp') : l));
            } else {
                w.line('// TODO');
            }
            w.close();
            w.line('');
        };
        m.guards.forEach(g => body(g, true));
        m.actions.forEach(a => body(a, false));
        w.trimBlank();
        w.close('};');
        if (m.namespace) {
            w.line('');
            w.close();
        }
        return { extension: 'Hooks.hpp', code: w.toString() };
    }

    if (language === 'csharp') {
        intro.forEach(l => w.line(`// ${l}`));
        w.line('');
        if (m.namespace) {
            w.open(`namespace ${m.namespace.replace(/::/g, '.')}`);
        }
        w.open(`public class ${m.name}Hooks : ${m.name}`);
        if (data.length) {
            w.line('// Variables used by the hook code.');
            for (const x of data) {
                const type = dataType(x.type, 'csharp');
                const array = x.size && /^\w+$/.test(x.size);
                w.line(
                    array
                        ? `protected ${type}[] ${x.name} = new ${type}[${x.size}]; // ${x.scope}, ${x.type}`
                        : `protected ${type} ${x.name}${/^[A-Z]/.test(type) && !TYPES[x.type.trim()] ? ` = new ${type}()` : ''}; // ${x.scope}, ${x.type}${x.size ? `, size ${x.size}` : ''}`
                );
            }
            w.line('');
        }
        if (m.threadSafe) {
            w.line('protected override void Lock() { } // TODO: acquire a lock');
            w.line('protected override void Unlock() { } // TODO: release it');
            w.line('');
        }
        if (m.timers.length) {
            w.line('// TODO: start a one-shot timer; when it elapses, call DispatchTimeout(timeout, generation).');
            w.line('protected override void StartTimer(Event timeout, int milliseconds, int generation) { }');
            w.line('protected override void CancelTimer(Event timeout) { }');
            w.line('');
        }
        const body = (hook: string, guard: boolean) => {
            const info = hooks[hook];
            if (info?.origin) {
                w.line(`// ${info.origin}`);
            }
            w.open(`protected override ${guard ? 'bool' : 'void'} ${hook}(${params(hook).map(p => p.decl).join(', ')})`);
            if (guard) {
                w.line(info ? `return ${codeLines(info.code).join(' ')};` : 'return false; // TODO');
            } else if (info) {
                codeLines(info.code).forEach(l => w.line(m.queue ? translateSend(l, 'csharp') : l));
            } else {
                w.line('// TODO');
            }
            w.close();
            w.line('');
        };
        m.guards.forEach(g => body(g, true));
        m.actions.forEach(a => body(a, false));
        w.trimBlank();
        w.close();
        if (m.namespace) {
            w.close();
        }
        return { extension: 'Hooks.cs', code: w.toString() };
    }

    // C: one static function per hook (named <P>_<hook>) and the hooks struct that binds them.
    const P = cPrefix(m);
    intro.forEach((l, i) => w.line(`${i === 0 ? '/* ' : '   '}${l}${i === intro.length - 1 ? ' */' : ''}`));
    w.line(`/* Pass &${P}_HookImpl to ${P}_Init; declare it with \`extern const ${P}_Hooks ${P}_HookImpl;\` where needed. */`);
    w.line(`#include "${m.name}.h"`);
    if (data.some(x => /int\d+_t$/.test(dataType(x.type, 'c')))) {
        w.line('#include <stdint.h>');
    }
    w.line('');
    if (data.length) {
        w.line('/* Variables used by the hook code. */');
        for (const x of data) {
            const size = x.size && /^\w+$/.test(x.size) ? `[${x.size}]` : '';
            w.line(`static ${dataType(x.type, 'c')} ${x.name}${size};   /* ${x.scope}, ${x.type}${x.size && !size ? `, size ${x.size}` : ''} */`);
        }
        w.line('');
    }
    const members: string[] = [];
    const fn = (signature: string, lines: string[], comment?: string) => {
        if (comment) {
            w.line(`/* ${comment} */`);
        }
        w.open(signature);
        lines.forEach(l => w.line(l));
        w.close();
        w.line('');
    };
    const decls = (hook: string) => ['void* context', ...params(hook).map(p => p.decl)].join(', ');
    const unused = (hook: string) => ['(void)context;', ...params(hook).map(p => `(void)${p.name};`)];
    for (const [hook, guard] of [...m.guards.map(g => [g, true] as const), ...m.actions.map(a => [a, false] as const)]) {
        const info = hooks[hook];
        const lines = guard
            ? [...unused(hook), info ? `return ${codeLines(info.code).join(' ')};` : 'return false;   /* TODO */']
            : [...unused(hook), ...(info ? codeLines(info.code) : ['/* TODO */'])];
        // The functions are prefixed so that a hook named like a C library function (`abort`, `exit`)
        // cannot clash with it.
        fn(`static ${guard ? 'bool' : 'void'} ${P}_${hook}(${decls(hook)})`, lines, info?.origin);
        members.push(`.${hook} = ${P}_${hook}`);
    }
    if (m.timers.length) {
        fn(`static void ${P}_StartTimerImpl(void* context, ${P}_Event timeout, unsigned milliseconds, unsigned generation)`, [
            '/* TODO: start a one-shot timer; when it elapses, call DispatchTimeout(timeout, generation). */',
            '(void)context;',
            '(void)timeout;',
            '(void)milliseconds;',
            '(void)generation;'
        ]);
        fn(`static void ${P}_CancelTimerImpl(void* context, ${P}_Event timeout)`, ['(void)context;', '(void)timeout;']);
        members.push(`.StartTimer = ${P}_StartTimerImpl`, `.CancelTimer = ${P}_CancelTimerImpl`);
    }
    if (m.threadSafe) {
        fn(`static void ${P}_LockImpl(void* context)`, ['(void)context;   /* TODO: acquire a lock */']);
        fn(`static void ${P}_UnlockImpl(void* context)`, ['(void)context;   /* TODO: release it */']);
        members.push(`.Lock = ${P}_LockImpl`, `.Unlock = ${P}_UnlockImpl`);
    }
    if (m.trace) {
        members.push('.Trace = NULL');
    }
    w.line(`extern const ${P}_Hooks ${P}_HookImpl;`);
    if (members.length) {
        w.open(`const ${P}_Hooks ${P}_HookImpl =`);
        members.forEach((x, i) => w.line(`${x}${i < members.length - 1 ? ',' : ''}`));
        w.close('};');
    } else {
        w.line(`const ${P}_Hooks ${P}_HookImpl = { 0 };`);
    }
    return { extension: 'Hooks.c', code: w.toString() };
}
