import * as vscode from 'vscode';
import { AslParser } from './aslParser';
import { AslLinter } from './linter';
import { PreviewPanel } from './preview';

const SUPPORTED_LANGUAGES = ['yaml', 'json'];

let _debounceTimer: ReturnType<typeof setTimeout> | undefined;

// ── Per-document async parse cache ────────────────────────────────────────────
// Keyed by document URI string; invalidated whenever the document version changes.
type DocCache = { version: number; parsed: import('./aslParser').ParsedSfn | null };
const _docCache = new Map<string, DocCache>();

/**
 * Parse a document, resolving `DefinitionUri` when necessary.
 *
 * The result is cached by (uri, version) so repeated calls within the same
 * edit cycle are free.  External file changes (the referenced ASL file) are
 * not tracked; the user should save the template to re-trigger resolution.
 */
async function parseDocumentAsync(
  doc: vscode.TextDocument,
): Promise<import('./aslParser').ParsedSfn | null> {
  const key = doc.uri.toString();
  const cached = _docCache.get(key);
  if (cached?.version === doc.version) return cached.parsed;

  const parsed = await AslParser.parseWithDefinitionUri(
    doc.getText(),
    doc.languageId,
    async (relativePath) => {
      const resolved = vscode.Uri.joinPath(doc.uri, '..', relativePath);
      const bytes = await vscode.workspace.fs.readFile(resolved);
      return new TextDecoder().decode(bytes);
    },
  );

  _docCache.set(key, { version: doc.version, parsed });
  return parsed;
}

export function activate(context: vscode.ExtensionContext) {
  // ── Update notification ────────────────────────────────────────────────────
  const currentVersion = context.extension.packageJSON.version as string;
  const previousVersion = context.globalState.get<string>('version');
  if (previousVersion && previousVersion !== currentVersion) {
    const [prevMaj, prevMin] = previousVersion.split('.').map(Number);
    const [curMaj, curMin]   = currentVersion.split('.').map(Number);
    const isMinorOrMajor = prevMaj !== curMaj || prevMin !== curMin;
    const command = isMinorOrMajor
      ? 'workbench.action.reloadWindow'
      : 'workbench.action.restartExtensionHost';
    vscode.window.showInformationMessage(
      `StepLens updated to v${currentVersion}. Reload to apply changes.`,
      'Reload Now'
    ).then(action => {
      if (action === 'Reload Now') {
        vscode.commands.executeCommand(command);
      }
    });
  }
  context.globalState.update('version', currentVersion);

  const diagnostics = vscode.languages.createDiagnosticCollection('steplens');
  context.subscriptions.push(diagnostics);

  // ── Status bar item ────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'workbench.action.problems.focus';
  statusBar.tooltip = 'StepLens — click to open the Problems panel';
  context.subscriptions.push(statusBar);

  // ── Command: open graph preview ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('steplens.preview', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      void parseDocumentAsync(editor.document).then(parsed => {
        if (!parsed) {
          vscode.window.showWarningMessage('StepLens: no Step Functions definition detected.');
          return;
        }
        PreviewPanel.create(context, editor.document);
      });
    })
  );

  // ── Command: manual lint ───────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('steplens.lint', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        void parseDocumentAsync(editor.document).then(parsed =>
          runLint(editor.document, diagnostics, statusBar, parsed)
        );
      }
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

  // ── Rename provider ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerRenameProvider(SUPPORTED_LANGUAGES, {
      prepareRename(doc, position) {
        // Only operate on inline ASL files (not DefinitionUri templates).
        const parsed = AslParser.parse(doc.getText(), doc.languageId);
        if (!parsed) throw new Error('StepLens: no Step Functions definition in this file');

        const lines = doc.getText().split('\n');
        const stateNames = AslParser.allStateNames(parsed.definition);
        const hit = AslParser.stateNameAtPosition(lines, position.line, position.character, stateNames);
        if (!hit) throw new Error('StepLens: cursor is not on a state name');

        return {
          range: new vscode.Range(position.line, hit.start, position.line, hit.end),
          placeholder: hit.name,
        };
      },

      provideRenameEdits(doc, position, newName) {
        const parsed = AslParser.parse(doc.getText(), doc.languageId);
        if (!parsed) return;

        const lines = doc.getText().split('\n');
        const stateNames = AslParser.allStateNames(parsed.definition);
        const hit = AslParser.stateNameAtPosition(lines, position.line, position.character, stateNames);
        if (!hit) return;

        const edit = new vscode.WorkspaceEdit();
        for (const occ of AslParser.findStateNameOccurrences(lines, hit.name)) {
          edit.replace(
            doc.uri,
            new vscode.Range(occ.line, occ.start, occ.line, occ.end),
            newName,
          );
        }
        return edit;
      },
    })
  );

  // ── Document highlight provider ───────────────────────────────────────────
  // When the cursor rests on a state name, all occurrences are highlighted
  // automatically (background tint). Drives the "change all occurrences" UX.
  context.subscriptions.push(
    vscode.languages.registerDocumentHighlightProvider(SUPPORTED_LANGUAGES, {
      provideDocumentHighlights(doc, position) {
        const parsed = AslParser.parse(doc.getText(), doc.languageId);
        if (!parsed) return;

        const lines = doc.getText().split('\n');
        const hit = AslParser.stateNameAtPosition(
          lines, position.line, position.character,
          AslParser.allStateNames(parsed.definition),
        );
        if (!hit) return;

        return AslParser.findStateNameOccurrences(lines, hit.name).map(occ =>
          new vscode.DocumentHighlight(
            new vscode.Range(occ.line, occ.start, occ.line, occ.end),
            vscode.DocumentHighlightKind.Text,
          )
        );
      },
    })
  );

  // ── Code action: "Rename state…" (lightbulb) + Quick Fix on broken refs ───
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      SUPPORTED_LANGUAGES,
      {
        provideCodeActions(doc, range, context) {
          const parsed = AslParser.parse(doc.getText(), doc.languageId);
          const actions: vscode.CodeAction[] = [];

          // ── Quick Fix: fix broken state reference ─────────────────────────
          // Fires when the linter emits "X not found" or "X does not exist".
          if (parsed) {
            const lines = doc.getText().split('\n');
            const stateNames = AslParser.allStateNames(parsed.definition);

            for (const diag of context.diagnostics) {
              if (diag.source !== 'StepLens') continue;
              const broken = extractBrokenStateName(diag.message);
              if (!broken) continue;

              const candidates = rankByDistance(broken, stateNames).slice(0, 3);
              candidates.forEach((candidate, idx) => {
                const fix = new vscode.CodeAction(
                  `Rename "${broken}" → "${candidate}"`,
                  vscode.CodeActionKind.QuickFix,
                );
                fix.diagnostics = [diag];
                fix.isPreferred = idx === 0;
                const edit = new vscode.WorkspaceEdit();
                for (const occ of AslParser.findStateNameOccurrences(lines, broken)) {
                  edit.replace(
                    doc.uri,
                    new vscode.Range(occ.line, occ.start, occ.line, occ.end),
                    candidate,
                  );
                }
                fix.edit = edit;
                actions.push(fix);
              });
            }
          }

          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    )
  );

  // ── Completion: state names for Next / Default / StartAt ─────────────────
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SUPPORTED_LANGUAGES,
      {
        provideCompletionItems(doc, position) {
          const parsed = AslParser.parse(doc.getText(), doc.languageId);
          if (!parsed) return;

          const prefix = doc.lineAt(position.line).text.slice(0, position.character);

          // YAML:  `Next: ` or `Next: PartialName`
          // JSON:  `"Next": "` or `"Next": "PartialName`
          const isYaml = /^\s*(?:-\s+)?(?:Next|Default|StartAt)\s*:\s*\S*$/.test(prefix);
          const isJson = /^\s*"(?:Next|Default|StartAt)"\s*:\s*"[^"]*$/.test(prefix);
          if (!isYaml && !isJson) return;

          return Object.keys(parsed.definition.States).map(name => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Value);
            item.detail = 'Step Functions state';
            return item;
          });
        },
      },
      ' ', '"',
    )
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
        void (async () => {
          const cfg = vscode.workspace.getConfiguration('steplens');
          // Resolve once (handles DefinitionUri) and share with lint + preview.
          const parsed = await parseDocumentAsync(doc);
          if (cfg.get('lintOnType')) {
            const stillActive = vscode.window.activeTextEditor?.document === doc;
            runLint(doc, diagnostics, stillActive ? statusBar : undefined, parsed);
          }
          if (PreviewPanel.currentPanel) {
            PreviewPanel.currentPanel.update(doc);
          }
        })();
      }, 200);
    })
  );

  // ── Auto-lint on save ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      const cfg = vscode.workspace.getConfiguration('steplens');
      if (cfg.get('lintOnSave') && SUPPORTED_LANGUAGES.includes(doc.languageId)) {
        const isActive = vscode.window.activeTextEditor?.document === doc;
        void parseDocumentAsync(doc).then(parsed =>
          runLint(doc, diagnostics, isActive ? statusBar : undefined, parsed)
        );
      }
    })
  );

  // ── Clear diagnostics and cache on close ──────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      diagnostics.delete(doc.uri);
      _docCache.delete(doc.uri.toString());
    })
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
        void parseDocumentAsync(doc).then(parsed =>
          runLint(doc, diagnostics, isActive ? statusBar : undefined, parsed)
        );
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
        void parseDocumentAsync(editor.document).then(parsed =>
          runLint(editor.document, diagnostics, statusBar, parsed)
        );
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
      void parseDocumentAsync(doc).then(parsed =>
        runLint(doc, diagnostics, isActive ? statusBar : undefined, parsed)
      );
    }
  });
}

/**
 * Set the `steplens.isSfnFile` context key so the editor/title icon is shown
 * only when the active file contains a Step Functions definition.
 */
function updateSfnContext(editor: vscode.TextEditor | undefined) {
  if (editor == null || !SUPPORTED_LANGUAGES.includes(editor.document.languageId)) {
    vscode.commands.executeCommand('setContext', 'steplens.isSfnFile', false);
    return;
  }
  const text = editor.document.getText();
  const isSfn =
    AslParser.parse(text, editor.document.languageId) != null ||
    AslParser.extractDefinitionUri(text, editor.document.languageId) != null;

  vscode.commands.executeCommand('setContext', 'steplens.isSfnFile', isSfn);
}

export function deactivate() {
  clearTimeout(_debounceTimer);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function runLint(
  doc: vscode.TextDocument,
  col: vscode.DiagnosticCollection,
  statusBar?: vscode.StatusBarItem,
  parsed?: import('./aslParser').ParsedSfn | null,
) {
  const cfg = vscode.workspace.getConfiguration('steplens');
  if (!cfg.get('autoDetect')) return;

  // `parsed` may be pre-resolved (e.g. from parseDocumentAsync for DefinitionUri
  // templates). When undefined the caller hasn't resolved yet; fall back to the
  // fast sync path which handles all inline formats.
  const result = parsed !== undefined ? parsed : AslParser.parse(doc.getText(), doc.languageId);
  if (!result) {
    col.delete(doc.uri);
    statusBar?.hide();
    return;
  }

  const text = doc.getText();

  const errors = AslLinter.lint(result.definition);
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
      statusBar.text = `$(error) StepLens: ${errCount} error${errCount > 1 ? 's' : ''}`;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (warnCount > 0) {
      statusBar.text = `$(warning) StepLens: ${warnCount} warning${warnCount > 1 ? 's' : ''}`;
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

/**
 * Extract the broken state name from a StepLens diagnostic message.
 * Matches the quoted name immediately before "not found" or "does not exist".
 * e.g. `"StateA": Next "Foo" not found`  →  "Foo"
 */
function extractBrokenStateName(message: string): string | null {
  const m = message.match(/"([^"]+)"\s+(?:not found|does not exist)/);
  return m ? m[1] : null;
}

/**
 * Rank `candidates` by Levenshtein distance to `target` (ascending).
 * Case-insensitive comparison; equal distances preserve original order.
 */
function rankByDistance(target: string, candidates: string[]): string[] {
  const t = target.toLowerCase();
  return [...candidates]
    .map(c => ({ name: c, dist: levenshtein(t, c.toLowerCase()) }))
    .sort((a, b) => a.dist - b.dist)
    .map(c => c.name);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return prev[n];
}
