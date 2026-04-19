import * as yaml from 'yaml';

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
  label: string;  // display label — may include ↺ / ×N / ‖N / ⏸ / ⊕ suffixes
  type: string;   // Task | Choice | Wait | Pass | Succeed | Fail | Parallel | Map | START | END
  hasRetry?: boolean;
  isWaitForToken?: boolean;
  isDistributedMap?: boolean;
  isHttpTask?: boolean;
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

export class AslParser {
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
        : yaml.parse(text);

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
      let label = name;
      const isWaitForToken = (state.Resource ?? '').includes('waitForTaskToken');
      const isHttpTask = (state.Resource ?? '').includes('states:::http:invoke');
      const isDistributedMap = state.Type === 'Map' &&
        (state.ItemProcessor as AslItemProcessor | undefined)?.ProcessorConfig?.Mode === 'DISTRIBUTED';

      if (state.Type === 'Map') {
        if (isDistributedMap) {
          label += ' ⊕';
        }
        if (state.MaxConcurrency !== undefined) {
          label += state.MaxConcurrency === 0 ? ' ×∞' : ` ×${state.MaxConcurrency}`;
        }
      }
      if (state.Type === 'Parallel' && state.Branches?.length) {
        label += ` ‖${state.Branches.length}`;
      }
      if ((state.Retry?.length ?? 0) > 0) label += ' ↺';
      if (isWaitForToken) label += ' ⏸';
      if (isHttpTask) label += ' 🌐';
      // Fail: append Error (or Cause if no Error) as a second line
      if (state.Type === 'Fail') {
        const detail = state.Error ?? state.Cause;
        if (detail) label += `\n${detail}`;
      }

      nodes.push({
        id: name,
        label,
        type: state.Type ?? 'Task',
        hasRetry: (state.Retry?.length ?? 0) > 0,
        isWaitForToken,
        isDistributedMap,
        isHttpTask,
      });
    }

    // __END__ exists whenever any state is terminal: explicit End, Fail, or Succeed
    const hasEnd = Object.values(def.States).some(
      s => s.End || s.Type === 'Fail' || s.Type === 'Succeed'
    );
    if (hasEnd) nodes.push({ id: '__END__', label: 'End', type: 'END' });

    // Start edge — only if StartAt actually exists in States (guard against dangling edge)
    if (def.States[def.StartAt] !== undefined) {
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

    for (const [name, state] of Object.entries(def.States)) {
      if (state.Type === 'Parallel' && state.Branches?.length) {
        state.Branches.forEach((branch, i) => {
          result.push({
            id: `${safe(name)}_b${i}`,
            label: `${name} — Branch ${i + 1}`,
            type: 'Parallel',
            parentStateName: name,
            data: AslParser.toGraphData(branch),
          });
        });
      } else if (state.Type === 'Map') {
        const iterator = state.Iterator ?? state.ItemProcessor;
        if (iterator) {
          result.push({
            id: `${safe(name)}_iter`,
            label: `${name} — Iterator`,
            type: 'Map',
            parentStateName: name,
            data: AslParser.toGraphData(iterator),
          });
        }
      }
    }
    return result;
  }

}
