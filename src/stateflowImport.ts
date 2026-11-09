// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Host side of the Stateflow import (the conversion itself is interop/stateflow.ts): reads the .slx file,
// finds the Simulink libraries it links to, reads MATLAB parameter scripts, lets the user pick a chart and,
// if the model does not tell, asks for the step period.
//
// Libraries are looked up by file name (`<library>.slx`), the way MATLAB finds them on its path:
//   1. in the folders of the `machinaState.stateflow.libraryPath` setting (searched recursively),
//   2. below the model's own folder, then below each of its ancestors, up to three levels up (a project's
//      models usually sit in sibling folders, such as `models/main_model` and `models/state_machines`).
// Folders starting with `.` and `node_modules` are skipped, and each search stops after 20000 entries.
//
// Parameters (the values of symbolic durations and of the sample time) come from the MATLAB scripts in the
// `machinaState.stateflow.parameterFiles` setting; when it is empty the user may pick scripts for this import.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Diagram } from './model';
import { importStateflow, parseMatlabParameters, StateflowImportResult } from './interop/stateflow';

/** Maximum number of directory entries visited per search root. */
const SCAN_LIMIT = 20000;

/** Every `*.slx` file below `root`, by base name (the first one found wins), searched breadth first. */
function indexLibraries(root: string, index: Map<string, string>): void {
    const queue = [root];
    let visited = 0;
    while (queue.length && visited < SCAN_LIMIT) {
        const dir = queue.shift()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (++visited > SCAN_LIMIT) {
                break;
            }
            if (e.isDirectory()) {
                if (!e.name.startsWith('.') && e.name !== 'node_modules') {
                    queue.push(path.join(dir, e.name));
                }
            } else if (/\.slx$/i.test(e.name)) {
                const base = e.name.slice(0, -4);
                if (!index.has(base)) {
                    index.set(base, path.join(dir, e.name));
                }
            }
        }
    }
}

/** Resolves a setting path: absolute, or relative to the first workspace folder. */
function settingPath(p: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return path.isAbsolute(p) || !root ? p : path.join(root, p);
}

/**
 * Builds a library resolver for a model file. The search roots are scanned lazily: the configured folders
 * first, then the model's folder and its ancestors, one at a time, only as long as a requested library has
 * not been found yet.
 */
function libraryResolver(modelPath: string): { resolve: (name: string) => Buffer | undefined } {
    const configured = vscode.workspace.getConfiguration('machinaState').get<string[]>('stateflow.libraryPath', []);
    const roots = configured.map(settingPath);
    let dir = path.dirname(modelPath);
    for (let i = 0; i <= 3; i++) {
        roots.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    const index = new Map<string, string>();
    let scanned = 0;
    const resolve = (name: string): Buffer | undefined => {
        while (!index.has(name) && scanned < roots.length) {
            indexLibraries(roots[scanned++], index);
        }
        const file = index.get(name);
        return file ? fs.readFileSync(file) : undefined;
    };
    return { resolve };
}

/** Parameters from the configured MATLAB scripts, or from scripts the user picks for this import. */
async function loadParameters(model: vscode.Uri): Promise<Record<string, number>> {
    let files = vscode.workspace
        .getConfiguration('machinaState')
        .get<string[]>('stateflow.parameterFiles', [])
        .map(settingPath);
    if (!files.length) {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            defaultUri: vscode.Uri.joinPath(model, '..'),
            filters: { 'MATLAB scripts': ['m'] },
            openLabel: 'Use Parameters',
            title: 'MATLAB scripts that define the chart\'s parameters (optional; Cancel to skip)'
        });
        files = (picked ?? []).map(u => u.fsPath);
    }
    const parameters: Record<string, number> = {};
    for (const f of files) {
        try {
            Object.assign(parameters, parseMatlabParameters(fs.readFileSync(f, 'utf8')));
        } catch (err) {
            vscode.window.showWarningMessage(`MachinaState: cannot read parameter file ${f}: ${(err as Error).message}`);
        }
    }
    return parameters;
}

/**
 * Imports a Stateflow chart from an .slx file (see the top of this file for the user interaction).
 *
 * @returns The diagram (positions zero; the caller runs the auto-layout) and the importer's warnings, or
 *          undefined if the user cancelled a choice.
 * @throws Error when the file cannot be read or contains no chart (directly or through its libraries).
 */
export async function importSlx(uri: vscode.Uri): Promise<{ diagram: Diagram; warnings: string[] } | undefined> {
    if (uri.scheme !== 'file') {
        throw new Error('Stateflow models can only be imported from local files.');
    }
    const data = fs.readFileSync(uri.fsPath);
    const parameters = await loadParameters(uri);
    const libraries = libraryResolver(uri.fsPath);
    const run = (options: { chart?: string; periodMs?: number } = {}): StateflowImportResult =>
        importStateflow(data, { parameters, resolveLibrary: libraries.resolve, ...options });

    let result = run();
    let chart: string | undefined;
    if (result.charts.length > 1) {
        chart = await vscode.window.showQuickPick(result.charts, { placeHolder: 'Chart to import' });
        if (!chart) {
            return undefined;
        }
        result = run({ chart });
    }
    // Without a known sample time, after(...) cannot be counted in steps: ask for the period.
    if (!result.diagram.step?.periodMs) {
        const answer = await vscode.window.showInputBox({
            title: 'Step period',
            prompt: 'The chart\'s sample time is unknown. Step period in milliseconds (empty: set it later in the diagram settings)',
            validateInput: v => (!v.trim() || Number(v) > 0 ? undefined : 'Enter a positive number of milliseconds')
        });
        if (answer === undefined) {
            return undefined;
        }
        if (answer.trim()) {
            result = run({ chart, periodMs: Number(answer) });
        }
    }
    return { diagram: result.diagram, warnings: result.warnings };
}
