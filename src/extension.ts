import * as vscode from 'vscode';
import { AslParser } from './aslParser';
import { AslLinter } from './linter';
import { PreviewPanel } from './preview';

const SUPPORTED_LANGUAGES = ['yaml', 'json'];

let _debounceTimer: ReturnType<typeof setTimeout> | undefined;

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('steplens');
  context.subscriptions.push(diagnostics);

  // ── Status bar item ────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'workbench.action.problems.focus';
  statusBar.tooltip = 'StepLens — cliquer pour ouvrir le panneau Problèmes';
  context.subscriptions.push(statusBar);

  // ── Command: open graph preview ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('steplens.preview', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const parsed = AslParser.parse(editor.document.getText(), editor.document.languageId);
      if (!parsed) {
        vscode.window.showWarningMessage('StepLens: pas de définition Step Functions détectée.');
        return;
      }

      PreviewPanel.create(context, editor.document);
    })
  );

  // ── Command: manual lint ───────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('steplens.lint', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) runLint(editor.document, diagnostics, statusBar);
    })
  );

  // ── Hover provider: show lint errors on the underlined range ─────────────
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SUPPORTED_LANGUAGES, {
      provideHover(doc, position) {
        const diags = vscode.languages.getDiagnostics(doc.uri).filter(
          d => d.source === 'StepLens' && d.range.contains(position)
        );
        if (!diags.length) return;

        const md = new vscode.MarkdownString(undefined, true);
        md.supportThemeIcons = true;
        md.appendMarkdown('**StepLens**\n\n');
        for (const d of diags) {
          const icon = d.severity === vscode.DiagnosticSeverity.Error
            ? '$(error)'
            : '$(warning)';
          md.appendMarkdown(`${icon} ${d.message}\n\n`);
        }
        return new vscode.Hover(md);
      },
    })
  );

  // ── Auto-lint on keystroke (debounced) ──────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!SUPPORTED_LANGUAGES.includes(e.document.languageId)) return;

      const isActive = vscode.window.activeTextEditor?.document === e.document;
      if (isActive) updateSfnContext(vscode.window.activeTextEditor);

      clearTimeout(_debounceTimer);
      const doc = e.document;
      _debounceTimer = setTimeout(() => {
        const cfg = vscode.workspace.getConfiguration('steplens');
        if (cfg.get('lintOnType')) {
          const stillActive = vscode.window.activeTextEditor?.document === doc;
          runLint(doc, diagnostics, stillActive ? statusBar : undefined);
        }
        if (PreviewPanel.currentPanel) {
          PreviewPanel.currentPanel.update(doc);
        }
      }, 200);
    })
  );

  // ── Auto-lint on save ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      const cfg = vscode.workspace.getConfiguration('steplens');
      if (cfg.get('lintOnSave') && SUPPORTED_LANGUAGES.includes(doc.languageId)) {
        const isActive = vscode.window.activeTextEditor?.document === doc;
        runLint(doc, diagnostics, isActive ? statusBar : undefined);
      }
    })
  );

  // ── Clear diagnostics on close ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri))
  );

  // ── React to settings changes ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('steplens')) return;

      const cfg = vscode.workspace.getConfiguration('steplens');

      if (!cfg.get('autoDetect')) {
        // autoDetect disabled → wipe all diagnostics immediately
        diagnostics.clear();
        statusBar.hide();
        return;
      }

      // Any other setting changed (lintOnType, lintOnSave) → re-lint all open
      // docs so the displayed state is consistent with the new configuration.
      vscode.workspace.textDocuments.forEach(doc => {
        if (!SUPPORTED_LANGUAGES.includes(doc.languageId)) return;
        const isActive = vscode.window.activeTextEditor?.document === doc;
        runLint(doc, diagnostics, isActive ? statusBar : undefined);
      });
    })
  );

  // ── Cursor movement → highlight state in graph ────────────────────────────
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (!PreviewPanel.currentPanel) return;
      const stateName = getStateNameAtCursor(e.textEditor);
      if (stateName) PreviewPanel.currentPanel.highlightState(stateName);
    })
  );

  // ── Active editor change → update icon + status bar ──────────────────────
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      updateSfnContext(editor);
      if (editor && SUPPORTED_LANGUAGES.includes(editor.document.languageId)) {
        runLint(editor.document, diagnostics, statusBar);
      } else {
        statusBar.hide();
      }
    })
  );

  // Set context for already-active editor on startup
  updateSfnContext(vscode.window.activeTextEditor);

  // Lint all already-open documents on activation
  vscode.workspace.textDocuments.forEach(doc => {
    if (SUPPORTED_LANGUAGES.includes(doc.languageId)) {
      const isActive = vscode.window.activeTextEditor?.document === doc;
      runLint(doc, diagnostics, isActive ? statusBar : undefined);
    }
  });
}

/**
 * Set the `steplens.isSfnFile` context key so the editor/title icon is shown
 * only when the active file contains a Step Functions definition.
 */
function updateSfnContext(editor: vscode.TextEditor | undefined) {
  const isSfn = editor != null
    && SUPPORTED_LANGUAGES.includes(editor.document.languageId)
    && AslParser.parse(editor.document.getText(), editor.document.languageId) != null;

  vscode.commands.executeCommand('setContext', 'steplens.isSfnFile', isSfn);
}

export function deactivate() {
  clearTimeout(_debounceTimer);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function runLint(
  doc: vscode.TextDocument,
  col: vscode.DiagnosticCollection,
  statusBar?: vscode.StatusBarItem
) {
  const cfg = vscode.workspace.getConfiguration('steplens');
  if (!cfg.get('autoDetect')) return;

  const text = doc.getText();
  const parsed = AslParser.parse(text, doc.languageId);
  if (!parsed) {
    col.delete(doc.uri);
    statusBar?.hide();
    return;
  }

  const errors = AslLinter.lint(parsed.definition);
  const lines = text.split('\n');

  const diags = errors.map(err => {
    const line = err.searchKey ? findLineForKey(lines, err.searchKey) : 0;
    const range = new vscode.Range(
      new vscode.Position(line, 0),
      new vscode.Position(line, doc.lineAt(line).text.length)
    );
    const diag = new vscode.Diagnostic(range, err.message, err.severity);
    diag.source = 'StepLens';
    return diag;
  });

  col.set(doc.uri, diags);

  if (statusBar) {
    const errCount  = errors.filter(e => e.severity === vscode.DiagnosticSeverity.Error).length;
    const warnCount = errors.filter(e => e.severity === vscode.DiagnosticSeverity.Warning).length;

    if (errCount > 0) {
      statusBar.text = `$(error) StepLens: ${errCount} erreur${errCount > 1 ? 's' : ''}`;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (warnCount > 0) {
      statusBar.text = `$(warning) StepLens: ${warnCount} alerte${warnCount > 1 ? 's' : ''}`;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      statusBar.text = '$(check) StepLens';
      statusBar.backgroundColor = undefined;
    }
    statusBar.show();
  }
}

// ── Cursor state lookup — cached per (uri, document version) ──────────────────
// Avoids re-parsing and re-indexing on every cursor movement.
type CursorCache = {
  uri: string;
  version: number;
  /** line number → state name, only for lines that open a state definition */
  lineMap: Map<number, string>;
};
let _cursorCache: CursorCache | null = null;

function getStateNameAtCursor(editor: vscode.TextEditor): string | null {
  const doc = editor.document;
  if (!SUPPORTED_LANGUAGES.includes(doc.languageId)) return null;

  const uri = doc.uri.toString();
  const version = doc.version;

  // Rebuild index only when the document actually changed
  if (!_cursorCache || _cursorCache.uri !== uri || _cursorCache.version !== version) {
    const parsed = AslParser.parse(doc.getText(), doc.languageId);
    if (!parsed) { _cursorCache = null; return null; }

    const stateNames = AslParser.allStateNames(parsed.definition);
    _cursorCache = { uri, version, lineMap: buildStateLineIndex(doc, stateNames) };
  }

  // O(k) walk backwards where k = distance to nearest state header above cursor
  const { lineMap } = _cursorCache;
  for (let i = editor.selection.active.line; i >= 0; i--) {
    const name = lineMap.get(i);
    if (name !== undefined) return name;
  }
  return null;
}

/**
 * Scan the document once and record which line each state definition starts on.
 * RegExps are compiled once per state name, not once per (line × state name).
 */
function buildStateLineIndex(
  doc: vscode.TextDocument,
  stateNames: string[]
): Map<number, string> {
  const lineMap = new Map<number, string>();
  if (stateNames.length === 0) return lineMap;

  const patterns = stateNames.map(name => ({
    name,
    re: new RegExp(`^\\s+(${escRe(name)}|"${escRe(name)}")\\s*:`),
  }));

  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    for (const { name, re } of patterns) {
      if (re.test(text)) {
        lineMap.set(i, name);
        break;
      }
    }
  }
  return lineMap;
}

/**
 * Find the 0-based line number of a state name in pre-split lines.
 * Avoids re-splitting the document text for every error.
 */
function findLineForKey(lines: string[], stateName: string): number {
  const esc = escRe(stateName);
  const pattern = new RegExp(`^\\s+(${esc}|"${esc}")\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return 0;
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
