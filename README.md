# StepLens — AWS Step Functions for VS Code

Visualize, navigate and lint **AWS Step Functions** definitions (ASL) directly in VS Code.
Supports **YAML** (Serverless Framework), raw **JSON**, and **JSONata** query language.

![StepLens Preview](images/preview.png)

---

## Features

### Interactive Graph Preview

Open a live graph of your state machine with a single click on the ⊤ toolbar icon.

- **Color-coded nodes** by state type (Task, Choice, Wait, Parallel, Map, Succeed, Fail…)
- **State count badge** on every tab — see at a glance how many states each graph contains
- **Click** any node → jumps to the matching line in the editor
- **Move the cursor** in the editor → the corresponding node is highlighted orange in the graph
- **Double-click** a Parallel or Map node → opens its sub-graph in a dedicated tab (works at any nesting depth)
- **← Main** back button appears automatically when browsing a sub-graph
- **⊡ Fit** button recenters the graph at any time
- **Export** the current view as PNG or JPEG

### Node annotations

| Annotation | Meaning |
|------------|---------|
| `↺` in label | State has a `Retry` block configured |
| `×N` in label | Map state with `MaxConcurrency: N` (`×∞` if 0 = unlimited) |
| `‖N` in label | Parallel state with N branches |
| `⊕` in label | Distributed Map (`ItemProcessor.ProcessorConfig.Mode: DISTRIBUTED`) |
| `⏸` in label | Task using `.waitForTaskToken` (waits for external callback) |
| `🌐` in label | HTTP Task (`states:::http:invoke`) |
| second line in Fail label | `Error` value (or `Cause` if `Error` is absent) — shown directly on the node |
| Purple dashed border | Parallel / Map — double-click to explore the sub-graph |
| Orange highlight | State at cursor position |
| Red dashed border + `(not found)` | Broken reference — a `Next`, `Default`, `Catch`, or `Choices` target that does not exist in `States` |

### Real-time Linter

**50+ rules** covering structural validity, JSONata/JSONPath field usage, distributed Map configuration, and state name constraints. Errors and warnings appear inline as you type, with hover tooltips explaining each issue. Every rule fires only on what can be determined from the ASL definition itself — no false positives from workflow-type assumptions.

#### Structural rules

| Rule | Severity | Description |
|------|----------|-------------|
| R-1 | Error | `StartAt` references a state that does not exist |
| R-2 | Error | `Next` references a state that does not exist |
| R-3 | Error | Non-terminal state has neither `Next` nor `End` |
| R-4 | Error | `Catch[i].Next` references a state that does not exist |
| R-5 | Error | Choice state: no branches, a branch has no `Next`, or `Choices[i].Next` not found |
| R-6 | Error | Parallel / Map state has neither `Next` nor `End` |
| R-7 | Error | Parallel branch is not a valid sub-state-machine (recursive validation) |
| R-8 | Warning | `waitForTaskToken` with no `Catch` for `States.HeartbeatTimeout` (deadlock risk); also warns when neither `HeartbeatSeconds`/`HeartbeatSecondsPath` nor `TimeoutSeconds`/`TimeoutSecondsPath` is set (may block indefinitely) |
| R-9 | Error | Map `Iterator` / `ItemProcessor` is missing or not a valid sub-state-machine |
| R-11 | Error | `TimeoutSeconds` and `TimeoutSecondsPath` are mutually exclusive (same for `HeartbeatSeconds`/`HeartbeatSecondsPath`) |
| R-12 | Error | `HeartbeatSeconds` must be less than `TimeoutSeconds` when both are defined |
| R-13 | Error | Fail state: `Error`/`ErrorPath` mutually exclusive; `Cause`/`CausePath` mutually exclusive |
| R-14 | Error | Wait state must have exactly one timing field (`Seconds`, `Timestamp`, `SecondsPath`, or `TimestampPath`) |
| R-15 | Error | `States.ALL` in `ErrorEquals` must be alone and placed last in Catch/Retry array |
| R-16 | Warning | `States.DataLimitExceeded` and `States.Runtime` cannot be caught |
| R-17 | Error | `ErrorEquals` array is empty in Catch or Retry clause |
| R-18 | Error | `ItemsPath` (JSONPath-only) used in JSONata mode — use `Items` instead |
| R-19 | Error | `ToleratedFailurePercentage` must be between 0 and 100 |
| R-20 | Error | `MaxConcurrency`/`MaxConcurrencyPath` mutually exclusive (and `ToleratedFailureCount*`, `ToleratedFailurePercentage*`) |
| R-21 | Error | `ProcessorConfig.ExecutionType` required when `Mode: DISTRIBUTED` |
| R-22 | Warning | `ProcessorConfig.ExecutionType` ignored in `Mode: INLINE` (only applies to DISTRIBUTED) |
| R-23 | Error | `Mode: INLINE` with `MaxConcurrency > 40` — switch to `DISTRIBUTED` to exceed this limit |
| R-24 | Error | State name exceeds 80 characters |
| R-25 | Error | State name contains forbidden characters |
| W-1 | Warning | State is unreachable from `StartAt` |
| W-2 | Warning | Choice state has no `Default` — risk of `States.NoChoiceMatched` at runtime |
| W-3 | Error | `$states.errorOutput` used outside a `Catch` block (JSONata) |
| W-4 | Warning | `$states.context.Task.Token` used in a state that is not `.waitForTaskToken` |
| — | Error | Task state is missing the required `Resource` field |
| — | Error | Choice state has a top-level `End` or `Next` (forbidden — use `Choices[].Next` / `Default`) |
| — | Error | `Version` present but not `"1.0"` |
| — | Error | `QueryLanguage` is not `"JSONata"` or `"JSONPath"` (definition or state level) |
| — | Error | Global `TimeoutSeconds` outside the valid range 1–99999999 |
| — | Error | `Retry.IntervalSeconds` outside 1–99999999; `MaxDelaySeconds` outside 1–31622400 |
| — | Error | `Retry.MaxAttempts` is negative; `BackoffRate` is less than 1.0 |
| — | Error | `Retry.JitterStrategy` is not `"FULL"` or `"NONE"` |
| — | Error | `TimeoutSeconds` or `HeartbeatSeconds` exceeds 99999999 |
| — | Warning | `Label`, `ItemBatcher`, `ItemReader`, or `ResultWriter` used on a Map in `INLINE` mode (DISTRIBUTED-only fields) |
| — | Error | Distributed Map `Label` exceeds 40 characters or contains forbidden characters |
| — | Error | `.waitForTaskToken` used inside a Distributed Map with `ExecutionType: EXPRESS` |

#### JSONata rules (when `QueryLanguage: JSONata`)

| Rule | Severity | Description |
|------|----------|-------------|
| J-1 | Error/Warn | Wrong fields for the active query language (`Parameters`↔`Arguments`, `OutputPath`↔`Output`, `Assign`, etc.) |
| J-2 | Error | Choice branch uses `Variable` in JSONata mode (use `Condition`) or vice-versa; validated recursively through `Not`/`And`/`Or`; `Condition` must be wrapped in `{%…%}` |
| J-3 | Error | Invalid `{%…%}` expression: empty, unclosed brace/bracket/paren/string, `$eval()`, trailing operator, JSONPath `$.` syntax inside JSONata |
| J-4 | Error | `$states.result` used in a state that has no result (only available in Task, Parallel, Map) |
| J-5 | Error | `ResultSelector` is JSONPath-only — not available in JSONata mode |
| J-6 | Error | `TimeoutSecondsPath` / `HeartbeatSecondsPath` are JSONPath-only |
| J-7 | Error | `SecondsPath` / `TimestampPath` in Wait state are JSONPath-only |
| J-8 | Error | `States.*` intrinsic functions (e.g. `States.Format`) used inside a `{%…%}` JSONata expression — these only work in JSONPath mode |
| J-9 | Error | `$$.` (Context Object JSONPath syntax) used in JSONata mode — use `$states.context` instead |
| — | Error | `ErrorPath` / `CausePath` in a Fail state are JSONPath-only |
| — | Error | `MaxConcurrencyPath`, `ToleratedFailureCountPath`, `ToleratedFailurePercentagePath` are JSONPath-only |

---

## Usage

1. Open any YAML or JSON file containing a Step Functions definition.
2. The **⊤ icon** appears in the editor toolbar — click it to open the graph.
3. Lint errors appear as squiggly underlines; hover over them to read the message.
4. The status bar shows `✓ StepLens` (clean), `⚠ N warnings`, or `✗ N errors`.

> **Icon not visible?** The toolbar icon may be hidden behind the **`···` overflow menu** (three dots at the right of the editor title bar). Click `···` to find it, then right-click it to pin it to the toolbar.

### Commands

You can also run StepLens commands from the **Command Palette** (`⇧⌘P` on macOS, `Ctrl+Shift+P` on Windows/Linux):

| Command | Keyboard shortcut | Description |
|---------|-------------------|-------------|
| `StepLens: Open Graph Preview` | `⌘⌥G` / `Ctrl+Alt+G` | Open the visual graph for the active file |
| `StepLens: Lint Current File` | — | Run the linter manually |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `steplens.autoDetect` | `true` | Auto-detect Step Functions files by looking for a `States` key |
| `steplens.lintOnType` | `true` | Run linter on every keystroke (200 ms debounce) |
| `steplens.lintOnSave` | `true` | Run linter on file save |

> Setting changes apply immediately — disabling `autoDetect` clears all diagnostics at once; toggling `lintOnType` or `lintOnSave` re-lints all open files right away.

---

## Supported formats

### Raw ASL (JSON)

```json
{
  "Comment": "Document approval workflow",
  "StartAt": "SubmitDocument",
  "States": {
    "SubmitDocument": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:eu-west-1:123456789012:function:submit-doc",
      "Next": "ReviewDocument"
    },
    "ReviewDocument": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:eu-west-1:123456789012:function:review-doc",
      "End": true
    }
  }
}
```

### Raw ASL with JSONata

```json
{
  "Comment": "Order routing with JSONata",
  "QueryLanguage": "JSONata",
  "StartAt": "ValidateOrder",
  "States": {
    "ValidateOrder": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:eu-west-1:123456789012:function:validate-order",
      "Arguments": {
        "orderId": "{% $states.input.id %}",
        "total":   "{% $states.input.price * $states.input.qty %}"
      },
      "Assign": { "orderType": "{% $states.input.type %}" },
      "Next": "RouteByType"
    },
    "RouteByType": {
      "Type": "Choice",
      "Choices": [
        { "Condition": "{% $orderType = 'express' %}",  "Next": "ExpressShipping" },
        { "Condition": "{% $orderType = 'standard' %}", "Next": "StandardShipping" }
      ],
      "Default": "FallbackRoute"
    },
    "ExpressShipping":  { "Type": "Task", "Resource": "arn:aws:lambda:eu-west-1:123456789012:function:express",  "End": true },
    "StandardShipping": { "Type": "Task", "Resource": "arn:aws:lambda:eu-west-1:123456789012:function:standard", "End": true },
    "FallbackRoute":    { "Type": "Fail", "Error": "UnknownType", "Cause": "Unrecognised order type" }
  }
}
```

### Serverless Framework (YAML) — flat wrapper

```yaml
definition:
  Comment: Document approval workflow
  StartAt: ReceiveDocument
  States:

    ReceiveDocument:
      Type: Task
      Resource: arn:aws:states:::lambda:invoke
      Next: WaitForReview

    WaitForReview:
      Type: Task
      Resource: arn:aws:states:::lambda:invoke.waitForTaskToken
      Parameters:
        FunctionName: request-review
        Payload:
          taskToken.$: $$.Task.Token
      HeartbeatSeconds: 3600
      Catch:
        - ErrorEquals: [States.HeartbeatTimeout]
          Next: ReviewTimedOut
      Next: CheckDecision

    CheckDecision:
      Type: Choice
      Choices:
        - Variable: $.decision
          StringEquals: approved
          Next: PublishDocument
        - Variable: $.decision
          StringEquals: rejected
          Next: RejectDocument
      Default: ReviewTimedOut

    PublishDocument:
      Type: Task
      Resource: arn:aws:states:::lambda:invoke
      Next: NotifyAuthor

    RejectDocument:
      Type: Task
      Resource: arn:aws:states:::lambda:invoke
      Next: NotifyAuthor

    NotifyAuthor:
      Type: Task
      Resource: arn:aws:states:::lambda:invoke
      End: true

    ReviewTimedOut:
      Type: Fail
      Error: ReviewTimeout
      Cause: No reviewer response within the deadline
```

### Serverless Framework (YAML) — named wrapper

```yaml
documentApproval:
  name: ${self:service}-${opt:stage}-doc-approval
  role: !GetAtt DocumentApprovalRole.Arn
  definition:
    Comment: Named Serverless Framework state machine
    StartAt: ReceiveDocument
    States:
      ReceiveDocument:
        Type: Task
        Resource: arn:aws:states:::lambda:invoke
        End: true
```

### Parallel branches

```yaml
definition:
  Comment: Enrich a user record with two parallel lookups
  StartAt: EnrichUser
  States:

    EnrichUser:
      Type: Parallel
      Branches:
        - StartAt: FetchLocation
          States:
            FetchLocation:
              Type: Task
              Resource: arn:aws:states:::lambda:invoke
              Parameters: { FunctionName: fetch-location, Payload.$: $ }
              End: true
        - StartAt: FetchPreferences
          States:
            FetchPreferences:
              Type: Task
              Resource: arn:aws:states:::lambda:invoke
              Parameters: { FunctionName: fetch-prefs, Payload.$: $ }
              End: true
      Next: MergeResults

    MergeResults:
      Type: Task
      Resource: arn:aws:states:::lambda:invoke
      End: true
```

> **Tip:** Double-click the `EnrichUser` node in the graph to explore each branch in a dedicated tab. The node label shows **‖2** (2 branches).

### Map iterator

```yaml
definition:
  Comment: Process a batch of uploaded files
  StartAt: ProcessFiles
  States:

    ProcessFiles:
      Type: Map
      ItemsPath: $.files
      MaxConcurrency: 5
      Iterator:
        StartAt: TranscodeFile
        States:
          TranscodeFile:
            Type: Task
            Resource: arn:aws:states:::lambda:invoke
            Parameters: { FunctionName: transcode, Payload.$: $ }
            Retry:
              - ErrorEquals: [States.TaskFailed]
                IntervalSeconds: 5
                MaxAttempts: 3
                BackoffRate: 2
            End: true
      Next: SaveManifest

    SaveManifest:
      Type: Task
      Resource: arn:aws:states:::lambda:invoke
      End: true
```

> The `ProcessFiles` node label shows **×5** (MaxConcurrency) and `TranscodeFile` shows **↺** (Retry configured). A Parallel state with 3 branches would show **‖3**.

---

## Graph legend

### Nodes

| Style | State type |
|-------|-----------|
| Blue rectangle | Task |
| Yellow diamond | Choice |
| Teal rectangle | Wait |
| Grey rectangle | Pass |
| Green circle | Succeed |
| Red circle | Fail |
| Purple dashed rectangle | Parallel / Map |
| Orange border | State at cursor position |
| Red dashed rectangle (`not found`) | Broken reference — target state not found in `States` |

### Edges

| Style | Meaning |
|-------|---------|
| Grey solid arrow | `Next` transition |
| Amber arrow | Choice branch / Default |
| Red dashed arrow | `Catch` (error handler) |

---

## JSONata quick reference

When `QueryLanguage: "JSONata"` is set (globally or per-state):

| JSONPath field | JSONata equivalent |
|----------------|--------------------|
| `Parameters` | `Arguments` |
| `OutputPath` | `Output` |
| `ItemsPath` (Map) | `Items` |
| `Variable` (Choice) | `Condition` |

JSONata expressions must be wrapped in `{%…%}`:

```json
"Arguments": {
  "name":  "{% $states.input.user.name %}",
  "total": "{% $states.input.price * $states.input.qty %}",
  "id":    "{% $uuid() %}"
}
```

**`$states` variable paths:**

| Path | Available in |
|------|-------------|
| `$states.input` | All states |
| `$states.result` | Task, Parallel, Map only |
| `$states.errorOutput` | Catch blocks only |
| `$states.context` | All states |

**AWS-specific functions:** `$partition()`, `$range()`, `$hash()`, `$random()`, `$uuid()`, `$parse()`

> `$eval()` is **not supported** by AWS Step Functions.

---

## License

MIT
