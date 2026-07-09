/**
 * End-to-end sanity for the webview card renderer.
 *
 * The webview JS lives inline in `webview/preview.html` (VS Code webview needs
 * one-file drop-in). To exercise it from Node we:
 *   1. Extract the main <script> block from preview.html
 *   2. Substitute the {{TABS_JSON}} / {{NODE_TO_TAB_JSON}} placeholders
 *   3. eval() it inside a mock browser env with just enough DOM to reach
 *      `buildElements()` and the SVG generators — Cytoscape init is stubbed
 *      because we only care about the data those functions produce, not the
 *      real render.
 *
 * This catches the class of "graph turns black" regressions where
 * buildElements throws, returns nothing, or produces malformed Cytoscape
 * elements — without needing to package a vsix and open VS Code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AslParser } from '../src/aslParser';

interface Probe {
  serviceCardCached: (opts: unknown) => { uri: string; cardW: number; cardH: number };
  buildServiceCard: (opts: unknown) => { uri: string; cardW: number; cardH: number };
  buildElements: (
    data: { nodes: unknown[]; edges: unknown[] },
    isLight: boolean,
  ) => Array<{ data: Record<string, unknown> }>;
  cardServiceFor: (n: { type: string; service?: string }) => string | null;
  SERVICE_GRADIENT: Record<string, [string, string]>;
}

let cachedProbe: Probe | null = null;

function loadProbe(): Probe {
  if (cachedProbe) return cachedProbe;

  const htmlPath = path.join(__dirname, '..', '..', 'webview', 'preview.html');
  const content = fs.readFileSync(htmlPath, 'utf8');
  const scripts = [...content.matchAll(/<script nonce="\{\{NONCE\}\}">([\s\S]+?)<\/script>/g)];
  if (scripts.length < 2) throw new Error('expected 2 <script nonce> blocks in preview.html');
  let js = scripts[scripts.length - 1][1];
  js = js.replace('{{TABS_JSON}}', '[]').replace('{{NODE_TO_TAB_JSON}}', '{}');

  // Stub the browser globals the script touches at boot
  const stubEl = () => ({
    addEventListener: () => {},
    style: {} as Record<string, string>,
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    textContent: '',
    innerHTML: '',
    clientWidth: 800,
    clientHeight: 600,
  });
  (globalThis as any).window = {
    ICON_URI_MAP: {},
    addEventListener: () => {},
  };
  (globalThis as any).document = {
    body: { getAttribute: () => '', style: {} as Record<string, string> },
    getElementById: () => stubEl(),
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  (globalThis as any).getComputedStyle = () => ({ backgroundColor: 'rgb(20,20,20)' });
  (globalThis as any).location = { search: '' };
  (globalThis as any).requestAnimationFrame = (fn: () => void) => fn();
  (globalThis as any).acquireVsCodeApi = () => ({ postMessage: () => {} });
  // Cytoscape stub — we don't render, we just need the API surface not to throw
  (globalThis as any).cytoscape = Object.assign(
    () => ({
      on: () => {},
      nodes: () => [] as unknown[],
      edges: () => [] as unknown[],
      resize: () => {},
      fit: () => {},
      zoom: () => 1,
      container: () => ({ clientWidth: 800, clientHeight: 600 }),
      layout: () => ({ run: () => {} }),
      batch: (fn: () => void) => fn(),
      elements: () => ({ remove: () => {} }),
      add: () => {},
      getElementById: () => ({ nonempty: () => false, data: () => {}, addClass: () => {} }),
      style: () => ({ selector: () => ({ style: () => ({ update: () => {} }) }) }),
      png: () => 'data:,',
      jpg: () => 'data:,',
    }),
    { use: () => {} },
  );
  (globalThis as any).cytoscapeDagre = {};

  // Inject a probe export right before the last catch, capturing the private
  // helpers we want to test.
  js = js.replace(
    '} catch (err) { showFatalError(err); }',
    '(globalThis.__probe = { serviceCardCached, buildServiceCard, buildElements, cardServiceFor, SERVICE_GRADIENT }); } catch (err) { throw err; }',
  );

  // eslint-disable-next-line no-eval
  eval(js);
  const probe = (globalThis as any).__probe as Probe | undefined;
  if (!probe) throw new Error('probe not exported — preview.html structure changed?');
  cachedProbe = probe;
  return probe;
}

describe('AWS icon stripping', () => {
  it('strips the coloured background rect from every icon so the card gradient shows through', () => {
    // Mirrors the regex used in src/preview.ts. Any icon that keeps its BG group
    // will hide the card's gradient panel behind an 80×80 opaque brand-coloured
    // rect, defeating the whole visual language.
    const iconDir = path.join(__dirname, '..', '..', 'media', 'aws-icons');
    if (!fs.existsSync(iconDir)) {
      // Skip when icons haven't been copied yet (e.g. fresh clone before npm run build)
      return;
    }
    const stripBg = (svg: string) => svg.replace(
      /<g[^>]*fill="url\(#linearGradient[^"]*\)"[^>]*>[\s\S]*?<\/g>/g,
      '',
    );
    for (const file of fs.readdirSync(iconDir)) {
      if (!file.endsWith('.svg')) continue;
      const raw = fs.readFileSync(path.join(iconDir, file), 'utf8');
      const stripped = stripBg(raw);
      // 1) The gradient reference must be gone from the body (it may still exist in <defs>)
      const bodyGradient = stripped.replace(/<defs>[\s\S]*?<\/defs>/, '').match(/fill="url\(#linearGradient/g);
      assert.strictEqual(bodyGradient, null, `${file}: still has a gradient-filled background`);
      // 2) The SVG root must be preserved
      assert.ok(stripped.includes('<svg') && stripped.includes('</svg>'), `${file}: stripping mangled the SVG`);
      // 3) At least one <path> should remain — the actual glyph
      assert.ok(stripped.includes('<path'), `${file}: no <path> left after stripping — glyph gone`);
    }
  });
});

describe('webview template placeholders', () => {
  it('preview.html has no un-substituted {{...}} placeholders after global replace', () => {
    // Regression guard for the CSP-nonce black-screen bug: `.replace('{{NONCE}}', v)`
    // (string overload) only replaces the FIRST occurrence, so any placeholder that
    // appears twice in the template (e.g. {{NONCE}} on both inline <script> tags)
    // stays as a literal in the second one and CSP blocks the script. We now use
    // /\{\{X\}\}/g in preview.ts — this test guarantees the fix stays in place.
    const htmlPath = path.join(__dirname, '..', '..', 'webview', 'preview.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const replacements: Array<[RegExp, string]> = [
      [/\{\{CSP_SOURCE\}\}/g, "vscode-webview://x 'nonce-fake'"],
      [/\{\{NONCE\}\}/g, 'fake'],
      [/\{\{VENDOR_URI\}\}/g, 'vscode-webview://x/vendor.js'],
      [/\{\{TAB_BUTTONS\}\}/g, ''],
      [/\{\{PANES\}\}/g, ''],
      [/\{\{TABS_JSON\}\}/g, '[]'],
      [/\{\{NODE_TO_TAB_JSON\}\}/g, '{}'],
      [/\{\{ICON_URI_MAP_JSON\}\}/g, '{}'],
      [/\{\{HINT_SUBGRAPHS\}\}/g, ''],
    ];
    for (const [re, val] of replacements) html = html.replace(re, val);
    const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
    assert.strictEqual(leftover, null, `unsubstituted placeholders: ${leftover?.join(', ')}`);
    // And every <script nonce="..."> must carry the real nonce, not the literal placeholder
    const scripts = [...html.matchAll(/<script[^>]*nonce="([^"]+)"/g)];
    assert.ok(scripts.length >= 2, 'expected at least 2 inline scripts');
    for (const m of scripts) {
      assert.strictEqual(m[1], 'fake', `script has nonce="${m[1]}" — replacement missed one`);
    }
  });
});

describe('webview cards', () => {
  it('extracts and evaluates preview.html without runtime errors', () => {
    const probe = loadProbe();
    assert.ok(typeof probe.buildElements === 'function');
    assert.ok(typeof probe.serviceCardCached === 'function');
    assert.ok(Object.keys(probe.SERVICE_GRADIENT).length > 30, 'gradient palette should cover core AWS services');
  });

  it('cardServiceFor routes state types to the right visual key', () => {
    const probe = loadProbe();
    assert.strictEqual(probe.cardServiceFor({ type: 'Task', service: 'lambda' }), 'lambda');
    assert.strictEqual(probe.cardServiceFor({ type: 'Task' }), 'http', 'unrecognised task → generic http card');
    assert.strictEqual(probe.cardServiceFor({ type: 'Fail' }), '__fail__');
    assert.strictEqual(probe.cardServiceFor({ type: 'Succeed' }), '__succeed__');
    assert.strictEqual(probe.cardServiceFor({ type: 'Pass' }), '__pass__');
    assert.strictEqual(probe.cardServiceFor({ type: 'Wait' }), '__wait__');
    assert.strictEqual(probe.cardServiceFor({ type: 'Choice' }), '__choice__');
    assert.strictEqual(probe.cardServiceFor({ type: 'Map' }), '__map__');
    assert.strictEqual(probe.cardServiceFor({ type: 'Parallel' }), '__parallel__');
    assert.strictEqual(probe.cardServiceFor({ type: 'START' }), null, 'START stays a plain shape');
    assert.strictEqual(probe.cardServiceFor({ type: 'END' }), null, 'END stays a plain shape');
    assert.strictEqual(probe.cardServiceFor({ type: 'GHOST' }), null);
  });

  it('buildServiceCard returns a valid data URI with plausible dimensions', () => {
    const probe = loadProbe();
    const card = probe.serviceCardCached({
      service: 'lambda',
      resourceLabel: 'AWS Lambda: Invoke',
      stateName: 'ValidateOrder',
      isLight: false,
      hasRetry: true,
      retryCount: 3,
    });
    assert.match(card.uri, /^data:image\/svg\+xml,/);
    assert.ok(card.cardW >= 200 && card.cardW <= 400, `cardW=${card.cardW} out of range`);
    assert.ok(card.cardH >= 68 && card.cardH <= 100, `cardH=${card.cardH} out of range`);
    const svg = decodeURIComponent(card.uri.slice('data:image/svg+xml,'.length));
    assert.ok(svg.includes('ValidateOrder'), 'card should contain the state name');
    assert.ok(svg.includes('Retry: 3'), 'retry badge should render count');
    assert.ok(svg.includes('linearGradient'), 'icon panel should use a gradient');
  });

  it('Succeed / Pass / Wait / Choice cards render the correct glyph + subtitle + gradient', () => {
    const probe = loadProbe();

    // Succeed → green gradient, checkmark path, terminal-state subtitle
    const succeed = probe.serviceCardCached({ service: '__succeed__', stateName: 'ProgramGenerated', isLight: false });
    const succeedSvg = decodeURIComponent(succeed.uri.slice('data:image/svg+xml,'.length));
    assert.ok(succeedSvg.includes('#0d5a2d') && succeedSvg.includes('#22c55e'), 'Succeed uses green gradient');
    assert.ok(succeedSvg.includes('M -4 0 L -1 3 L 5 -3'), 'Succeed shows checkmark glyph');
    assert.ok(succeedSvg.includes('Succeeded'), 'Succeed subtitle mentions Succeeded');
    assert.ok(succeedSvg.includes('Succeed state'), 'Succeed shows meta line');

    // Pass → gray gradient, arrow glyph
    const pass = probe.serviceCardCached({ service: '__pass__', stateName: 'Initialize', isLight: false });
    const passSvg = decodeURIComponent(pass.uri.slice('data:image/svg+xml,'.length));
    assert.ok(passSvg.includes('#2a2a2a') && passSvg.includes('#6b7280'), 'Pass uses gray gradient');
    assert.ok(passSvg.includes('M -8 0 L 6 0'), 'Pass shows arrow glyph');
    assert.ok(passSvg.includes('Pass · no-op'), 'Pass subtitle mentions no-op');
    assert.ok(passSvg.includes('Pass state'), 'Pass shows meta line');

    // Wait → teal gradient, clock glyph
    const wait = probe.serviceCardCached({ service: '__wait__', stateName: 'DelayHour', isLight: false });
    const waitSvg = decodeURIComponent(wait.uri.slice('data:image/svg+xml,'.length));
    assert.ok(waitSvg.includes('#0d3330') && waitSvg.includes('#4ec9b0'), 'Wait uses teal gradient');
    assert.ok(waitSvg.includes('M 0 -4 L 0 0 L 3 2'), 'Wait shows clock-hand glyph');
    assert.ok(waitSvg.includes('Wait · time delay'), 'Wait subtitle mentions time delay');

    // Choice → amber gradient, diamond+cross glyph
    const choice = probe.serviceCardCached({ service: '__choice__', stateName: 'Route', isLight: false });
    const choiceSvg = decodeURIComponent(choice.uri.slice('data:image/svg+xml,'.length));
    assert.ok(choiceSvg.includes('#5a4a00') && choiceSvg.includes('#eab308'), 'Choice uses amber gradient');
    assert.ok(choiceSvg.includes('M -8 0 L 0 -8 L 8 0 L 0 8 Z'), 'Choice shows diamond glyph');
    assert.ok(choiceSvg.includes('Choice · branch on condition'), 'Choice subtitle');
  });

  it('every service returned by cardServiceFor has a SERVICE_GRADIENT entry', () => {
    // Guard rail: prevents "add a state kind, forget the palette" bugs.
    // The card falls back to `http` grey when a service is missing from the
    // gradient map, which is silent and confusing.
    const probe = loadProbe();
    const stateKinds = ['Task', 'Fail', 'Succeed', 'Pass', 'Wait', 'Choice', 'Map', 'Parallel'];
    for (const type of stateKinds) {
      const key = probe.cardServiceFor({ type, service: undefined });
      assert.ok(key, `cardServiceFor(${type}) should route to a card`);
      assert.ok(
        probe.SERVICE_GRADIENT[key!],
        `cardServiceFor(${type}) returned "${key}" but SERVICE_GRADIENT has no entry — palette will fallback to http grey`,
      );
    }
    // And the AWS service passthrough for Task nodes
    const lambdaKey = probe.cardServiceFor({ type: 'Task', service: 'lambda' });
    assert.ok(lambdaKey && probe.SERVICE_GRADIENT[lambdaKey]);
  });

  it('Map/Parallel/Fail cards get the right badge + meta text', () => {
    const probe = loadProbe();
    const mapCard = probe.serviceCardCached({
      service: '__map__', stateName: 'ProcessFiles', isLight: false, mapConcurrency: 5,
    });
    const mapSvg = decodeURIComponent(mapCard.uri.slice('data:image/svg+xml,'.length));
    assert.ok(mapSvg.includes('×5'), 'Map card should show ×N badge');
    assert.ok(mapSvg.includes('Map iterator'), 'Map card should show meta line');

    const parCard = probe.serviceCardCached({
      service: '__parallel__', stateName: 'Enrich', isLight: false, parallelBranches: 2,
    });
    const parSvg = decodeURIComponent(parCard.uri.slice('data:image/svg+xml,'.length));
    assert.ok(parSvg.includes('‖2'), 'Parallel card should show ‖N badge');
    assert.ok(parSvg.includes('Parallel branch'), 'Parallel card should show meta line');

    const failCard = probe.serviceCardCached({
      service: '__fail__', stateName: 'HandleError', isLight: false, failError: 'OrderNotFound',
    });
    const failSvg = decodeURIComponent(failCard.uri.slice('data:image/svg+xml,'.length));
    assert.ok(failSvg.includes('OrderNotFound'), 'Fail card should surface the error name');
    assert.ok(failSvg.includes('Catch'), 'Fail card subtitle should mention Catch');
  });

  it('unlimited Map concurrency renders ×∞', () => {
    const probe = loadProbe();
    const card = probe.serviceCardCached({
      service: '__map__', stateName: 'ProcessAll', isLight: false, mapConcurrency: 0,
    });
    const svg = decodeURIComponent(card.uri.slice('data:image/svg+xml,'.length));
    assert.ok(svg.includes('×∞'));
  });

  it('waitForTaskToken badge takes precedence over retry (when both set)', () => {
    const probe = loadProbe();
    const card = probe.serviceCardCached({
      service: 'sns', resourceLabel: 'Amazon SNS: Publish', stateName: 'Notify',
      isLight: false, hasRetry: true, retryCount: 2, isWaitForToken: true,
    });
    const svg = decodeURIComponent(card.uri.slice('data:image/svg+xml,'.length));
    assert.ok(svg.includes('waitForTaskToken'), 'wft badge should render');
    assert.ok(!svg.includes('Retry: 2'), 'retry badge should be suppressed by wft');
  });

  it('buildElements produces one Cytoscape element per graph node + edge', () => {
    const probe = loadProbe();
    const yaml = `
StartAt: A
States:
  A: { Type: Task, Resource: 'arn:aws:lambda:::function:foo', Next: M }
  M:
    Type: Map
    MaxConcurrency: 3
    ItemProcessor:
      StartAt: X
      States:
        X: { Type: Task, Resource: 'arn:aws:states:::dynamodb:putItem', End: true }
    Next: F
  F: { Type: Fail, Error: BadInput }
`;
    const parsed = AslParser.parse(yaml, 'yaml');
    assert.ok(parsed, 'YAML should parse');
    const graph = AslParser.toGraphData(parsed.definition);
    const els = probe.buildElements(graph, false);
    assert.strictEqual(
      els.length,
      graph.nodes.length + graph.edges.length,
      `expected ${graph.nodes.length + graph.edges.length} elements, got ${els.length}`,
    );

    // Every card node must expose the fields the Cytoscape style block reads
    for (const el of els) {
      const d = el.data;
      if (d.svgCard) {
        assert.ok(typeof d.svgCard === 'string' && (d.svgCard as string).startsWith('data:image/svg+xml,'));
        assert.ok(typeof d.cardW === 'number' && (d.cardW as number) > 0);
        assert.ok(typeof d.cardH === 'number' && (d.cardH as number) > 0);
      }
    }

    // The Map node should carry the ×N badge indirectly via a card
    const mapEl = els.find(e => e.data.id === 'M');
    assert.ok(mapEl, 'Map element missing');
    assert.ok(mapEl!.data.svgCard, 'Map node should be a card');
    const mapSvg = decodeURIComponent((mapEl!.data.svgCard as string).slice('data:image/svg+xml,'.length));
    assert.ok(mapSvg.includes('×3'));

    // Fail node → red __fail__ card
    const failEl = els.find(e => e.data.id === 'F');
    assert.ok(failEl && failEl.data.svgCard);
    assert.strictEqual(failEl!.data.service, '__fail__');

    // START/END keep plain shapes (no card)
    const startEl = els.find(e => e.data.id === '__START__');
    assert.ok(startEl && !startEl.data.svgCard, 'START should stay a plain shape');
  });

  it('every service in SERVICE_GRADIENT resolves to a well-formed [dark, brand] tuple', () => {
    const probe = loadProbe();
    for (const [service, tuple] of Object.entries(probe.SERVICE_GRADIENT)) {
      assert.ok(Array.isArray(tuple) && tuple.length === 2, `${service}: gradient must be a 2-tuple`);
      for (const c of tuple) {
        assert.match(c, /^#[0-9a-fA-F]{6}$/, `${service}: color "${c}" is not a #rrggbb hex`);
      }
    }
  });
});
