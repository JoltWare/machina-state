// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Minimal XML reader and writer for SCXML import/export (elements, attributes, namespaces, text, comments,
// CDATA and the predefined/numeric entities; DTDs and processing instructions are skipped).
//
// The extension has no runtime dependencies, so instead of a full XML library this file provides just enough
// to read the SCXML documents that tools write and to escape the text that the SCXML exporter writes (the
// writer side is only `escapeXml`; the exporter assembles the markup itself).
//
// What the reader does and does not do:
//  - It builds a simple tree of `XmlElement`s. Element and attribute names are kept exactly as written,
//    prefix included (`machina:kind`), in `name` and `attrs`; callers that only care about SCXML element
//    names compare them with `localName`.
//  - Namespaces are resolved as in "Namespaces in XML": `xmlns="uri"` declares the default namespace of the
//    element and its descendants, `xmlns:p="uri"` binds prefix `p` in the same scope (an inner declaration
//    overrides an outer one), and `xmlns=""` / `xmlns:p=""` remove a binding again. Each element records its
//    namespace URI (`namespace`) and its attributes with resolved names (`nsAttrs`, read with `attrNS`);
//    unprefixed attributes are in no namespace, whatever the default namespace is. The `xml` prefix is
//    predefined. A prefix that is not declared in scope is an error.
//  - Attribute values must be quoted (single or double quotes); entities in them are decoded.
//  - The text of an element is the concatenation of all its direct text and CDATA content, including the
//    whitespace between child elements, so the relative order of text and children is lost (SCXML only needs
//    the text of leaf elements such as <script>). Entities in text are decoded; CDATA content is taken as is.
//  - Comments, processing instructions (including the `<?xml ...?>` declaration) and `<!...>` declarations
//    such as <!DOCTYPE> (including an internal subset in `[...]`) are skipped. Entities declared in a DTD are
//    not supported: references to them are left in the text unchanged.
//  - Malformed input (unterminated constructs, mismatched end tags, several root elements, text outside
//    the root, character references to characters that XML does not allow, undeclared namespace prefixes)
//    throws an Error whose message starts with the 1-based line number of the problem.

/** An attribute with its name resolved against the namespace declarations in scope. */
export interface XmlAttribute {
    /** Namespace URI; '' for an unprefixed attribute (unprefixed attributes are in no namespace). */
    uri: string;
    /** Name without the prefix (`kind` for `machina:kind`). */
    local: string;
    /** Value with entities decoded. */
    value: string;
}

/** An element of the parsed document. */
export interface XmlElement {
    /** Element name as written, including any namespace prefix (`machina:state`). */
    name: string;
    /** Namespace URI of the element: that of its prefix, or the default namespace in scope; '' for none. */
    namespace: string;
    /** Attributes by name (prefix included) with entities decoded; for duplicates the last one wins. */
    attrs: Record<string, string>;
    /**
     * The same attributes with resolved names, in document order; namespace declarations (`xmlns`,
     * `xmlns:p`) are not included. Use `attrNS` to look one up.
     */
    nsAttrs: XmlAttribute[];
    /** Child elements in document order. */
    children: XmlElement[];
    /** All direct text content (text and CDATA, whitespace included), concatenated. */
    text: string;
}

/** The five entities predefined by XML. */
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Namespace URI bound to the `xml` prefix by definition (it needs no declaration). */
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * True for a code point that XML allows in a document (the `Char` production of XML 1.0): tab, line feed,
 * carriage return, U+0020-U+D7FF, U+E000-U+FFFD and U+10000-U+10FFFF. This excludes NUL and the other C0
 * control characters, the surrogates (which are not characters on their own), U+FFFE and U+FFFF, and
 * anything above U+10FFFF (for which String.fromCodePoint would throw a RangeError).
 */
const isXmlChar = (c: number) =>
    c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);

/**
 * Replaces entity and character references by the characters they stand for: the five predefined named
 * entities and decimal (`&#65;`) or hexadecimal (`&#x41;`) character references. Unknown named entities
 * (for example ones declared in a DTD) are left unchanged.
 *
 * A character reference to a code point that XML does not allow (see `isXmlChar`: `&#0;`, a surrogate such as
 * `&#xD800;`, or a value above U+10FFFF such as `&#x110000;`) makes the document malformed, so it is reported
 * through `invalid` rather than replaced or kept: keeping it as text would hide the error, and decoding it is
 * impossible or would produce a string that is not valid text.
 *
 * @param s Text or attribute value as written in the document.
 * @param invalid Called with the offending reference and its offset in `s`; it must throw. By default it
 *   throws `Error('invalid character reference <ref>')`; `parseXml` passes one that reports the line.
 */
export function decodeEntities(
    s: string,
    invalid: (ref: string, offset: number) => never = ref => {
        throw new Error(`invalid character reference ${ref}`);
    }
): string {
    // &( #x[0-9a-f]+ | #\d+ | \w+ );  hexadecimal reference, decimal reference or a name, case-insensitively
    // (so `&#X41;` is accepted too). The capture `e` is the part between `&` and `;`, `offset` where `m` starts.
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string, offset: number) => {
        if (e[0] === '#') {
            // The pattern guarantees digits, so parseInt always gives a number; a very long reference gives a
            // huge value (or Infinity), which fails the range test of isXmlChar.
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return isXmlChar(code) ? String.fromCodePoint(code) : invalid(m, offset);
        }
        return ENTITIES[e] ?? m;
    });
}

/**
 * Escapes text for use in XML content or in a double-quoted attribute value: `&`, `<`, `>` and `"`.
 * `&` is replaced first so that the entities produced by the later replacements are not escaped again.
 * Apostrophes are left alone because the exporter always quotes attributes with double quotes.
 */
export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Parses an XML document and returns its root element. Throws on malformed input.
 *
 * The parser is a single forward scan with a cursor `i` and a stack of open elements: at each position it
 * recognises a comment, CDATA section, processing instruction, declaration, end tag, start tag or a run of
 * text, consumes it and moves on. Elements are attached to their parent as soon as their start tag is read,
 * and their namespaces are resolved at that point too (all declarations they depend on have been read).
 *
 * @param source The complete document text.
 * @returns The root element with its whole subtree.
 * @throws Error `XML line <n>: <message>` for malformed input or a document without a root element.
 */
export function parseXml(source: string): XmlElement {
    let i = 0;
    // Throws with the line of position `at` (by default the current position); typed `never` so it can end a
    // branch.
    const fail = (message: string, at = i): never => {
        const line = source.slice(0, at).split('\n').length;
        throw new Error(`XML line ${line}: ${message}`);
    };
    // Decodes the references in `text`, which starts at offset `at` of the source, reporting an invalid
    // character reference with the line it is on.
    const decode = (text: string, at: number) => decodeEntities(text, (ref, offset) => fail(`invalid character reference ${ref}`, at + offset));
    // Skips a construct that starts at `i` with `open` and ends with the next `close`; its content is ignored.
    const skip = (open: string, close: string) => {
        const end = source.indexOf(close, i + open.length);
        if (end < 0) {
            fail(`unterminated ${open}`);
        }
        i = end + close.length;
    };
    // Skips a `<!...>` declaration such as <!DOCTYPE>. Its end is the first `>` that is neither inside a quoted
    // literal (`SYSTEM "a>b.dtd"`) nor inside the internal subset `[ ... ]`, which holds declarations with
    // their own `>` (`<!ENTITY x "y">`) and possibly comments, whose text may contain `"`, `'`, `[` or `]`.
    const skipDeclaration = () => {
        let depth = 0; // nesting of `[`: 1 inside the internal subset
        for (let j = i + 2; j < source.length; j++) {
            const ch = source[j];
            if (ch === '"' || ch === "'") {
                // A quoted literal: continue after its closing quote.
                const end = source.indexOf(ch, j + 1);
                if (end < 0) {
                    break;
                }
                j = end;
            } else if (depth > 0 && source.startsWith('<!--', j)) {
                // A comment in the internal subset: continue after its `-->`.
                const end = source.indexOf('-->', j + 4);
                if (end < 0) {
                    break;
                }
                j = end + 2;
            } else if (ch === '[') {
                depth++;
            } else if (ch === ']') {
                depth--;
            } else if (ch === '>' && depth <= 0) {
                i = j + 1;
                return;
            }
        }
        fail('unterminated <!');
    };
    // Elements whose start tag has been read but not their end tag; the last one receives children and text.
    const stack: XmlElement[] = [];
    // Namespace bindings in scope (prefix -> URI, '' for the default namespace): one map per open element, in
    // step with `stack`, above the document level at the bottom. A start tag with declarations gets a copy of
    // the enclosing map extended with them; other elements share the enclosing map.
    const scopes: Record<string, string>[] = [{ xml: XML_NS }];
    let root: XmlElement | undefined;
    while (i < source.length) {
        // The order of the tests matters: the more specific `<!--`, `<![CDATA[`, `<?` and `<!` prefixes must be
        // recognised before the generic `<` of a start tag.
        if (source.startsWith('<!--', i)) {
            skip('<!--', '-->');
        } else if (source.startsWith('<![CDATA[', i)) {
            const end = source.indexOf(']]>', i);
            if (end < 0) {
                fail('unterminated CDATA section');
            }
            // CDATA content is literal text (no entity decoding); 9 is the length of `<![CDATA[`. CDATA outside
            // the root element is silently ignored.
            if (stack.length) {
                stack[stack.length - 1].text += source.slice(i + 9, end);
            }
            i = end + 3;
        } else if (source.startsWith('<?', i)) {
            // Processing instruction or the XML declaration.
            skip('<?', '?>');
        } else if (source.startsWith('<!', i)) {
            // <!DOCTYPE ...> (with or without an internal subset) and similar declarations.
            skipDeclaration();
        } else if (source.startsWith('</', i)) {
            // End tag: it must close the innermost open element, with exactly the same (prefixed) name.
            // <\/([\w:.-]+)\s*>  `</`, group 1 the name (the characters of a start tag name), optional
            // whitespace, `>`; the sticky flag `y` anchors the match at `lastIndex` = i.
            const endTag = /<\/([\w:.-]+)\s*>/y;
            endTag.lastIndex = i;
            const m = endTag.exec(source);
            if (!m) {
                // Without any further `>` the tag runs to the end of the document; otherwise something other
                // than a name stands between `</` and the `>` (such as another tag that starts first).
                fail(source.indexOf('>', i) < 0 ? 'unterminated end tag' : 'malformed end tag');
            }
            const name = m![1];
            const open = stack.pop();
            if (!open || open.name !== name) {
                fail(`unexpected </${name}>`);
            }
            scopes.pop();
            i += m![0].length;
        } else if (source[i] === '<') {
            // Start tag or empty-element tag, matched against the rest of the document:
            // <([\w:.-]+)                       group 1: element name (letters, digits, _, :, ., -)
            // ((?:\s+[\w:.-]+\s*=\s*            group 2: all attributes, each `name = value` after whitespace,
            //    (?:"[^"]*"|'[^']*'))*)          with the value in double or single quotes (unquoted values or
            //                                    attributes without a value make the tag malformed)
            // \s*(\/?)>                          group 3: `/` for an empty-element tag `<x/>`, then the `>`
            const tag = /^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(source.slice(i));
            if (!tag) {
                fail('malformed tag');
            }
            // `fail` returns never, but TypeScript does not narrow `tag` after a call, hence the `!` below.
            const element: XmlElement = { name: tag![1], namespace: '', attrs: {}, nsAttrs: [], children: [], text: '' };
            // Splits group 2 into single attributes: group 1 name, group 2 a double-quoted value or group 3 a
            // single-quoted value (the quotes are not part of either group). The source offset of the value,
            // for error messages, is the tag start + 1 (`<`) + the element name + the attribute's index in
            // group 2 + the part of its match before the value (all of it except the value and closing quote).
            for (const a of tag![2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
                const raw = a[2] ?? a[3] ?? '';
                element.attrs[a[1]] = decode(raw, i + 1 + tag![1].length + a.index! + a[0].length - raw.length - 1);
            }
            // Namespace declarations come first: they apply to the element's own name and attributes as well as
            // to its descendants. They go into a copy of the enclosing bindings, so that they end with the
            // element. An empty URI removes a binding (`xmlns=""` returns to no default namespace).
            const outer = scopes[scopes.length - 1];
            let ns = outer;
            for (const [k, v] of Object.entries(element.attrs)) {
                if (k === 'xmlns' || k.startsWith('xmlns:')) {
                    if (ns === outer) {
                        ns = { ...outer };
                    }
                    // 6 is the length of `xmlns:`.
                    const prefix = k === 'xmlns' ? '' : k.slice(6);
                    if (v) {
                        ns[prefix] = v;
                    } else {
                        delete ns[prefix];
                    }
                }
            }
            // The namespace URI of an element or attribute name: the URI bound to its prefix (which must be
            // declared), else the default namespace for an element and no namespace ('') for an attribute.
            const resolve = (qname: string, isAttribute: boolean): string => {
                const colon = qname.indexOf(':');
                if (colon < 0) {
                    return isAttribute ? '' : ns[''] ?? '';
                }
                const prefix = qname.slice(0, colon);
                if (!Object.prototype.hasOwnProperty.call(ns, prefix)) {
                    fail(`undeclared namespace prefix '${prefix}' in '${qname}'`);
                }
                return ns[prefix];
            };
            element.namespace = resolve(element.name, false);
            for (const [k, v] of Object.entries(element.attrs)) {
                if (k !== 'xmlns' && !k.startsWith('xmlns:')) {
                    element.nsAttrs.push({ uri: resolve(k, true), local: localName(k), value: v });
                }
            }
            if (stack.length) {
                stack[stack.length - 1].children.push(element);
            } else if (root) {
                fail('more than one root element');
            } else {
                root = element;
            }
            // Only a start tag (not `<x/>`) opens an element that later content belongs to; its bindings stay
            // in scope until its end tag.
            if (!tag![3]) {
                stack.push(element);
                scopes.push(ns);
            }
            i += tag![0].length;
        } else {
            // Character data up to the next `<` (or the end of the document).
            const end = source.indexOf('<', i);
            const text = source.slice(i, end < 0 ? source.length : end);
            if (stack.length) {
                stack[stack.length - 1].text += decode(text, i);
            } else if (text.trim()) {
                // Whitespace before or after the root element is allowed; anything else is not.
                fail('text outside the root element');
            }
            i = end < 0 ? source.length : end;
        }
    }
    if (stack.length) {
        fail(`<${stack[stack.length - 1].name}> is not closed`);
    }
    if (!root) {
        fail('no root element');
    }
    return root!;
}

/**
 * Local name of a possibly prefixed element or attribute name: `machina:kind` gives `kind`. A name without a
 * prefix is returned unchanged (indexOf gives -1, so the slice starts at 0).
 */
export const localName = (name: string) => name.slice(name.indexOf(':') + 1);

/**
 * The value of the attribute of `e` in namespace `uri` with local name `local`, whatever prefix the document
 * binds to that namespace; undefined when there is none. With '' as `uri` it finds an unprefixed attribute.
 */
export const attrNS = (e: XmlElement, uri: string, local: string): string | undefined => e.nsAttrs.find(a => a.uri === uri && a.local === local)?.value;
