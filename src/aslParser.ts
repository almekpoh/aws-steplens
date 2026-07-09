import * as yaml from 'yaml';

/**
 * CloudFormation intrinsic function tags — used in Serverless Framework and
 * SAM templates that wrap Step Functions ASL. These are not part of standard
 * YAML, so `yaml.parse(text)` warns "TAG_RESOLVE_FAILED" for each occurrence
 * even though our ASL walk never inspects those values. Registering the tag
 * set makes the parser accept them silently and return the raw payload
 * (which we don't consume).
 *
 * Reference: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference.html
 */
const CFN_INTRINSIC_TAGS: yaml.Tags = [
  // Scalar-form intrinsics: `!Ref MyResource`, `!GetAtt Res.Arn`, `!Sub "abc"`
  ...['!Ref', '!GetAtt', '!Sub', '!ImportValue', '!Base64', '!GetAZs',
      '!Condition', '!Transform', '!ToJsonString'].map(tag =>
    ({ tag, resolve: (str: string) => str } as yaml.ScalarTag)),
  // Sequence-form intrinsics: `!Join [":", [a, b]]`, `!GetAtt [R, Arn]`, etc.
  ...['!Join', '!Split', '!Select', '!FindInMap', '!Cidr', '!Sub',
      '!GetAtt', '!If', '!And', '!Or', '!Not', '!Equals', '!ForEach',
      '!Length'].map(tag =>
    ({ tag, collection: 'seq' as const, resolve: (seq: unknown) => seq } as unknown as yaml.CollectionTag)),
];

/** Silent, CFN-aware YAML parser used everywhere in the extension. */
function parseYaml(text: string): unknown {
  return yaml.parse(text, {
    customTags: CFN_INTRINSIC_TAGS,
    // Never log to console — we don't want CFN template noise in the user's dev tools
    logLevel: 'silent',
  });
}

export interface AslCatchClause {
  ErrorEquals: string[];
  Next: string;
  Output?: unknown;
  ResultPath?: string;
  Assign?: Record<string, unknown>;
}

export interface AslChoiceBranch {
  // JSONata style
  Condition?: string;
  // Classic ASL style (Variable / comparison operators)
  Variable?: string;
  Next: string;
  Assign?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AslRetryClause {
  ErrorEquals: string[];
  IntervalSeconds?: number;
  MaxAttempts?: number;
  BackoffRate?: number;
  MaxDelaySeconds?: number;
  JitterStrategy?: 'FULL' | 'NONE';
}

export interface AslItemProcessor {
  StartAt: string;
  States: Record<string, AslState>;
  ProcessorConfig?: {
    Mode?: 'INLINE' | 'DISTRIBUTED';
    ExecutionType?: 'STANDARD' | 'EXPRESS';
  };
}

export interface AslBranch {
  StartAt: string;
  States: Record<string, AslState>;
}

export interface AslState {
  Type: string;
  Next?: string;
  End?: boolean;
  Comment?: string;
  QueryLanguage?: 'JSONata' | 'JSONPath';
  // Task
  Resource?: string;
  Arguments?: Record<string, unknown>;    // JSONata mode
  Parameters?: Record<string, unknown>;   // JSONPath mode
  Output?: unknown;                       // JSONata mode (replaces OutputPath)
  OutputPath?: string;                    // JSONPath mode
  InputPath?: string;                     // JSONPath mode
  ResultPath?: string;                    // JSONPath mode (null = discard result)
  ResultSelector?: Record<string, unknown>; // JSONPath mode only
  TimeoutSeconds?: number;
  TimeoutSecondsPath?: string;            // JSONPath only, mutually exclusive with TimeoutSeconds
  HeartbeatSeconds?: number;
  HeartbeatSecondsPath?: string;          // JSONPath only, mutually exclusive with HeartbeatSeconds
  Credentials?: { RoleArn: string | Record<string, string> };
  Retry?: AslRetryClause[];
  Catch?: AslCatchClause[];
  // Fail
  Error?: string;
  Cause?: string;
  ErrorPath?: string;                     // JSONPath only, mutually exclusive with Error
  CausePath?: string;                     // JSONPath only, mutually exclusive with Cause
  // Choice
  Choices?: AslChoiceBranch[];
  Default?: string;
  // Wait
  Seconds?: number;
  SecondsPath?: string;                   // JSONPath only
  Timestamp?: string;
  TimestampPath?: string;                 // JSONPath only
  // Pass
  Result?: unknown;
  // JSONata
  Assign?: Record<string, unknown>;
  // Parallel / Map
  Branches?: AslBranch[];
  Iterator?: AslBranch;                   // classic ASL Map format (deprecated)
  ItemProcessor?: AslItemProcessor;       // newer ASL Map format (SDK v2 / console export)
  MaxConcurrency?: number;                // Map: 0 = unlimited
  MaxConcurrencyPath?: string;            // JSONPath only, mutually exclusive with MaxConcurrency
  ItemsPath?: string;                     // JSONPath only
  Items?: unknown;                        // JSONata only (replaces ItemsPath)
  ItemSelector?: Record<string, unknown>; // replaces Parameters for Map
  ToleratedFailureCount?: number;         // distributed Map
  ToleratedFailureCountPath?: string;     // JSONPath only
  ToleratedFailurePercentage?: number;    // distributed Map, 0-100
  ToleratedFailurePercentagePath?: string; // JSONPath only
  ItemReader?: Record<string, unknown>;   // distributed Map — read from S3
  ResultWriter?: Record<string, unknown>; // distributed Map — write to S3
  ItemBatcher?: Record<string, unknown>;  // distributed Map — batch items
  Label?: string;                         // distributed Map, max 40 chars
}

export interface AslDefinition {
  Comment?: string;
  QueryLanguage?: 'JSONata' | 'JSONPath';
  StartAt: string;
  States: Record<string, AslState>;
  TimeoutSeconds?: number;
  Version?: string;
}

export interface ParsedSfn {
  definition: AslDefinition;
  /** true if wrapped in a Serverless Framework config (role/tags/name/definition) */
  isWrapped: boolean;
}

// ── Graph data types for Cytoscape rendering ───────────────────────────────

export interface GraphNode {
  id: string;
  label: string;  // pure state name — badge metadata lives in structured fields below
  type: string;   // Task | Choice | Wait | Pass | Succeed | Fail | Parallel | Map | START | END
  hasRetry?: boolean;
  retryCount?: number;         // number of Retry entries — used to render "↺ Retry: N" badge
  isWaitForToken?: boolean;
  isDistributedMap?: boolean;
  isHttpTask?: boolean;
  service?: string;            // 'lambda' | 'sns' | 'dynamodb' | 'bedrock' | etc.
  serviceAction?: string;      // 'Invoke' | 'Publish' | 'PutItem' | etc.
  resourceLabel?: string;      // 'AWS Lambda: Invoke' — shown as subtitle in card
  mapConcurrency?: number;     // Map only. 0 = unlimited (∞). undefined = no badge.
  parallelBranches?: number;   // Parallel only. undefined = no badge.
  failError?: string;          // Fail only. Error (or Cause if no Error) shown in card subtitle.
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  edgeType: 'normal' | 'catch' | 'branch' | 'default';
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SubGraph {
  id: string;
  label: string;
  type: string;        // 'Parallel' | 'Map'
  parentStateName: string;
  data: GraphData;
}

/** Official display names for Step Functions SDK integration services */
const SERVICE_DISPLAY_NAMES: Record<string, string> = {
  'lambda':           'AWS Lambda',
  'states':           'AWS Step Functions',
  'ecs':              'Amazon ECS',
  'fargate':          'AWS Fargate',
  'batch':            'AWS Batch',
  'dynamodb':         'Amazon DynamoDB',
  's3':               'Amazon S3',
  'athena':           'Amazon Athena',
  'glue':             'AWS Glue',
  'databrew':         'AWS Glue DataBrew',
  'kinesis':          'Amazon Kinesis',
  'firehose':         'Amazon Kinesis Firehose',
  'elasticmapreduce': 'Amazon EMR',
  'emr-containers':   'Amazon EMR on EKS',
  'emr-serverless':   'Amazon EMR Serverless',
  'appsync':          'AWS AppSync',
  'apigateway':       'Amazon API Gateway',
  'events':           'Amazon EventBridge',
  'eventbridge':      'Amazon EventBridge',
  'scheduler':        'Amazon EventBridge Scheduler',
  'sns':              'Amazon SNS',
  'sqs':              'Amazon SQS',
  'sagemaker':        'Amazon SageMaker',
  'comprehend':       'Amazon Comprehend',
  'rekognition':      'Amazon Rekognition',
  'textract':         'Amazon Textract',
  'translate':        'Amazon Translate',
  'polly':            'Amazon Polly',
  'transcribe':       'Amazon Transcribe',
  'lex':              'Amazon Lex',
  'cloudformation':   'AWS CloudFormation',
  'ssm':              'AWS Systems Manager',
  'secretsmanager':   'AWS Secrets Manager',
  'mediaconvert':     'AWS Elemental MediaConvert',
  'iot':              'AWS IoT',
  'codebuild':        'AWS CodeBuild',
  'bedrock':          'Amazon Bedrock',
  'bedrock-agent':    'Amazon Bedrock Agent',
  'http':             'HTTP',
};

/** Convert camelCase or lowercase to PascalCase — e.g. invokeModel → InvokeModel */
function toPascalCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Extract service identifier, action and display label from a Step Functions Resource ARN.
 * Returns empty object for non-Task states or unrecognised ARN formats.
 */
function detectService(resource: string | undefined): {
  service?: string;
  serviceAction?: string;
  resourceLabel?: string;
} {
  if (!resource) return {};

  // Pattern: arn:*:states:::aws-sdk:SERVICE:ACTION[.PATTERN]
  const awsSdkMatch = resource.match(/arn:[^:]*:states:::aws-sdk:([^:.]+):([^.]+)/);
  if (awsSdkMatch) {
    const service = awsSdkMatch[1].toLowerCase();
    const action  = toPascalCase(awsSdkMatch[2]);
    const display = SERVICE_DISPLAY_NAMES[service] ?? service;
    return { service, serviceAction: action, resourceLabel: `${display}: ${action}` };
  }

  // Pattern: arn:*:states:::SERVICE:ACTION[.PATTERN]
  const sdkMatch = resource.match(/arn:[^:]*:states:::([^:.]+):([^.]+)/);
  if (sdkMatch) {
    const service = sdkMatch[1].toLowerCase();
    const action  = toPascalCase(sdkMatch[2]);
    const display = SERVICE_DISPLAY_NAMES[service] ?? service;
    return { service, serviceAction: action, resourceLabel: `${display}: ${action}` };
  }

  // Pattern: direct Lambda ARN — arn:aws:lambda:REGION:ACCOUNT:function:NAME
  if (/arn:[^:]*:lambda:/.test(resource)) {
    return { service: 'lambda', serviceAction: 'Invoke', resourceLabel: 'AWS Lambda: Invoke' };
  }

  // Pattern: nested Step Functions — arn:aws:states:REGION:ACCOUNT:stateMachine:NAME
  if (/arn:[^:]*:states:[^:]+:[^:]+:stateMachine:/.test(resource)) {
    return { service: 'states', serviceAction: 'StartExecution', resourceLabel: 'AWS Step Functions: StartExecution' };
  }

  return {};
}

export class AslParser {
  /**
   * If the document is a SAM/CloudFormation template that uses
   * `AWS::Serverless::StateMachine` with a `DefinitionUri` pointing to a
   * local file, return that relative path.  Returns null in all other cases
   * (inline Definition, S3 DefinitionUri, CF StateMachine, non-template).
   *
   * The path is relative to the template file and suitable for use with
   * `parseWithDefinitionUri`.
   */
  static extractDefinitionUri(text: string, languageId: string): string | null {
    try {
      const raw = languageId === 'json' ? JSON.parse(text) : parseYaml(text);
      if (!raw?.Resources || typeof raw.Resources !== 'object') return null;

      for (const resource of Object.values(raw.Resources as Record<string, unknown>)) {
        const r = resource as Record<string, unknown>;
        if (r?.Type !== 'AWS::Serverless::StateMachine') continue;

        const props = r?.Properties as Record<string, unknown> | undefined;
        if (!props) continue;

        const uri = props.DefinitionUri;
        // Only local string paths — skip S3 objects ({ Bucket, Key }) and s3:// URIs
        if (typeof uri === 'string' && !uri.startsWith('s3://')) {
          return uri;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Async variant of `parse` that additionally handles SAM `DefinitionUri`.
   *
   * 1. Tries `parse()` (sync, all inline formats).
   * 2. Falls back to `extractDefinitionUri()` + `readFile()` if step 1 fails.
   *
   * `readFile` receives the raw path returned by `extractDefinitionUri` (relative
   * to the template) and must return the file contents as a string.  Inject
   * `vscode.workspace.fs` in production and a simple `fs.readFile` stub in tests.
   */
  static async parseWithDefinitionUri(
    text: string,
    languageId: string,
    readFile: (relativePath: string) => Promise<string>,
  ): Promise<ParsedSfn | null> {
    const direct = AslParser.parse(text, languageId);
    if (direct) return direct;

    const uriPath = AslParser.extractDefinitionUri(text, languageId);
    if (!uriPath) return null;

    try {
      const content = await readFile(uriPath);
      const ext = uriPath.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      const result = AslParser.parse(content, ext);
      // The definition lives in an external file referenced by the template,
      // so it is wrapped — mark it accordingly regardless of the file format.
      if (result) return { ...result, isWrapped: true };
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse a YAML or JSON file and extract the ASL definition.
   *
   * Supported formats:
   *  - Raw ASL                        { StartAt, States }
   *  - Serverless Framework wrapper   { role, tags, name, definition: { StartAt, States } }
   */
  static parse(text: string, languageId: string): ParsedSfn | null {
    try {
      const raw = languageId === 'json'
        ? JSON.parse(text)
        : parseYaml(text);

      if (!raw || typeof raw !== 'object') return null;

      const isStatesObj = (v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v);

      // Raw ASL  { StartAt, States }
      if (isStatesObj(raw.States)) {
        return { definition: raw as AslDefinition, isWrapped: false };
      }

      // Serverless Framework flat wrapper  { definition: { StartAt, States } }
      if (isStatesObj(raw.definition?.States)) {
        return { definition: raw.definition as AslDefinition, isWrapped: true };
      }

      // Serverless Framework named wrapper  { machineName: { definition: { StartAt, States } } }
      for (const value of Object.values(raw)) {
        const v = value as Record<string, unknown>;
        if (v && typeof v === 'object' && isStatesObj((v.definition as Record<string, unknown>)?.States)) {
          return { definition: v.definition as AslDefinition, isWrapped: true };
        }
      }

      // ── CloudFormation / SAM template ──────────────────────────────────────
      // Supported:
      //   AWS::StepFunctions::StateMachine  — Definition (object), DefinitionString
      //   AWS::Serverless::StateMachine     — Definition (map), DefinitionUri (local path only)
      //
      // Not supported (cannot resolve without external access):
      //   DefinitionS3Location / DefinitionUri pointing to S3
      //   DefinitionUri pointing to a local file (requires async file I/O)
      if (raw.Resources && typeof raw.Resources === 'object' && !Array.isArray(raw.Resources)) {
        for (const resource of Object.values(raw.Resources as Record<string, unknown>)) {
          const r = resource as Record<string, unknown>;
          if (
            r?.Type !== 'AWS::StepFunctions::StateMachine' &&
            r?.Type !== 'AWS::Serverless::StateMachine'
          ) continue;

          const props = r?.Properties as Record<string, unknown> | undefined;
          if (!props) continue;

          // 1. Inline Definition object  { StartAt, States }
          //    Works for both CF and SAM.  DefinitionSubstitutions use ${placeholder}
          //    syntax which our ARN validator already skips for non-literal values.
          if (isStatesObj((props.Definition as Record<string, unknown>)?.States)) {
            return { definition: props.Definition as AslDefinition, isWrapped: true };
          }

          // Helper: normalise a CF-resolved string — replace every ${Var} or
          // intrinsic-function object token with the placeholder __CF_REF__ so
          // that JSON.parse can still succeed.
          const stripCfRefs = (s: string) => s.replace(/\$\{[^}]+\}/g, '__CF_REF__');

          // Helper: resolve a CF token to a plain string best-effort.
          // Returns the string as-is, a __CF_REF__ placeholder for intrinsic
          // function objects, or null when the value cannot be reduced.
          const resolveToken = (token: unknown): string | null => {
            if (typeof token === 'string') return token;
            if (token && typeof token === 'object' && !Array.isArray(token)) return '__CF_REF__';
            return null;
          };

          // 2. DefinitionString as a plain JSON string
          if (typeof props.DefinitionString === 'string') {
            try {
              const def = JSON.parse(props.DefinitionString) as unknown as AslDefinition;
              if (isStatesObj(def.States)) return { definition: def, isWrapped: true };
            } catch { /* not valid JSON */ }
          }

          if (props.DefinitionString && typeof props.DefinitionString === 'object') {
            const ds = props.DefinitionString as Record<string, unknown>;

            // 3. DefinitionString: { Fn::Sub: "…" }
            //    Strip ${Variable} refs so JSON.parse can succeed.
            if (typeof ds['Fn::Sub'] === 'string') {
              try {
                const def = JSON.parse(
                  stripCfRefs(ds['Fn::Sub'] as string)
                ) as unknown as AslDefinition;
                if (isStatesObj(def.States)) return { definition: def, isWrapped: true };
              } catch { /* substitutions made it unparseable */ }
            }

            // 4. DefinitionString: { Fn::Join: [sep, [item, …]] }
            //    Documented in CF examples (common for multi-line definitions).
            //    Each item may be a plain string or a CF intrinsic (→ __CF_REF__).
            if (Array.isArray(ds['Fn::Join']) && (ds['Fn::Join'] as unknown[]).length === 2) {
              const [sep, items] = ds['Fn::Join'] as unknown[];
              if (typeof sep === 'string' && Array.isArray(items)) {
                const parts = (items as unknown[]).map(resolveToken).filter((p): p is string => p !== null);
                if (parts.length === (items as unknown[]).length) {
                  try {
                    const joined = parts.join(sep);
                    const def = JSON.parse(stripCfRefs(joined)) as unknown as AslDefinition;
                    if (isStatesObj(def.States)) return { definition: def, isWrapped: true };
                  } catch { /* joined string is not valid JSON */ }
                }
              }
            }
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Collect all state names reachable from StartAt via DFS.
   * Follows Next, Default, Choices[*].Next, Catch[*].Next, and branch StartAt.
   */
  static reachableStates(def: AslDefinition): Set<string> {
    const visited = new Set<string>();
    const stack = [def.StartAt];

    while (stack.length) {
      const name = stack.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);

      const state = def.States[name];
      if (!state) continue;

      if (state.Next) stack.push(state.Next);
      if (state.Default) stack.push(state.Default);
      state.Catch?.forEach(c => stack.push(c.Next));
      state.Choices?.forEach(c => { if (c.Next) stack.push(c.Next); });
      // Note: Parallel branch and Map iterator states are sub-state-machines
      // validated via recursive lint — they are not top-level states.
    }

    return visited;
  }

  /**
   * Convert an ASL definition to Cytoscape-compatible nodes + edges.
   */
  static toGraphData(def: { StartAt: string; States: Record<string, AslState> }): GraphData {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    let edgeIdx = 0;
    const eid = () => `e${edgeIdx++}`;

    // Synthetic start/end nodes
    nodes.push({ id: '__START__', label: 'Start', type: 'START' });

    for (const [name, state] of Object.entries(def.States)) {
      const resourceStr = typeof state.Resource === 'string' ? state.Resource : '';
      const isWaitForToken = resourceStr.includes('waitForTaskToken');
      const isHttpTask = resourceStr.includes('states:::http:invoke');
      const isDistributedMap = state.Type === 'Map' &&
        (state.ItemProcessor as AslItemProcessor | undefined)?.ProcessorConfig?.Mode === 'DISTRIBUTED';

      const retryCount = state.Retry?.length ?? 0;
      const mapConcurrency = state.Type === 'Map' ? state.MaxConcurrency : undefined;
      const parallelBranches = state.Type === 'Parallel' ? state.Branches?.length : undefined;
      const failError = state.Type === 'Fail' ? (state.Error ?? state.Cause) : undefined;

      const serviceInfo = state.Type === 'Task' || state.Type === undefined
        ? detectService(resourceStr)
        : {};

      nodes.push({
        id: name,
        label: name,
        type: state.Type ?? 'Task',
        hasRetry: retryCount > 0,
        retryCount: retryCount > 0 ? retryCount : undefined,
        isWaitForToken,
        isDistributedMap,
        isHttpTask,
        mapConcurrency,
        parallelBranches,
        failError,
        ...serviceInfo,
      });
    }

    // __END__ exists whenever any state is terminal: explicit End, Fail, or Succeed
    const hasEnd = Object.values(def.States).some(
      s => s.End || s.Type === 'Fail' || s.Type === 'Succeed'
    );
    if (hasEnd) nodes.push({ id: '__END__', label: 'End', type: 'END' });

    // Collect all state names referenced as targets but absent from States
    // and materialise them as ghost nodes so Cytoscape never receives an edge
    // pointing to a non-existent node (which can crash the layout engine).
    const ghostIds = new Set<string>();
    const ensureTarget = (target: string) => {
      if (def.States[target] === undefined && target !== '__END__' && target !== '__START__' && !ghostIds.has(target)) {
        ghostIds.add(target);
        nodes.push({ id: target, label: `${target}\n(not found)`, type: 'GHOST' });
      }
    };

    for (const state of Object.values(def.States)) {
      if (state.Next)     ensureTarget(state.Next);
      if (state.Default)  ensureTarget(state.Default);
      state.Catch?.forEach(c => ensureTarget(c.Next));
      state.Choices?.forEach(c => { if (c.Next) ensureTarget(c.Next); });
    }
    if (def.StartAt && def.States[def.StartAt] === undefined) ensureTarget(def.StartAt);

    // Start edge — only if StartAt actually exists (real or ghost node)
    if (def.States[def.StartAt] !== undefined || ghostIds.has(def.StartAt)) {
      edges.push({ id: eid(), source: '__START__', target: def.StartAt, label: '', edgeType: 'normal' });
    }

    for (const [name, state] of Object.entries(def.States)) {
      if (state.Next) {
        edges.push({ id: eid(), source: name, target: state.Next, label: '', edgeType: 'normal' });
      }
      if (state.End || state.Type === 'Fail' || state.Type === 'Succeed') {
        edges.push({ id: eid(), source: name, target: '__END__', label: '', edgeType: 'normal' });
      }
      state.Catch?.forEach(c => {
        const lbl = c.ErrorEquals.join(', ');
        edges.push({ id: eid(), source: name, target: c.Next, label: lbl, edgeType: 'catch' });
      });
      state.Choices?.forEach((c, i) => {
        if (c.Next) {
          let lbl: string;
          if (c.Condition) {
            lbl = String(c.Condition).replace(/\{%\s*|\s*%\}/g, '').trim();
          } else if (c.Variable) {
            lbl = String(c.Variable).split('.').pop() ?? `b${i + 1}`;
          } else {
            lbl = `b${i + 1}`;
          }
          edges.push({ id: eid(), source: name, target: c.Next, label: lbl, edgeType: 'branch' });
        }
      });
      if (state.Default) {
        edges.push({ id: eid(), source: name, target: state.Default, label: 'default', edgeType: 'default' });
      }
    }

    return { nodes, edges };
  }

  /**
   * Collect every state name at every nesting level (top-level + all
   * Parallel branches and Map iterators), deduplicated.
   */
  /**
   * Detect cycles that contain no Choice state — those loops have no
   * conditional exit and will run forever (W-5).
   *
   * Returns one array per detected infinite cycle, each array listing the
   * state names that form the loop (in traversal order).
   *
   * Cycles that include at least one Choice state are intentional polling
   * loops and are NOT reported.
   */
  static findInfiniteCycles(def: AslDefinition): string[][] {
    const states = def.States;
    // 0 = unvisited, 1 = on current DFS path (gray), 2 = fully processed (black)
    const color = new Map<string, 0 | 1 | 2>();
    const path: string[] = [];
    const cycles: string[][] = [];

    const successors = (name: string): string[] => {
      const s = states[name];
      if (!s) return [];
      const out: string[] = [];
      if (s.Next)    out.push(s.Next);
      if (s.Default) out.push(s.Default);
      s.Choices?.forEach(c => { if (c.Next) out.push(c.Next); });
      return out.filter(n => n in states);
    };

    const dfs = (name: string) => {
      const c = color.get(name) ?? 0;
      if (c === 2) return;                // already fully processed
      if (c === 1) {                      // back edge → cycle found
        const idx = path.indexOf(name);
        if (idx >= 0) {
          const cycle = path.slice(idx);
          if (!cycle.some(n => states[n]?.Type === 'Choice')) {
            cycles.push([...cycle]);
          }
        }
        return;
      }
      color.set(name, 1);
      path.push(name);
      for (const next of successors(name)) dfs(next);
      path.pop();
      color.set(name, 2);
    };

    for (const name of Object.keys(states)) {
      if (!color.has(name)) dfs(name);
    }
    return cycles;
  }

  static allStateNames(def: AslDefinition): string[] {
    const names = new Set<string>();
    const walk = (states: Record<string, AslState>) => {
      for (const [name, state] of Object.entries(states)) {
        names.add(name);
        state.Branches?.forEach(b => walk(b.States ?? {}));
        const iter = state.Iterator ?? state.ItemProcessor;
        if (iter) walk(iter.States ?? {});
      }
    };
    walk(def.States);
    return [...names];
  }

  static extractSubGraphs(def: AslDefinition): SubGraph[] {
    const result: SubGraph[] = [];
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');

    const walk = (states: Record<string, AslState>, idPrefix: string) => {
      for (const [name, state] of Object.entries(states)) {
        const safeId = idPrefix ? `${idPrefix}_${safe(name)}` : safe(name);

        if (state.Type === 'Parallel' && state.Branches?.length) {
          state.Branches.forEach((branch, i) => {
            const tabId = `${safeId}_b${i}`;
            result.push({
              id: tabId,
              label: `${name} — Branch ${i + 1}`,
              type: 'Parallel',
              parentStateName: name,
              data: AslParser.toGraphData(branch),
            });
            walk(branch.States ?? {}, tabId);
          });
        } else if (state.Type === 'Map') {
          const iterator = state.Iterator ?? state.ItemProcessor;
          if (iterator) {
            const tabId = `${safeId}_iter`;
            result.push({
              id: tabId,
              label: `${name} — Iterator`,
              type: 'Map',
              parentStateName: name,
              data: AslParser.toGraphData(iterator),
            });
            walk(iterator.States ?? {}, tabId);
          }
        }
      }
    };

    walk(def.States, '');
    return result;
  }

  // ── Rename helpers ─────────────────────────────────────────────────────────

  /**
   * Scan `lines` for every position where `stateName` appears as either:
   *  • a state **declaration** key   →  `  StateName:`  (YAML) / `  "StateName": {`  (JSON)
   *  • a state **reference** value   →  `Next: StateName` / `"Next": "StateName"` (JSON)
   *
   * Returns zero-based `{ line, start, end }` character ranges, suitable for
   * building `vscode.Range` objects without importing VS Code types here.
   */
  static findStateNameOccurrences(
    lines: string[],
    stateName: string,
  ): Array<{ line: number; start: number; end: number }> {
    const result: Array<{ line: number; start: number; end: number }> = [];
    const e = escapeRe(stateName);
    const len = stateName.length;

    // YAML declaration:  `  StateName:` or `  StateName: {` or `  StateName: # comment`
    // The `:` must be followed by end-of-line, `{`, or `#` (never a plain string value).
    const yamlDecl = new RegExp(`^(\\s+)(${e})\\s*:(?:\\s*(?:[#{].*)?)?$`);

    // JSON declaration:  `  "StateName": {`
    const jsonDecl = new RegExp(`^(\\s+")(${e})"\\s*:\\s*\\{`);

    // YAML reference value:  `Next: StateName`  (possibly `- Next: …` in arrays)
    // Allows trailing YAML comments.
    const yamlVal = new RegExp(
      `^(\\s*(?:-\\s+)?(?:Next|Default|StartAt)\\s*:\\s+)(${e})\\s*(?:#.*)?$`,
    );

    // JSON reference value:  `"Next": "StateName"` (optional trailing comma)
    const jsonVal = new RegExp(
      `^(\\s*"(?:Next|Default|StartAt)"\\s*:\\s+")(${e})"\\s*,?\\s*$`,
    );

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      let m: RegExpMatchArray | null;

      // --- Declaration ---
      if ((m = text.match(yamlDecl))) {
        const s = m[1].length;
        result.push({ line: i, start: s, end: s + len });
      } else if ((m = text.match(jsonDecl))) {
        const s = m[1].length;
        result.push({ line: i, start: s, end: s + len });
      }

      // --- Reference value (independent check — different line structure) ---
      if ((m = text.match(yamlVal))) {
        const s = m[1].length;
        result.push({ line: i, start: s, end: s + len });
      } else if ((m = text.match(jsonVal))) {
        const s = m[1].length;
        result.push({ line: i, start: s, end: s + len });
      }
    }

    return result;
  }

  /**
   * If the cursor at `(lineIndex, col)` is on a state name (declaration or
   * reference), return `{ name, start, end }`.  `stateNames` must come from
   * `AslParser.allStateNames()`.  Returns `null` if the cursor is elsewhere.
   */
  static stateNameAtPosition(
    lines: string[],
    lineIndex: number,
    col: number,
    stateNames: string[],
  ): { name: string; start: number; end: number } | null {
    for (const name of stateNames) {
      const hits = AslParser.findStateNameOccurrences([lines[lineIndex]], name);
      if (hits.length > 0) {
        const { start, end } = hits[0];
        if (col >= start && col <= end) {
          return { name, start, end };
        }
      }
    }
    return null;
  }

}

/** Escape a string for use in a RegExp literal. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
