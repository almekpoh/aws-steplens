import * as vscode from 'vscode';
import { AslDefinition, AslParser } from './aslParser';

export interface LintError {
  message: string;
  severity: vscode.DiagnosticSeverity;
  /** Key to locate in the document (best-effort) */
  searchKey?: string;
}

// Error names that can never be caught by States.ALL or States.TaskFailed
const UNCATCHABLE_ERRORS = new Set(['States.DataLimitExceeded', 'States.Runtime']);

// State name: max 80 chars, forbidden characters
const STATE_NAME_FORBIDDEN = /[?*<>{}[\]"#%\\^|~`$&,;:/\u0000-\u001f\u007f-\u009f]/;

// SDK integration: services that never support .sync / .sync:2
// - sqs/sns/dynamodb/scheduler/events/eventbridge: fire-and-forget only
// - lambda: already synchronous by design — no .sync pattern exists
// - apigateway: only request-response and .waitForTaskToken
// - http: request-response only
const NO_SYNC_SERVICES = new Set([
  'sqs', 'sns', 'dynamodb', 'http', 'events', 'eventbridge', 'scheduler',
  'lambda', 'apigateway',
]);

// SDK integration: services that never support .waitForTaskToken
// Source: https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html
// Note: events/eventbridge, lambda, sqs, sns, apigateway, ecs, eks, bedrock, states DO support .waitForTaskToken
// http:invoke supports neither .sync nor .waitForTaskToken (confirmed in official table)
const NO_WAIT_FOR_TOKEN_SERVICES = new Set([
  'http', 'dynamodb',
  'athena', 'batch', 'codebuild', 'glue', 'databrew',
  'elasticmapreduce', 'emr-containers', 'emr-serverless',
  'mediaconvert', 'sagemaker',
]);

// Regex to parse an optimised SDK integration ARN:
//   arn:aws[…]:states:::SERVICE:ACTION[.PATTERN]
const SDK_SERVICE_RE = /^arn:[^:]*:states:::([^:]+):([^.]+)(?:\.(sync:2|sync|waitForTaskToken))?$/;

// RFC 3339 timestamp: uppercase T separator, uppercase Z suffix (no numeric offset)
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Choice rule keys whose values must be RFC 3339 timestamps (not the *Path variants)
const TIMESTAMP_LITERAL_KEYS = new Set([
  'TimestampEquals', 'TimestampGreaterThan', 'TimestampGreaterThanEquals',
  'TimestampLessThan', 'TimestampLessThanEquals',
]);

// Valid States.Hash algorithm names
const VALID_HASH_ALGOS = new Set(['MD5', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);

export class AslLinter {
  static lint(def: AslDefinition): LintError[] {
    const errors: LintError[] = [];
    const states = def.States ?? {};
    const stateNames = new Set(Object.keys(states));

    // ── Version: only "1.0" is valid if present ───────────────────────────────
    if (def.Version !== undefined && def.Version !== '1.0') {
      errors.push({
        message: `Version "${def.Version}" is not valid — only "1.0" is accepted`,
        severity: vscode.DiagnosticSeverity.Error,
        searchKey: 'Version',
      });
    }

    // ── Definition-level QueryLanguage ────────────────────────────────────────
    if (def.QueryLanguage !== undefined && def.QueryLanguage !== 'JSONata' && def.QueryLanguage !== 'JSONPath') {
      errors.push({
        message: `QueryLanguage "${def.QueryLanguage}" is not valid — accepted values: "JSONata", "JSONPath"`,
        severity: vscode.DiagnosticSeverity.Error,
        searchKey: 'QueryLanguage',
      });
    }

    // ── Definition-level TimeoutSeconds: 1 to 99999999 ────────────────────────
    if (def.TimeoutSeconds !== undefined) {
      if (def.TimeoutSeconds < 1 || def.TimeoutSeconds > 99999999) {
        errors.push({
          message: `global TimeoutSeconds (${def.TimeoutSeconds}) is not valid — must be between 1 and 99999999`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: 'TimeoutSeconds',
        });
      }
    }

    // ── R-1: StartAt must exist ─────────────────────────────────────────────
    if (!stateNames.has(def.StartAt)) {
      errors.push({
        message: `StartAt "${def.StartAt}" does not exist in States`,
        severity: vscode.DiagnosticSeverity.Error,
        searchKey: 'StartAt',
      });
    }

    for (const [name, state] of Object.entries(states)) {

      // ── State-level QueryLanguage ─────────────────────────────────────────
      if (state.QueryLanguage !== undefined && state.QueryLanguage !== 'JSONata' && state.QueryLanguage !== 'JSONPath') {
        errors.push({
          message: `"${name}": QueryLanguage "${state.QueryLanguage}" is not valid — accepted values: "JSONata", "JSONPath"`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-24: State name max 80 chars ────────────────────────────────────
      if (name.length > 80) {
        errors.push({
          message: `"${name}": state name is too long (${name.length} chars, max 80)`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-25: State name forbidden characters ────────────────────────────
      if (STATE_NAME_FORBIDDEN.test(name)) {
        errors.push({
          message: `"${name}": state name contains forbidden characters`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-2: Next must point to an existing state ─────────────────────────
      if (state.Next && !stateNames.has(state.Next)) {
        errors.push({
          message: `"${name}": Next "${state.Next}" not found`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-3: Non-terminal states must have Next or End ────────────────────
      const isTerminal = state.Type === 'Succeed' || state.Type === 'Fail';
      const isChoice = state.Type === 'Choice';
      if (!isTerminal && !isChoice && state.Type !== 'Parallel' && state.Type !== 'Map' && !state.Next && !state.End) {
        errors.push({
          message: `"${name}" (${state.Type}): neither "Next" nor "End" defined`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── Succeed/Fail must not have Next or End ────────────────────────────
      if (isTerminal && state.Next) {
        errors.push({
          message: `"${name}" (${state.Type}): "Next" is not allowed on a terminal state`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      // ── Choice must not have Retry, Catch, Next, or End ─────────────────────
      if (isChoice) {
        if ((state.Retry?.length ?? 0) > 0) {
          errors.push({
            message: `"${name}" (Choice): "Retry" is not allowed on a Choice state`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if ((state.Catch?.length ?? 0) > 0) {
          errors.push({
            message: `"${name}" (Choice): "Catch" is not allowed on a Choice state`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (state.Next) {
          errors.push({
            message: `"${name}" (Choice): "Next" is not allowed — transitions are defined by Choices[].Next and Default`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (state.End) {
          errors.push({
            message: `"${name}" (Choice): "End" is not allowed on a Choice state`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      }

      // ── R-4: Catch.Next must exist ────────────────────────────────────────
      state.Catch?.forEach((c, i) => {
        if (!stateNames.has(c.Next)) {
          errors.push({
            message: `"${name}": Catch[${i}].Next "${c.Next}" not found`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }

        // ── R-17: ErrorEquals must be non-empty ──────────────────────────
        if (!c.ErrorEquals || c.ErrorEquals.length === 0) {
          errors.push({
            message: `"${name}": Catch[${i}].ErrorEquals is empty`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }

        // ── R-15: States.ALL must be alone and last ──────────────────────
        if (c.ErrorEquals?.includes('States.ALL')) {
          if (c.ErrorEquals.length > 1) {
            errors.push({
              message: `"${name}": Catch[${i}].ErrorEquals contains "States.ALL" with other errors — States.ALL must be alone`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
          const catchArr = state.Catch!;
          if (i < catchArr.length - 1) {
            errors.push({
              message: `"${name}": Catch[${i}] with "States.ALL" must be the last handler`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
        }

        // ── R-16: Uncatchable errors ─────────────────────────────────────
        c.ErrorEquals?.forEach(e => {
          if (UNCATCHABLE_ERRORS.has(e)) {
            errors.push({
              message: `"${name}": Catch[${i}] — "${e}" cannot be caught (non-catchable error)`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }
        });
      });

      // ── R-15 (Retry): States.ALL must be alone and last ──────────────────
      state.Retry?.forEach((r, i) => {
        if (!r.ErrorEquals || r.ErrorEquals.length === 0) {
          errors.push({
            message: `"${name}": Retry[${i}].ErrorEquals is empty`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (r.ErrorEquals?.includes('States.ALL')) {
          if (r.ErrorEquals.length > 1) {
            errors.push({
              message: `"${name}": Retry[${i}].ErrorEquals contains "States.ALL" with other errors — States.ALL must be alone`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
          if (i < (state.Retry!.length - 1)) {
            errors.push({
              message: `"${name}": Retry[${i}] with "States.ALL" must be the last entry`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
        }
        // IntervalSeconds minimum 1, maximum 99999999
        if (r.IntervalSeconds !== undefined && r.IntervalSeconds < 1) {
          errors.push({
            message: `"${name}": Retry[${i}].IntervalSeconds must be ≥ 1 (value: ${r.IntervalSeconds})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (r.IntervalSeconds !== undefined && r.IntervalSeconds > 99999999) {
          errors.push({
            message: `"${name}": Retry[${i}].IntervalSeconds (${r.IntervalSeconds}) exceeds the maximum limit of 99999999`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // BackoffRate minimum 1.0
        if (r.BackoffRate !== undefined && r.BackoffRate < 1) {
          errors.push({
            message: `"${name}": Retry[${i}].BackoffRate must be ≥ 1.0 (value: ${r.BackoffRate})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // MaxDelaySeconds range: 1 to 31622400
        if (r.MaxDelaySeconds !== undefined && (r.MaxDelaySeconds < 1 || r.MaxDelaySeconds > 31622400)) {
          errors.push({
            message: `"${name}": Retry[${i}].MaxDelaySeconds must be between 1 and 31622400 (value: ${r.MaxDelaySeconds})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // MaxAttempts >= 0
        if (r.MaxAttempts !== undefined && r.MaxAttempts < 0) {
          errors.push({
            message: `"${name}": Retry[${i}].MaxAttempts must be ≥ 0 (value: ${r.MaxAttempts})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // JitterStrategy must be FULL or NONE
        if (r.JitterStrategy !== undefined && !r.JitterStrategy.includes('{%') && !r.JitterStrategy.startsWith('$') && r.JitterStrategy !== 'FULL' && r.JitterStrategy !== 'NONE') {
          errors.push({
            message: `"${name}": Retry[${i}].JitterStrategy "${r.JitterStrategy}" is not valid — accepted values: FULL, NONE`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      });

      // ── R-5: Choice branches must have valid Next ─────────────────────────
      if (state.Type === 'Choice') {
        if (!state.Choices || state.Choices.length === 0) {
          errors.push({
            message: `"${name}" (Choice): no branches defined`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        state.Choices?.forEach((c, i) => {
          if (!c.Next) {
            errors.push({
              message: `"${name}": Choices[${i}] missing "Next"`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          } else if (!stateNames.has(c.Next)) {
            errors.push({
              message: `"${name}": Choices[${i}].Next "${c.Next}" not found`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
        });
        if (state.Default && !stateNames.has(state.Default)) {
          errors.push({
            message: `"${name}": Default "${state.Default}" not found`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // ── W-2: Choice without Default ──────────────────────────────────
        if (!state.Default) {
          errors.push({
            message: `"${name}" (Choice): no "Default" defined — risk of States.NoChoiceMatched at runtime`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }
      }

      // ── Pass: Result and ResultPath usage ────────────────────────────────
      if (state.Type === 'Pass') {
        if (state.Result !== undefined && state.ResultPath === null) {
          errors.push({
            message: `"${name}" (Pass): Result is defined but ResultPath is null — the result will be discarded (ResultPath: null means "do not merge into output")`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }
        if (state.Parameters !== undefined && state.Result !== undefined) {
          errors.push({
            message: `"${name}" (Pass): Result and Parameters are mutually exclusive — Parameters takes precedence over Result when both are defined`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }
      }

      // ── R-6: Parallel/Map must have End or Next ───────────────────────────
      if ((state.Type === 'Parallel' || state.Type === 'Map') && !state.Next && !state.End) {
        errors.push({
          message: `"${name}" (${state.Type}): neither "Next" nor "End"`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-7: Parallel branches are valid sub-state-machines ───────────────
      state.Branches?.forEach((branch, i) => {
        if (!branch.StartAt || !branch.States) {
          errors.push({
            message: `"${name}": Branches[${i}] is not valid (StartAt/States missing)`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        } else {
          AslLinter.lint({ StartAt: branch.StartAt, States: branch.States, QueryLanguage: def.QueryLanguage })
            .forEach(e => errors.push({ ...e, message: `[Branch ${i}] ${e.message}` }));
        }
      });

      // ── Task requires Resource ────────────────────────────────────────────────
      if (state.Type === 'Task' && !state.Resource) {
        errors.push({
          message: `"${name}" (Task): "Resource" is required`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── Resource ARN + integration pattern validation (Task states only) ───
      // If Resource is a CF intrinsic object (Fn::GetAtt, Fn::Sub…) treat as empty — no string ops possible.
      // If Resource is a string without ":" it is a CF tag result (!GetAtt, !Ref) — cannot be validated as ARN.
      const resource = typeof state.Resource === 'string' ? state.Resource : '';
      const isResolvableResource = resource.includes(':'); // real ARNs always contain ":"
      if (state.Type === 'Task' && isResolvableResource) {

        // ── ARN-1: Resource must start with arn: ────────────────────────────
        if (!resource.startsWith('arn:')) {
          errors.push({
            message: `"${name}": Resource "${resource}" is not a valid ARN — must start with "arn:"`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }

        // ── ARN-2: SDK integration pattern compatibility ─────────────────────
        const sdkMatch = resource.match(SDK_SERVICE_RE);
        if (sdkMatch) {
          const service = sdkMatch[1]; // e.g. 'sqs', 'lambda', 'aws-sdk', 'http'
          const pattern = sdkMatch[3]; // 'sync', 'sync:2', 'waitForTaskToken', or undefined
          const isAwsSdk = service === 'aws-sdk';

          // aws-sdk:SERVICE:ACTION format never supports .sync / .sync:2
          if (isAwsSdk && (pattern === 'sync' || pattern === 'sync:2')) {
            errors.push({
              message: `"${name}": AWS SDK integrations (aws-sdk:*) do not support the ".${pattern}" pattern — use an optimized integration if available`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }

          // Optimized integrations: some services don't support .sync
          if (!isAwsSdk && (pattern === 'sync' || pattern === 'sync:2') && NO_SYNC_SERVICES.has(service)) {
            errors.push({
              message: `"${name}": service "${service}" does not support ".${pattern}" — fire-and-forget integration only`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }

          if (pattern === 'waitForTaskToken' && NO_WAIT_FOR_TOKEN_SERVICES.has(service)) {
            errors.push({
              message: `"${name}": service "${service}" does not support ".waitForTaskToken"`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }

          // HTTP Task required fields
          if (service === 'http') {
            const params = (state.Parameters ?? state.Arguments ?? {}) as Record<string, unknown>;
            if (!params['ApiEndpoint'] && !params['ApiEndpoint.$']) {
              errors.push({
                message: `"${name}" (HTTP Task): "ApiEndpoint" is required in Parameters/Arguments`,
                severity: vscode.DiagnosticSeverity.Error,
                searchKey: name,
              });
            }
            const method = params['Method'];
            if (!method && !params['Method.$']) {
              errors.push({
                message: `"${name}" (HTTP Task): "Method" is required in Parameters/Arguments`,
                severity: vscode.DiagnosticSeverity.Error,
                searchKey: name,
              });
            } else if (typeof method === 'string' && !method.includes('{%') && !method.startsWith('$')) {
              const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);
              if (!VALID_METHODS.has(method.toUpperCase())) {
                errors.push({
                  message: `"${name}" (HTTP Task): invalid HTTP method "${method}" — accepted values: GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD`,
                  severity: vscode.DiagnosticSeverity.Error,
                  searchKey: name,
                });
              }
            }
          }
        }
      }

      // ── R-8: waitForTaskToken must have a Catch for HeartbeatTimeout ──────
      if (resource.includes('waitForTaskToken')) {
        const catchesHeartbeat = state.Catch?.some(c =>
          c.ErrorEquals.includes('States.HeartbeatTimeout') ||
          c.ErrorEquals.includes('States.ALL')
        ) ?? false;

        if (!catchesHeartbeat) {
          errors.push({
            message: `"${name}": uses waitForTaskToken but has no Catch for States.HeartbeatTimeout — risk of permanent deadlock`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }

        if (!state.HeartbeatSeconds && !state.HeartbeatSecondsPath && !state.TimeoutSeconds && !state.TimeoutSecondsPath) {
          errors.push({
            message: `"${name}": waitForTaskToken without HeartbeatSeconds or TimeoutSeconds — execution may block indefinitely`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }
      }

      // ── R-9: Map iterator/ItemProcessor must be a valid sub-state-machine ──
      if (state.Type === 'Map') {
        const iterator = state.Iterator ?? state.ItemProcessor;
        if (!iterator) {
          errors.push({
            message: `"${name}" (Map): no Iterator or ItemProcessor defined`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        } else if (!iterator.StartAt || !iterator.States) {
          errors.push({
            message: `"${name}": Iterator is not valid (StartAt/States missing)`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        } else {
          AslLinter.lint({ StartAt: iterator.StartAt, States: iterator.States, QueryLanguage: def.QueryLanguage })
            .forEach(e => errors.push({ ...e, message: `[Iterator] ${e.message}` }));
        }
      }


      // ── R-11: TimeoutSeconds / TimeoutSecondsPath mutual exclusion ────────
      if (state.TimeoutSeconds !== undefined && state.TimeoutSecondsPath !== undefined) {
        errors.push({
          message: `"${name}": TimeoutSeconds and TimeoutSecondsPath are mutually exclusive`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.TimeoutSeconds !== undefined && state.TimeoutSeconds <= 0) {
        errors.push({
          message: `"${name}": TimeoutSeconds must be a positive integer > 0 (value: ${state.TimeoutSeconds})`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.TimeoutSeconds !== undefined && state.TimeoutSeconds > 99999999) {
        errors.push({
          message: `"${name}": TimeoutSeconds (${state.TimeoutSeconds}) exceeds the maximum limit of 99999999`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-11 (Heartbeat): HeartbeatSeconds / HeartbeatSecondsPath ─────────
      if (state.HeartbeatSeconds !== undefined && state.HeartbeatSecondsPath !== undefined) {
        errors.push({
          message: `"${name}": HeartbeatSeconds and HeartbeatSecondsPath are mutually exclusive`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-12: HeartbeatSeconds must be < TimeoutSeconds ──────────────────
      if (state.HeartbeatSeconds !== undefined && state.HeartbeatSeconds <= 0) {
        errors.push({
          message: `"${name}": HeartbeatSeconds must be a positive integer > 0 (value: ${state.HeartbeatSeconds})`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.HeartbeatSeconds !== undefined && state.HeartbeatSeconds > 99999999) {
        errors.push({
          message: `"${name}": HeartbeatSeconds (${state.HeartbeatSeconds}) exceeds the maximum limit of 99999999`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.HeartbeatSeconds !== undefined && state.TimeoutSeconds !== undefined &&
          typeof state.HeartbeatSeconds === 'number' && typeof state.TimeoutSeconds === 'number') {
        if (state.HeartbeatSeconds >= state.TimeoutSeconds) {
          errors.push({
            message: `"${name}": HeartbeatSeconds (${state.HeartbeatSeconds}) must be less than TimeoutSeconds (${state.TimeoutSeconds})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      }

      // ── R-13: Fail state Error/ErrorPath and Cause/CausePath mutual exclusion
      if (state.Type === 'Fail') {
        if (state.Error !== undefined && state.ErrorPath !== undefined) {
          errors.push({
            message: `"${name}" (Fail): Error and ErrorPath are mutually exclusive`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (state.Cause !== undefined && state.CausePath !== undefined) {
          errors.push({
            message: `"${name}" (Fail): Cause and CausePath are mutually exclusive`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      }

      // ── R-14: Wait state must have exactly one timing field ───────────────
      if (state.Type === 'Wait') {
        const timingFields = [state.Seconds, state.Timestamp, state.SecondsPath, state.TimestampPath]
          .filter(v => v !== undefined);
        if (timingFields.length === 0) {
          errors.push({
            message: `"${name}" (Wait): no timing field defined — set Seconds, Timestamp, SecondsPath, or TimestampPath`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        } else if (timingFields.length > 1) {
          errors.push({
            message: `"${name}" (Wait): multiple timing fields defined — only one allowed (Seconds, Timestamp, SecondsPath, or TimestampPath)`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // Seconds range: 0 to 99999999
        if (state.Seconds !== undefined && (state.Seconds < 0 || state.Seconds > 99999999)) {
          errors.push({
            message: `"${name}" (Wait): Seconds (${state.Seconds}) out of range — must be between 0 and 99999999`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // Timestamp must be RFC 3339 with uppercase T and uppercase Z
        // Skip dynamic values: JSONata expressions ({%...%}) and JSONPath references ($./ $$.)
        if (typeof state.Timestamp === 'string' && !state.Timestamp.includes('{%') && !state.Timestamp.startsWith('$') && !RFC3339_RE.test(state.Timestamp)) {
          errors.push({
            message: `"${name}" (Wait): Timestamp "${state.Timestamp}" is not valid — RFC3339 format required with uppercase T and Z (e.g. "2024-01-15T12:00:00Z")`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      }

      // ── R-19: ToleratedFailurePercentage must be 0-100 ───────────────────
      if (state.ToleratedFailurePercentage !== undefined) {
        if (state.ToleratedFailurePercentage < 0 || state.ToleratedFailurePercentage > 100) {
          errors.push({
            message: `"${name}": ToleratedFailurePercentage (${state.ToleratedFailurePercentage}) must be between 0 and 100`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      }

      // ── R-20: MaxConcurrency / MaxConcurrencyPath mutual exclusion ────────
      if (state.MaxConcurrency !== undefined && state.MaxConcurrencyPath !== undefined) {
        errors.push({
          message: `"${name}": MaxConcurrency and MaxConcurrencyPath are mutually exclusive`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.ToleratedFailureCount !== undefined && state.ToleratedFailureCountPath !== undefined) {
        errors.push({
          message: `"${name}": ToleratedFailureCount and ToleratedFailureCountPath are mutually exclusive`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.ToleratedFailurePercentage !== undefined && state.ToleratedFailurePercentagePath !== undefined) {
        errors.push({
          message: `"${name}": ToleratedFailurePercentage and ToleratedFailurePercentagePath are mutually exclusive`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── ProcessorConfig validation ────────────────────────────────────────
      if (state.Type === 'Map' && state.ItemProcessor) {
        const pc = (state.ItemProcessor as { ProcessorConfig?: { Mode?: string; ExecutionType?: string } }).ProcessorConfig;
        const mode = pc?.Mode ?? 'INLINE';
        const execType = pc?.ExecutionType;

        // ExecutionType required when DISTRIBUTED
        if (mode === 'DISTRIBUTED' && !execType) {
          errors.push({
            message: `"${name}": ItemProcessor.ProcessorConfig.ExecutionType is required in DISTRIBUTED mode ("STANDARD" or "EXPRESS")`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }

        // ExecutionType irrelevant in INLINE mode
        if (mode === 'INLINE' && execType) {
          errors.push({
            message: `"${name}": ItemProcessor.ProcessorConfig.ExecutionType is ignored in INLINE mode — only applies to DISTRIBUTED`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }

        // INLINE concurrency > 40 — hard limit enforced by AWS
        if (mode === 'INLINE' && state.MaxConcurrency !== undefined && state.MaxConcurrency > 40) {
          errors.push({
            message: `"${name}": INLINE mode limited to 40 concurrent iterations (MaxConcurrency: ${state.MaxConcurrency}) — switch to DISTRIBUTED to exceed this limit`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }

        // waitForTaskToken not supported in EXPRESS children
        if (mode === 'DISTRIBUTED' && execType === 'EXPRESS') {
          const hasWaitForToken = Object.values(state.ItemProcessor?.States ?? {})
            .some(s => typeof s.Resource === 'string' && s.Resource.includes('waitForTaskToken'));
          if (hasWaitForToken) {
            errors.push({
              message: `"${name}": EXPRESS child executions do not support .waitForTaskToken (request-response only)`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
        }

        // DISTRIBUTED-only fields on INLINE Map
        if (mode === 'INLINE') {
          if (state.Label !== undefined) {
            errors.push({
              message: `"${name}": Label is ignored in INLINE mode — only applies to DISTRIBUTED Maps`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }
          if (state.ItemBatcher !== undefined) {
            errors.push({
              message: `"${name}": "ItemBatcher" is reserved for DISTRIBUTED Maps — ignored in INLINE mode`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }
          if (state.ItemReader !== undefined) {
            errors.push({
              message: `"${name}": "ItemReader" is reserved for DISTRIBUTED Maps — ignored in INLINE mode`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }
          if (state.ResultWriter !== undefined) {
            errors.push({
              message: `"${name}": "ResultWriter" is reserved for DISTRIBUTED Maps — ignored in INLINE mode`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }
        }

        // Label max 40 chars (distributed Map)
        if (mode === 'DISTRIBUTED' && state.Label !== undefined) {
          if (state.Label.length > 40) {
            errors.push({
              message: `"${name}": Label "${state.Label}" is too long (${state.Label.length} chars, max 40)`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
          if (/[\s?*<>{}[\]"#%\\^|~`$&,;:/]/.test(state.Label)) {
            errors.push({
              message: `"${name}": Label contains forbidden characters`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
        }
      }

      // ── JSONata rules ────────────────────────────────────────────────────
      const jsonata = (state.QueryLanguage ?? def.QueryLanguage ?? 'JSONPath') === 'JSONata';

      // ── J-1: Wrong fields for current query language ──────────────────────
      if (jsonata) {
        if (state.Parameters !== undefined) {
          errors.push({ message: `"${name}": "Parameters" is a JSONPath field — use "Arguments" in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        if (state.OutputPath !== undefined) {
          errors.push({ message: `"${name}": "OutputPath" is a JSONPath field — use "Output" in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        if (state.InputPath !== undefined) {
          errors.push({ message: `"${name}": "InputPath" is not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        if (state.ResultPath !== undefined) {
          errors.push({ message: `"${name}": "ResultPath" is not available in JSONata mode — use "Output"`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        // ── J-5: ResultSelector is JSONPath-only ──────────────────────────
        if (state.ResultSelector !== undefined) {
          errors.push({ message: `"${name}": "ResultSelector" is a JSONPath field — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        // ── J-6: TimeoutSecondsPath / HeartbeatSecondsPath are JSONPath-only
        if (state.TimeoutSecondsPath !== undefined) {
          errors.push({ message: `"${name}": "TimeoutSecondsPath" is JSONPath-only — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        if (state.HeartbeatSecondsPath !== undefined) {
          errors.push({ message: `"${name}": "HeartbeatSecondsPath" is JSONPath-only — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        // ── J-7: SecondsPath / TimestampPath in Wait are JSONPath-only ────
        if (state.Type === 'Wait') {
          if (state.SecondsPath !== undefined) {
            errors.push({ message: `"${name}": "SecondsPath" is JSONPath-only — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
          if (state.TimestampPath !== undefined) {
            errors.push({ message: `"${name}": "TimestampPath" is JSONPath-only — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
        }
        // ── R-18: Items vs ItemsPath per query language ───────────────────
        if (state.Type === 'Map' && state.ItemsPath !== undefined) {
          errors.push({ message: `"${name}": "ItemsPath" is JSONPath-only — use "Items" in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        // ── Map JSONPath-only path fields ─────────────────────────────────
        if (state.Type === 'Map') {
          if (state.MaxConcurrencyPath !== undefined) {
            errors.push({ message: `"${name}": "MaxConcurrencyPath" is JSONPath-only — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
          if (state.ToleratedFailureCountPath !== undefined) {
            errors.push({ message: `"${name}": "ToleratedFailureCountPath" is JSONPath-only — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
          if (state.ToleratedFailurePercentagePath !== undefined) {
            errors.push({ message: `"${name}": "ToleratedFailurePercentagePath" is JSONPath-only — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
        }
        // ── Fail JSONPath-only path fields ────────────────────────────────
        if (state.Type === 'Fail') {
          if (state.ErrorPath !== undefined) {
            errors.push({ message: `"${name}": "ErrorPath" is JSONPath-only — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
          if (state.CausePath !== undefined) {
            errors.push({ message: `"${name}": "CausePath" is JSONPath-only — not available in JSONata mode`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
        }
      } else {
        if (state.Arguments !== undefined) {
          errors.push({ message: `"${name}": "Arguments" is a JSONata field — use "Parameters" in JSONPath mode`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
        }
        if (state.Output !== undefined && state.Type !== 'Choice') {
          errors.push({ message: `"${name}": "Output" is a JSONata field — use "OutputPath" in JSONPath mode`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
        }
        // ── R-18: Items only in JSONata ───────────────────────────────────
        if (state.Type === 'Map' && state.Items !== undefined) {
          errors.push({ message: `"${name}": "Items" is a JSONata field — use "ItemsPath" in JSONPath mode`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
        }
        // ── Assign is JSONata-only ────────────────────────────────────────
        if (state.Assign !== undefined) {
          errors.push({ message: `"${name}": "Assign" is a JSONata field — not available in JSONPath mode`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
        }
        // ── J-9: $$. context object path only in JSONPath ─────────────────
        // (checked in string fields below)

        // ── Intrinsic function validation (JSONPath mode) ─────────────────
        for (const [obj, fieldName] of [
          [state.Parameters, 'Parameters'],
          [state.ResultSelector, 'ResultSelector'],
          [state.ItemSelector, 'ItemSelector'],
        ] as Array<[unknown, string]>) {
          if (obj == null) continue;
          scanIntrinsicCalls(obj, fieldName, name, errors);
        }

        // ── Choice Timestamp literal values must be RFC3339 (recursive) ──
        if (state.Type === 'Choice') {
          state.Choices?.forEach((c, i) => {
            for (const leaf of collectChoiceLeaves(c as Record<string, unknown>)) {
              for (const key of TIMESTAMP_LITERAL_KEYS) {
                const val = leaf[key];
                if (typeof val === 'string' && !val.includes('{%') && !val.startsWith('$') && !RFC3339_RE.test(val)) {
                  errors.push({
                    message: `"${name}": Choices[${i}].${key} "${val}" is not valid — RFC3339 format required with uppercase T and Z (e.g. "2024-01-15T12:00:00Z")`,
                    severity: vscode.DiagnosticSeverity.Error,
                    searchKey: name,
                  });
                }
              }
            }
          });
        }
      }

      // ── J-2: Choice — Condition vs Variable per query language ───────────
      if (state.Type === 'Choice') {
        state.Choices?.forEach((c, i) => {
          if (jsonata) {
            const leaves = collectChoiceLeaves(c as Record<string, unknown>);
            if (leaves.some(leaf => leaf.Variable !== undefined)) {
              errors.push({ message: `"${name}": Choices[${i}] uses "Variable" (JSONPath) — in JSONata mode use "Condition"`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
            if (c.Condition && !/^\{%/.test(c.Condition)) {
              errors.push({ message: `"${name}": Choices[${i}].Condition must be wrapped in {%...%} — e.g. "{% $states.input.field = 'value' %}"`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
          } else {
            if (c.Condition !== undefined) {
              errors.push({ message: `"${name}": Choices[${i}] uses "Condition" (JSONata) — in JSONPath mode use "Variable"`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
          }
        });
      }

      // ── J-3: Validate {% ... %} expression syntax ─────────────────────────
      // ── J-4: $states.result only in Task / Parallel / Map ─────────────────
      // ── W-3: $states.errorOutput only in Catch context ────────────────────
      // ── W-4: $states.context.Task.Token only in waitForTaskToken ──────────
      // ── J-8: States.* intrinsic functions in JSONata mode ─────────────────
      // ── J-9: $$. in JSONata mode ──────────────────────────────────────────
      if (jsonata) {
        const fieldsToScan: Array<[unknown, string]> = [
          [state.Arguments, 'Arguments'],
          [state.Output,    'Output'],
          [state.Assign,    'Assign'],
        ];
        state.Choices?.forEach((c, i) => {
          if (c.Condition) fieldsToScan.push([c.Condition, `Choices[${i}].Condition`]);
        });

        const allowsResult = state.Type === 'Task' || state.Type === 'Parallel' || state.Type === 'Map';
        const isWaitForToken = resource.includes('waitForTaskToken');

        for (const [obj, fieldName] of fieldsToScan) {
          if (obj == null) continue;
          for (const { path, expr } of findJsonataExprs(obj, fieldName)) {
            const exprErr = validateJsonataExpr(expr);
            if (exprErr) {
              errors.push({ message: `"${name}": ${path} — ${exprErr}`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
            if (!allowsResult && expr.includes('$states.result')) {
              errors.push({ message: `"${name}": ${path} — $states.result is only available in Task, Parallel, and Map (not in ${state.Type})`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
            // W-3: $states.errorOutput outside Catch
            if (expr.includes('$states.errorOutput')) {
              errors.push({ message: `"${name}": ${path} — $states.errorOutput is only available inside a Catch block`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
            // W-4: $states.context.Task.Token outside waitForTaskToken
            if (expr.includes('$states.context.Task.Token') && !isWaitForToken) {
              errors.push({ message: `"${name}": ${path} — $states.context.Task.Token is only available in .waitForTaskToken states`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
            }
            // J-8: States.* intrinsic functions in JSONata mode
            if (/States\.(Format|StringToJson|JsonToString|Array|ArrayPartition|ArrayContains|ArrayRange|ArrayGetItem|ArrayLength|ArrayUnique|Base64Encode|Base64Decode|Hash|JsonMerge|MathAdd|MathRandom|StringSplit|UUID)\s*\(/.test(expr)) {
              errors.push({ message: `"${name}": ${path} — States.* intrinsic functions only work in JSONPath mode, not JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
          }
        }

        // J-9: $$. context object path in JSONata mode (scan raw string fields)
        const rawStrFields: Array<[unknown, string]> = [
          [state.Arguments, 'Arguments'],
          [state.Output,    'Output'],
          [state.Assign,    'Assign'],
          [state.ItemSelector, 'ItemSelector'],
        ];
        for (const [obj, fieldName] of rawStrFields) {
          if (obj == null) continue;
          scanForDoubledollar(obj, fieldName).forEach(path => {
            errors.push({ message: `"${name}": ${path} — "$$." is JSONPath syntax (Context Object) — in JSONata mode use $states.context`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          });
        }
      }
    }

    // ── W-1: Unreachable states ───────────────────────────────────────────────
    const reachable = AslParser.reachableStates(def);
    for (const name of stateNames) {
      if (!reachable.has(name)) {
        errors.push({
          message: `"${name}" is unreachable (never referenced from StartAt)`,
          severity: vscode.DiagnosticSeverity.Warning,
          searchKey: name,
        });
      }
    }

    return errors;
  }
}

/**
 * Find the 0-based line number of a state definition in the document.
 */
export function findLineForStateName(doc: vscode.TextDocument, stateName: string): number {
  const lines = doc.getText().split('\n');
  const esc = escapeRegex(stateName);
  const pattern = new RegExp(`^\\s+(${esc}|"${esc}")\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return 0;
}

/**
 * Recursively collect all leaf comparison rules from a Choice branch,
 * walking into Not, And, and Or boolean operators.
 */
function collectChoiceLeaves(rule: Record<string, unknown>): Array<Record<string, unknown>> {
  if (rule.Not && typeof rule.Not === 'object' && !Array.isArray(rule.Not)) {
    return collectChoiceLeaves(rule.Not as Record<string, unknown>);
  }
  if (Array.isArray(rule.And)) {
    return (rule.And as unknown[]).flatMap(sub =>
      sub && typeof sub === 'object' ? collectChoiceLeaves(sub as Record<string, unknown>) : []
    );
  }
  if (Array.isArray(rule.Or)) {
    return (rule.Or as unknown[]).flatMap(sub =>
      sub && typeof sub === 'object' ? collectChoiceLeaves(sub as Record<string, unknown>) : []
    );
  }
  return [rule];
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recursively find all {% ... %} expressions inside a nested JSON value.
 */
function findJsonataExprs(
  obj: unknown,
  path: string
): Array<{ path: string; expr: string }> {
  if (typeof obj === 'string') {
    const m = obj.match(/^\{%([\s\S]*?)%\}$/);
    if (m) return [{ path, expr: m[1] }];
  } else if (Array.isArray(obj)) {
    return (obj as unknown[]).flatMap((v, i) =>
      findJsonataExprs(v, `${path}[${i}]`)
    );
  } else if (obj !== null && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      findJsonataExprs(v, `${path}.${k}`)
    );
  }
  return [];
}

/**
 * Recursively scan for any string containing $$. (JSONPath Context Object syntax).
 * Returns dot-paths where it was found.
 */
function scanForDoubledollar(obj: unknown, path: string): string[] {
  if (typeof obj === 'string') {
    return obj.includes('$$.') ? [path] : [];
  } else if (Array.isArray(obj)) {
    return (obj as unknown[]).flatMap((v, i) => scanForDoubledollar(v, `${path}[${i}]`));
  } else if (obj !== null && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      scanForDoubledollar(v, `${path}.${k}`)
    );
  }
  return [];
}

/**
 * Validate the raw inner content of a {% ... %} expression.
 * Returns an error message if invalid, or null if OK.
 */
function validateJsonataExpr(raw: string): string | null {
  const expr = raw.trim();

  if (!expr)
    return 'empty JSONata expression — {%  %} is not valid';
  if (expr.includes('{%'))
    return 'nested {%...%} delimiters (not allowed)';
  if (/\$eval\s*\(/.test(expr))
    return '$eval() is not supported by AWS Step Functions';
  if (/\$\./.test(expr))
    return 'JSONPath "$." syntax inside a JSONata expression — use $states.input.field instead of $.field';
  if (/[\+\-\*\/\%\&]$/.test(expr))
    return 'incomplete expression (ends with an operator)';
  if (/\.$/.test(expr))
    return 'incomplete expression (ends with ".")';

  // Balance check (ignoring content inside string literals)
  let inSQ = false, inDQ = false;
  const d = { brace: 0, bracket: 0, paren: 0 };
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i], p = i > 0 ? expr[i - 1] : '';
    if      (c === "'" && !inDQ && p !== '\\') inSQ = !inSQ;
    else if (c === '"' && !inSQ && p !== '\\') inDQ = !inDQ;
    if (!inSQ && !inDQ) {
      if      (c === '{') d.brace++;
      else if (c === '}') { if (--d.brace < 0) return 'unexpected closing brace "}"'; }
      else if (c === '[') d.bracket++;
      else if (c === ']') { if (--d.bracket < 0) return 'unexpected closing bracket "]"'; }
      else if (c === '(') d.paren++;
      else if (c === ')') { if (--d.paren < 0) return 'unexpected closing parenthesis ")"'; }
    }
  }
  if (inSQ)       return 'unclosed single quote';
  if (inDQ)       return 'unclosed double quote';
  if (d.brace)    return `unclosed opening brace (${d.brace} missing)`;
  if (d.bracket)  return `unclosed opening bracket (${d.bracket} missing)`;
  if (d.paren)    return `unclosed opening parenthesis (${d.paren} missing)`;

  return null;
}

/**
 * Split intrinsic function argument string by commas, respecting nested parentheses.
 * e.g. "$.a, States.Array(1,2), 'x'" → ["$.a", "States.Array(1,2)", "'x'"]
 */
function splitIntrinsicArgs(argsStr: string): string[] {
  const args: string[] = [];
  let depth = 0, current = '';
  for (const ch of argsStr) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * Extract the full argument string of an intrinsic function call,
 * correctly balancing nested parentheses.
 * e.g. extractFuncArgs("States.Hash(States.Format(a,b), 'SHA-256')", "States.Hash")
 *   → "States.Format(a,b), 'SHA-256'"
 */
function extractFuncArgs(str: string, funcName: string): string | null {
  const idx = str.indexOf(funcName + '(');
  if (idx === -1) return null;
  const start = idx + funcName.length + 1;
  let depth = 1;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return str.slice(start, i);
    }
  }
  return null;
}

/**
 * Recursively scan an object for intrinsic function calls (JSONPath mode)
 * and validate States.Hash algorithm and States.JsonMerge third argument.
 */
function scanIntrinsicCalls(
  obj: unknown,
  path: string,
  stateName: string,
  errors: LintError[]
): void {
  if (typeof obj === 'string') {
    // States.Hash(data, algorithm) — algorithm must be a known value
    const hashArgs = extractFuncArgs(obj, 'States.Hash');
    if (hashArgs) {
      const args = splitIntrinsicArgs(hashArgs);
      if (args.length >= 2) {
        const algo = args[1].replace(/^['"]|['"]$/g, '');
        if (!VALID_HASH_ALGOS.has(algo)) {
          errors.push({
            message: `"${stateName}": ${path} — States.Hash: algorithm "${algo}" is not valid — accepted values: ${[...VALID_HASH_ALGOS].join(', ')}`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: stateName,
          });
        }
      }
    }
    // States.JsonMerge(obj1, obj2, deep) — third arg must be false (shallow only)
    const mergeArgs = extractFuncArgs(obj, 'States.JsonMerge');
    if (mergeArgs) {
      const args = splitIntrinsicArgs(mergeArgs);
      if (args.length >= 3 && args[2].trim() !== 'false') {
        errors.push({
          message: `"${stateName}": ${path} — States.JsonMerge: the 3rd argument must be "false" (only shallow merge is supported)`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: stateName,
        });
      }
    }
  } else if (Array.isArray(obj)) {
    (obj as unknown[]).forEach((v, i) => scanIntrinsicCalls(v, `${path}[${i}]`, stateName, errors));
  } else if (obj !== null && typeof obj === 'object') {
    Object.entries(obj as Record<string, unknown>).forEach(([k, v]) =>
      scanIntrinsicCalls(v, `${path}.${k}`, stateName, errors)
    );
  }
}
