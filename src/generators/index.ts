// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0
//
// Entry point of the code generators: maps a target language to its generator and names the output files.
//
// Each generator turns an analysed Machine (see model.ts) into complete, self-contained source text in one
// of two styles ('switch': nested switch statements; 'table': constant transition tables). The options
// stored on the Machine (trace, threadSafe, queue, queueCapacity) are read by the generators themselves, so
// this module only has to dispatch on the language:
//
//   cpp     -> <Name>.hpp            single header-only C++17 class   (generateCpp, cpp.ts)
//   csharp  -> <Name>.cs             single abstract C# class         (generateCSharp, csharp.ts)
//   c       -> <Name>.h + <Name>.c   C99 header and implementation    (generateC, c.ts)
//
// The caller (codegen.ts) writes the files next to the diagram; the golden tests (test/golden.test.js)
// compare every language/style/option combination against checked-in output.

import { Language, Machine, Style } from '../model';
import { generateC } from './c';
import { generateCpp } from './cpp';
import { generateCSharp } from './csharp';

/** One generated source file; its full name is `<machine name><extension>`. */
export interface GeneratedFile {
    /** File name extension, e.g. `.hpp`; the base name is the machine name. */
    extension: string;
    /** Complete file contents, with LF line endings and a trailing newline. */
    code: string;
}

/**
 * Generates the code for a machine; the first file is the main one (the header for C).
 *
 * @param machine analysed, error-free machine (the result of `analyze` without issues).
 * @param language target language; 'cpp' is handled by the default branch.
 * @param style 'switch' for nested switch statements, 'table' for data-driven transition tables.
 * @returns one file for C++ and C#, two (header first, then source) for C.
 */
export function generateCode(machine: Machine, language: Language, style: Style): GeneratedFile[] {
    switch (language) {
        case 'c': {
            // The C header is identical for both styles; only the .c file differs.
            const { header, source } = generateC(machine, style);
            return [
                { extension: '.h', code: header },
                { extension: '.c', code: source }
            ];
        }
        case 'csharp':
            return [{ extension: '.cs', code: generateCSharp(machine, style) }];
        default:
            // 'cpp' (codegen.ts already maps a diagram without a configured language to 'cpp').
            return [{ extension: '.hpp', code: generateCpp(machine, style) }];
    }
}
