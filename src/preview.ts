import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AslDefinition, AslParser, GraphData, SubGraph } from './aslParser';

export class PreviewPanel {
  static currentPanel: PreviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _currentDoc: vscode.TextDocument | undefined;
  /** Set of tab IDs from the last full render — used to detect structural changes */
  private _renderedTabIds = new Set<string>();

  static create(context: vscode.ExtensionContext, doc: vscode.TextDocument) {
    if (PreviewPanel.currentPanel) {
      PreviewPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
      PreviewPanel.currentPanel.update(doc);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'steplensPreview',
      'StepLens Preview',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'webview'))],
      }
    );
    PreviewPanel.currentPanel = new PreviewPanel(panel, context, doc);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _context: vscode.ExtensionContext,
    doc: vscode.TextDocument
  ) {
    this._panel = panel;
    this._currentDoc = doc;
    this._render();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      msg => {
        if (msg.type === 'goto' && this._currentDoc) {
          const editor = vscode.window.visibleTextEditors.find(
            e => e.document === this._currentDoc
          );
          if (editor) {
            const lines = this._currentDoc.getText().split('\n');
            const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`^\\s+(${esc(msg.state as string)}|"${esc(msg.state as string)}")\\s*:`);
            const lineIdx = lines.findIndex(l => re.test(l));
            if (lineIdx >= 0) {
              const pos = new vscode.Position(lineIdx, 0);
              editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
              editor.selection = new vscode.Selection(pos, pos);
            }
          }
        } else if (msg.type === 'export') {
          this._handleExport(msg.format as string, msg.data as string).catch(console.error);
        }
      },
      null,
      this._disposables
    );
  }

  update(doc: vscode.TextDocument) {
    this._currentDoc = doc;
    this._render();
  }

  highlightState(stateName: string) {
    this._panel.webview.postMessage({ type: 'highlight', state: stateName });
  }

  private _render() {
    if (!this._currentDoc) return;
    const parsed = AslParser.parse(this._currentDoc.getText(), this._currentDoc.languageId);
    if (!parsed) {
      this._renderedTabIds.clear();
      this._panel.webview.html = this._errorHtml('Aucune définition Step Functions détectée dans ce fichier.');
      return;
    }

    const graphData = AslParser.toGraphData(parsed.definition);
    const subGraphs = AslParser.extractSubGraphs(parsed.definition);

    type TabEntry = { id: string; label: string; data: GraphData };
    const tabs: TabEntry[] = [
      { id: 'main', label: 'Main', data: graphData },
      ...subGraphs.map(sg => ({ id: sg.id, label: sg.label, data: sg.data })),
    ];
    const tabIds = new Set(tabs.map(t => t.id));

    // Same tab structure → update in place (preserves zoom/pan)
    const sameStructure =
      this._renderedTabIds.size > 0 &&
      tabIds.size === this._renderedTabIds.size &&
      [...tabIds].every(id => this._renderedTabIds.has(id));

    if (sameStructure) {
      const nodeToTab: Record<string, string> = {};
      for (const sg of subGraphs) {
        if (!(sg.parentStateName in nodeToTab)) nodeToTab[sg.parentStateName] = sg.id;
      }
      this._panel.webview.postMessage({ type: 'update', tabs, nodeToTab });
      return;
    }

    // Structure changed (new/removed Parallel|Map state) → full rebuild
    this._renderedTabIds = tabIds;
    this._panel.webview.html = this._buildHtml(graphData, parsed.definition, subGraphs);
  }

  private _buildHtml(graph: GraphData, _def: AslDefinition, subGraphs: SubGraph[]): string {
    type TabEntry = { id: string; label: string; data: GraphData };

    const tabs: TabEntry[] = [
      { id: 'main', label: 'Main', data: graph },
      ...subGraphs.map(sg => ({ id: sg.id, label: sg.label, data: sg.data })),
    ];

    // state name → first sub-graph tab id (for double-click navigation)
    const nodeToTab: Record<string, string> = {};
    for (const sg of subGraphs) {
      if (!(sg.parentStateName in nodeToTab)) nodeToTab[sg.parentStateName] = sg.id;
    }

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const tabButtonsHtml = tabs.map((t, i) => {
      const sg = subGraphs.find(s => s.id === t.id);
      const badge = sg ? `<span class="tab-badge">${sg.type}</span>` : '';
      const count = t.data.nodes.filter(n => n.type !== 'START' && n.type !== 'END').length;
      return `<button class="tab-btn${i === 0 ? ' active' : ''}" data-id="${t.id}">${esc(t.label)}<span class="tab-count">${count}</span>${badge}</button>`;
    }).join('\n    ');

    const panesHtml = tabs.map((t, i) =>
      `<div id="pane-${t.id}" class="graph-pane${i === 0 ? ' active' : ''}"><div id="cy-${t.id}" class="cy-container"></div></div>`
    ).join('\n  ');

    const templatePath = path.join(this._context.extensionPath, 'webview', 'preview.html');
    let template: string;
    try {
      template = fs.readFileSync(templatePath, 'utf8');
    } catch {
      vscode.window.showErrorMessage(
        "StepLens: template de prévisualisation introuvable — réinstallez l'extension."
      );
      return this._errorHtml("Erreur interne : template manquant. Réinstallez l'extension.");
    }

    const vendorUri = this._panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(this._context.extensionPath, 'webview', 'vendor.js'))
    );

    // Escape < and > so state names containing </script> cannot break the HTML context
    const safeJson = (v: unknown) => JSON.stringify(v)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    return template
      .replace('{{CSP_SOURCE}}', this._panel.webview.cspSource)
      .replace('{{VENDOR_URI}}', vendorUri.toString())
      .replace('{{TAB_BUTTONS}}', tabButtonsHtml)
      .replace('{{PANES}}', panesHtml)
      .replace('{{TABS_JSON}}', safeJson(tabs))
      .replace('{{NODE_TO_TAB_JSON}}', safeJson(nodeToTab))
      .replace('{{HINT_SUBGRAPHS}}', subGraphs.length > 0 ? ' · Double-click Parallel/Map to explore sub-graph' : '');
  }

  private _errorHtml(msg: string): string {
    return `<!DOCTYPE html><html><body style="background:#1e1e1e;color:#858585;padding:20px;font-family:sans-serif;">
      <p>${msg}</p>
    </body></html>`;
  }

  private async _handleExport(format: string, dataUri: string) {
    const base64 = dataUri.split(',')[1];
    if (!base64) return;
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`stepfunction.${ext}`),
      filters: format === 'png'
        ? { 'PNG Image': ['png'] }
        : { 'JPEG Image': ['jpg', 'jpeg'] },
    });
    if (saveUri) {
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(base64, 'base64'));
      vscode.window.showInformationMessage(`StepLens: exporté → ${path.basename(saveUri.fsPath)}`);
    }
  }

  dispose() {
    PreviewPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
