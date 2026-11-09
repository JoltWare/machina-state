// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Extension entry point. VS Code loads out/extension.js (package.json "main") and calls `activate` when a
// workspace contains a *.machina file (the declared activation event) or, through the activation events
// VS Code derives from the contributions, when a contributed command is run or the custom editor is opened.
//
// How the pieces fit together:
//
//   activate()
//     ├─ MachinaEditorProvider (editorProvider.ts) — the custom editor that shows a .machina file as an
//     │    interactive diagram in a webview (media/editor.js). The underlying TextDocument stays the single
//     │    source of truth: the webview sends whole-document edits back, and VS Code provides save, undo,
//     │    redo and dirty tracking for free.
//     ├─ registerDiagnostics (diagnostics.ts) — validates every open .machina document, publishes the
//     │    problems to the Problems panel and, if `machinaState.generateOnSave` is set, regenerates code on
//     │    save.
//     └─ commands (declared under "contributes.commands" in package.json):
//          machinaState.newDiagram      – write a starter diagram (TEMPLATE) and open it in the editor
//          machinaState.generateCode    – generate C/C++/C# code (codegen.ts → generators/)
//          machinaState.autoLayout      – rearrange the diagram with ELK (layout.ts)
//          machinaState.exportPlantUml  – write a .puml file (interop/plantuml.ts)
//          machinaState.exportScxml     – write a .scxml file (interop/scxml.ts)
//          machinaState.exportMermaid   – write a .mmd file, or a .md file with a ```mermaid block (interop/mermaid.ts)
//          machinaState.copyMermaid     – put the diagram on the clipboard as a ```mermaid Markdown block
//          machinaState.import          – convert a PlantUML/SCXML/Mermaid file or a Stateflow model (.slx,
//                                         stateflowImport.ts) into a new, auto-laid-out .machina
//          machinaState.openManual      – open the user manual for this version in the browser (hostUtil.ts)
//          machinaState.getStarted      – open the Get Started walkthrough ("contributes.walkthroughs")
//
// The commands that act on a diagram can be invoked from the command palette (no argument: they use the
// active diagram editor), from the editor title bar or from the explorer context menu (VS Code then passes
// the file's Uri as the first argument). `diagramDocument` resolves which document is meant.
//
// Everything that must be cleaned up on deactivation (the editor registration, the commands, the
// diagnostics collection and its listeners) is pushed onto `context.subscriptions`, which VS Code disposes
// when the extension is deactivated, so `deactivate` itself has nothing to do.
import * as vscode from 'vscode';
import { generateForDocument } from './codegen';
import { registerDiagnostics } from './diagnostics';
import { MachinaEditorProvider, layoutDocument } from './editorProvider';
import { importCodegen, manualUrl } from './hostUtil';
import { detectFormat, exportLimitations } from './interop/common';
import { exportMermaid, importMermaid, mermaidMarkdown } from './interop/mermaid';
import { exportPlantUml, importPlantUml } from './interop/plantuml';
import { exportScxml, importScxml } from './interop/scxml';
import { autoLayout } from './layout';
import { importSlx } from './stateflowImport';
import { Diagram, parseDiagram } from './model';

/**
 * Starter content written by the "New State Machine Diagram" command: an initial pseudostate with a
 * completion transition into a single simple state `Idle`, set up for switch-based C++ generation.
 * Positions and sizes are in diagram coordinates (the same units the webview canvas uses).
 */
const TEMPLATE: Diagram = {
    name: 'StateMachine',
    namespace: '',
    states: [
        { id: 'init', name: 'Initial', kind: 'initial', parent: null, x: 40, y: 68, w: 24, h: 24 },
        { id: 'idle', name: 'Idle', kind: 'state', parent: null, x: 120, y: 45, w: 140, h: 70, entry: '', exit: '' }
    ],
    transitions: [{ id: 't0', source: 'init', target: 'idle', event: '', guard: '', action: '' }],
    codegen: { language: 'cpp', style: 'switch' }
};

/**
 * Called by VS Code when the extension is activated. Registers the custom editor, the diagnostics and all
 * contributed commands; every registration is added to `context.subscriptions` so that it is disposed when
 * the extension is deactivated.
 *
 * @param context The extension context; provides the extension's install location (used by the editor to
 *                locate the media/ folder) and the subscription list for disposal.
 */
export function activate(context: vscode.ExtensionContext): void {
    // One provider instance serves every open diagram editor; it also tracks which one is focused so the
    // palette commands below know which document to act on.
    const provider = new MachinaEditorProvider(context);
    registerDiagnostics(context);
    context.subscriptions.push(
        // The view type must match "contributes.customEditors[].viewType" in package.json, which binds the
        // editor to *.machina files. `retainContextWhenHidden` keeps the webview (and with it the zoom/pan,
        // selection and any running simulation) alive while its tab is in the background, at the cost of
        // memory, instead of rebuilding it from the document text every time the tab is shown again.
        vscode.window.registerCustomEditorProvider(MachinaEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),

        // Ask where to create the file (defaulting to the first workspace folder), write the template as
        // pretty-printed JSON and open it with the diagram editor rather than the default text editor.
        vscode.commands.registerCommand('machinaState.newDiagram', async () => {
            const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const uri = await vscode.window.showSaveDialog({
                defaultUri: folder ? vscode.Uri.joinPath(folder, 'StateMachine.machina') : undefined,
                filters: { 'State machine diagram': ['machina'] }
            });
            if (!uri) {
                return;
            }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(TEMPLATE, null, 2), 'utf8'));
            await vscode.commands.executeCommand('vscode.openWith', uri, MachinaEditorProvider.viewType);
        }),

        // `uri` is supplied when the command is run from the editor title bar or the explorer context menu.
        // Called this way (or from the palette) no language or style is passed, so generateForDocument uses
        // the ones stored in the diagram and asks with quick picks only for what the diagram does not store
        // (the webview's "Generate Code" button passes the toolbar's choices instead; see editorProvider.ts).
        vscode.commands.registerCommand('machinaState.generateCode', async (uri?: vscode.Uri) => {
            const document = await diagramDocument(provider, uri);
            if (!document) {
                return;
            }
            await generateForDocument(document);
        }),

        // Same operation as the webview's "Layout" button; the result is applied as a single undoable edit.
        vscode.commands.registerCommand('machinaState.autoLayout', async (uri?: vscode.Uri) => {
            const document = await diagramDocument(provider, uri);
            if (document) {
                await layoutDocument(document);
            }
        }),

        vscode.commands.registerCommand('machinaState.exportPlantUml', (uri?: vscode.Uri) => exportDiagram(provider, uri, 'puml')),
        vscode.commands.registerCommand('machinaState.exportScxml', (uri?: vscode.Uri) => exportDiagram(provider, uri, 'scxml')),
        vscode.commands.registerCommand('machinaState.exportMermaid', (uri?: vscode.Uri) => exportDiagram(provider, uri, 'mmd')),
        // For pasting into a README, an issue or a wiki page: a ```mermaid block renders there as a diagram.
        vscode.commands.registerCommand('machinaState.copyMermaid', async (uri?: vscode.Uri) => {
            const opened = await openDiagram(provider, uri);
            if (opened) {
                await vscode.env.clipboard.writeText(mermaidMarkdown(exportMermaid(opened.diagram)));
                vscode.window.setStatusBarMessage('MachinaState: copied the diagram as a Mermaid Markdown block', 5000);
                const limits = exportLimitations(opened.diagram);
                if (limits) {
                    vscode.window.showWarningMessage(`MachinaState: copied, but ${limits}.`);
                }
            }
        }),
        vscode.commands.registerCommand('machinaState.import', importDiagram),

        // Help: the manual is a PDF on GitHub (VS Code has no PDF viewer of its own), opened in the browser.
        // The diagram editor's help overlay runs both commands through its `openManual` / `getStarted`
        // messages.
        vscode.commands.registerCommand('machinaState.openManual', () =>
            vscode.env.openExternal(vscode.Uri.parse(manualUrl(context.extension.packageJSON.version)))
        ),
        // The walkthrough id is `<publisher>.<name>#<walkthrough id>`; `false` opens it in the current
        // editor group instead of beside the active editor.
        vscode.commands.registerCommand('machinaState.getStarted', () =>
            vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#gettingStarted`, false)
        )
    );
}

/**
 * The diagram a command applies to (see `diagramDocument`), parsed from the current, possibly unsaved, text.
 * Shows an error and returns undefined if there is no diagram or it cannot be parsed.
 *
 * @param provider Used to find the active diagram editor when no `uri` is given.
 * @param uri      The diagram file when invoked from a menu, otherwise undefined.
 */
async function openDiagram(provider: MachinaEditorProvider, uri: vscode.Uri | undefined): Promise<{ document: vscode.TextDocument; diagram: Diagram } | undefined> {
    const document = await diagramDocument(provider, uri);
    if (!document) {
        return undefined;
    }
    try {
        return { document, diagram: parseDiagram(document.getText()) };
    } catch (err) {
        vscode.window.showErrorMessage(`MachinaState: cannot parse diagram: ${(err as Error).message}`);
        return undefined;
    }
}

/** Save dialog filters for each export format (the first extension of the first entry is the default). */
const EXPORT_FILTERS: Record<'puml' | 'scxml' | 'mmd', Record<string, string[]>> = {
    puml: { PlantUML: ['puml', 'plantuml'] },
    scxml: { SCXML: ['scxml'] },
    mmd: { Mermaid: ['mmd', 'mermaid'], 'Markdown (Mermaid block)': ['md'] }
};

/**
 * Exports a diagram to PlantUML, SCXML or Mermaid. The user picks the destination (by default
 * `<diagram name>.<format>` next to the diagram); the exported text is then opened beside the current editor.
 * A Mermaid export saved as a `.md` file is wrapped in a ```mermaid fence.
 *
 * @param provider Used to find the active diagram editor when no `uri` is given.
 * @param uri      The diagram file when invoked from a menu, otherwise undefined.
 * @param format   `'puml'`, `'scxml'` or `'mmd'`; also the default file extension.
 */
async function exportDiagram(provider: MachinaEditorProvider, uri: vscode.Uri | undefined, format: 'puml' | 'scxml' | 'mmd'): Promise<void> {
    // Export the current (possibly unsaved) document text, not the file on disk.
    const opened = await openDiagram(provider, uri);
    if (!opened) {
        return;
    }
    const { document, diagram } = opened;
    // Untitled documents have no folder to default to, so the dialog then starts at VS Code's default location.
    const target = await vscode.window.showSaveDialog({
        defaultUri: document.isUntitled ? undefined : vscode.Uri.joinPath(document.uri, '..', `${diagram.name}.${format}`),
        filters: EXPORT_FILTERS[format]
    });
    if (!target) {
        return;
    }
    let text: string;
    if (format === 'mmd') {
        text = exportMermaid(diagram);
        if (/\.(md|markdown)$/i.test(target.path)) {
            text = mermaidMarkdown(text);
        }
    } else {
        text = format === 'puml' ? exportPlantUml(diagram) : exportScxml(diagram);
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    const limits = exportLimitations(diagram);
    if (limits) {
        vscode.window.showWarningMessage(`MachinaState: exported, but ${limits}.`);
    }
}

/**
 * Imports a PlantUML, SCXML or Mermaid state machine, or a Stateflow chart from a Simulink model (.slx), as a
 * new .machina diagram.
 *
 * Steps: pick the source file (unless one was given by the explorer context menu), parse it with the
 * matching importer (chosen by `detectFormat`; a Markdown file is read as Mermaid, from its first ```mermaid
 * state diagram), complete its code generation settings with the defaults, compute positions with the
 * automatic layout (imported models carry no geometry), ask where to save it (default `<name>.machina` next
 * to the source), write it and open it in the diagram editor. Importer warnings (constructs that could not be
 * represented) are summarised in a warning notification, showing at most the first three.
 *
 * @param uri The file to import when invoked from the explorer context menu. Any other argument value
 *            (e.g. from the command palette) is ignored and an open dialog is shown instead.
 */
async function importDiagram(uri?: vscode.Uri): Promise<void> {
    if (!(uri instanceof vscode.Uri)) {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: {
                'State machines': ['puml', 'plantuml', 'pu', 'wsd', 'scxml', 'xml', 'mmd', 'mermaid', 'md', 'slx'],
                PlantUML: ['puml', 'plantuml', 'pu', 'wsd'],
                SCXML: ['scxml', 'xml'],
                'Mermaid or Markdown': ['mmd', 'mermaid', 'md'],
                'Simulink model with Stateflow chart': ['slx']
            },
            openLabel: 'Import'
        });
        uri = picked?.[0];
    }
    if (!uri) {
        return;
    }
    let result;
    try {
        if (/\.slx$/i.test(uri.path)) {
            // A binary package; the user may still cancel the chart or step period choice.
            result = await importSlx(uri);
            if (!result) {
                return;
            }
        } else {
            const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            const format = detectFormat(uri.path, text);
            result = format === 'scxml' ? importScxml(text) : format === 'mermaid' ? importMermaid(text) : importPlantUml(text);
        }
    } catch (err) {
        vscode.window.showErrorMessage(`MachinaState: cannot import ${vscode.workspace.asRelativePath(uri)}: ${(err as Error).message}`);
        return;
    }
    const { diagram, warnings } = result;
    // Imported files normally carry no code generation settings; fill in the defaults the template uses
    // (C++, switch-based; the extension has no setting for other defaults), keeping anything the importer
    // did produce.
    diagram.codegen = importCodegen(diagram.codegen);
    await autoLayout(diagram);
    const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(uri, '..', `${diagram.name}.machina`),
        filters: { 'State machine diagram': ['machina'] }
    });
    if (!target) {
        return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(diagram, null, 2), 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', target, MachinaEditorProvider.viewType);
    if (warnings.length) {
        vscode.window.showWarningMessage(`MachinaState: imported with ${warnings.length} warning(s): ${warnings.slice(0, 3).join('; ')}`);
    }
}

/**
 * The diagram a command applies to: the given file, the active diagram editor, or a .machina text editor.
 *
 * Resolution order:
 * 1. An explicit `uri` (menu invocation) is opened as a TextDocument; if it is already open in an editor
 *    VS Code returns that same document, so unsaved changes are included.
 * 2. Otherwise the diagram whose custom editor is currently focused (tracked by the provider).
 * 3. Otherwise a .machina file open in an ordinary text editor (e.g. via "Reopen Editor With... >
 *    Text Editor").
 *
 * Shows a warning and returns undefined if none of these applies.
 *
 * @param provider The editor provider, which knows the active diagram editor.
 * @param uri      Command argument; only honoured if it really is a Uri.
 */
async function diagramDocument(provider: MachinaEditorProvider, uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    if (uri instanceof vscode.Uri) {
        return vscode.workspace.openTextDocument(uri);
    }
    const editorDoc = vscode.window.activeTextEditor?.document;
    const document = provider.active ?? (editorDoc?.fileName.endsWith('.machina') ? editorDoc : undefined);
    if (!document) {
        vscode.window.showWarningMessage('MachinaState: open a .machina diagram first.');
    }
    return document;
}

/** Called by VS Code on deactivation. Nothing to do: all resources are disposed via `context.subscriptions`. */
export function deactivate(): void {}
