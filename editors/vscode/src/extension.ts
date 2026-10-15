import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { accessFor, completionContext, findMessageOccurrences, flattenCatalog, jsonKeyRange, localeTable, messageCompletions, missingLocales, missingReport, validMessageIdentifiers, type LocaleMessages } from './core';

const languages = [{ language: 'javascript' }, { language: 'javascriptreact' }, { language: 'typescript' }, { language: 'typescriptreact' }, { language: 'vue' }, { language: 'svelte' }, { language: 'html' }];
const execFile = promisify(execFileCallback);

const identifiers = (): string[] => validMessageIdentifiers(vscode.workspace.getConfiguration('nordbeam').get<unknown>('messageIdentifiers'));

class CatalogIndex {
  catalogs: LocaleMessages = new Map();
  files = new Map<string, vscode.Uri>();
  baseLocale = 'en';
  readonly changed = new vscode.EventEmitter<void>();
  async refresh(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    let directory = 'messages';
    for (const configName of ['nordbeam-locale.config.json', 'nordbeam-i18n.config.json', 'fasti18n.config.json']) {
      try {
        const config = JSON.parse(await readFile(resolve(root.fsPath, configName), 'utf8')) as { catalogs?: string; baseLocale?: string };
        directory = config.catalogs ?? directory; this.baseLocale = config.baseLocale ?? this.baseLocale; break;
      } catch { /* try the bounded compatibility names, then use defaults */ }
    }
    const catalogs = new Map<string, Map<string, string>>(), files = new Map<string, vscode.Uri>();
    for (const uri of await vscode.workspace.findFiles(`${directory}/*.json`)) {
      try {
        const locale = basename(uri.fsPath, '.json');
        catalogs.set(locale, flattenCatalog(JSON.parse(await readFile(uri.fsPath, 'utf8')))); files.set(locale, uri);
      } catch { /* JSON diagnostics belong to the language service */ }
    }
    this.catalogs = catalogs; this.files = files;
    this.changed.fire();
  }
  messageAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const offset = document.offsetAt(position);
    return findMessageOccurrences(document.getText(), identifiers()).find(item => offset >= item.start && offset <= item.end)?.id;
  }
}

async function writeNestedJson(uri: vscode.Uri, id: string, value: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const parsed = JSON.parse(document.getText()) as Record<string, unknown>;
  const parts = id.split('.'); let node = parsed;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), `${JSON.stringify(parsed, null, 2)}\n`);
  await vscode.workspace.applyEdit(edit); await document.save();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new CatalogIndex(); await index.refresh();
  const decoration = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 1rem', fontStyle: 'italic' } });
  const missing = vscode.languages.createDiagnosticCollection('nordbeam-locale');
  const output = vscode.window.createOutputChannel('Nordbeam Locale');
  const updateInline = (editor = vscode.window.activeTextEditor): void => {
    if (!editor || !vscode.workspace.getConfiguration('nordbeam').get('inlineTranslations', true)) return;
    const base = index.catalogs.get(index.baseLocale); if (!base) return;
    editor.setDecorations(decoration, findMessageOccurrences(editor.document.getText(), identifiers()).flatMap(item => {
      const text = base.get(item.id); return text ? [{ range: new vscode.Range(editor.document.positionAt(item.end), editor.document.positionAt(item.end)), renderOptions: { after: { contentText: `  ${text}` } } }] : [];
    }));
  };
  const publishMissing = async (): Promise<void> => {
    missing.clear();
    const uri = index.files.get(index.baseLocale), base = index.catalogs.get(index.baseLocale);
    if (!uri || !base) return;
    const document = await vscode.workspace.openTextDocument(uri), text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];
    for (const id of base.keys()) {
      const locales = missingLocales(id, index.catalogs), range = jsonKeyRange(text, id);
      if (!locales.length || !range) continue;
      const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)), `Missing translation in ${locales.join(', ')}.`, vscode.DiagnosticSeverity.Information);
      diagnostic.source = 'Nordbeam Locale'; diagnostics.push(diagnostic);
    }
    missing.set(uri, diagnostics);
  };
  context.subscriptions.push(decoration, missing, output, index.changed, index.changed.event(() => void publishMissing()), vscode.languages.registerHoverProvider(languages, { provideHover(document, position) {
    const id = index.messageAt(document, position); if (!id) return;
    const rows = localeTable(id, index.catalogs).map(row => `| ${row.locale} | ${row.text?.replace(/\|/g, '\\|') ?? '⚠ missing'} |`).join('\n');
    return new vscode.Hover(new vscode.MarkdownString(`**${id}**\n\n| Locale | Translation |\n| --- | --- |\n${rows}`));
  }}), vscode.languages.registerCompletionItemProvider(languages, { provideCompletionItems(document, position) {
    const base = index.catalogs.get(index.baseLocale); if (!base) return;
    const context = completionContext(document.lineAt(position.line).text.slice(0, position.character), identifiers()); if (!context) return;
    const range = new vscode.Range(position.line, position.character - context.partial.length, position.line, position.character);
    return messageCompletions(base, context).map(candidate => {
      const item = new vscode.CompletionItem(candidate.label, candidate.leaf ? vscode.CompletionItemKind.Value : vscode.CompletionItemKind.Module);
      item.range = range; item.detail = candidate.text; return item;
    });
  }}, '.', '[', '"', "'"));
  context.subscriptions.push(vscode.commands.registerCommand('nordbeam.extractMessage', async () => {
    const editor = vscode.window.activeTextEditor; if (!editor) return;
    const selected = editor.document.getText(editor.selection);
    const id = await vscode.window.showInputBox({ title: 'Extract Nordbeam message', prompt: 'Stable message ID', validateInput: value => value && !value.split('.').some(part => !part) ? undefined : 'Use non-empty dot-separated segments.' });
    if (!id) return;
    const message = selected || await vscode.window.showInputBox({ prompt: 'Base-locale message' }); if (message === undefined) return;
    const file = index.files.get(index.baseLocale); if (!file) return void vscode.window.showErrorMessage(`No ${index.baseLocale}.json Nordbeam catalog found.`);
    await writeNestedJson(file, id, message);
    if (!editor.selection.isEmpty) await editor.edit(builder => builder.replace(editor.selection, `${accessFor(id, identifiers()[0])}()`));
    await index.refresh(); updateInline(editor);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('nordbeam.renameMessage', async () => {
    const editor = vscode.window.activeTextEditor; if (!editor) return;
    const from = index.messageAt(editor.document, editor.selection.active); if (!from) return void vscode.window.showWarningMessage('Place the cursor on a message ID first.');
    const to = await vscode.window.showInputBox({ value: from, prompt: 'New message ID' }); if (!to || to === from) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) return;
    try {
      await execFile(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', 'nordbeam-locale', 'rename', '--id', from, '--to', to], { cwd: root });
      await index.refresh(); updateInline(editor);
      await vscode.window.showInformationMessage(`Renamed ${from} to ${to} across catalogs and recognized source references.`);
    } catch (error) { await vscode.window.showErrorMessage(`Nordbeam rename failed without a partial catalog write: ${(error as Error).message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('nordbeam.repairMissingKey', async () => {
    const editor = vscode.window.activeTextEditor; if (!editor) return;
    const id = index.messageAt(editor.document, editor.selection.active); if (!id) return;
    const base = index.catalogs.get(index.baseLocale)?.get(id) ?? id;
    for (const locale of missingLocales(id, index.catalogs)) { const file = index.files.get(locale); if (file) await writeNestedJson(file, id, base); }
    await index.refresh(); updateInline(editor);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('nordbeam.showMissingTranslations', () => {
    if (!index.catalogs.has(index.baseLocale)) return void vscode.window.showErrorMessage(`No ${index.baseLocale}.json Nordbeam catalog found.`);
    output.clear();
    output.appendLine(`Base locale ${index.baseLocale}: ${index.catalogs.get(index.baseLocale)!.size} message IDs`);
    for (const { locale, ids } of missingReport(index.catalogs, index.baseLocale)) {
      output.appendLine(ids.length ? `${locale}: ${ids.length} missing` : `${locale}: complete`);
      for (const id of ids) output.appendLine(`  ${id}`);
    }
    output.show(true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('nordbeam.verify', async () => {
    const task = new vscode.Task({ type: 'nordbeam-locale' }, vscode.TaskScope.Workspace, 'Verify messages', 'Nordbeam', new vscode.ShellExecution('npx nordbeam-locale check'));
    await vscode.tasks.executeTask(task);
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateInline), vscode.workspace.onDidChangeTextDocument(event => { if (event.document === vscode.window.activeTextEditor?.document) updateInline(); }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('nordbeam.messageIdentifiers')) updateInline(); }));
  const watcher = vscode.workspace.createFileSystemWatcher('**/messages/**/*.json');
  const refresh = async (): Promise<void> => { await index.refresh(); updateInline(); };
  context.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
  updateInline();
  void publishMissing();
}

export function deactivate(): void {}
