// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Helpers of the extension-host modules that do not depend on the VS Code API, kept in their own module so
// that they can be unit-tested with plain Node.js (test/host.test.js); the modules that use them import
// `vscode`, which only exists inside the extension host.
//
// - Locating diagram elements in the JSON text (diagnostics.ts): a small JSON scanner records the character
//   range of every value, so a problem can be placed on exactly the element it refers to, instead of on
//   the first piece of text that happens to look like `"id": "<id>"`.
// - Reading the stored code generation settings (codegen.ts, extension.ts): `codegen.language` and
//   `codegen.style` come from a hand-editable file, so they are checked against the known values before use.
// - The web address of the user manual for the installed version (extension.ts, "Open User Manual").
import { CodegenOptions, Language, Style } from './model';

/** The GitHub repository the extension is published from; the user manual is served from there. */
const REPOSITORY = 'https://github.com/JoltWare/machina-state';

/**
 * Web address of the user manual (docs/manual.pdf) that matches an extension version: the copy in the
 * repository at the release tag `v<version>`, which GitHub shows in its PDF viewer. The PDF is not packaged
 * with the extension (docs/ is excluded in .vscodeignore), and a hosted copy also works in remote and web
 * workspaces. A version that is not a plain `x.y.z` (or is missing) falls back to the main branch.
 *
 * @param version The extension version from package.json.
 */
export function manualUrl(version: unknown): string {
    const ref = typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : 'main';
    return `${REPOSITORY}/blob/${ref}/docs/manual.pdf`;
}

/** A half-open range [start, end) of character offsets into a text. */
export interface TextSpan {
    start: number;
    end: number;
}

/**
 * A JSON value with its position in the source text, as produced by `scanJson`. Only what locating
 * elements needs is kept: the decoded value of strings, the properties of objects (in source order,
 * duplicates included) and the items of arrays. Numbers, booleans and null are all `other`.
 */
interface JsonNode {
    kind: 'object' | 'array' | 'string' | 'other';
    /** Offset of the value's first character. */
    start: number;
    /** Offset just past the value's last character. */
    end: number;
    /** Decoded text of a string. */
    value?: string;
    /** Properties of an object; `key` is decoded, `keyStart`/`keyEnd` span the quoted key. */
    props?: { key: string; keyStart: number; keyEnd: number; value: JsonNode }[];
    /** Items of an array. */
    items?: JsonNode[];
}

/**
 * Scans JSON text into a tree of `JsonNode`s with source positions.
 *
 * A hand-written recursive-descent scanner, because JSON.parse reports no positions. It is lenient about
 * the details JSON.parse already checks (callers only scan text that parsed successfully): number and
 * literal tokens are taken as whatever runs up to the next delimiter, and string contents are decoded with
 * JSON.parse. Malformed structure (missing brackets, colons or commas, trailing text) yields undefined.
 *
 * @param text JSON text.
 * @returns The root value, or undefined if the text cannot be scanned.
 */
function scanJson(text: string): JsonNode | undefined {
    let i = 0;
    const skipSpace = () => {
        while (i < text.length && ' \t\r\n'.includes(text[i])) {
            i++;
        }
    };
    // Each parse function starts at the value's first character and leaves `i` just past its end; they
    // throw on malformed input, which the outer try turns into undefined.
    const parseString = (): JsonNode => {
        const start = i++;
        while (i < text.length && text[i] !== '"') {
            // Skip the escaped character, so an escaped quote does not end the string.
            i += text[i] === '\\' ? 2 : 1;
        }
        if (i >= text.length) {
            throw new Error('unterminated string');
        }
        i++;
        return { kind: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) as string };
    };
    const parseValue = (): JsonNode => {
        skipSpace();
        const start = i;
        const c = text[i];
        if (c === '"') {
            return parseString();
        }
        if (c === '{') {
            i++;
            const props: NonNullable<JsonNode['props']> = [];
            skipSpace();
            if (text[i] === '}') {
                i++;
                return { kind: 'object', start, end: i, props };
            }
            for (;;) {
                skipSpace();
                if (text[i] !== '"') {
                    throw new Error('expected a key');
                }
                const key = parseString();
                skipSpace();
                if (text[i++] !== ':') {
                    throw new Error('expected a colon');
                }
                props.push({ key: key.value!, keyStart: key.start, keyEnd: key.end, value: parseValue() });
                skipSpace();
                const sep = text[i++];
                if (sep === '}') {
                    return { kind: 'object', start, end: i, props };
                }
                if (sep !== ',') {
                    throw new Error('expected a comma');
                }
            }
        }
        if (c === '[') {
            i++;
            const items: JsonNode[] = [];
            skipSpace();
            if (text[i] === ']') {
                i++;
                return { kind: 'array', start, end: i, items };
            }
            for (;;) {
                items.push(parseValue());
                skipSpace();
                const sep = text[i++];
                if (sep === ']') {
                    return { kind: 'array', start, end: i, items };
                }
                if (sep !== ',') {
                    throw new Error('expected a comma');
                }
            }
        }
        // Number, true, false or null: everything up to the next delimiter.
        while (i < text.length && !' \t\r\n,]}:'.includes(text[i])) {
            i++;
        }
        if (i === start) {
            throw new Error('expected a value');
        }
        return { kind: 'other', start, end: i };
    };
    try {
        const root = parseValue();
        skipSpace();
        return i === text.length ? root : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The value of property `key` of an object node. With duplicate keys the last one is used, as JSON.parse
 * (and therefore parseDiagram) does.
 */
function propOf(node: JsonNode | undefined, key: string) {
    return node?.kind === 'object' ? [...node.props!].reverse().find(p => p.key === key) : undefined;
}

/** Which element array of the diagram an id is looked up in. */
export type ElementList = 'states' | 'transitions';

/**
 * Finds the `"id": "<id>"` property of a diagram element in the document text.
 *
 * Only the elements of the top-level `states` and `transitions` arrays are searched, comparing the decoded
 * id value, so ids that need escaping in JSON are found and an `"id"` elsewhere (e.g. in scenarios) is never
 * mistaken for an element. State and transition ids live in separate namespaces (only duplicate state ids
 * are an error), so the same id may occur in both arrays; `prefer` names the array searched first. Without
 * it the states are searched first, as the webview does when an issue is clicked. Within one array the
 * first element with the id is returned.
 *
 * @param text   The document text (valid JSON).
 * @param id     The element id from an Issue.
 * @param prefer The array to search first, when known.
 * @returns The span from the `"id"` key to the end of its value, or undefined if no element has this id
 *          (or the text cannot be scanned).
 */
export function locateElement(text: string, id: string, prefer?: ElementList): TextSpan | undefined {
    const root = scanJson(text);
    const lists: ElementList[] = prefer === 'transitions' ? ['transitions', 'states'] : ['states', 'transitions'];
    for (const list of lists) {
        const array = propOf(root, list)?.value;
        for (const item of array?.kind === 'array' ? array.items! : []) {
            const prop = propOf(item, 'id');
            if (prop && prop.value.kind === 'string' && prop.value.value === id) {
                return { start: prop.keyStart, end: prop.value.end };
            }
        }
    }
    return undefined;
}

/**
 * Finds a property key of the top-level object, e.g. `states`, used to place issues that belong to no
 * particular element.
 *
 * @returns The span of the quoted key, or undefined if the top level has no such property.
 */
export function locateTopLevelKey(text: string, key: string): TextSpan | undefined {
    const prop = propOf(scanJson(text), key);
    return prop && { start: prop.keyStart, end: prop.keyEnd };
}

/**
 * The character offset a JSON.parse error message refers to (V8 messages contain `at position <n>`),
 * clamped to the text length; undefined if the message names no position.
 */
export function jsonErrorOffset(message: string, textLength: number): number | undefined {
    const m = /at position (\d+)/.exec(message);
    return m ? Math.min(Number(m[1]), textLength) : undefined;
}

/** True if `x` is one of the supported target languages. */
export const isLanguage = (x: unknown): x is Language => x === 'cpp' || x === 'csharp' || x === 'c';
/** True if `x` is one of the supported implementation styles. */
export const isStyle = (x: unknown): x is Style => x === 'switch' || x === 'table';

/**
 * The language and style stored in a diagram's `codegen` settings; a missing or unknown value is left
 * undefined so that the caller can ask for it or apply its default.
 */
export function storedCodegen(codegen: CodegenOptions | undefined): { language?: Language; style?: Style } {
    return {
        language: isLanguage(codegen?.language) ? codegen!.language : undefined,
        style: isStyle(codegen?.style) ? codegen!.style : undefined
    };
}

/**
 * Code generation settings for a newly imported diagram: everything the imported content carries is kept,
 * and only a missing or unknown language or style is filled in from `defaults` (C++ and switch-based, the
 * same as the "New State Machine Diagram" template, unless the caller passes others).
 *
 * @param carried  The `codegen` object produced by the importer, if any.
 * @param defaults Language and style to use where `carried` has none.
 */
export function importCodegen(
    carried: CodegenOptions | undefined,
    defaults: { language: Language; style: Style } = { language: 'cpp', style: 'switch' }
): CodegenOptions {
    const stored = storedCodegen(carried);
    return { ...carried, language: stored.language ?? defaults.language, style: stored.style ?? defaults.style };
}
