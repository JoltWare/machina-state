// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Problems-panel integration and generate-on-save for .machina documents.
//
// Every open .machina TextDocument is validated with the same parseDiagram + analyze pipeline that code
// generation uses, and the resulting issues are published to a DiagnosticCollection, so problems are listed
// in the Problems panel whether the file is open in the diagram editor or as plain JSON text. (The diagram
// editor additionally shows the same issues in its own side panel; see editorProvider.ts.)
//
// Update triggers:
//   - documents already open at activation, and each newly opened document → validated immediately;
//   - every text change of a .machina document → validated after a 250 ms debounce per document, so typing
//     in the text editor or a burst of edits from the webview causes one analysis rather than many (changes
//     to other documents start no timer at all);
//   - closing a document → its pending timer is cancelled and its diagnostics are removed, so a timer
//     started by a last-moment edit cannot publish them again for the closed file;
//   - saving → if the `machinaState.generateOnSave` setting is enabled, code is regenerated silently
//     (codegen.ts). The setting is read for the document's own Uri at save time, so folder-level settings
//     in a multi-root workspace apply and changes take effect without reloading.
import * as vscode from 'vscode';
import { generateSilently } from './codegen';
import { ElementList, jsonErrorOffset, locateElement, locateTopLevelKey, TextSpan } from './hostUtil';
import { analyze, isError, Issue, parseDiagram } from './model';

/**
 * True for documents this module handles. Decided by file extension, since package.json maps .machina
 * files to the json language id.
 */
const isDiagram = (doc: vscode.TextDocument) => doc.uri.path.endsWith('.machina');

/**
 * Publishes validation problems of .machina files to the Problems panel and regenerates code on save if
 * enabled.
 *
 * The collection and all event listeners are added to `context.subscriptions`, so they are disposed (and the
 * diagnostics cleared) when the extension is deactivated.
 *
 * @param context Extension context whose subscriptions own the created resources.
 */
export function registerDiagnostics(context: vscode.ExtensionContext): void {
    const collection = vscode.languages.createDiagnosticCollection('machinaState');
    // Running debounce timers, keyed by document Uri string. An entry exists only while its timer is
    // pending: the timer removes it when it fires, closing the document cancels and removes it, and
    // disposal cancels all of them.
    const pending = new Map<string, ReturnType<typeof setTimeout>>();

    /** Cancels the pending debounce timer of the document with Uri string `key`, if any. */
    const cancel = (key: string) => {
        clearTimeout(pending.get(key));
        pending.delete(key);
    };
    /** Re-validates `doc` now and replaces its diagnostics; ignores non-diagram and closed documents. */
    const update = (doc: vscode.TextDocument) => {
        if (!isDiagram(doc) || doc.isClosed) {
            return;
        }
        collection.set(doc.uri, diagnosticsFor(doc));
    };
    /**
     * Restarts the 250 ms debounce timer for a diagram document; only the last change in a burst triggers
     * an update. Changes to other documents are ignored here, so they do not create timers.
     */
    const schedule = (doc: vscode.TextDocument) => {
        if (!isDiagram(doc)) {
            return;
        }
        const key = doc.uri.toString();
        cancel(key);
        pending.set(
            key,
            setTimeout(() => {
                pending.delete(key);
                update(doc);
            }, 250)
        );
    };

    // Documents opened before activation produce no open event, so validate them up front.
    vscode.workspace.textDocuments.forEach(update);
    context.subscriptions.push(
        collection,
        // Disposed with the extension: no timer may fire into the disposed collection.
        { dispose: () => [...pending.keys()].forEach(cancel) },
        vscode.workspace.onDidOpenTextDocument(update),
        vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => {
            cancel(doc.uri.toString());
            collection.delete(doc.uri);
        }),
        vscode.workspace.onDidSaveTextDocument(async doc => {
            if (isDiagram(doc) && vscode.workspace.getConfiguration('machinaState', doc.uri).get<boolean>('generateOnSave', false)) {
                await generateSilently(doc);
            }
        })
    );
}

/**
 * Validates a diagram document and converts the issues into VS Code diagnostics (errors and warnings, with source
 * `MachinaState`).
 *
 * Text that is not a valid diagram (bad JSON, or not a JSON object) yields a single diagnostic, placed at
 * the position named in the JSON.parse error if there is one, otherwise at the start of the file. Each
 * analysis issue is placed by `issueSpan`.
 *
 * @param doc The .machina document to check.
 * @returns The diagnostics to publish for `doc` (empty if it is valid).
 */
function diagnosticsFor(doc: vscode.TextDocument): vscode.Diagnostic[] {
    const text = doc.getText();
    const toRange = (span: TextSpan) => new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));
    const error = (range: vscode.Range, message: string, severity = vscode.DiagnosticSeverity.Error) => {
        const diagnostic = new vscode.Diagnostic(range, message, severity);
        diagnostic.source = 'MachinaState';
        return diagnostic;
    };
    let issues: Issue[];
    try {
        issues = analyze(parseDiagram(text)).issues;
    } catch (err) {
        const message = (err as Error).message;
        const offset = jsonErrorOffset(message, text.length) ?? 0;
        return [error(toRange({ start: offset, end: offset }), `Invalid diagram: ${message}`)];
    }
    // Warnings (issue.severity 'warning', e.g. an unused choice point) do not block code generation, so they
    // are shown as warnings; everything else is an error.
    return issues.map(issue =>
        error(
            toRange(issueSpan(text, issue)),
            issue.message,
            isError(issue) ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
        )
    );
}

/**
 * Where an issue is shown in the document text.
 *
 * - An issue with an id (`issue.id` non-empty) is placed on the `"id": "<id>"` property of that element,
 *   located structurally by locateElement. If the issue names the kind of element (an optional `element`
 *   field, 'state' or 'transition'), that array is searched first; otherwise states come first.
 * - An issue whose id matches no element (e.g. a synthetic region id), and an issue without any id (null,
 *   undefined or empty; such as a missing top-level initial pseudostate, or the machine name), is placed
 *   on the top-level `"states"` key if there is one, otherwise at the start of the file.
 *
 * @param text  The document text; it has already been parsed successfully.
 * @param issue The issue to place.
 */
function issueSpan(text: string, issue: Issue): TextSpan {
    // `element` is not (yet) part of the model's Issue type; read it defensively so that it is used if the
    // analyser provides it.
    const element = (issue as Issue & { element?: unknown }).element;
    const prefer: ElementList | undefined = element === 'transition' ? 'transitions' : element === 'state' ? 'states' : undefined;
    const id = typeof issue.id === 'string' && issue.id ? issue.id : undefined;
    return (id && locateElement(text, id, prefer)) || locateTopLevelKey(text, 'states') || { start: 0, end: 0 };
}
