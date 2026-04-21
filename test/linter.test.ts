import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AslParser } from '../src/aslParser';
import { AslLinter, findLineForStateName } from '../src/linter';

// ── Helpers ───────────────────────────────────────────────────────────────────

function lint(yaml: string) {
  const parsed = AslParser.parse(yaml.trim(), 'yaml');
  if (!parsed) throw new Error('Failed to parse YAML fixture');
  return AslLinter.lint(parsed.definition);
}

function hasError(errors: ReturnType<typeof AslLinter.lint>, pattern: string | RegExp) {
  return errors.some(e => typeof pattern === 'string'
    ? e.message.includes(pattern)
    : pattern.test(e.message));
}

// ── R-1: StartAt must exist ───────────────────────────────────────────────────

describe('R-1: StartAt must exist', () => {
  it('reports missing StartAt state', () => {
    const errs = lint(`
StartAt: Missing
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(hasError(errs, 'StartAt "Missing"'));
  });

  it('passes when StartAt exists', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(!hasError(errs, 'StartAt'));
  });
});

// ── R-2: Next must exist ──────────────────────────────────────────────────────

describe('R-2: Next must exist', () => {
  it('reports invalid Next reference', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, Next: Nowhere }
`);
    assert.ok(hasError(errs, 'Next "Nowhere" not found'));
  });
});

// ── R-3: Non-terminal state must have Next or End ────────────────────────────

describe('R-3: Non-terminal state must have Next or End', () => {
  it('reports state with no Next/End', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn }
`);
    assert.ok(hasError(errs, 'neither "Next" nor "End"'));
  });

  it('does not flag Succeed or Fail', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, Next: B }
  B: { Type: Succeed }
`);
    assert.ok(!hasError(errs, 'neither "Next" nor "End"'));
  });
});

// ── R-4: Catch.Next must exist ────────────────────────────────────────────────

describe('R-4: Catch.Next must exist', () => {
  it('reports invalid Catch.Next', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Catch:
      - ErrorEquals: [States.ALL]
        Next: Nowhere
    End: true
`);
    assert.ok(hasError(errs, 'Catch[0].Next "Nowhere" not found'));
  });
});

// ── R-5: Choice branches ──────────────────────────────────────────────────────

describe('R-5: Choice branches', () => {
  it('reports empty Choices array', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Choice, Choices: [] }
`);
    assert.ok(hasError(errs, 'no branches'));
  });

  it('reports missing Next in branch', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.x
        StringEquals: y
`);
    assert.ok(hasError(errs, 'missing "Next"'));
  });
});

// ── R-8: waitForTaskToken ─────────────────────────────────────────────────────

describe('R-8: waitForTaskToken', () => {
  it('warns when no HeartbeatSeconds', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke.waitForTaskToken
    Catch:
      - ErrorEquals: [States.HeartbeatTimeout]
        Next: B
    End: true
  B: { Type: Fail }
`);
    assert.ok(hasError(errs, 'HeartbeatSeconds'));
  });

  it('warns when no HeartbeatTimeout catch', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke.waitForTaskToken
    HeartbeatSeconds: 300
    End: true
`);
    assert.ok(hasError(errs, 'Catch for States.HeartbeatTimeout'));
  });
});


// ── R-11: Timeout mutual exclusion ───────────────────────────────────────────

describe('R-11: TimeoutSeconds / TimeoutSecondsPath mutual exclusion', () => {
  it('reports when both are set', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    TimeoutSeconds: 30
    TimeoutSecondsPath: $.timeout
    End: true
`);
    assert.ok(hasError(errs, 'TimeoutSeconds and TimeoutSecondsPath are mutually exclusive'));
  });
});

// ── R-12: HeartbeatSeconds < TimeoutSeconds ───────────────────────────────────

describe('R-12: HeartbeatSeconds must be < TimeoutSeconds', () => {
  it('reports when heartbeat >= timeout', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    TimeoutSeconds: 30
    HeartbeatSeconds: 30
    End: true
`);
    assert.ok(hasError(errs, 'less than TimeoutSeconds'));
  });
});

// ── R-13: Fail state mutual exclusion ────────────────────────────────────────

describe('R-13: Fail state Error/ErrorPath mutual exclusion', () => {
  it('reports Error + ErrorPath', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, Next: F }
  F:
    Type: Fail
    Error: MyError
    ErrorPath: $.errorField
`);
    assert.ok(hasError(errs, 'Error and ErrorPath are mutually exclusive'));
  });
});

// ── R-14: Wait state timing ───────────────────────────────────────────────────

describe('R-14: Wait state must have exactly one timing field', () => {
  it('reports no timing field', () => {
    const errs = lint(`
StartAt: W
States:
  W: { Type: Wait, End: true }
`);
    assert.ok(hasError(errs, 'no timing field'));
  });

  it('reports multiple timing fields', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Seconds: 10
    Timestamp: "2030-01-01T00:00:00Z"
    End: true
`);
    assert.ok(hasError(errs, 'multiple timing fields'));
  });

  it('passes with a single timing field', () => {
    const errs = lint(`
StartAt: W
States:
  W: { Type: Wait, Seconds: 10, End: true }
`);
    assert.ok(!hasError(errs, 'timing'));
  });
});

// ── R-15: States.ALL must be alone and last ───────────────────────────────────

describe('R-15: States.ALL must be alone and last', () => {
  it('reports States.ALL mixed with other errors', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Catch:
      - ErrorEquals: [States.ALL, States.Timeout]
        Next: A
    End: true
`);
    assert.ok(hasError(errs, 'States.ALL" with other errors'));
  });

  it('reports States.ALL not last', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Catch:
      - ErrorEquals: [States.ALL]
        Next: A
      - ErrorEquals: [States.Timeout]
        Next: A
    End: true
`);
    assert.ok(hasError(errs, 'must be the last handler'));
  });
});

// ── R-17: ErrorEquals empty ───────────────────────────────────────────────────

describe('R-17: ErrorEquals must not be empty', () => {
  it('reports empty ErrorEquals in Catch', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Catch:
      - ErrorEquals: []
        Next: A
    End: true
`);
    assert.ok(hasError(errs, 'ErrorEquals is empty'));
  });
});

// ── R-19: ToleratedFailurePercentage range ────────────────────────────────────

describe('R-19: ToleratedFailurePercentage must be 0-100', () => {
  it('reports value > 100', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ToleratedFailurePercentage: 150
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, 'between 0 and 100'));
  });
});

// ── W-1: Unreachable states ───────────────────────────────────────────────────

describe('W-1: Unreachable states', () => {
  it('warns on orphan state', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
  Orphan: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(hasError(errs, '"Orphan" is unreachable'));
  });
});

// ── W-2: Choice without Default ──────────────────────────────────────────────

describe('W-2: Choice without Default', () => {
  it('warns when no Default', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.x
        StringEquals: y
        Next: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, 'NoChoiceMatched'));
  });

  it('does not warn when Default is set', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.x
        StringEquals: y
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(!hasError(errs, 'NoChoiceMatched'));
  });
});

// ── J-1: Wrong fields per query language ─────────────────────────────────────

describe('J-1: Wrong fields per query language', () => {
  it('reports Parameters in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Parameters:
      foo: bar
    End: true
`);
    assert.ok(hasError(errs, '"Parameters" is a JSONPath field'));
  });

  it('reports Arguments in JSONPath mode', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Arguments:
      foo: bar
    End: true
`);
    assert.ok(hasError(errs, '"Arguments" is a JSONata field'));
  });
});

// ── J-3: Invalid JSONata expression ──────────────────────────────────────────

describe('J-3: JSONata expression validation', () => {
  it('reports empty expression', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Arguments:
      x: "{%  %}"
    End: true
`);
    assert.ok(hasError(errs, 'empty'));
  });

  it('reports $eval() usage', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Arguments:
      x: "{% $eval('foo') %}"
    End: true
`);
    assert.ok(hasError(errs, '$eval()'));
  });

  it('reports JSONPath $. syntax inside JSONata', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Arguments:
      x: "{% $.field %}"
    End: true
`);
    assert.ok(hasError(errs, '"$."'));
  });

  it('reports unbalanced parenthesis', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Arguments:
      x: "{% foo( %}"
    End: true
`);
    assert.ok(hasError(errs, 'parenthesis'));
  });
});

// ── J-4: $states.result scope ────────────────────────────────────────────────

describe('J-4: $states.result scope', () => {
  it('reports $states.result in Choice state', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Condition: "{% $states.result.x = 1 %}"
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, '$states.result'));
  });
});

// ── ProcessorConfig validation ────────────────────────────────────────────────

describe('ProcessorConfig: DISTRIBUTED mode', () => {
  it('reports missing ExecutionType in DISTRIBUTED mode', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemProcessor:
      ProcessorConfig:
        Mode: DISTRIBUTED
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, 'ExecutionType is required in DISTRIBUTED mode'));
  });

  it('warns when ExecutionType set in INLINE mode', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemProcessor:
      ProcessorConfig:
        Mode: INLINE
        ExecutionType: EXPRESS
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, 'ignored in INLINE mode'));
  });

  it('errors when INLINE MaxConcurrency > 40', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    MaxConcurrency: 50
    ItemProcessor:
      ProcessorConfig:
        Mode: INLINE
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, 'limited to 40'));
  });

  it('reports waitForTaskToken in EXPRESS children', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemProcessor:
      ProcessorConfig:
        Mode: DISTRIBUTED
        ExecutionType: EXPRESS
      StartAt: C
      States:
        C:
          Type: Task
          Resource: arn:aws:states:::lambda:invoke.waitForTaskToken
          End: true
    End: true
`);
    assert.ok(hasError(errs, 'EXPRESS child executions do not support .waitForTaskToken'));
  });
});

// ── BackoffRate minimum ───────────────────────────────────────────────────────

describe('BackoffRate minimum 1.0', () => {
  it('reports BackoffRate < 1', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        BackoffRate: 0.5
    End: true
`);
    assert.ok(hasError(errs, 'BackoffRate must be ≥ 1.0'));
  });
});


// ── R-6: Parallel/Map must have Next or End ──────────────────────────────────

describe('R-6: Parallel/Map must have Next or End', () => {
  it('reports Parallel without Next or End', () => {
    const errs = lint(`
StartAt: P
States:
  P:
    Type: Parallel
    Branches:
      - StartAt: A
        States:
          A: { Type: Task, Resource: arn:aws:states:::lambda:invoke, End: true }
`);
    assert.ok(hasError(errs, '"P" (Parallel): neither "Next" nor "End"'));
  });

  it('reports Map without Next or End', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn:aws:states:::lambda:invoke, End: true }
`);
    assert.ok(hasError(errs, '"M" (Map): neither "Next" nor "End"'));
  });

  it('passes when Parallel has End', () => {
    const errs = lint(`
StartAt: P
States:
  P:
    Type: Parallel
    Branches:
      - StartAt: A
        States:
          A: { Type: Task, Resource: arn:aws:states:::lambda:invoke, End: true }
    End: true
`);
    assert.ok(!hasError(errs, '(Parallel): neither "Next" nor "End"'));
  });
});

// ── R-7: Parallel branches invalid sub-state-machine ─────────────────────────

describe('R-7: Parallel branch must be a valid sub-state-machine', () => {
  it('reports branch missing StartAt', () => {
    const errs = lint(`
StartAt: P
States:
  P:
    Type: Parallel
    Branches:
      - States:
          A: { Type: Task, Resource: arn:aws:states:::lambda:invoke, End: true }
    End: true
`);
    assert.ok(hasError(errs, 'Branches[0] is not valid'));
  });

  it('reports branch missing States', () => {
    const errs = lint(`
StartAt: P
States:
  P:
    Type: Parallel
    Branches:
      - StartAt: A
    End: true
`);
    assert.ok(hasError(errs, 'Branches[0] is not valid'));
  });

  it('propagates lint errors from inside a branch', () => {
    const errs = lint(`
StartAt: P
States:
  P:
    Type: Parallel
    Branches:
      - StartAt: Missing
        States:
          A: { Type: Task, Resource: arn:aws:states:::lambda:invoke, End: true }
    End: true
`);
    assert.ok(hasError(errs, '[Branch 0]'));
  });
});

// ── R-9: Map iterator invalid sub-state-machine ───────────────────────────────

describe('R-9: Map iterator must be a valid sub-state-machine', () => {
  it('reports missing ItemProcessor', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    End: true
`);
    assert.ok(hasError(errs, 'no Iterator or ItemProcessor'));
  });

  it('reports iterator missing StartAt', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemProcessor:
      States:
        C: { Type: Task, Resource: arn:aws:states:::lambda:invoke, End: true }
    End: true
`);
    assert.ok(hasError(errs, 'Iterator is not valid'));
  });

  it('propagates lint errors from inside an iterator', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemProcessor:
      StartAt: Missing
      States:
        C: { Type: Task, Resource: arn:aws:states:::lambda:invoke, End: true }
    End: true
`);
    assert.ok(hasError(errs, '[Iterator]'));
  });
});

// ── Pass state ────────────────────────────────────────────────────────────────

describe('Pass: Result and ResultPath usage', () => {
  it('warns when Result is set but ResultPath is null', () => {
    const errs = lint(`
StartAt: P
States:
  P:
    Type: Pass
    Result:
      foo: bar
    ResultPath: null
    End: true
`);
    assert.ok(hasError(errs, 'ResultPath is null'));
  });

  it('warns when Result and Parameters are both set', () => {
    const errs = lint(`
StartAt: P
States:
  P:
    Type: Pass
    Result:
      foo: bar
    Parameters:
      baz: qux
    End: true
`);
    assert.ok(hasError(errs, 'Result and Parameters are mutually exclusive'));
  });

  it('passes when only Result is set', () => {
    const errs = lint(`
StartAt: P
States:
  P:
    Type: Pass
    Result:
      foo: bar
    End: true
`);
    assert.ok(!hasError(errs, 'ResultPath is null'));
    assert.ok(!hasError(errs, 'mutually exclusive'));
  });
});

// ── R-16: Uncatchable errors ──────────────────────────────────────────────────

describe('R-16: Uncatchable errors', () => {
  it('warns when catching States.DataLimitExceeded', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Catch:
      - ErrorEquals: [States.DataLimitExceeded]
        Next: B
    End: true
  B: { Type: Fail }
`);
    assert.ok(hasError(errs, 'States.DataLimitExceeded'));
  });

  it('warns when catching States.Runtime', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Catch:
      - ErrorEquals: [States.Runtime]
        Next: B
    End: true
  B: { Type: Fail }
`);
    assert.ok(hasError(errs, 'States.Runtime'));
  });
});

// ── R-18: Items vs ItemsPath per query language ───────────────────────────────

describe('R-18: Items vs ItemsPath', () => {
  it('reports ItemsPath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: M
States:
  M:
    Type: Map
    ItemsPath: $.items
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"ItemsPath" is JSONPath-only'));
  });

  it('reports Items in JSONPath mode', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    Items:
      - a
      - b
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"Items" is a JSONata field'));
  });
});

// ── R-20: Mutual exclusion on Map fields ──────────────────────────────────────

describe('R-20: MaxConcurrency / MaxConcurrencyPath mutual exclusion', () => {
  it('reports MaxConcurrency + MaxConcurrencyPath', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    MaxConcurrency: 5
    MaxConcurrencyPath: $.concurrency
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, 'MaxConcurrency and MaxConcurrencyPath are mutually exclusive'));
  });

  it('reports ToleratedFailureCount + ToleratedFailureCountPath', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ToleratedFailureCount: 3
    ToleratedFailureCountPath: $.count
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, 'ToleratedFailureCount and ToleratedFailureCountPath are mutually exclusive'));
  });
});

// ── R-24: State name max 80 chars ────────────────────────────────────────────

describe('R-24: State name max 80 chars', () => {
  it('reports state name > 80 chars', () => {
    const longName = 'A'.repeat(81);
    const errs = lint(`
StartAt: ${longName}
States:
  ${longName}: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(hasError(errs, 'state name is too long'));
  });

  it('passes for name exactly 80 chars', () => {
    const name = 'A'.repeat(80);
    const errs = lint(`
StartAt: ${name}
States:
  ${name}: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(!hasError(errs, 'state name is too long'));
  });
});

// ── R-25: State name forbidden characters ────────────────────────────────────

describe('R-25: State name forbidden characters', () => {
  it('reports state name with forbidden character', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, Next: "B<C" }
  "B<C": { Type: Succeed }
`);
    assert.ok(hasError(errs, 'forbidden characters'));
  });
});

// ── J-2: Choice Condition vs Variable ────────────────────────────────────────

describe('J-2: Choice — Condition vs Variable per query language', () => {
  it('reports Variable in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.x
        StringEquals: y
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, '"Variable" (JSONPath) — in JSONata mode use "Condition"'));
  });

  it('reports Condition without {%...%} delimiters', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Condition: "$states.input.x = 1"
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, '{%...%}'));
  });

  it('reports Condition in JSONPath mode', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Condition: "{% $states.input.x = 1 %}"
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, '"Condition" (JSONata) — in JSONPath mode use "Variable"'));
  });
});

// ── J-5: ResultSelector in JSONata mode ──────────────────────────────────────

describe('J-5: ResultSelector in JSONata mode', () => {
  it('reports ResultSelector in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    ResultSelector:
      foo.$: $.bar
    End: true
`);
    assert.ok(hasError(errs, '"ResultSelector" is a JSONPath field'));
  });
});

// ── J-6: TimeoutSecondsPath / HeartbeatSecondsPath in JSONata mode ────────────

describe('J-6: Path fields in JSONata mode', () => {
  it('reports TimeoutSecondsPath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    TimeoutSecondsPath: $.timeout
    End: true
`);
    assert.ok(hasError(errs, '"TimeoutSecondsPath" is JSONPath-only'));
  });

  it('reports HeartbeatSecondsPath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    HeartbeatSecondsPath: $.heartbeat
    End: true
`);
    assert.ok(hasError(errs, '"HeartbeatSecondsPath" is JSONPath-only'));
  });
});

// ── J-7: SecondsPath / TimestampPath in JSONata Wait state ───────────────────

describe('J-7: JSONPath timing fields in JSONata Wait state', () => {
  it('reports SecondsPath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: W
States:
  W:
    Type: Wait
    SecondsPath: $.delay
    End: true
`);
    assert.ok(hasError(errs, '"SecondsPath" is JSONPath-only'));
  });

  it('reports TimestampPath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: W
States:
  W:
    Type: Wait
    TimestampPath: $.ts
    End: true
`);
    assert.ok(hasError(errs, '"TimestampPath" is JSONPath-only'));
  });
});

// ── J-8: States.* intrinsic functions in JSONata mode ────────────────────────

describe('J-8: States.* intrinsic functions in JSONata mode', () => {
  it('reports States.Format inside {%...%}', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Arguments:
      x: "{% States.Format('hello {}', $states.input.name) %}"
    End: true
`);
    assert.ok(hasError(errs, 'States.*'));
  });
});

// ── J-9: $$. in JSONata mode ──────────────────────────────────────────────────

describe('J-9: $$. Context Object syntax in JSONata mode', () => {
  it('reports $$. in Arguments in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Arguments:
      token: "$$.Task.Token"
    End: true
`);
    assert.ok(hasError(errs, '"$$."'));
  });
});

// ── W-3: $states.errorOutput outside Catch ───────────────────────────────────

describe('W-3: $states.errorOutput outside Catch', () => {
  it('reports $states.errorOutput in Arguments (not in Catch)', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Arguments:
      err: "{% $states.errorOutput %}"
    End: true
`);
    assert.ok(hasError(errs, '$states.errorOutput'));
  });
});

// ── ARN-1: Resource ARN format ────────────────────────────────────────────────

describe('ARN-1: Resource must start with arn:', () => {
  it('warns when Resource does not start with arn:', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: lambda:invoke
    End: true
`);
    assert.ok(hasError(errs, 'is not a valid ARN'));
  });

  it('passes for a valid optimised integration ARN', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke
    End: true
`);
    assert.ok(!hasError(errs, 'is not a valid ARN'));
  });

  it('passes for a direct Lambda ARN', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:lambda:us-east-1:123456789012:function:myFn
    End: true
`);
    assert.ok(!hasError(errs, 'is not a valid ARN'));
  });

  it('passes for a GovCloud ARN (arn:aws-us-gov:)', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws-us-gov:states:::lambda:invoke
    End: true
`);
    assert.ok(!hasError(errs, 'is not a valid ARN'));
  });

  it('passes for a China region ARN (arn:aws-cn:)', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws-cn:states:::lambda:invoke
    End: true
`);
    assert.ok(!hasError(errs, 'is not a valid ARN'));
  });
});

// ── ARN-2: SDK integration pattern compatibility ───────────────────────────────

describe('ARN-2: .sync incompatible services', () => {
  it('reports .sync on SQS', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::sqs:sendMessage.sync
    End: true
`);
    assert.ok(hasError(errs, 'service "sqs" does not support ".sync"'));
  });

  it('reports .sync on SNS', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::sns:publish.sync
    End: true
`);
    assert.ok(hasError(errs, 'service "sns" does not support ".sync"'));
  });

  it('reports .sync on DynamoDB', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::dynamodb:putItem.sync
    End: true
`);
    assert.ok(hasError(errs, 'service "dynamodb" does not support ".sync"'));
  });

  it('reports .sync on HTTP Task', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke.sync
    End: true
`);
    assert.ok(hasError(errs, 'service "http" does not support ".sync"'));
  });

  it('does not warn for fire-and-forget Lambda integration', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke
    End: true
`);
    assert.ok(!hasError(errs, 'does not support'));
  });
});

describe('ARN-2: .waitForTaskToken incompatible services', () => {
  it('reports .waitForTaskToken on DynamoDB', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::dynamodb:putItem.waitForTaskToken
    End: true
`);
    assert.ok(hasError(errs, 'service "dynamodb" does not support ".waitForTaskToken"'));
  });

  it('reports .waitForTaskToken on Athena', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::athena:startQueryExecution.waitForTaskToken
    End: true
`);
    assert.ok(hasError(errs, 'service "athena" does not support ".waitForTaskToken"'));
  });

  it('passes .waitForTaskToken on Lambda', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke.waitForTaskToken
    End: true
`);
    assert.ok(!hasError(errs, 'does not support ".waitForTaskToken"'));
  });

  it('passes .waitForTaskToken on SQS', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::sqs:sendMessage.waitForTaskToken
    End: true
`);
    assert.ok(!hasError(errs, 'does not support ".waitForTaskToken"'));
  });

  it('passes .waitForTaskToken on SNS', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::sns:publish.waitForTaskToken
    End: true
`);
    assert.ok(!hasError(errs, 'does not support ".waitForTaskToken"'));
  });

  it('passes .waitForTaskToken on EventBridge', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::events:putEvents.waitForTaskToken
    End: true
`);
    assert.ok(!hasError(errs, 'does not support ".waitForTaskToken"'));
  });
});

// ── ARN-2: aws-sdk .sync ──────────────────────────────────────────────────────

describe('ARN-2: aws-sdk integrations do not support .sync', () => {
  it('reports .sync on aws-sdk format', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::aws-sdk:lambda:invoke.sync
    End: true
`);
    assert.ok(hasError(errs, 'aws-sdk:*') || hasError(errs, 'AWS SDK'));
  });
});

// ── ARN-2: Lambda and API Gateway do not support .sync ───────────────────────

describe('ARN-2: lambda and apigateway do not support .sync', () => {
  it('reports .sync on Lambda optimized integration', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke.sync
    End: true
`);
    assert.ok(hasError(errs, 'service "lambda" does not support ".sync"'));
  });

  it('reports .sync on API Gateway', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::apigateway:invoke.sync
    End: true
`);
    assert.ok(hasError(errs, 'service "apigateway" does not support ".sync"'));
  });

});

// ── ARN-2: EventBridge supports .waitForTaskToken ────────────────────────────

describe('ARN-2: EventBridge supports .waitForTaskToken', () => {
  it('does not report incompatible error for EventBridge .waitForTaskToken', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::events:putEvents.waitForTaskToken
    HeartbeatSeconds: 60
    Catch:
      - ErrorEquals: [States.HeartbeatTimeout]
        Next: B
    End: true
  B: { Type: Fail }
`);
    assert.ok(!hasError(errs, '"events" does not support ".waitForTaskToken"'));
    assert.ok(!hasError(errs, '"eventbridge" does not support ".waitForTaskToken"'));
  });
});

// ── HTTP Task required fields ─────────────────────────────────────────────────

describe('HTTP Task required fields', () => {
  it('reports missing ApiEndpoint', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    Parameters:
      Method: GET
      Authentication:
        ConnectionArn: arn:aws:events:us-east-1:123:connection/my-conn
    End: true
`);
    assert.ok(hasError(errs, '"ApiEndpoint" is required'));
  });

  it('reports missing Method', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    Parameters:
      ApiEndpoint: https://api.example.com/path
      Authentication:
        ConnectionArn: arn:aws:events:us-east-1:123:connection/my-conn
    End: true
`);
    assert.ok(hasError(errs, '"Method" is required'));
  });

  it('passes when all required fields are present', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    Parameters:
      ApiEndpoint: https://api.example.com/path
      Method: GET
      Authentication:
        ConnectionArn: arn:aws:events:us-east-1:123:connection/my-conn
    End: true
`);
    assert.ok(!hasError(errs, '"ApiEndpoint" is required'));
    assert.ok(!hasError(errs, '"Method" is required'));
  });
});

// ── W-4: $states.context.Task.Token outside waitForTaskToken ─────────────────

describe('W-4: $states.context.Task.Token outside waitForTaskToken', () => {
  it('warns when Token used in non-waitForTaskToken state', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke
    Arguments:
      token: "{% $states.context.Task.Token %}"
    End: true
`);
    assert.ok(hasError(errs, '$states.context.Task.Token'));
  });

  it('does not warn when used in waitForTaskToken state', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke.waitForTaskToken
    Arguments:
      token: "{% $states.context.Task.Token %}"
    End: true
`);
    assert.ok(!hasError(errs, 'W-4'));
  });
});

// ── TimeoutSeconds > 0 ───────────────────────────────────────────────────────

describe('TimeoutSeconds must be > 0', () => {
  it('reports TimeoutSeconds: 0', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    TimeoutSeconds: 0
    End: true
`);
    assert.ok(hasError(errs, 'TimeoutSeconds must be a positive integer'));
  });

  it('passes for TimeoutSeconds: 1', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    TimeoutSeconds: 1
    End: true
`);
    assert.ok(!hasError(errs, 'TimeoutSeconds must be a positive integer'));
  });
});

// ── HeartbeatSeconds > 0 ─────────────────────────────────────────────────────

describe('HeartbeatSeconds must be > 0', () => {
  it('reports HeartbeatSeconds: 0', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    HeartbeatSeconds: 0
    TimeoutSeconds: 30
    End: true
`);
    assert.ok(hasError(errs, 'HeartbeatSeconds must be a positive integer'));
  });
});

// ── IntervalSeconds >= 1 ─────────────────────────────────────────────────────

describe('Retry.IntervalSeconds must be >= 1', () => {
  it('reports IntervalSeconds: 0', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        IntervalSeconds: 0
    End: true
`);
    assert.ok(hasError(errs, 'IntervalSeconds must be ≥ 1'));
  });

  it('passes for IntervalSeconds: 1', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        IntervalSeconds: 1
    End: true
`);
    assert.ok(!hasError(errs, 'IntervalSeconds'));
  });
});

// ── Succeed/Fail + Next interdit ─────────────────────────────────────────────

describe('Succeed/Fail must not have Next', () => {
  it('reports Next on Succeed', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, Next: B }
  B:
    Type: Succeed
    Next: A
`);
    assert.ok(hasError(errs, '"Next" is not allowed on a terminal state'));
  });

  it('reports Next on Fail', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, Next: F }
  F:
    Type: Fail
    Next: A
`);
    assert.ok(hasError(errs, '"Next" is not allowed on a terminal state'));
  });
});


// ── Choice + Retry/Catch interdits ───────────────────────────────────────────

describe('Choice must not have Retry or Catch', () => {
  it('reports Retry on Choice', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.x
        StringEquals: y
        Next: B
    Retry:
      - ErrorEquals: [States.ALL]
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, '"Retry" is not allowed on a Choice state'));
  });

  it('reports Catch on Choice', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.x
        StringEquals: y
        Next: B
    Catch:
      - ErrorEquals: [States.ALL]
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, '"Catch" is not allowed on a Choice state'));
  });
});


// ── HTTP Task Method enum validation ────────────────────────────────────────────

describe('HTTP Task Method enum validation', () => {
  it('reports invalid Method value', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    Parameters:
      ApiEndpoint: https://api.example.com
      Method: CONNECT
      Authentication:
        ConnectionArn: arn:aws:events:us-east-1:123:connection/c
    End: true
`);
    assert.ok(hasError(errs, 'invalid HTTP method "CONNECT"'));
  });

  it('passes for valid Method: DELETE', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    Parameters:
      ApiEndpoint: https://api.example.com
      Method: DELETE
      Authentication:
        ConnectionArn: arn:aws:events:us-east-1:123:connection/c
    End: true
`);
    assert.ok(!hasError(errs, 'invalid HTTP method'));
  });
});

// ── Wait Seconds range ────────────────────────────────────────────────────────

describe('Wait.Seconds valid range (0–99999999)', () => {
  it('reports negative Seconds', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Seconds: -1
    End: true
`);
    assert.ok(hasError(errs, 'Seconds (-1) out of range'));
  });

  it('reports Seconds > 99999999', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Seconds: 100000000
    End: true
`);
    assert.ok(hasError(errs, 'out of range'));
  });

  it('passes for Seconds: 0', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Seconds: 0
    End: true
`);
    assert.ok(!hasError(errs, 'out of range'));
  });
});

// ── Wait Timestamp RFC3339 ────────────────────────────────────────────────────

describe('Wait.Timestamp must be RFC3339 with uppercase T and Z', () => {
  it('reports lowercase t separator', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Timestamp: "2024-01-15t12:00:00Z"
    End: true
`);
    assert.ok(hasError(errs, 'Timestamp') && hasError(errs, 'RFC3339'));
  });

  it('reports numeric offset instead of Z', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Timestamp: "2024-01-15T12:00:00+02:00"
    End: true
`);
    assert.ok(hasError(errs, 'RFC3339'));
  });

  it('passes for valid RFC3339 timestamp', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Timestamp: "2024-01-15T12:00:00Z"
    End: true
`);
    assert.ok(!hasError(errs, 'RFC3339'));
  });

  it('passes for RFC3339 with milliseconds', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Timestamp: "2024-01-15T12:00:00.500Z"
    End: true
`);
    assert.ok(!hasError(errs, 'RFC3339'));
  });
});

// ── Choice Timestamp RFC3339 ──────────────────────────────────────────────────

describe('Choice TimestampEquals must be RFC3339', () => {
  it('reports invalid timestamp in TimestampEquals', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.ts
        TimestampEquals: "2024/01/15 12:00:00"
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, 'TimestampEquals') && hasError(errs, 'RFC3339'));
  });

  it('passes for valid RFC3339 in TimestampGreaterThan', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.ts
        TimestampGreaterThan: "2024-01-15T00:00:00Z"
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(!hasError(errs, 'RFC3339'));
  });
});

// ── States.Hash algorithm ─────────────────────────────────────────────────────

describe('States.Hash algorithm validation', () => {
  it('reports invalid algorithm', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Parameters:
      hash.$: "States.Hash($.data, 'INVALID')"
    End: true
`);
    assert.ok(hasError(errs, 'States.Hash') && hasError(errs, 'INVALID'));
  });

  it('passes for SHA-256', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Parameters:
      hash.$: "States.Hash($.data, 'SHA-256')"
    End: true
`);
    assert.ok(!hasError(errs, 'States.Hash'));
  });

  it('passes for MD5', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Parameters:
      hash.$: "States.Hash($.data, 'MD5')"
    End: true
`);
    assert.ok(!hasError(errs, 'States.Hash'));
  });
});

// ── States.JsonMerge third arg ────────────────────────────────────────────────

describe('States.JsonMerge third argument must be false', () => {
  it('reports third arg true', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Pass
    Parameters:
      merged.$: "States.JsonMerge($.a, $.b, true)"
    End: true
`);
    assert.ok(hasError(errs, 'States.JsonMerge') && hasError(errs, '3rd argument'));
  });

  it('passes for third arg false', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Pass
    Parameters:
      merged.$: "States.JsonMerge($.a, $.b, false)"
    End: true
`);
    assert.ok(!hasError(errs, 'States.JsonMerge'));
  });
});

// ── TimeoutSeconds max limit ────────────────────────────────────────────────

describe('TimeoutSeconds max 99999999', () => {
  it('reports TimeoutSeconds > 99999999', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    TimeoutSeconds: 100000000
    End: true
`);
    assert.ok(hasError(errs, 'exceeds the maximum limit of 99999999'));
  });

  it('passes for TimeoutSeconds: 99999999', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    TimeoutSeconds: 99999999
    End: true
`);
    assert.ok(!hasError(errs, 'exceeds the maximum limit'));
  });
});

// ── HeartbeatSeconds max limit ──────────────────────────────────────────────

describe('HeartbeatSeconds max 99999999', () => {
  it('reports HeartbeatSeconds > 99999999', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    HeartbeatSeconds: 100000000
    TimeoutSeconds: 99999999
    End: true
`);
    assert.ok(hasError(errs, 'HeartbeatSeconds (100000000) exceeds the maximum limit'));
  });
});

// ── Retry.MaxDelaySeconds range ─────────────────────────────────────────────

describe('Retry.MaxDelaySeconds must be 1–31622400', () => {
  it('reports MaxDelaySeconds: 0', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        MaxDelaySeconds: 0
    End: true
`);
    assert.ok(hasError(errs, 'MaxDelaySeconds must be between 1 and 31622400'));
  });

  it('reports MaxDelaySeconds > 31622400', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        MaxDelaySeconds: 31622401
    End: true
`);
    assert.ok(hasError(errs, 'MaxDelaySeconds must be between 1 and 31622400'));
  });

  it('passes for MaxDelaySeconds: 1', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        MaxDelaySeconds: 1
    End: true
`);
    assert.ok(!hasError(errs, 'MaxDelaySeconds'));
  });
});

// ── Retry.MaxAttempts >= 0 ──────────────────────────────────────────────────

describe('Retry.MaxAttempts must be >= 0', () => {
  it('reports MaxAttempts: -1', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        MaxAttempts: -1
    End: true
`);
    assert.ok(hasError(errs, 'MaxAttempts must be ≥ 0'));
  });

  it('passes for MaxAttempts: 0', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        MaxAttempts: 0
    End: true
`);
    assert.ok(!hasError(errs, 'MaxAttempts'));
  });
});

// ── Retry.JitterStrategy validation ─────────────────────────────────────────

describe('Retry.JitterStrategy must be FULL or NONE', () => {
  it('reports invalid JitterStrategy', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        JitterStrategy: RANDOM
    End: true
`);
    assert.ok(hasError(errs, 'JitterStrategy "RANDOM" is not valid'));
  });

  it('passes for JitterStrategy: FULL', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        JitterStrategy: FULL
    End: true
`);
    assert.ok(!hasError(errs, 'JitterStrategy'));
  });

  it('passes for JitterStrategy: NONE', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        JitterStrategy: NONE
    End: true
`);
    assert.ok(!hasError(errs, 'JitterStrategy'));
  });
});

// ── Choice recursive Not/And/Or timestamp validation ────────────────────────

describe('Choice: recursive Not/And/Or timestamp validation', () => {
  it('reports invalid timestamp inside Not', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Not:
          Variable: $.ts
          TimestampEquals: "2024/01/15 12:00"
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, 'TimestampEquals') && hasError(errs, 'RFC3339'));
  });

  it('reports invalid timestamp inside And', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - And:
          - Variable: $.x
            StringEquals: y
          - Variable: $.ts
            TimestampGreaterThan: "bad-timestamp"
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, 'TimestampGreaterThan') && hasError(errs, 'RFC3339'));
  });

  it('passes for valid timestamp inside Or', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Or:
          - Variable: $.ts
            TimestampEquals: "2024-01-15T12:00:00Z"
          - Variable: $.x
            StringEquals: y
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(!hasError(errs, 'RFC3339'));
  });
});

// ── Choice recursive J-2: Variable in JSONata mode ──────────────────────────

describe('J-2 recursive: Variable inside Not/And in JSONata mode', () => {
  it('reports Variable inside Not in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Not:
          Variable: $.x
          StringEquals: y
        Next: B
    Default: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, '"Variable" (JSONPath)'));
  });
});

// ── Task sans Resource ────────────────────────────────────────────────────────

describe('Task requires Resource', () => {
  it('reports Task without Resource', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    End: true
`);
    assert.ok(hasError(errs, '"Resource" is required'));
  });

  it('passes when Resource is present', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke
    End: true
`);
    assert.ok(!hasError(errs, '"Resource" is required'));
  });
});

// ── Choice avec End ou Next interdit ─────────────────────────────────────────

describe('Choice must not have End or Next', () => {
  it('reports End on Choice', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.x
        StringEquals: y
        Next: B
    Default: B
    End: true
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, '"End" is not allowed on a Choice state'));
  });

  it('reports Next on Choice', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Choice
    Choices:
      - Variable: $.x
        StringEquals: y
        Next: B
    Default: B
    Next: B
  B: { Type: Succeed }
`);
    assert.ok(hasError(errs, '"Next" is not allowed'));
  });
});

// ── Assign en mode JSONPath ───────────────────────────────────────────────────

describe('Assign is JSONata-only', () => {
  it('warns when Assign is used in JSONPath mode', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Assign:
      myVar: hello
    End: true
`);
    assert.ok(hasError(errs, '"Assign" is a JSONata field'));
  });

  it('does not warn when Assign is used in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Assign:
      myVar: hello
    End: true
`);
    assert.ok(!hasError(errs, '"Assign" is a JSONata field'));
  });
});

// ── CausePath / ErrorPath en mode JSONata ─────────────────────────────────────

describe('CausePath / ErrorPath are JSONPath-only in Fail state', () => {
  it('reports ErrorPath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Fail
    ErrorPath: $.errorCode
`);
    assert.ok(hasError(errs, '"ErrorPath" is JSONPath-only'));
  });

  it('reports CausePath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Fail
    CausePath: $.cause
`);
    assert.ok(hasError(errs, '"CausePath" is JSONPath-only'));
  });
});

// ── MaxConcurrencyPath en mode JSONata ───────────────────────────────────────

describe('MaxConcurrencyPath is JSONPath-only in JSONata mode', () => {
  it('reports MaxConcurrencyPath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: M
States:
  M:
    Type: Map
    MaxConcurrencyPath: $.concurrency
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"MaxConcurrencyPath" is JSONPath-only'));
  });
});

// ── ToleratedFailure*Path en mode JSONata ─────────────────────────────────────

describe('ToleratedFailureCountPath / ToleratedFailurePercentagePath are JSONPath-only', () => {
  it('reports ToleratedFailureCountPath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: M
States:
  M:
    Type: Map
    ToleratedFailureCountPath: $.count
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"ToleratedFailureCountPath" is JSONPath-only'));
  });

  it('reports ToleratedFailurePercentagePath in JSONata mode', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: M
States:
  M:
    Type: Map
    ToleratedFailurePercentagePath: $.pct
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"ToleratedFailurePercentagePath" is JSONPath-only'));
  });
});

// ── ItemBatcher / ItemReader / ResultWriter sur Map INLINE ───────────────────

describe('ItemBatcher / ItemReader / ResultWriter are DISTRIBUTED-only', () => {
  it('warns ItemBatcher on INLINE Map', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemBatcher:
      MaxItemsPerBatch: 10
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"ItemBatcher" is reserved for DISTRIBUTED Maps'));
  });

  it('warns ItemReader on INLINE Map', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemReader:
      Resource: arn:aws:states:::s3:getObject
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"ItemReader" is reserved for DISTRIBUTED Maps'));
  });

  it('warns ResultWriter on INLINE Map', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ResultWriter:
      Resource: arn:aws:states:::s3:putObject
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"ResultWriter" is reserved for DISTRIBUTED Maps'));
  });

  it('does not warn ItemBatcher on DISTRIBUTED Map', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemBatcher:
      MaxItemsPerBatch: 10
    ItemProcessor:
      ProcessorConfig:
        Mode: DISTRIBUTED
        ExecutionType: STANDARD
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(!hasError(errs, '"ItemBatcher" is reserved'));
  });
});

// ── Version validation ────────────────────────────────────────────────────────

describe('Version — only "1.0" is valid', () => {
  it('reports Version: "2.0"', () => {
    const errs = lint(`
Version: "2.0"
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(hasError(errs, 'Version "2.0" is not valid'));
  });

  it('passes when Version is absent', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(!hasError(errs, 'Version'));
  });

  it('passes for Version: "1.0"', () => {
    const errs = lint(`
Version: "1.0"
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(!hasError(errs, 'Version'));
  });
});

// ── Label on Map INLINE ───────────────────────────────────────────────────────

describe('Label is not valid on Map INLINE', () => {
  it('warns when Label is set on INLINE Map', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    Label: my-label
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, 'Label is ignored in INLINE mode'));
  });

  it('does not warn when Label is set on DISTRIBUTED Map', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    Label: my-label
    ItemProcessor:
      ProcessorConfig:
        Mode: DISTRIBUTED
        ExecutionType: STANDARD
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(!hasError(errs, 'Label is ignored in INLINE mode'));
  });
});

// ── QueryLanguage validation ──────────────────────────────────────────────────

describe('QueryLanguage — definition-level validation', () => {
  it('reports invalid QueryLanguage at definition level', () => {
    const errs = lint(`
QueryLanguage: JSONPath2
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(hasError(errs, 'QueryLanguage "JSONPath2" is not valid'));
  });

  it('passes for QueryLanguage: JSONata', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(!hasError(errs, 'QueryLanguage'));
  });

  it('passes for QueryLanguage: JSONPath', () => {
    const errs = lint(`
QueryLanguage: JSONPath
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(!hasError(errs, 'QueryLanguage'));
  });

  it('reports invalid QueryLanguage at state level', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    QueryLanguage: SPARQL
    End: true
`);
    assert.ok(hasError(errs, 'QueryLanguage "SPARQL" is not valid'));
  });
});

// ── AslDefinition.TimeoutSeconds global ──────────────────────────────────────

describe('Global TimeoutSeconds validation (1–99999999)', () => {
  it('reports TimeoutSeconds: 0 at definition level', () => {
    const errs = lint(`
TimeoutSeconds: 0
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(hasError(errs, 'global TimeoutSeconds (0) is not valid'));
  });

  it('reports TimeoutSeconds > 99999999 at definition level', () => {
    const errs = lint(`
TimeoutSeconds: 100000000
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(hasError(errs, 'global TimeoutSeconds (100000000) is not valid'));
  });

  it('passes for TimeoutSeconds: 3600', () => {
    const errs = lint(`
TimeoutSeconds: 3600
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(!hasError(errs, 'TimeoutSeconds global'));
  });
});

// ── Retry.IntervalSeconds max ─────────────────────────────────────────────────

describe('Retry.IntervalSeconds max 99999999', () => {
  it('reports IntervalSeconds > 99999999', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        IntervalSeconds: 100000000
    End: true
`);
    assert.ok(hasError(errs, 'IntervalSeconds (100000000) exceeds the maximum limit'));
  });

  it('passes for IntervalSeconds: 99999999', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    Retry:
      - ErrorEquals: [States.ALL]
        IntervalSeconds: 99999999
    End: true
`);
    assert.ok(!hasError(errs, 'exceeds the maximum limit'));
  });
});

// ── CloudFormation intrinsic Resource references ──────────────────────────────

describe('CloudFormation intrinsic Resource — no false positives', () => {
  it('does not crash or warn for Fn::GetAtt (object form)', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource:
      Fn::GetAtt: [MyLambda, Arn]
    End: true
`);
    assert.ok(!hasError(errs, 'not a valid ARN'));
    assert.ok(!hasError(errs, '"Resource" is required'));
  });

  it('does not warn for !GetAtt string form (e.g. "MyLambda.Arn")', () => {
    // yaml strips the !GetAtt tag and produces the plain string "MyLambda.Arn"
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: MyLambda.Arn
    End: true
`);
    assert.ok(!hasError(errs, 'not a valid ARN'));
    assert.ok(!hasError(errs, '"Resource" is required'));
  });
});

// ── Dynamic values in Timestamp (Wait state) ─────────────────────────────────

describe('Wait state Timestamp — dynamic values skip RFC3339 check', () => {
  it('does not warn for JSONata expression in Timestamp', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: W
States:
  W:
    Type: Wait
    Timestamp: "{% $states.input.startAt %}"
    End: true
`);
    assert.ok(!hasError(errs, 'RFC3339'));
  });

  it('does not warn for JSONPath reference in Timestamp', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Timestamp: $.myTimestamp
    End: true
`);
    assert.ok(!hasError(errs, 'RFC3339'));
  });

  it('still warns for a malformed static Timestamp', () => {
    const errs = lint(`
StartAt: W
States:
  W:
    Type: Wait
    Timestamp: "2024-01-15 12:00:00"
    End: true
`);
    assert.ok(hasError(errs, 'RFC3339'));
  });
});

// ── Dynamic values in Choice Timestamp comparison keys ────────────────────────

describe('Choice TimestampEquals — dynamic values skip RFC3339 check', () => {
  it('does not warn for JSONata expression in TimestampEquals', () => {
    const errs = lint(`
StartAt: C
States:
  C:
    Type: Choice
    Choices:
      - Variable: $.date
        TimestampEquals: "{% $states.input.cutoff %}"
        Next: End
    Default: End
  End: { Type: Succeed }
`);
    assert.ok(!hasError(errs, 'RFC3339'));
  });

  it('does not warn for JSONPath reference in TimestampGreaterThan', () => {
    const errs = lint(`
StartAt: C
States:
  C:
    Type: Choice
    Choices:
      - Variable: $.date
        TimestampGreaterThan: $.cutoffDate
        Next: End
    Default: End
  End: { Type: Succeed }
`);
    assert.ok(!hasError(errs, 'RFC3339'));
  });
});

// ── Dynamic values in HTTP Task Method ───────────────────────────────────────

describe('HTTP Task Method — dynamic values skip method validation', () => {
  it('does not warn for JSONata expression in Method', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    Arguments:
      ApiEndpoint: https://example.com/api
      Method: "{% $states.input.httpMethod %}"
    End: true
`);
    assert.ok(!hasError(errs, 'invalid HTTP method'));
  });

  it('does not warn for JSONPath reference in Method', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    Parameters:
      ApiEndpoint: https://example.com/api
      Method.$: $.httpMethod
    End: true
`);
    assert.ok(!hasError(errs, 'invalid HTTP method'));
  });

  it('still warns for an invalid static Method', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    Parameters:
      ApiEndpoint: https://example.com/api
      Method: FETCH
    End: true
`);
    assert.ok(hasError(errs, 'invalid HTTP method'));
  });
});

// ── Dynamic values in Retry.JitterStrategy ───────────────────────────────────

describe('JitterStrategy — dynamic values skip enum check', () => {
  it('does not warn for JSONata expression in JitterStrategy', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke
    Retry:
      - ErrorEquals: [States.ALL]
        JitterStrategy: "{% $states.input.strategy %}"
    End: true
`);
    assert.ok(!hasError(errs, 'JitterStrategy'));
  });

  it('does not warn for JSONPath reference in JitterStrategy', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke
    Retry:
      - ErrorEquals: [States.ALL]
        JitterStrategy: $.jitterStrategy
    End: true
`);
    assert.ok(!hasError(errs, 'JitterStrategy'));
  });
});

// ── R-12 dynamic HeartbeatSeconds / TimeoutSeconds ───────────────────────────

describe('R-12: no false positive when HeartbeatSeconds or TimeoutSeconds is dynamic', () => {
  it('does not warn when both are JSONata expressions', () => {
    const errs = lint(`
QueryLanguage: JSONata
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke
    TimeoutSeconds: "{% $states.input.timeout %}"
    HeartbeatSeconds: "{% $states.input.heartbeat %}"
    End: true
`);
    assert.ok(!hasError(errs, 'less than TimeoutSeconds'));
  });

  it('does not warn when HeartbeatSeconds is a JSONPath reference', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke
    TimeoutSeconds: 60
    HeartbeatSeconds: $.heartbeat
    End: true
`);
    assert.ok(!hasError(errs, 'less than TimeoutSeconds'));
  });

  it('still warns when both are static numbers and heartbeat >= timeout', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn
    TimeoutSeconds: 30
    HeartbeatSeconds: 30
    End: true
`);
    assert.ok(hasError(errs, 'less than TimeoutSeconds'));
  });
});

// ── findLineForStateName ────────────────────────────────────────────────────

describe('findLineForStateName', () => {
  const mockDoc = (text: string) => ({ getText: () => text }) as Parameters<typeof findLineForStateName>[0];

  it('finds the correct line for a state name', () => {
    const line = findLineForStateName(
      mockDoc('StartAt: A\nStates:\n  A:\n    Type: Task\n  B:\n    Type: Succeed'),
      'B'
    );
    assert.strictEqual(line, 4);
  });

  it('returns 0 when state name not found', () => {
    const line = findLineForStateName(
      mockDoc('StartAt: A\nStates:\n  A:\n    Type: Task'),
      'Missing'
    );
    assert.strictEqual(line, 0);
  });

  it('finds quoted state name', () => {
    const line = findLineForStateName(
      mockDoc('StartAt: A\nStates:\n  A:\n    Type: Task\n  "My State":\n    Type: Succeed'),
      'My State'
    );
    assert.strictEqual(line, 4);
  });
});
