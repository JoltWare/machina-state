// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Bridges VS Code and the code generators: turns a diagram TextDocument into source files on disk.
//
// Data flow: TextDocument text → parseDiagram (JSON → Diagram) → analyze (validation; on success a
// semantic `Machine` model) → generateCode (generators/index.ts dispatches to the C, C++ or C# generator)
// → one or more { extension, code } files → written with vscode.workspace.fs.
//
// Generated files are always named after the machine (`<machine name><extension>`; analyze has already
// checked that the name is a valid identifier, and the C source includes its header as "<name>.h", so the
// name cannot be chosen freely). For saved diagrams they are written to the folder that contains the
// .machina file, overwriting any previous output; for untitled diagrams the user picks the folder:
//   C++ → <name>.hpp     C# → <name>.cs     C → <name>.h and <name>.c
// Diagrams that record the code behind their hooks (imported Stateflow charts) also get a hook stub,
// <name>Hooks.<ext> (generators/stub.ts), interactively and only if it does not exist yet.
//
// Two entry points:
// - generateForDocument: interactive. Used by the "Generate State Machine Code" command (which uses the
//   language and style stored in the diagram and asks only for what is missing) and by the webview's
//   "Generate Code" button (which passes the toolbar's choices). Reports problems as error notifications and
//   opens the generated file beside the editor.
// - generateSilently: non-interactive. Used by diagnostics.ts when `machinaState.generateOnSave` is enabled;
//   uses the language/style stored in the diagram, only touches files whose content changed, and reports
//   through transient status bar messages.
//
// The options trace/threadSafe/queue are not parameters here: analyze copies them from the diagram's
// stored `codegen` settings into the Machine, so the generators always use what is saved in the document.
import * as vscode from 'vscode';
import { generateCode } from './generators';
import { generateHookStub } from './generators/stub';
import { storedCodegen } from './hostUtil';
import { analyze, isError, Language, parseDiagram, Style } from './model';

/**
 * Generates code for a diagram interactively and writes it next to the diagram.
 *
 * A `language`/`style` that is not passed is taken from the diagram's stored `codegen` settings; only if the
 * diagram has none (or an unknown value) is it asked for with a quick pick. Cancelling a pick (or the folder
 * dialog for an untitled document) aborts silently. If the diagram does not parse or fails validation an error
 * notification is shown (with at most the first five problem messages; the full list is in the Problems
 * panel) and nothing is written. On success the first generated file (the header for C) is opened beside
 * the active editor and the written paths are shown in the status bar for five seconds.
 *
 * @param document The diagram; its current, possibly unsaved, text is used.
 * @param language Target language; when omitted the stored one, or prompted for if none is stored.
 * @param style    Switch- or table-based implementation; when omitted the stored one, or prompted for.
 */
export async function generateForDocument(document: vscode.TextDocument, language?: Language, style?: Style): Promise<void> {
    let diagram;
    try {
        diagram = parseDiagram(document.getText());
    } catch (err) {
        vscode.window.showErrorMessage(`MachinaState: cannot parse diagram: ${(err as Error).message}`);
        return;
    }

    // Use what the caller supplied, else what the diagram stores; prompt only for what is still missing.
    const stored = storedCodegen(diagram.codegen);
    language ??= stored.language ?? (await pickLanguage());
    if (!language) {
        return;
    }
    style ??= stored.style ?? (await pickStyle());
    if (!style) {
        return;
    }

    // `machine` is only present when there are no errors (warnings do not block generation); otherwise
    // refuse to generate and quote the first few errors.
    const { machine, issues } = analyze(diagram);
    if (!machine) {
        const errors = issues.filter(isError);
        const shown = errors.slice(0, 5).map(i => i.message).join(' ');
        vscode.window.showErrorMessage(`MachinaState: the diagram has ${errors.length} error(s). ${shown}`);
        return;
    }

    const files = generateCode(machine, language, style);
    // Output folder. A saved diagram writes into its own folder without asking. An untitled one has no
    // folder, so the user picks one (starting in the first workspace folder, if any). Only the folder is
    // asked for, not a file name, because the names are fixed (see the top of this file); a save dialog
    // would let the user type a name or extension that the files could not honour.
    let folder: vscode.Uri | undefined;
    if (document.isUntitled) {
        folder = (
            await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
                openLabel: 'Generate Here',
                title: `Folder for ${files.map(f => machine.name + f.extension).join(' and ')}`
            })
        )?.[0];
    } else {
        folder = vscode.Uri.joinPath(document.uri, '..');
    }
    if (!folder) {
        return;
    }
    const targets = files.map(f => vscode.Uri.joinPath(folder!, machine.name + f.extension));
    // A folder picked for an untitled diagram may hold unrelated files of the same name; unlike a save
    // dialog, the folder picker does not warn about that, so ask before overwriting them.
    if (document.isUntitled) {
        const existing: string[] = [];
        for (const target of targets) {
            try {
                await vscode.workspace.fs.stat(target);
                existing.push(vscode.workspace.asRelativePath(target));
            } catch {
                // Does not exist.
            }
        }
        if (existing.length) {
            const answer = await vscode.window.showWarningMessage(`MachinaState: overwrite ${existing.join(', ')}?`, { modal: true }, 'Overwrite');
            if (answer !== 'Overwrite') {
                return;
            }
        }
    }
    for (let i = 0; i < files.length; i++) {
        await vscode.workspace.fs.writeFile(targets[i], Buffer.from(files[i].code, 'utf8'));
    }
    // A diagram that records the code behind its hooks (an imported Stateflow chart) also gets a hook stub,
    // `<name>Hooks.<ext>`, with that code as the hook bodies. It is written only if it does not exist yet: from
    // then on it is the user's file. Other diagrams get no extra file.
    const written = [...targets];
    if (diagram.hooks && Object.keys(diagram.hooks).length > 0) {
        const stub = generateHookStub(machine, diagram, language);
        const target = vscode.Uri.joinPath(folder, machine.name + stub.extension);
        if (!(await exists(target))) {
            await vscode.workspace.fs.writeFile(target, Buffer.from(stub.code, 'utf8'));
            written.push(target);
        }
    }
    await vscode.window.showTextDocument(targets[0], { viewColumn: vscode.ViewColumn.Beside, preview: false });
    vscode.window.setStatusBarMessage(`MachinaState: generated ${written.map(t => vscode.workspace.asRelativePath(t)).join(', ')}`, 5000);
}

/**
 * Regenerates code next to a saved diagram using its stored language/style, without prompts or opening editors.
 *
 * Called on save when `machinaState.generateOnSave` is enabled (see diagnostics.ts). Untitled documents and
 * text that does not parse are ignored (the parse error is already shown in the Problems panel); if
 * validation fails only a status bar warning is shown. When no language or style is stored (or the stored
 * value is unknown) the defaults C++ and switch-based are used. A file is rewritten only if its content
 * differs, which avoids touching timestamps (and triggering file watchers or rebuilds) when nothing changed.
 *
 * @param document The saved diagram document.
 */
export async function generateSilently(document: vscode.TextDocument): Promise<void> {
    if (document.isUntitled) {
        return;
    }
    let diagram;
    try {
        diagram = parseDiagram(document.getText());
    } catch {
        return;
    }
    const { machine, issues } = analyze(diagram);
    if (!machine) {
        vscode.window.setStatusBarMessage(`$(warning) MachinaState: not generated, ${issues.filter(isError).length} error(s)`, 5000);
        return;
    }
    const stored = storedCodegen(diagram.codegen);
    const files = generateCode(machine, stored.language ?? 'cpp', stored.style ?? 'switch');
    const written: string[] = []; // workspace-relative paths of the files actually rewritten
    for (const { code, extension } of files) {
        const target = vscode.Uri.joinPath(document.uri, '..', machine.name + extension);
        // Skip the write if the file on disk already holds exactly this code.
        try {
            const existing = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
            if (existing === code) {
                continue;
            }
        } catch {
            // File does not exist yet.
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(code, 'utf8'));
        written.push(vscode.workspace.asRelativePath(target));
    }
    if (written.length) {
        vscode.window.setStatusBarMessage(`MachinaState: regenerated ${written.join(', ')}`, 5000);
    }
}

/** True if a file or folder exists at `uri`. */
async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

/**
 * Asks for the target language with a quick pick.
 *
 * @returns The chosen language, or undefined if the pick was dismissed.
 */
async function pickLanguage(): Promise<Language | undefined> {
    const pick = await vscode.window.showQuickPick(
        [
            { label: 'C++', value: 'cpp' as Language },
            { label: 'C#', value: 'csharp' as Language },
            { label: 'C (C99)', value: 'c' as Language }
        ],
        { placeHolder: 'Target language' }
    );
    return pick?.value;
}

/**
 * Asks for the implementation style (switch statements or a transition table) with a quick pick.
 *
 * @returns The chosen style, or undefined if the pick was dismissed.
 */
async function pickStyle(): Promise<Style | undefined> {
    const pick = await vscode.window.showQuickPick(
        [
            { label: 'Switch-based', value: 'switch' as Style },
            { label: 'Table-based', value: 'table' as Style }
        ],
        { placeHolder: 'Implementation style' }
    );
    return pick?.value;
}
