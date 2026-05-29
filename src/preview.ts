import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
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
        retainContextWhenHidden: true,
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

    this._panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.visible) {
        this._panel.webview.postMessage({ type: 'resize' });
      }
    }, null, this._disposables);

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
        } else if (msg.type === 'exportHtml') {
          this._handleExportHtml().catch(console.error);
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
      this._panel.webview.html = this._errorHtml('No Step Functions definition detected in this file.');
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
        "StepLens: preview template not found — please reinstall the extension."
      );
      return this._errorHtml("Internal error: template missing. Please reinstall the extension.");
    }

    const vendorUri = this._panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(this._context.extensionPath, 'webview', 'vendor.js'))
    );

    const nonce = crypto.randomBytes(16).toString('base64');

    // Escape < and > so state names containing </script> cannot break the HTML context
    const safeJson = (v: unknown) => JSON.stringify(v)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    return template
      .replace('{{CSP_SOURCE}}', `${this._panel.webview.cspSource} 'nonce-${nonce}'`)
      .replace('{{NONCE}}', nonce)
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
      vscode.window.showInformationMessage(`StepLens: exported → ${path.basename(saveUri.fsPath)}`);
    }
  }

  private async _handleExportHtml() {
    if (!this._currentDoc) return;
    const parsed = AslParser.parse(this._currentDoc.getText(), this._currentDoc.languageId);
    if (!parsed) {
      vscode.window.showWarningMessage('StepLens: no Step Functions definition found.');
      return;
    }

    const graphData = AslParser.toGraphData(parsed.definition);
    const subGraphs = AslParser.extractSubGraphs(parsed.definition);

    type TabEntry = { id: string; label: string; data: GraphData };
    const tabs: TabEntry[] = [
      { id: 'main', label: 'Main', data: graphData },
      ...subGraphs.map(sg => ({ id: sg.id, label: sg.label, data: sg.data })),
    ];
    const nodeToTab: Record<string, string> = {};
    for (const sg of subGraphs) {
      if (!(sg.parentStateName in nodeToTab)) nodeToTab[sg.parentStateName] = sg.id;
    }

    const vendorPath = path.join(this._context.extensionPath, 'webview', 'vendor.js');
    let vendorJs: string;
    try {
      vendorJs = fs.readFileSync(vendorPath, 'utf8');
    } catch {
      vscode.window.showErrorMessage('StepLens: could not read vendor.js for HTML export.');
      return;
    }

    const title = path.basename(this._currentDoc.fileName, path.extname(this._currentDoc.fileName));
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${title}.html`),
      filters: { 'HTML File': ['html'] },
    });
    if (!saveUri) return;

    const html = this._buildExportHtml(tabs, nodeToTab, vendorJs, title);
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html, 'utf8'));
    vscode.window.showInformationMessage(`StepLens: exported → ${path.basename(saveUri.fsPath)}`);
  }

  private _buildExportHtml(
    tabs: Array<{ id: string; label: string; data: GraphData }>,
    nodeToTab: Record<string, string>,
    vendorJs: string,
    title: string
  ): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeJson = (v: unknown) => JSON.stringify(v)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    const tabButtonsHtml = tabs.map((t, i) => {
      const count = t.data.nodes.filter(n => n.type !== 'START' && n.type !== 'END').length;
      return `<button class="tab-btn${i === 0 ? ' active' : ''}" data-id="${t.id}">${esc(t.label)}<span class="tab-count">${count}</span></button>`;
    }).join('\n    ');

    const panesHtml = tabs.map((t, i) =>
      `<div id="pane-${t.id}" class="graph-pane${i === 0 ? ' active' : ''}"><div id="cy-${t.id}" class="cy-container"></div></div>`
    ).join('\n  ');

    const hasSubgraphs = tabs.length > 1;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StepLens — ${esc(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #141414; font-family: 'Segoe UI', system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    #tab-bar { display: flex; align-items: center; gap: 3px; background: #1c1c1c; border-bottom: 1px solid #2a2a2a; height: 36px; padding: 0 8px; flex-shrink: 0; overflow-x: auto; }
    .tab-btn { background: none; border: 1px solid transparent; border-radius: 4px; color: #555; cursor: pointer; font-size: 11px; font-family: inherit; padding: 3px 10px; white-space: nowrap; transition: all 0.1s; }
    .tab-btn.active { background: #2a2a2a; border-color: #3a3a3a; color: #ddd; }
    .tab-btn:hover:not(.active) { color: #999; background: #1e1e1e; }
    .back-btn { background: #1a1a2e; border: 1px solid #333; border-radius: 4px; color: #7b8cde; cursor: pointer; font-size: 11px; font-family: inherit; padding: 3px 9px; white-space: nowrap; transition: all 0.1s; flex-shrink: 0; }
    .back-btn:hover { color: #aab4f0; border-color: #555; background: #202038; }
    .tab-count { display: inline-block; background: #2a2a2a; color: #555; border-radius: 8px; font-size: 9px; padding: 0 4px; margin-left: 3px; }
    .tab-sep { flex: 1; }
    .ctrl-btn { background: #1a1a1a; border: 1px solid #333; border-radius: 4px; color: #666; cursor: pointer; font-size: 10px; font-family: inherit; padding: 3px 9px; transition: all 0.1s; white-space: nowrap; }
    .ctrl-btn:hover { color: #ccc; border-color: #555; background: #222; }
    #graph-area { flex: 1; position: relative; overflow: hidden; }
    .graph-pane { position: absolute; top: 0; right: 0; bottom: 0; left: 0; visibility: hidden; pointer-events: none; }
    .graph-pane.active { visibility: visible; pointer-events: auto; }
    .cy-container { width: 100%; height: 100%; }
    #hint { position: fixed; bottom: 8px; left: 10px; font-size: 10px; color: #3a3a3a; }
  </style>
</head>
<body>
  <div id="tab-bar">
    <button id="btn-back" class="back-btn" style="display:none">← Main</button>
    ${tabButtonsHtml}
    <div class="tab-sep"></div>
    <button class="ctrl-btn" id="btn-theme">☀</button>
    <button class="ctrl-btn" id="btn-fit">⊡ Fit</button>
  </div>
  <div id="graph-area">
    ${panesHtml}
  </div>
  <div id="hint">Scroll to zoom · Drag to pan${hasSubgraphs ? ' · Double-click Parallel/Map to explore sub-graph' : ''}</div>

  <script>${vendorJs}</script>
  <script>
    const TABS        = ${safeJson(tabs)};
    const NODE_TO_TAB = ${safeJson(nodeToTab)};

    cytoscape.use(cytoscapeDagre);

    const NS = {
      Task:     { bg: '#1a3d6e', border: '#4a9de8', shape: 'round-rectangle' },
      Choice:   { bg: '#2e2d00', border: '#ffe033', shape: 'diamond'         },
      Wait:     { bg: '#0d2e2b', border: '#4ec9b0', shape: 'round-rectangle' },
      Pass:     { bg: '#252525', border: '#6b6b6b', shape: 'rectangle'       },
      Succeed:  { bg: '#0d2e18', border: '#4caf50', shape: 'ellipse'         },
      Fail:     { bg: '#2e0d0d', border: '#f44336', shape: 'ellipse'         },
      Parallel: { bg: '#2a1a3d', border: '#a78bfa', shape: 'round-rectangle' },
      Map:      { bg: '#2a1a3d', border: '#a78bfa', shape: 'round-rectangle' },
      START:    { bg: '#1a1a3a', border: '#9b59b6', shape: 'ellipse'         },
      END:      { bg: '#1a1a3a', border: '#9b59b6', shape: 'ellipse'         },
      GHOST:    { bg: '#2a0000', border: '#f44336', shape: 'rectangle'       },
    };

    const CY_STYLE = [
      { selector: 'node', style: { 'background-color': 'data(bg)', 'border-color': 'data(border)', 'border-width': 2, 'shape': 'data(shape)', 'label': 'data(label)', 'color': '#e0e0e0', 'font-size': 11, 'font-family': 'Consolas, monospace', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 140, 'padding': 10, 'width': 'label', 'height': 32, 'min-width': 80 } },
      { selector: 'node[type="Choice"]', style: { 'height': 48, 'min-width': 100 } },
      { selector: 'node[type="START"], node[type="END"]', style: { 'font-weight': 'bold', 'width': 60, 'height': 28, 'font-size': 12 } },
      { selector: 'node[type="GHOST"]', style: { 'border-style': 'dashed', 'border-width': 2, 'color': '#f44336', 'font-style': 'italic', 'font-size': 10 } },
      { selector: 'node[type="Parallel"], node[type="Map"]', style: { 'border-style': 'dashed', 'border-width': 2.5, 'font-style': 'italic' } },
      { selector: 'node[hasRetry="true"]', style: { 'underlay-color': '#4caf50', 'underlay-opacity': 0.08, 'underlay-padding': 3 } },
      { selector: 'node:active', style: { 'overlay-opacity': 0 } },
      { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, 'line-color': '#3d3d3d', 'target-arrow-color': '#3d3d3d', 'label': 'data(label)', 'font-size': 9, 'font-family': 'Consolas, monospace', 'color': '#858585', 'text-background-color': '#141414', 'text-background-opacity': 0.85, 'text-background-padding': 2, 'width': 1.5, 'text-wrap': 'wrap', 'text-max-width': 110 } },
      { selector: 'edge[edgeType="catch"]', style: { 'line-color': '#7a1a1a', 'target-arrow-color': '#7a1a1a', 'line-style': 'dashed', 'line-dash-pattern': [6, 3], 'color': '#f44336', 'width': 1.5 } },
      { selector: 'edge[edgeType="branch"], edge[edgeType="default"]', style: { 'line-color': '#4a3d00', 'target-arrow-color': '#4a3d00', 'color': '#a07800' } },
    ];

    const LAYOUT = { name: 'dagre', rankDir: 'TB', ranker: 'network-simplex', nodeSep: 60, rankSep: 90, edgeSep: 20, padding: 40, animate: false };

    function buildElements(graphData) {
      const nodes = graphData.nodes.map(n => {
        const s = NS[n.type] || NS.Task;
        return { data: { id: n.id, label: n.label, type: n.type, bg: s.bg, border: s.border, shape: s.shape, hasRetry: n.hasRetry ? 'true' : 'false' } };
      });
      const edges = graphData.edges.map(e => ({ data: { id: e.id, source: e.source, target: e.target, label: e.label, edgeType: e.edgeType } }));
      return [...nodes, ...edges];
    }

    const instances = {};
    let activeTabId = TABS[0]?.id ?? 'main';

    TABS.forEach(tab => {
      const container = document.getElementById('cy-' + tab.id);
      if (!container) return;
      const cy = cytoscape({ container, elements: buildElements(tab.data), style: CY_STYLE, layout: LAYOUT, wheelSensitivity: 0.5, minZoom: 0.15, maxZoom: 3 });
      cy.on('dblclick', 'node', evt => {
        const id   = evt.target.data('id');
        const type = evt.target.data('type');
        if ((type === 'Parallel' || type === 'Map') && NODE_TO_TAB[id]) switchTab(NODE_TO_TAB[id]);
      });
      instances[tab.id] = cy;
    });

    requestAnimationFrame(() => {
      Object.entries(instances).forEach(([id, cy]) => {
        cy.resize();
        if (id === activeTabId) cy.fit(undefined, 40);
      });
    });

    function switchTab(id) {
      document.querySelectorAll('.graph-pane').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('pane-' + id)?.classList.add('active');
      document.querySelector('.tab-btn[data-id="' + id + '"]')?.classList.add('active');
      activeTabId = id;
      document.getElementById('btn-back').style.display = id === 'main' ? 'none' : '';
      instances[id]?.resize();
      instances[id]?.fit(undefined, 40);
    }

    document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.id)));
    document.getElementById('btn-back').addEventListener('click', () => switchTab('main'));
    document.getElementById('btn-fit').addEventListener('click', () => instances[activeTabId]?.fit(undefined, 40));

    // ── Theme toggle ──────────────────────────────────────────────────────
    let lightTheme = false;
    function applyTheme(light) {
      lightTheme = light;
      document.body.style.background = light ? '#f5f5f5' : '#141414';
      document.getElementById('btn-theme').textContent = light ? '☾' : '☀';
      const labelBg = light ? '#f5f5f5' : '#141414';
      Object.values(instances).forEach(cy => {
        cy.style().selector('edge').style('text-background-color', labelBg).update();
      });
    }
    document.getElementById('btn-theme').addEventListener('click', () => applyTheme(!lightTheme));
  </script>
</body>
</html>`;
  }

  dispose() {
    PreviewPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
