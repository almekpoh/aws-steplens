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
    assert.ok(hasError(errs, 'Next "Nowhere" introuvable'));
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
    assert.ok(hasError(errs, 'ni "Next" ni "End"'));
  });

  it('does not flag Succeed or Fail', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, Next: B }
  B: { Type: Succeed }
`);
    assert.ok(!hasError(errs, 'ni "Next" ni "End"'));
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
    assert.ok(hasError(errs, 'Catch[0].Next "Nowhere" introuvable'));
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
    assert.ok(hasError(errs, 'aucune branche'));
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
    assert.ok(hasError(errs, 'sans "Next"'));
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
    assert.ok(hasError(errs, 'Catch pour States.HeartbeatTimeout'));
  });
});

// ── R-10: MaxConcurrency: 0 ───────────────────────────────────────────────────

describe('R-10: MaxConcurrency 0 warning', () => {
  it('warns when MaxConcurrency is 0', () => {
    const errs = lint(`
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
`);
    assert.ok(hasError(errs, 'illimitée'));
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
    assert.ok(hasError(errs, 'TimeoutSeconds et TimeoutSecondsPath sont mutuellement exclusifs'));
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
    assert.ok(hasError(errs, 'inférieur à TimeoutSeconds'));
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
    assert.ok(hasError(errs, 'Error et ErrorPath sont mutuellement exclusifs'));
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
    assert.ok(hasError(errs, 'aucun champ de timing'));
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
    assert.ok(hasError(errs, 'plusieurs champs de timing'));
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
    assert.ok(hasError(errs, 'States.ALL" avec d\'autres erreurs'));
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
    assert.ok(hasError(errs, 'doit être le dernier catcheur'));
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
    assert.ok(hasError(errs, 'ErrorEquals est vide'));
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
    assert.ok(hasError(errs, 'entre 0 et 100'));
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
    assert.ok(hasError(errs, '"Orphan" est inaccessible'));
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
    assert.ok(hasError(errs, '"Parameters" est un champ JSONPath'));
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
    assert.ok(hasError(errs, '"Arguments" est un champ JSONata'));
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
    assert.ok(hasError(errs, 'vide'));
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
    assert.ok(hasError(errs, 'parenthèse'));
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
    assert.ok(hasError(errs, 'ExecutionType est requis en mode DISTRIBUTED'));
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
    assert.ok(hasError(errs, 'ignoré en mode INLINE'));
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
    assert.ok(hasError(errs, 'limité à 40'));
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
    assert.ok(hasError(errs, 'EXPRESS ne supportent pas .waitForTaskToken'));
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
    assert.ok(hasError(errs, 'BackoffRate doit être ≥ 1.0'));
  });
});

// ── Deprecated Iterator ───────────────────────────────────────────────────────

describe('Deprecated Iterator warning', () => {
  it('warns when Iterator used instead of ItemProcessor', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    Iterator:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"Iterator" est déprécié'));
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
    assert.ok(hasError(errs, '"P" (Parallel): ni "Next" ni "End"'));
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
    assert.ok(hasError(errs, '"M" (Map): ni "Next" ni "End"'));
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
    assert.ok(!hasError(errs, '(Parallel): ni "Next" ni "End"'));
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
    assert.ok(hasError(errs, 'Branches[0] invalide'));
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
    assert.ok(hasError(errs, 'Branches[0] invalide'));
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
    assert.ok(hasError(errs, 'aucun Iterator ou ItemProcessor'));
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
    assert.ok(hasError(errs, 'Iterator invalide'));
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
    assert.ok(hasError(errs, 'ResultPath est null'));
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
    assert.ok(hasError(errs, 'Result et Parameters sont mutuellement exclusifs'));
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
    assert.ok(!hasError(errs, 'ResultPath est null'));
    assert.ok(!hasError(errs, 'mutuellement exclusifs'));
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
    assert.ok(hasError(errs, '"ItemsPath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, '"Items" est un champ JSONata'));
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
    assert.ok(hasError(errs, 'MaxConcurrency et MaxConcurrencyPath sont mutuellement exclusifs'));
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
    assert.ok(hasError(errs, 'ToleratedFailureCount et ToleratedFailureCountPath sont mutuellement exclusifs'));
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
    assert.ok(hasError(errs, 'nom d\'état trop long'));
  });

  it('passes for name exactly 80 chars', () => {
    const name = 'A'.repeat(80);
    const errs = lint(`
StartAt: ${name}
States:
  ${name}: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(!hasError(errs, 'nom d\'état trop long'));
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
    assert.ok(hasError(errs, 'caractères interdits'));
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
    assert.ok(hasError(errs, '"Variable" (JSONPath) — en mode JSONata utilisez "Condition"'));
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
    assert.ok(hasError(errs, '"Condition" (JSONata) — en mode JSONPath utilisez "Variable"'));
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
    assert.ok(hasError(errs, '"ResultSelector" est un champ JSONPath'));
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
    assert.ok(hasError(errs, '"TimeoutSecondsPath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, '"HeartbeatSecondsPath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, '"SecondsPath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, '"TimestampPath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, 'n\'est pas un ARN valide'));
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
    assert.ok(!hasError(errs, 'n\'est pas un ARN valide'));
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
    assert.ok(!hasError(errs, 'n\'est pas un ARN valide'));
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
    assert.ok(!hasError(errs, 'n\'est pas un ARN valide'));
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
    assert.ok(!hasError(errs, 'n\'est pas un ARN valide'));
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
    assert.ok(hasError(errs, '"sqs" ne supporte pas ".sync"'));
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
    assert.ok(hasError(errs, '"sns" ne supporte pas ".sync"'));
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
    assert.ok(hasError(errs, '"dynamodb" ne supporte pas ".sync"'));
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
    assert.ok(hasError(errs, '"http" ne supporte pas ".sync"'));
  });

  it('warns that .sync requires Standard workflow', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::ecs:runTask.sync
    End: true
`);
    assert.ok(hasError(errs, 'nécessite un workflow Standard'));
  });

  it('warns that .sync:2 requires Standard workflow', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::ecs:runTask.sync:2
    End: true
`);
    assert.ok(hasError(errs, 'nécessite un workflow Standard'));
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
    assert.ok(!hasError(errs, 'ne supporte pas'));
    assert.ok(!hasError(errs, 'nécessite un workflow Standard'));
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
    assert.ok(hasError(errs, '"dynamodb" ne supporte pas ".waitForTaskToken"'));
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
    assert.ok(hasError(errs, '"athena" ne supporte pas ".waitForTaskToken"'));
  });

  it('passes .waitForTaskToken on Lambda (warns Standard workflow)', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke.waitForTaskToken
    End: true
`);
    assert.ok(!hasError(errs, 'ne supporte pas ".waitForTaskToken"'));
    assert.ok(hasError(errs, 'nécessite un workflow Standard'));
  });

  it('passes .waitForTaskToken on SQS (warns Standard workflow)', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::sqs:sendMessage.waitForTaskToken
    End: true
`);
    assert.ok(!hasError(errs, 'ne supporte pas ".waitForTaskToken"'));
    assert.ok(hasError(errs, 'nécessite un workflow Standard'));
  });

  it('passes .waitForTaskToken on SNS (warns Standard workflow)', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::sns:publish.waitForTaskToken
    End: true
`);
    assert.ok(!hasError(errs, 'ne supporte pas ".waitForTaskToken"'));
    assert.ok(hasError(errs, 'nécessite un workflow Standard'));
  });

  it('passes .waitForTaskToken on EventBridge (warns Standard workflow)', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::events:putEvents.waitForTaskToken
    End: true
`);
    assert.ok(!hasError(errs, 'ne supporte pas ".waitForTaskToken"'));
    assert.ok(hasError(errs, 'nécessite un workflow Standard'));
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
    assert.ok(hasError(errs, '"lambda" ne supporte pas ".sync"'));
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
    assert.ok(hasError(errs, '"apigateway" ne supporte pas ".sync"'));
  });

  it('does NOT warn Standard workflow for lambda .sync (already an error)', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke.sync
    End: true
`);
    assert.ok(!hasError(errs, 'nécessite un workflow Standard'));
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
    assert.ok(!hasError(errs, '"events" ne supporte pas ".waitForTaskToken"'));
    assert.ok(!hasError(errs, '"eventbridge" ne supporte pas ".waitForTaskToken"'));
    // Does warn about Standard workflow requirement
    assert.ok(hasError(errs, 'nécessite un workflow Standard'));
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
    assert.ok(hasError(errs, '"ApiEndpoint" est requis'));
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
    assert.ok(hasError(errs, '"Method" est requis'));
  });

  it('warns when Authentication.ConnectionArn is missing', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::http:invoke
    Parameters:
      ApiEndpoint: https://api.example.com/path
      Method: POST
    End: true
`);
    assert.ok(hasError(errs, 'Authentication.ConnectionArn'));
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
    assert.ok(!hasError(errs, '"ApiEndpoint" est requis'));
    assert.ok(!hasError(errs, '"Method" est requis'));
    assert.ok(!hasError(errs, 'Authentication.ConnectionArn'));
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
    assert.ok(hasError(errs, 'TimeoutSeconds doit être un entier positif'));
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
    assert.ok(!hasError(errs, 'TimeoutSeconds doit être un entier positif'));
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
    assert.ok(hasError(errs, 'HeartbeatSeconds doit être un entier positif'));
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
    assert.ok(hasError(errs, 'IntervalSeconds doit être ≥ 1'));
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
    assert.ok(hasError(errs, '"Next" n\'est pas autorisé sur un état terminal'));
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
    assert.ok(hasError(errs, '"Next" n\'est pas autorisé sur un état terminal'));
  });
});

// ── Succeed/Fail + End redondant ─────────────────────────────────────────────

describe('Succeed/Fail with End is redundant', () => {
  it('warns End on Succeed', () => {
    const errs = lint(`
StartAt: A
States:
  A: { Type: Task, Resource: arn, Next: B }
  B:
    Type: Succeed
    End: true
`);
    assert.ok(hasError(errs, '"End" est implicite et redondant'));
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
    assert.ok(hasError(errs, '"Retry" n\'est pas autorisé sur un état Choice'));
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
    assert.ok(hasError(errs, '"Catch" n\'est pas autorisé sur un état Choice'));
  });
});

// ── Map Parameters déprécié ──────────────────────────────────────────────────

describe('Map.Parameters deprecated — use ItemSelector', () => {
  it('warns when Parameters is used in Map without ItemSelector', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    Parameters:
      input.$: $$.Map.Item.Value
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(hasError(errs, '"Parameters" est déprécié dans Map'));
  });

  it('does not warn when ItemSelector is used', () => {
    const errs = lint(`
StartAt: M
States:
  M:
    Type: Map
    ItemSelector:
      input.$: $$.Map.Item.Value
    ItemProcessor:
      StartAt: C
      States:
        C: { Type: Task, Resource: arn, End: true }
    End: true
`);
    assert.ok(!hasError(errs, 'déprécié dans Map'));
  });
});

// ── Activity ARN sur Express ──────────────────────────────────────────────────

describe('Activity ARN warns Express-incompatible', () => {
  it('warns for Activity ARN', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:us-east-1:123456789012:activity:myActivity
    End: true
`);
    assert.ok(hasError(errs, 'Activities ne sont pas supportées dans les workflows Express'));
  });

  it('does not warn for optimized integration ARN', () => {
    const errs = lint(`
StartAt: A
States:
  A:
    Type: Task
    Resource: arn:aws:states:::lambda:invoke
    End: true
`);
    assert.ok(!hasError(errs, 'Activities'));
  });
});

// ── Distributed Map sur Express ───────────────────────────────────────────────

describe('Distributed Map warns Express-incompatible', () => {
  it('warns for DISTRIBUTED mode', () => {
    const errs = lint(`
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
`);
    assert.ok(hasError(errs, 'mode DISTRIBUTED nécessite un workflow Standard'));
  });
});

// ── HTTP Task Method enum invalide ────────────────────────────────────────────

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
    assert.ok(hasError(errs, 'méthode HTTP invalide "CONNECT"'));
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
    assert.ok(!hasError(errs, 'méthode HTTP invalide'));
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
    assert.ok(hasError(errs, 'Seconds (-1) hors plage'));
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
    assert.ok(hasError(errs, 'hors plage'));
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
    assert.ok(!hasError(errs, 'hors plage'));
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
    assert.ok(hasError(errs, 'States.JsonMerge') && hasError(errs, '3ème argument'));
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
    assert.ok(hasError(errs, 'dépasse la limite maximale de 99999999'));
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
    assert.ok(!hasError(errs, 'dépasse la limite'));
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
    assert.ok(hasError(errs, 'HeartbeatSeconds (100000000) dépasse la limite'));
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
    assert.ok(hasError(errs, 'MaxDelaySeconds doit être entre 1 et 31622400'));
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
    assert.ok(hasError(errs, 'MaxDelaySeconds doit être entre 1 et 31622400'));
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
    assert.ok(hasError(errs, 'MaxAttempts doit être ≥ 0'));
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
    assert.ok(hasError(errs, 'JitterStrategy invalide "RANDOM"'));
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
    assert.ok(hasError(errs, '"Resource" est requis'));
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
    assert.ok(!hasError(errs, '"Resource" est requis'));
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
    assert.ok(hasError(errs, '"End" n\'est pas autorisé sur un état Choice'));
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
    assert.ok(hasError(errs, '"Next" n\'est pas autorisé'));
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
    assert.ok(hasError(errs, '"Assign" est un champ JSONata'));
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
    assert.ok(!hasError(errs, '"Assign" est un champ JSONata'));
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
    assert.ok(hasError(errs, '"ErrorPath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, '"CausePath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, '"MaxConcurrencyPath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, '"ToleratedFailureCountPath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, '"ToleratedFailurePercentagePath" est JSONPath uniquement'));
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
    assert.ok(hasError(errs, '"ItemBatcher" est réservé aux Maps DISTRIBUTED'));
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
    assert.ok(hasError(errs, '"ItemReader" est réservé aux Maps DISTRIBUTED'));
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
    assert.ok(hasError(errs, '"ResultWriter" est réservé aux Maps DISTRIBUTED'));
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
    assert.ok(!hasError(errs, '"ItemBatcher" est réservé'));
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
    assert.ok(hasError(errs, 'Version "2.0" invalide'));
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
    assert.ok(hasError(errs, 'Label est ignoré en mode INLINE'));
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
    assert.ok(!hasError(errs, 'Label est ignoré en mode INLINE'));
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
    assert.ok(hasError(errs, 'QueryLanguage "JSONPath2" invalide'));
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
    assert.ok(hasError(errs, 'QueryLanguage "SPARQL" invalide'));
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
    assert.ok(hasError(errs, 'TimeoutSeconds global (0) invalide'));
  });

  it('reports TimeoutSeconds > 99999999 at definition level', () => {
    const errs = lint(`
TimeoutSeconds: 100000000
StartAt: A
States:
  A: { Type: Task, Resource: arn, End: true }
`);
    assert.ok(hasError(errs, 'TimeoutSeconds global (100000000) invalide'));
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
    assert.ok(hasError(errs, 'IntervalSeconds (100000000) dépasse la limite maximale'));
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
    assert.ok(!hasError(errs, 'dépasse la limite maximale'));
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
