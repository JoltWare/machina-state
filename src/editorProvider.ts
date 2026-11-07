// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// The custom diagram editor for *.machina files (a CustomTextEditorProvider registered in extension.ts).
//
// Model: the .machina file is an ordinary VS Code TextDocument holding the diagram as JSON. The webview
// (media/editor.js, plus media/machina.js with the shared model and engine used for validation and
// simulation; see scripts/bundle-webview.js) is only a view of that document. Because the TextDocument
// stays the source of truth, VS Code itself provides saving, the dirty marker, hot exit, undo/redo and
// "Reopen Editor With... > Text Editor", and a diagram editor and a text editor on the same file stay
// consistent with each other.
//
// Synchronisation:
//   webview → document: after each user action the webview serialises the whole diagram and posts it as an
//     `edit` message; replaceDocument applies it as one WorkspaceEdit replacing the entire text, so every
//     webview action becomes exactly one undo step on the document's normal undo stack.
//   document → webview: every content change to the document (the webview's own edit, typing in a text
//     editor, undo/redo, auto-layout, revert, …) fires onDidChangeTextDocument, and sendUpdate posts the
//     full text plus fresh validation results. The webview ignores an `update` whose text equals what it
//     last sent or received, so the echo of its own edit is harmless.
//
// Webview message protocol (plain objects with a `type` field):
//   extension → webview
//     { type: 'update', text }                 full document text to (re)render
//     { type: 'validation', issues }           Issue[] from analyze(), or one "Invalid JSON" issue
//   webview → extension
//     { type: 'ready' }                        script loaded; requests the initial update/validation
//     { type: 'edit', text }                   replace the document text
//     { type: 'autoLayout' }                   run the automatic layout on the document (layout.ts)
//     { type: 'generate', language, style }    generate code with the toolbar's choices (codegen.ts)
//     { type: 'exportPng', name, data }        save `data`, a base64 PNG data: URL, as an image file
//     { type: 'exportSvg', name, data }        save `data`, SVG text starting with an XML declaration
//     { type: 'openManual' }                   open the user manual (help overlay; command in extension.ts)
//     { type: 'getStarted' }                   open the Get Started walkthrough (help overlay)
// Message fields are checked before use; malformed or unknown messages are ignored. Messages from one webview
// are handled one at a time, in the order they were posted (see resolveCustomTextEditor).
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { generateForDocument } from './codegen';
import { isLanguage, isStyle } from './hostUtil';
import { autoLayout } from './layout';
import { analyze, Issue, parseDiagram } from './model';

/** Prefix of the data: URL the webview produces with canvas.toDataURL('image/png'); the rest is base64. */
const PNG_PREFIX = 'data:image/png;base64,';

/**
 * Replaces the whole text of a diagram document (one undoable edit).
 *
 * Nothing is done when the text is unchanged, so no empty undo step is recorded and the document does not
 * become dirty. The comparison normalises CRLF to LF because the webview always produces LF text (from
 * JSON.stringify) while a file on disk may use CRLF; when the edit is applied, VS Code converts the
 * inserted line breaks to the document's own end-of-line sequence.
 *
 * The edit is applied through a WorkspaceEdit rather than written to disk, so it goes through the
 * TextDocument: it marks the document dirty, lands on the undo stack, and notifies every listener
 * (including the webview's own onDidChangeTextDocument subscription and diagnostics.ts).
 *
 * @param document The diagram document to change.
 * @param text     The complete new text.
 */
export async function replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
    if (document.getText().replace(/\r\n/g, '\n') === text) {
        return;
    }
    const edit = new vscode.WorkspaceEdit();
    // Line `lineCount` is past the last line; VS Code clamps the range to the end of the document, so this
    // range covers the entire text.
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
}

/**
 * Rearranges a diagram with the automatic layout.
 *
 * Used by the `machinaState.autoLayout` command and the webview's `autoLayout` message. The new positions,
 * sizes and transition bends are written back as a single undoable edit, so the layout can be reverted
 * with Undo.
 *
 * The text is first checked with parseDiagram, which rejects what is not a diagram at all (invalid JSON, or
 * not a JSON object). The object that is laid out and re-serialised is then the document's own JSON (from
 * JSON.parse), so all of its properties are kept (parseDiagram builds a copy containing only the known
 * top-level fields). A diagram without states (`states` missing, not an array or empty) only gets an
 * information message. A `transitions` member that is missing or not an array is laid out as an empty list
 * but written back unchanged. Malformed elements inside the arrays (which only `analyze` reports) can still
 * make the layout fail; that is reported as an error notification rather than thrown.
 *
 * @param document The diagram document to lay out; an error notification is shown if it is not a diagram,
 *                 and an information message if it has no states.
 */
export async function layoutDocument(document: vscode.TextDocument): Promise<void> {
    const text = document.getText();
    let raw;
    try {
        parseDiagram(text);
        // Empty text is an empty diagram for parseDiagram; there is nothing to lay out then.
        raw = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
        vscode.window.showErrorMessage(`MachinaState: cannot parse diagram: ${(err as Error).message}`);
        return;
    }
    if (!Array.isArray(raw.states) || raw.states.length === 0) {
        vscode.window.showInformationMessage('MachinaState: the diagram has no states to lay out.');
        return;
    }
    // A shallow copy with valid arrays: autoLayout mutates the state and transition objects themselves,
    // which are shared with `raw`, so serialising `raw` afterwards writes the new geometry.
    try {
        await autoLayout({ ...raw, transitions: Array.isArray(raw.transitions) ? raw.transitions : [] });
    } catch (err) {
        vscode.window.showErrorMessage(`MachinaState: cannot lay out diagram: ${(err as Error).message}`);
        return;
    }
    await replaceDocument(document, JSON.stringify(raw, null, 2));
}

/**
 * Provides the diagram editor for .machina files. VS Code calls `resolveCustomTextEditor` once for every
 * editor tab it opens with this view type; each tab gets its own webview panel, while the TextDocument is
 * shared by all editors showing the same file.
 */
export class MachinaEditorProvider implements vscode.CustomTextEditorProvider {
    /** Custom editor id; must match "contributes.customEditors[].viewType" in package.json. */
    static readonly viewType = 'machinaState.editor';

    /** Document of the diagram editor that is currently the active editor, if any (see `active`). */
    private activeDocument?: vscode.TextDocument;

    /** @param context Extension context, used to locate the media/ folder inside the installed extension. */
    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * The document shown in the active diagram editor, or undefined if no diagram editor is active. Lets
     * commands run from the command palette or editor title bar find the diagram (custom editors do not
     * appear as `vscode.window.activeTextEditor`).
     */
    get active(): vscode.TextDocument | undefined {
        return this.activeDocument;
    }

    /**
     * Sets up one diagram editor: configures and fills the webview, wires document changes to the webview
     * and webview messages to the document, and tracks whether this editor is the active one.
     *
     * Lifetime: the document change subscription is global, so it is disposed explicitly when the panel is
     * closed. The view state, dispose and message listeners belong to the panel and its webview and go away
     * with them.
     *
     * @param document The diagram's TextDocument (the source of truth).
     * @param panel    The webview panel VS Code created for this editor tab.
     */
    resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        // Scripts are needed for the editor; localResourceRoots limits what the webview may load from the
        // extension to the media/ folder (editor.js, machina.js, editor.css).
        const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
        panel.webview.html = this.getHtml(panel.webview, mediaRoot);

        // Pushes the current document text and its validation result to the webview. Validation runs here,
        // in the extension, so the webview's issue list matches the Problems panel. A message posted before
        // the webview script is listening may be lost, which is why the first update waits for `ready`.
        const sendUpdate = () => {
            const text = document.getText();
            let issues: Issue[];
            try {
                issues = analyze(parseDiagram(text)).issues;
            } catch (err) {
                issues = [{ message: `Invalid JSON: ${(err as Error).message}` }];
            }
            panel.webview.postMessage({ type: 'update', text });
            panel.webview.postMessage({ type: 'validation', issues });
        };

        // Keep the webview in sync with the document. The event fires for every document in the workspace,
        // so filter on this document's Uri; events without content changes (e.g. only the dirty state
        // changed) need no re-render.
        const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length > 0) {
                sendUpdate();
            }
        });
        // Track the active diagram editor for `active`: set it when this panel becomes active, and clear it
        // only if it still points at this document when the panel loses focus or is closed (another
        // diagram's panel may already have taken over).
        if (panel.active) {
            this.activeDocument = document;
        }
        panel.onDidChangeViewState(() => {
            if (panel.active) {
                this.activeDocument = document;
            } else if (this.activeDocument === document) {
                this.activeDocument = undefined;
            }
        });
        panel.onDidDispose(() => {
            changeSub.dispose();
            if (this.activeDocument === document) {
                this.activeDocument = undefined;
            }
        });

        // Messages from the webview (protocol listed at the top of this file). Each field is checked before
        // use; anything malformed or unknown is ignored.
        //
        // Messages are handled strictly one after another, in arrival order: VS Code does not wait for an
        // async listener, so without the queue a `generate` posted right after an `edit` could read the
        // document before the edit has been applied (and two edits could interleave). Each message is
        // chained onto `queue`; a failing handler is reported and does not stop the messages after it. A
        // handler that waits for the user (the folder picker of `generate`, the save dialog of an export)
        // holds back the messages after it until the dialog is closed; they are then applied in order.
        let queue: Promise<void> = Promise.resolve();
        panel.webview.onDidReceiveMessage(msg => {
            queue = queue.then(() => this.handleMessage(document, msg, sendUpdate)).catch(err => {
                vscode.window.showErrorMessage(`MachinaState: ${(err as Error)?.message ?? err}`);
            });
        });
    }

    /**
     * Handles one message from a diagram editor's webview; called through the per-panel queue in
     * resolveCustomTextEditor, so the returned promise settles before the next message is handled.
     *
     * @param document   The diagram document of the panel the message came from.
     * @param msg        The message, untrusted (checked field by field).
     * @param sendUpdate Posts the document text and validation result to that panel's webview.
     */
    private async handleMessage(document: vscode.TextDocument, msg: any, sendUpdate: () => void): Promise<void> {
        switch (msg?.type) {
            case 'ready':
                // Posted by editor.js once its message listener is installed: send the initial content.
                sendUpdate();
                break;
            case 'edit':
                // One user action in the diagram → one undoable whole-document replacement.
                if (typeof msg.text === 'string') {
                    await replaceDocument(document, msg.text);
                }
                break;
            case 'autoLayout':
                await layoutDocument(document);
                break;
            case 'generate':
                // Only the known language/style values are accepted; generateForDocument then skips its
                // quick picks. The other options (trace, thread-safe, queue) are read from the diagram,
                // where the webview has already stored them with an `edit`; the message queue guarantees
                // that this edit has been applied before the document is read here.
                if (isLanguage(msg.language) && isStyle(msg.style)) {
                    await generateForDocument(document, msg.language, msg.style);
                }
                break;
            case 'exportPng':
                // Decode the base64 payload of the data: URL into the binary PNG.
                if (typeof msg.data === 'string' && msg.data.startsWith(PNG_PREFIX)) {
                    await this.saveExport(document, msg.name, 'png', Buffer.from(msg.data.slice(PNG_PREFIX.length), 'base64'));
                }
                break;
            case 'exportSvg':
                if (typeof msg.data === 'string' && msg.data.startsWith('<?xml')) {
                    await this.saveExport(document, msg.name, 'svg', Buffer.from(msg.data, 'utf8'));
                }
                break;
            case 'openManual':
                await vscode.commands.executeCommand('machinaState.openManual');
                break;
            case 'getStarted':
                await vscode.commands.executeCommand('machinaState.getStarted');
                break;
        }
    }

    /**
     * Asks where to save an exported image and writes it. The default location is next to the diagram (no
     * default for untitled documents); a status bar message confirms the export for five seconds.
     *
     * @param document  The diagram the image was rendered from.
     * @param name      Suggested base file name from the webview (the diagram name). Untrusted: every
     *                  character other than letters, digits, `_`, `.` and `-` is replaced by `_`, and
     *                  `diagram` is used if it is missing or empty.
     * @param extension File type, used for the default file name and the dialog filter.
     * @param data      The file content.
     */
    private async saveExport(document: vscode.TextDocument, name: unknown, extension: 'png' | 'svg', data: Buffer): Promise<void> {
        const base = typeof name === 'string' ? name.replace(/[^\w.-]/g, '_') : '';
        const fileName = `${base || 'diagram'}.${extension}`;
        const target = await vscode.window.showSaveDialog({
            defaultUri: document.isUntitled ? undefined : vscode.Uri.joinPath(document.uri, '..', fileName),
            filters: extension === 'png' ? { 'PNG image': ['png'] } : { 'SVG image': ['svg'] }
        });
        if (!target) {
            return;
        }
        await vscode.workspace.fs.writeFile(target, data);
        vscode.window.setStatusBarMessage(`MachinaState: exported ${vscode.workspace.asRelativePath(target)}`, 5000);
    }

    /**
     * Builds the webview's HTML: the toolbar (tools, layout/fit/export/simulate buttons, code generation
     * options), the SVG canvas with its arrowhead marker, the side panel for properties and issues, and a
     * hidden box for JSON parse errors. All behaviour is attached by media/editor.js, which looks these
     * elements up by id.
     *
     * Content Security Policy (in the <meta> tag):
     * - `default-src 'none'` blocks everything not explicitly allowed (network requests, fonts, frames, …);
     * - `img-src data:` permits only data: URL images (PNG export draws the diagram, serialised as a
     *   data:image/svg+xml image, onto a canvas);
     * - `style-src ${webview.cspSource}` permits only stylesheets served from the extension's resources
     *   (editor.css); inline <style> blocks and style attributes in markup are not allowed;
     * - `script-src 'nonce-…'` runs only the two <script> tags carrying this page's random nonce, so inline
     *   scripts, inline event handlers and injected scripts are rejected.
     * machina.js (window.Machina: model and engine) is loaded before editor.js, which uses it.
     *
     * @param webview   Used to convert file Uris into webview resource Uris and to get the CSP source.
     * @param mediaRoot The extension's media/ folder.
     * @returns The complete HTML document.
     */
    private getHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
        // Webviews cannot load file: Uris directly; asWebviewUri maps them to the webview resource scheme.
        const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.js'));
        const runtime = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'machina.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.css'));
        // A fresh nonce for every webview, referenced by the CSP and the script tags: 128 bits from the
        // cryptographic random generator as 32 hex characters (Math.random is not unpredictable enough).
        const nonce = randomBytes(16).toString('hex');
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>State Machine</title>
</head>
<body>
<div id="toolbar">
  <div class="group" id="tools">
    <button data-mode="select" title="Select, move and resize (Esc)">Select</button>
    <button data-mode="state" title="Add a state (click on canvas; click inside a state to nest it)">State</button>
    <button data-mode="region" title="Add an orthogonal region inside a state (a state with two or more regions runs them in parallel)">Region</button>
    <button data-mode="initial" title="Add an initial pseudostate">Initial</button>
    <button data-mode="final" title="Add a final state">Final</button>
    <button data-mode="history" title="Add a history pseudostate inside a composite state">History</button>
    <button data-mode="choice" title="Add a choice point (branches on guards)">Choice</button>
    <button data-mode="transition" title="Add a transition (drag from source to target)">Transition</button>
    <button id="btn-delete" title="Delete selection (Del)">Delete</button>
  </div>
  <div class="group">
    <button id="btn-snap" title="Snap positions and sizes to a 10-pixel grid">Snap</button>
    <button id="btn-layout" title="Arrange all states automatically (undo with Ctrl+Z)">Layout</button>
    <button id="btn-fit" title="Fit diagram to view">Fit</button>
    <button id="btn-png" title="Export the diagram as a PNG image">PNG</button>
    <button id="btn-svg" title="Export the diagram as an SVG image">SVG</button>
    <button id="btn-sim" title="Start / stop simulation">Simulate</button>
  </div>
  <div class="group">
    <select id="sel-lang" title="Target language">
      <option value="cpp">C++</option>
      <option value="csharp">C#</option>
      <option value="c">C</option>
    </select>
    <select id="sel-style" title="Implementation style">
      <option value="switch">Switch-based</option>
      <option value="table">Table-based</option>
    </select>
    <label class="check" title="Generate a virtual Trace(kind, name) method that is called for every event, transition, exit and entry">
      <input type="checkbox" id="chk-trace"> Trace
    </label>
    <label class="check" title="Guard every public member with abstract Lock()/Unlock() hooks that you implement (e.g. with a mutex)">
      <input type="checkbox" id="chk-threadsafe"> Thread-safe
    </label>
    <label class="check" title="Generate Post() so hooks can queue events that are processed after the current one">
      <input type="checkbox" id="chk-queue"> Queue
    </label>
    <button id="btn-gen">Generate Code</button>
  </div>
  <div class="group" id="help-group">
    <button id="btn-help" title="Shortcuts, notation and the user manual (?)" aria-haspopup="dialog">?</button>
  </div>
</div>
<div id="main">
  <svg id="canvas" tabindex="0">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z"></path>
      </marker>
    </defs>
    <g id="viewport"></g>
  </svg>
  <div id="side">
    <div id="panel"></div>
    <div id="issues"></div>
  </div>
</div>
<div id="parse-error" hidden></div>
<script nonce="${nonce}" src="${runtime}"></script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}
