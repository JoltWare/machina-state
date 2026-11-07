// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0
//
// Line-oriented source writer shared by all code generators (C, C++ and C#).
//
// The generators never build output with ad-hoc string concatenation of indentation: they emit one logical
// line at a time and describe the block structure with open()/close(), and the writer takes care of
// indentation (four spaces per level) and of the brace style. Two brace styles are supported:
//
//   K&R / 1TBS (allman = false, used for C and C++)    Allman (allman = true, used for C#)
//
//       if (x) {                                           if (x)
//           y();                                           {
//       }                                                      y();
//                                                          }
//
// The writer keeps no knowledge of the target language beyond that; in particular it does not escape or
// validate anything. Empty lines are emitted without trailing whitespace, which keeps the generated files
// (and the golden files they are compared against in the tests) clean.

/** Accumulates generated source lines with automatic indentation and a configurable brace style. */
export class Writer {
    /** Finished output lines, already indented. */
    private readonly lines: string[] = [];
    /** Current indentation depth in levels of four spaces. */
    private level = 0;

    /**
     * @param allman true to put opening braces on their own line (Allman style, used for C#); false to put
     *     them at the end of the head line (K&R style, used for C and C++).
     */
    constructor(private readonly allman: boolean) {}

    /**
     * Appends one line at the current indentation. An empty `text` produces a truly empty line (no
     * indentation), so blank separator lines never carry trailing whitespace.
     */
    line(text = ''): void {
        this.lines.push(text ? '    '.repeat(this.level) + text : '');
    }

    /**
     * Access specifier line (C++), outdented by two spaces relative to members.
     *
     * Inside a class body opened with open(), members are one level (four spaces) deeper than the class head;
     * `public:` / `protected:` / `private:` are placed halfway in between, i.e. one level less plus two
     * spaces, which is the common clang-format layout (`AccessModifierOffset: -2`):
     *
     *     class Foo {
     *       public:
     *         void Bar();
     *     };
     */
    label(text: string): void {
        // Math.max guards against a label written at the outermost level, which would otherwise produce a
        // negative repeat count (a RangeError).
        this.lines.push('    '.repeat(Math.max(0, this.level - 1)) + '  ' + text);
    }

    /**
     * Opens a block: writes `head` followed by an opening brace (on the same line in K&R style, on the next
     * line in Allman style) and increases the indentation. `head` is the statement or declaration that owns
     * the block, e.g. `if (x)`, `class Foo` or `case Event::Coin:` (the latter gives a braced case scope for
     * local variables). Every open() must be balanced by a close().
     */
    open(head: string): void {
        if (this.allman) {
            this.line(head);
            this.line('{');
        } else {
            this.line(`${head} {`);
        }
        this.level++;
    }

    /**
     * Closes the innermost block opened with open(): decreases the indentation and writes `tail`, which is
     * `}` by default. Pass `};` for class, struct, enum and array-initialiser blocks, which need the
     * terminating semicolon.
     */
    close(tail = '}'): void {
        this.level--;
        this.line(tail);
    }

    /**
     * Closes the innermost block and opens its continuation, e.g. `else` or `else if (x)`: `} else {` in K&R
     * style, `}` / `else` / `{` on separate lines in Allman style. The indentation level is unchanged.
     */
    chain(head: string): void {
        this.level--;
        if (this.allman) {
            this.line('}');
            this.line(head);
            this.line('{');
        } else {
            this.line(`} ${head} {`);
        }
        this.level++;
    }

    /**
     * Removes the last line if it is empty, e.g. the blank separator a member emitter left before a closing
     * brace.
     */
    trimBlank(): void {
        if (this.lines.length > 0 && this.lines[this.lines.length - 1] === '') {
            this.lines.pop();
        }
    }

    /**
     * Increases the indentation without writing a brace, e.g. for the statements below a `case` label or
     * for a brace-less `if` body. Must be balanced by dedent().
     */
    indent(): void {
        this.level++;
    }

    /** Decreases the indentation without writing a brace; the counterpart of indent(). */
    dedent(): void {
        this.level--;
    }

    /** The complete output: all lines joined with `\n`, terminated by a final newline (LF line endings). */
    toString(): string {
        return this.lines.join('\n') + '\n';
    }
}
