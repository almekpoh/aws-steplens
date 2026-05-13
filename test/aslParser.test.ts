import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AslParser } from '../src/aslParser';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RAW_JSON = JSON.stringify({
  StartAt: 'Hello',
  States: {
    Hello: { Type: 'Task', Resource: 'arn:aws:lambda:::fn', End: true },
  },
});

const RAW_YAML = `
StartAt: Hello
States:
  Hello:
    Type: Task
    Resource: arn:aws:lambda:::fn
    End: true
`;

const SF_FLAT_YAML = `
definition:
  StartAt: Hello
  States:
    Hello:
      Type: Task
      Resource: arn:aws:lambda:::fn
      End: true
`;

const SF_NAMED_YAML = `
myMachine:
  name: my-machine
  definition:
    StartAt: Hello
    States:
      Hello:
        Type: Task
        Resource: arn:aws:lambda:::fn
        End: true
`;

const PARALLEL_YAML = `
StartAt: Par
States:
  Par:
    Type: Parallel
    Branches:
      - StartAt: A
        States:
          A: { Type: Task, Resource: arn, End: true }
      - StartAt: B
        States:
          B: { Type: Task, Resource: arn, End: true }
    End: true
`;

const MAP_YAML = `
StartAt: M
States:
  M:
    Type: Map
    MaxConcurrency: 5
    ItemProcessor:
      StartAt: Child
      States:
        Child: { Type: Task, Resource: arn, End: true }
    Next: Done
  Done:
    Type: Succeed
`;

// ── parse() ──────────────────────────────────────────────────────────────────

describe('AslParser.parse()', () => {
  it('parses raw JSON', () => {
    const r = AslParser.parse(RAW_JSON, 'json');
    assert.ok(r);
    assert.strictEqual(r.definition.StartAt, 'Hello');
    assert.strictEqual(r.isWrapped, false);
  });

  it('parses raw YAML', () => {
    const r = AslParser.parse(RAW_YAML, 'yaml');
    assert.ok(r);
    assert.strictEqual(r.definition.StartAt, 'Hello');
    assert.strictEqual(r.isWrapped, false);
  });

  it('parses Serverless Framework flat wrapper', () => {
    const r = AslParser.parse(SF_FLAT_YAML, 'yaml');
    assert.ok(r);
    assert.strictEqual(r.isWrapped, true);
    assert.strictEqual(r.definition.StartAt, 'Hello');
  });

  it('parses Serverless Framework named wrapper', () => {
    const r = AslParser.parse(SF_NAMED_YAML, 'yaml');
    assert.ok(r);
    assert.strictEqual(r.isWrapped, true);
    assert.strictEqual(r.definition.StartAt, 'Hello');
  });

  it('returns null for non-SFN file', () => {
    assert.strictEqual(AslParser.parse('name: foo\nversion: 1', 'yaml'), null);
  });

  it('returns null for invalid JSON', () => {
    assert.strictEqual(AslParser.parse('{broken', 'json'), null);
  });

  it('returns null for JSON that looks like ASL but has no States', () => {
    assert.strictEqual(
      AslParser.parse('{"StartAt":"A","Comment":"no states here"}', 'json'),
      null
    );
  });

  it('returns null for JSON with States as a non-object', () => {
    assert.strictEqual(
      AslParser.parse('{"StartAt":"A","States":"invalid"}', 'json'),
      null
    );
  });

  it('returns null for empty string', () => {
    assert.strictEqual(AslParser.parse('', 'yaml'), null);
  });

  it('parses GovCloud ARN partition in Resource without error', () => {
    const yaml = `
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws-us-gov:states:::lambda:invoke
    End: true
`;
    const r = AslParser.parse(yaml, 'yaml');
    assert.ok(r);
    assert.strictEqual(r.definition.States['A'].Resource, 'arn:aws-us-gov:states:::lambda:invoke');
  });
});

// ── reachableStates() ────────────────────────────────────────────────────────

describe('AslParser.reachableStates()', () => {
  it('marks all reachable states', () => {
    const def = AslParser.parse(MAP_YAML, 'yaml')!.definition;
    const r = AslParser.reachableStates(def);
    assert.ok(r.has('M'));
    assert.ok(r.has('Done'));
  });

  it('does not include states from unreachable branches in top-level set', () => {
    const yaml = `
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
  Orphan: { Type: Task, Resource: arn, End: true }
`;
    const def = AslParser.parse(yaml, 'yaml')!.definition;
    const r = AslParser.reachableStates(def);
    assert.ok(r.has('A'));
    assert.ok(!r.has('Orphan'));
  });
});

// ── toGraphData() ─────────────────────────────────────────────────────────────

describe('AslParser.toGraphData()', () => {
  it('creates START and END nodes', () => {
    const def = AslParser.parse(RAW_JSON, 'json')!.definition;
    const g = AslParser.toGraphData(def);
    assert.ok(g.nodes.find(n => n.id === '__START__'));
    assert.ok(g.nodes.find(n => n.id === '__END__'));
  });

  it('annotates Map node with ×N', () => {
    const def = AslParser.parse(MAP_YAML, 'yaml')!.definition;
    const g = AslParser.toGraphData(def);
    const m = g.nodes.find(n => n.id === 'M')!;
    assert.ok(m.label.includes('×5'), `label was: ${m.label}`);
  });

  it('annotates Map node with ×∞ when MaxConcurrency is 0', () => {
    const yaml = `
StartAt: M
States:
  M:
    Type: Map
    MaxConcurrency: 0
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`;
    const def = AslParser.parse(yaml, 'yaml')!.definition;
    const g = AslParser.toGraphData(def);
    assert.ok(g.nodes.find(n => n.id === 'M')!.label.includes('×∞'));
  });

  it('annotates Parallel node with ‖N', () => {
    const def = AslParser.parse(PARALLEL_YAML, 'yaml')!.definition;
    const g = AslParser.toGraphData(def);
    const p = g.nodes.find(n => n.id === 'Par')!;
    assert.ok(p.label.includes('‖2'), `label was: ${p.label}`);
  });

  it('annotates Task with ↺ when Retry is set', () => {
    const yaml = `
StartAt: T
States:
  T:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
    End: true
`;
    const def = AslParser.parse(yaml, 'yaml')!.definition;
    const g = AslParser.toGraphData(def);
    assert.ok(g.nodes.find(n => n.id === 'T')!.label.includes('↺'));
  });

  it('annotates waitForTaskToken with ⏸', () => {
    const yaml = `
StartAt: T
States:
  T:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke.waitForTaskToken
    End: true
`;
    const def = AslParser.parse(yaml, 'yaml')!.definition;
    const g = AslParser.toGraphData(def);
    assert.ok(g.nodes.find(n => n.id === 'T')!.label.includes('⏸'));
  });

  it('annotates HTTP Task with 🌐', () => {
    const yaml = `
StartAt: T
States:
  T:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    End: true
`;
    const def = AslParser.parse(yaml, 'yaml')!.definition;
    const g = AslParser.toGraphData(def);
    assert.ok(g.nodes.find(n => n.id === 'T')!.label.includes('🌐'));
  });

  it('annotates distributed Map with ⊕', () => {
    const yaml = `
StartAt: M
States:
  M:
    Type: Map
    ItemProcessor:
      ProcessorConfig:
        Mode: DISTRIBUTED
        ExecutionType: STANDARD
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`;
    const def = AslParser.parse(yaml, 'yaml')!.definition;
    const g = AslParser.toGraphData(def);
    assert.ok(g.nodes.find(n => n.id === 'M')!.label.includes('⊕'));
  });

  it('creates __END__ node when only Fail state exists (no explicit End: true)', () => {
    const g = AslParser.toGraphData({
      StartAt: 'A',
      States: {
        A: { Type: 'Task', Resource: 'arn', Next: 'F' },
        F: { Type: 'Fail', Error: 'MyError', Cause: 'something went wrong' },
      },
    });
    assert.ok(g.nodes.find(n => n.id === '__END__'), 'should create __END__ for Fail state');
  });

  it('creates __END__ node when only Succeed state exists (no explicit End: true)', () => {
    const g = AslParser.toGraphData({
      StartAt: 'A',
      States: {
        A: { Type: 'Task', Resource: 'arn', Next: 'S' },
        S: { Type: 'Succeed' },
      },
    });
    assert.ok(g.nodes.find(n => n.id === '__END__'), 'should create __END__ for Succeed state');
  });

  it('adds edge from Fail state to __END__', () => {
    const g = AslParser.toGraphData({
      StartAt: 'A',
      States: {
        A: { Type: 'Task', Resource: 'arn', Next: 'F' },
        F: { Type: 'Fail' },
      },
    });
    assert.ok(g.edges.find(e => e.source === 'F' && e.target === '__END__'), 'Fail → __END__ edge missing');
  });

  it('adds edge from Succeed state to __END__', () => {
    const g = AslParser.toGraphData({
      StartAt: 'A',
      States: {
        A: { Type: 'Task', Resource: 'arn', Next: 'S' },
        S: { Type: 'Succeed' },
      },
    });
    assert.ok(g.edges.find(e => e.source === 'S' && e.target === '__END__'), 'Succeed → __END__ edge missing');
  });

  it('shows Error in Fail node label', () => {
    const g = AslParser.toGraphData({
      StartAt: 'F',
      States: { F: { Type: 'Fail', Error: 'OrderNotFound', Cause: 'No such order' } },
    });
    const node = g.nodes.find(n => n.id === 'F')!;
    assert.ok(node.label.includes('OrderNotFound'), `label was: ${node.label}`);
  });

  it('falls back to Cause in Fail node label when Error is absent', () => {
    const g = AslParser.toGraphData({
      StartAt: 'F',
      States: { F: { Type: 'Fail', Cause: 'Something exploded' } },
    });
    const node = g.nodes.find(n => n.id === 'F')!;
    assert.ok(node.label.includes('Something exploded'), `label was: ${node.label}`);
  });

  it('creates a ghost node and start edge when StartAt is not in States', () => {
    const g = AslParser.toGraphData({
      StartAt: 'Missing',
      States: { A: { Type: 'Task', Resource: 'arn', End: true } },
    });
    const ghostNode = g.nodes.find(n => n.id === 'Missing' && n.type === 'GHOST');
    assert.ok(ghostNode, 'ghost node should be created for missing StartAt state');
    const startEdge = g.edges.find(e => e.source === '__START__' && e.target === 'Missing');
    assert.ok(startEdge, 'start edge should point to the ghost node');
  });
});

// ── extractSubGraphs() ───────────────────────────────────────────────────────

describe('AslParser.extractSubGraphs()', () => {
  it('extracts Parallel branches', () => {
    const def = AslParser.parse(PARALLEL_YAML, 'yaml')!.definition;
    const subs = AslParser.extractSubGraphs(def);
    assert.strictEqual(subs.length, 2);
    assert.ok(subs.every(s => s.type === 'Parallel'));
  });

  it('extracts Map iterator (ItemProcessor)', () => {
    const def = AslParser.parse(MAP_YAML, 'yaml')!.definition;
    const subs = AslParser.extractSubGraphs(def);
    assert.strictEqual(subs.length, 1);
    assert.strictEqual(subs[0].type, 'Map');
  });

  it('extracts legacy Iterator (deprecated format)', () => {
    const yaml = `
StartAt: M
States:
  M:
    Type: Map
    Iterator:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`;
    const def = AslParser.parse(yaml, 'yaml')!.definition;
    const subs = AslParser.extractSubGraphs(def);
    assert.strictEqual(subs.length, 1);
    assert.strictEqual(subs[0].type, 'Map');
  });
});

// ── allStateNames() ──────────────────────────────────────────────────────────

describe('AslParser.allStateNames()', () => {
  it('returns top-level state names', () => {
    const def = AslParser.parse(MAP_YAML, 'yaml')!.definition;
    const names = AslParser.allStateNames(def);
    assert.ok(names.includes('M'));
    assert.ok(names.includes('Done'));
  });

  it('includes states from Parallel branches', () => {
    const def = AslParser.parse(PARALLEL_YAML, 'yaml')!.definition;
    const names = AslParser.allStateNames(def);
    assert.ok(names.includes('Par'));
    assert.ok(names.includes('A'));
    assert.ok(names.includes('B'));
  });

  it('includes states from Map iterator', () => {
    const def = AslParser.parse(MAP_YAML, 'yaml')!.definition;
    const names = AslParser.allStateNames(def);
    assert.ok(names.includes('Child'));
  });

  it('includes states from Map inside Parallel (deep nesting)', () => {
    const yaml = `
StartAt: Par
States:
  Par:
    Type: Parallel
    Branches:
      - StartAt: M
        States:
          M:
            Type: Map
            ItemProcessor:
              StartAt: Inner
              States:
                Inner: { Type: Task, Resource: arn, End: true }
            End: true
    End: true
`;
    const def = AslParser.parse(yaml, 'yaml')!.definition;
    const names = AslParser.allStateNames(def);
    assert.ok(names.includes('Par'));
    assert.ok(names.includes('M'));
    assert.ok(names.includes('Inner'));
  });
});

// ── Serverless Framework + JSONata combination ────────────────────────────────

describe('AslParser.parse() — SF wrapper + JSONata', () => {
  it('parses SF flat wrapper with QueryLanguage: JSONata', () => {
    const yaml = `
definition:
  QueryLanguage: JSONata
  StartAt: A
  States:
    A:
      Type: Task
      Resource: arn
      End: true
`;
    const r = AslParser.parse(yaml, 'yaml');
    assert.ok(r);
    assert.strictEqual(r.isWrapped, true);
    assert.strictEqual(r.definition.QueryLanguage, 'JSONata');
  });

  it('parses SF named wrapper with QueryLanguage: JSONata', () => {
    const yaml = `
myMachine:
  definition:
    QueryLanguage: JSONata
    StartAt: A
    States:
      A:
        Type: Task
        Resource: arn
        End: true
`;
    const r = AslParser.parse(yaml, 'yaml');
    assert.ok(r);
    assert.strictEqual(r.isWrapped, true);
    assert.strictEqual(r.definition.QueryLanguage, 'JSONata');
  });
});

// ── findInfiniteCycles() ─────────────────────────────────────────────────────

describe('AslParser.findInfiniteCycles()', () => {
  it('returns empty array when no cycle exists', () => {
    const cycles = AslParser.findInfiniteCycles({
      StartAt: 'A',
      States: {
        A: { Type: 'Task', Resource: 'arn', Next: 'B' },
        B: { Type: 'Task', Resource: 'arn', End: true },
      },
    });
    assert.strictEqual(cycles.length, 0);
  });

  it('detects a simple A→B→A infinite cycle', () => {
    const cycles = AslParser.findInfiniteCycles({
      StartAt: 'A',
      States: {
        A: { Type: 'Task', Resource: 'arn', Next: 'B' },
        B: { Type: 'Task', Resource: 'arn', Next: 'A' },
      },
    });
    assert.strictEqual(cycles.length, 1);
    assert.ok(cycles[0].includes('A') && cycles[0].includes('B'));
  });

  it('does NOT flag a cycle containing a Choice state (polling loop)', () => {
    const cycles = AslParser.findInfiniteCycles({
      StartAt: 'Poll',
      States: {
        Poll:   { Type: 'Task', Resource: 'arn', Next: 'Check' },
        Check:  { Type: 'Choice', Choices: [{ Variable: '$.done', Next: 'Done' }], Default: 'Wait' },
        Wait:   { Type: 'Wait', Seconds: 10, Next: 'Poll' },
        Done:   { Type: 'Succeed' },
      },
    });
    assert.strictEqual(cycles.length, 0, 'polling loop with Choice should not be flagged');
  });

  it('detects a self-loop (A→A)', () => {
    const cycles = AslParser.findInfiniteCycles({
      StartAt: 'A',
      States: {
        A: { Type: 'Task', Resource: 'arn', Next: 'A' },
      },
    });
    assert.strictEqual(cycles.length, 1);
    assert.deepStrictEqual(cycles[0], ['A']);
  });
});

// ── parse() — CloudFormation / SAM ──────────────────────────────────────────

describe('AslParser.parse() — CloudFormation / SAM', () => {
  it('parses AWS::StepFunctions::StateMachine with inline Definition (YAML)', () => {
    const yaml = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  MyMachine:
    Type: AWS::StepFunctions::StateMachine
    Properties:
      Definition:
        StartAt: A
        States:
          A:
            Type: Task
            Resource: arn:aws:lambda:::function:foo
            End: true
`;
    const r = AslParser.parse(yaml, 'yaml');
    assert.ok(r, 'should detect CF inline Definition');
    assert.strictEqual(r!.isWrapped, true);
    assert.strictEqual(r!.definition.StartAt, 'A');
  });

  it('parses AWS::StepFunctions::StateMachine with DefinitionString JSON', () => {
    const json = JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        MyMachine: {
          Type: 'AWS::StepFunctions::StateMachine',
          Properties: {
            DefinitionString: JSON.stringify({
              StartAt: 'Hello',
              States: { Hello: { Type: 'Pass', End: true } },
            }),
          },
        },
      },
    });
    const r = AslParser.parse(json, 'json');
    assert.ok(r, 'should detect CF DefinitionString');
    assert.strictEqual(r!.definition.StartAt, 'Hello');
  });

  it('parses AWS::Serverless::StateMachine with inline Definition', () => {
    const yaml = `
Transform: AWS::Serverless-2016-10-31
Resources:
  MyMachine:
    Type: AWS::Serverless::StateMachine
    Properties:
      Definition:
        StartAt: S
        States:
          S:
            Type: Succeed
`;
    const r = AslParser.parse(yaml, 'yaml');
    assert.ok(r, 'should detect SAM StateMachine');
    assert.strictEqual(r!.definition.StartAt, 'S');
  });

  it('parses CF DefinitionString with Fn::Sub substitutions', () => {
    const yaml = `
Resources:
  MyMachine:
    Type: AWS::StepFunctions::StateMachine
    Properties:
      DefinitionString:
        Fn::Sub: |
          {
            "StartAt": "Invoke",
            "States": {
              "Invoke": {
                "Type": "Task",
                "Resource": "\${MyLambda.Arn}",
                "End": true
              }
            }
          }
`;
    const r = AslParser.parse(yaml, 'yaml');
    assert.ok(r, 'should parse Fn::Sub DefinitionString');
    assert.strictEqual(r!.definition.StartAt, 'Invoke');
  });

  it('parses CF DefinitionString with Fn::Join', () => {
    const def = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        MyMachine: {
          Type: 'AWS::StepFunctions::StateMachine',
          Properties: {
            DefinitionString: {
              'Fn::Join': [
                '\n',
                [
                  '{',
                  '"StartAt": "A",',
                  '"States": {',
                  '"A": { "Type": "Pass", "End": true }',
                  '}',
                  '}',
                ],
              ],
            },
          },
        },
      },
    };
    const r = AslParser.parse(JSON.stringify(def), 'json');
    assert.ok(r, 'should parse Fn::Join DefinitionString');
    assert.strictEqual(r!.definition.StartAt, 'A');
  });

  it('returns null for a CF template with no state machine resources', () => {
    const yaml = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  MyBucket:
    Type: AWS::S3::Bucket
`;
    const r = AslParser.parse(yaml, 'yaml');
    assert.strictEqual(r, null);
  });
});

// ── extractDefinitionUri() ────────────────────────────────────────────────────

describe('AslParser.extractDefinitionUri()', () => {
  const samTemplate = (defVal: unknown) => {
    const template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Transform: 'AWS::Serverless-2016-10-31',
      Resources: {
        MyMachine: {
          Type: 'AWS::Serverless::StateMachine',
          Properties: {
            DefinitionUri: defVal,
          },
        },
      },
    };
    return JSON.stringify(template);
  };

  it('returns the relative path for a local DefinitionUri string', () => {
    const result = AslParser.extractDefinitionUri(
      samTemplate('statemachine/order.asl.json'),
      'json',
    );
    assert.strictEqual(result, 'statemachine/order.asl.json');
  });

  it('returns null for an S3 DefinitionUri string', () => {
    const result = AslParser.extractDefinitionUri(
      samTemplate('s3://my-bucket/order.asl.json'),
      'json',
    );
    assert.strictEqual(result, null);
  });

  it('returns null for an S3 DefinitionUri object { Bucket, Key }', () => {
    const result = AslParser.extractDefinitionUri(
      samTemplate({ Bucket: 'my-bucket', Key: 'order.asl.json' }),
      'json',
    );
    assert.strictEqual(result, null);
  });

  it('returns null for inline Definition (no DefinitionUri)', () => {
    const template = JSON.stringify({
      Resources: {
        M: {
          Type: 'AWS::Serverless::StateMachine',
          Properties: {
            Definition: { StartAt: 'A', States: { A: { Type: 'Succeed' } } },
          },
        },
      },
    });
    assert.strictEqual(AslParser.extractDefinitionUri(template, 'json'), null);
  });

  it('returns null for AWS::StepFunctions::StateMachine (DefinitionUri not supported)', () => {
    const template = JSON.stringify({
      Resources: {
        M: {
          Type: 'AWS::StepFunctions::StateMachine',
          Properties: { DefinitionUri: 'statemachine/order.asl.json' },
        },
      },
    });
    assert.strictEqual(AslParser.extractDefinitionUri(template, 'json'), null);
  });

  it('parses a YAML SAM template', () => {
    const yaml = `
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  MyMachine:
    Type: AWS::Serverless::StateMachine
    Properties:
      DefinitionUri: statemachine/order.asl.yaml
`;
    const result = AslParser.extractDefinitionUri(yaml, 'yaml');
    assert.strictEqual(result, 'statemachine/order.asl.yaml');
  });

  it('returns null for a non-template file', () => {
    assert.strictEqual(
      AslParser.extractDefinitionUri('StartAt: A\nStates:\n  A: {Type: Succeed}', 'yaml'),
      null,
    );
  });
});

// ── parseWithDefinitionUri() ──────────────────────────────────────────────────

describe('AslParser.parseWithDefinitionUri()', () => {
  const ASL_CONTENT = JSON.stringify({
    StartAt: 'DoWork',
    States: { DoWork: { Type: 'Task', Resource: 'arn:aws:lambda:::fn', End: true } },
  });

  const SAM_TEMPLATE_YAML = `
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  MyMachine:
    Type: AWS::Serverless::StateMachine
    Properties:
      DefinitionUri: statemachine/order.asl.json
`;

  it('resolves DefinitionUri and parses the referenced file', async () => {
    const readFile = async (path: string) => {
      assert.strictEqual(path, 'statemachine/order.asl.json');
      return ASL_CONTENT;
    };
    const result = await AslParser.parseWithDefinitionUri(SAM_TEMPLATE_YAML, 'yaml', readFile);
    assert.ok(result, 'expected a parsed definition');
    assert.strictEqual(result.definition.StartAt, 'DoWork');
    assert.ok(result.isWrapped);
  });

  it('returns the inline definition directly without calling readFile', async () => {
    const readFile = async (_path: string): Promise<string> => {
      throw new Error('readFile should not be called for inline definitions');
    };
    const inlineYaml = `
StartAt: A
States:
  A: { Type: Succeed }
`;
    const result = await AslParser.parseWithDefinitionUri(inlineYaml, 'yaml', readFile);
    assert.ok(result);
    assert.strictEqual(result.definition.StartAt, 'A');
  });

  it('returns null when readFile throws (file not found)', async () => {
    const readFile = async (_path: string): Promise<string> => {
      throw new Error('ENOENT');
    };
    const result = await AslParser.parseWithDefinitionUri(SAM_TEMPLATE_YAML, 'yaml', readFile);
    assert.strictEqual(result, null);
  });

  it('returns null when the referenced file is not valid ASL', async () => {
    const readFile = async (_path: string) => '{"not": "asl"}';
    const result = await AslParser.parseWithDefinitionUri(SAM_TEMPLATE_YAML, 'yaml', readFile);
    assert.strictEqual(result, null);
  });

  it('infers yaml language from .asl.yaml extension', async () => {
    const samYaml = `
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  M:
    Type: AWS::Serverless::StateMachine
    Properties:
      DefinitionUri: sm/machine.asl.yaml
`;
    const aslYaml = 'StartAt: A\nStates:\n  A:\n    Type: Succeed\n';
    const readFile = async (_path: string) => aslYaml;
    const result = await AslParser.parseWithDefinitionUri(samYaml, 'yaml', readFile);
    assert.ok(result);
    assert.strictEqual(result.definition.StartAt, 'A');
  });
});

// ── findStateNameOccurrences() ────────────────────────────────────────────────

describe('AslParser.findStateNameOccurrences()', () => {
  // YAML fixture
  const YAML_LINES = `
StartAt: ValidateInput
States:
  ValidateInput:
    Type: Task
    Resource: arn
    Next: ProcessOrder
    Catch:
      - ErrorEquals: [States.ALL]
        Next: HandleError
  ProcessOrder:
    Type: Task
    Resource: arn
    Next: HandleError
  HandleError:
    Type: Fail
`.trimStart().split('\n');

  // JSON fixture
  const JSON_LINES = `{
  "StartAt": "ValidateInput",
  "States": {
    "ValidateInput": {
      "Type": "Task",
      "Next": "ProcessOrder"
    },
    "ProcessOrder": {
      "Type": "Task",
      "Next": "HandleError"
    },
    "HandleError": {
      "Type": "Fail"
    }
  }
}`.split('\n');

  it('finds declaration + all Next references for a YAML file', () => {
    const hits = AslParser.findStateNameOccurrences(YAML_LINES, 'HandleError');
    // declaration on line 14 ("  HandleError:")
    // Next reference on line 9 ("        Next: HandleError" in Catch)
    // Next reference on line 13 ("    Next: HandleError" in ProcessOrder)
    assert.strictEqual(hits.length, 3);
  });

  it('finds StartAt reference in YAML', () => {
    const hits = AslParser.findStateNameOccurrences(YAML_LINES, 'ValidateInput');
    // StartAt: ValidateInput (line 0) + declaration (line 3)
    assert.strictEqual(hits.length, 2);
  });

  it('returns the correct character range for a YAML declaration', () => {
    const hits = AslParser.findStateNameOccurrences(YAML_LINES, 'ProcessOrder');
    const decl = hits.find(h => YAML_LINES[h.line].includes('ProcessOrder:'));
    assert.ok(decl, 'declaration not found');
    assert.strictEqual(YAML_LINES[decl.line].slice(decl.start, decl.end), 'ProcessOrder');
  });

  it('returns the correct character range for a YAML Next value', () => {
    const hits = AslParser.findStateNameOccurrences(YAML_LINES, 'ProcessOrder');
    const ref = hits.find(h => YAML_LINES[h.line].includes('Next: ProcessOrder'));
    assert.ok(ref, 'Next reference not found');
    assert.strictEqual(YAML_LINES[ref.line].slice(ref.start, ref.end), 'ProcessOrder');
  });

  it('finds declaration + all references in a JSON file', () => {
    const hits = AslParser.findStateNameOccurrences(JSON_LINES, 'HandleError');
    // declaration ("HandleError": {), Next in ProcessOrder, StartAt is not HandleError
    assert.ok(hits.length >= 2);
    for (const h of hits) {
      assert.strictEqual(JSON_LINES[h.line].slice(h.start, h.end), 'HandleError');
    }
  });

  it('returns the correct range for a JSON declaration', () => {
    const hits = AslParser.findStateNameOccurrences(JSON_LINES, 'ValidateInput');
    const decl = hits.find(h => JSON_LINES[h.line].includes('"ValidateInput": {'));
    assert.ok(decl, 'declaration not found');
    assert.strictEqual(JSON_LINES[decl.line].slice(decl.start, decl.end), 'ValidateInput');
  });

  it('returns the correct range for a JSON value', () => {
    const hits = AslParser.findStateNameOccurrences(JSON_LINES, 'ProcessOrder');
    const ref = hits.find(h => JSON_LINES[h.line].includes('"Next": "ProcessOrder"'));
    assert.ok(ref, 'Next reference not found');
    assert.strictEqual(JSON_LINES[ref.line].slice(ref.start, ref.end), 'ProcessOrder');
  });

  it('returns empty array for a name that does not exist', () => {
    assert.deepStrictEqual(
      AslParser.findStateNameOccurrences(YAML_LINES, 'GhostState'),
      [],
    );
  });

  it('does not match a substring of another state name', () => {
    // 'Handle' should not match inside 'HandleError'
    const hits = AslParser.findStateNameOccurrences(YAML_LINES, 'Handle');
    assert.strictEqual(hits.length, 0);
  });
});

// ── stateNameAtPosition() ─────────────────────────────────────────────────────

describe('AslParser.stateNameAtPosition()', () => {
  const LINES = `
StartAt: ValidateInput
States:
  ValidateInput:
    Type: Task
    Next: ProcessOrder
`.trimStart().split('\n');

  const NAMES = ['ValidateInput', 'ProcessOrder'];

  it('detects a state name when cursor is within the declaration', () => {
    // line 2: "  ValidateInput:"
    const decl = LINES[2];
    const col = decl.indexOf('ValidateInput') + 3; // middle of the name
    const hit = AslParser.stateNameAtPosition(LINES, 2, col, NAMES);
    assert.ok(hit);
    assert.strictEqual(hit.name, 'ValidateInput');
  });

  it('detects a state name when cursor is within a Next reference', () => {
    // line 4: "    Next: ProcessOrder"
    const ref = LINES[4];
    const col = ref.indexOf('ProcessOrder') + 4;
    const hit = AslParser.stateNameAtPosition(LINES, 4, col, NAMES);
    assert.ok(hit);
    assert.strictEqual(hit.name, 'ProcessOrder');
  });

  it('returns null when cursor is on a keyword (Next), not a state name', () => {
    // line 4: "    Next: ProcessOrder" — cursor on "Next" (col 4)
    const hit = AslParser.stateNameAtPosition(LINES, 4, 4, NAMES);
    assert.strictEqual(hit, null);
  });

  it('returns null on an unrelated line', () => {
    // line 3: "    Type: Task"
    const hit = AslParser.stateNameAtPosition(LINES, 3, 10, NAMES);
    assert.strictEqual(hit, null);
  });
});
