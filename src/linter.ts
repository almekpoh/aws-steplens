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
        message: `Version "${def.Version}" invalide — seule "1.0" est supportée`,
        severity: vscode.DiagnosticSeverity.Error,
        searchKey: 'Version',
      });
    }

    // ── Definition-level QueryLanguage ────────────────────────────────────────
    if (def.QueryLanguage !== undefined && def.QueryLanguage !== 'JSONata' && def.QueryLanguage !== 'JSONPath') {
      errors.push({
        message: `QueryLanguage "${def.QueryLanguage}" invalide — valeurs acceptées: "JSONata", "JSONPath"`,
        severity: vscode.DiagnosticSeverity.Error,
        searchKey: 'QueryLanguage',
      });
    }

    // ── Definition-level TimeoutSeconds: 1 to 99999999 ────────────────────────
    if (def.TimeoutSeconds !== undefined) {
      if (def.TimeoutSeconds < 1 || def.TimeoutSeconds > 99999999) {
        errors.push({
          message: `TimeoutSeconds global (${def.TimeoutSeconds}) invalide — doit être entre 1 et 99999999`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: 'TimeoutSeconds',
        });
      }
    }

    // ── R-1: StartAt must exist ─────────────────────────────────────────────
    if (!stateNames.has(def.StartAt)) {
      errors.push({
        message: `StartAt "${def.StartAt}" n'existe pas dans States`,
        severity: vscode.DiagnosticSeverity.Error,
        searchKey: 'StartAt',
      });
    }

    for (const [name, state] of Object.entries(states)) {

      // ── State-level QueryLanguage ─────────────────────────────────────────
      if (state.QueryLanguage !== undefined && state.QueryLanguage !== 'JSONata' && state.QueryLanguage !== 'JSONPath') {
        errors.push({
          message: `"${name}": QueryLanguage "${state.QueryLanguage}" invalide — valeurs acceptées: "JSONata", "JSONPath"`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-24: State name max 80 chars ────────────────────────────────────
      if (name.length > 80) {
        errors.push({
          message: `"${name}": nom d'état trop long (${name.length} chars, max 80)`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-25: State name forbidden characters ────────────────────────────
      if (STATE_NAME_FORBIDDEN.test(name)) {
        errors.push({
          message: `"${name}": nom d'état contient des caractères interdits`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-2: Next must point to an existing state ─────────────────────────
      if (state.Next && !stateNames.has(state.Next)) {
        errors.push({
          message: `"${name}": Next "${state.Next}" introuvable`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-3: Non-terminal states must have Next or End ────────────────────
      const isTerminal = state.Type === 'Succeed' || state.Type === 'Fail';
      const isChoice = state.Type === 'Choice';
      if (!isTerminal && !isChoice && !state.Next && !state.End) {
        errors.push({
          message: `"${name}" (${state.Type}): ni "Next" ni "End" défini`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── Succeed/Fail must not have Next or End ────────────────────────────
      if (isTerminal && state.Next) {
        errors.push({
          message: `"${name}" (${state.Type}): "Next" n'est pas autorisé sur un état terminal`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (isTerminal && state.End) {
        errors.push({
          message: `"${name}" (${state.Type}): "End" est implicite et redondant sur un état terminal`,
          severity: vscode.DiagnosticSeverity.Warning,
          searchKey: name,
        });
      }

      // ── Choice must not have Retry, Catch, Next, or End ─────────────────────
      if (isChoice) {
        if ((state.Retry?.length ?? 0) > 0) {
          errors.push({
            message: `"${name}" (Choice): "Retry" n'est pas autorisé sur un état Choice`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if ((state.Catch?.length ?? 0) > 0) {
          errors.push({
            message: `"${name}" (Choice): "Catch" n'est pas autorisé sur un état Choice`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (state.Next) {
          errors.push({
            message: `"${name}" (Choice): "Next" n'est pas autorisé — la transition est définie par Choices[].Next et Default`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (state.End) {
          errors.push({
            message: `"${name}" (Choice): "End" n'est pas autorisé sur un état Choice`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      }

      // ── R-4: Catch.Next must exist ────────────────────────────────────────
      state.Catch?.forEach((c, i) => {
        if (!stateNames.has(c.Next)) {
          errors.push({
            message: `"${name}": Catch[${i}].Next "${c.Next}" introuvable`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }

        // ── R-17: ErrorEquals must be non-empty ──────────────────────────
        if (!c.ErrorEquals || c.ErrorEquals.length === 0) {
          errors.push({
            message: `"${name}": Catch[${i}].ErrorEquals est vide`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }

        // ── R-15: States.ALL must be alone and last ──────────────────────
        if (c.ErrorEquals?.includes('States.ALL')) {
          if (c.ErrorEquals.length > 1) {
            errors.push({
              message: `"${name}": Catch[${i}].ErrorEquals contient "States.ALL" avec d'autres erreurs — States.ALL doit être seul`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
          const catchArr = state.Catch!;
          if (i < catchArr.length - 1) {
            errors.push({
              message: `"${name}": Catch[${i}] avec "States.ALL" doit être le dernier catcheur`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
        }

        // ── R-16: Uncatchable errors ─────────────────────────────────────
        c.ErrorEquals?.forEach(e => {
          if (UNCATCHABLE_ERRORS.has(e)) {
            errors.push({
              message: `"${name}": Catch[${i}] — "${e}" ne peut pas être catchée (erreur non interceptable)`,
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
            message: `"${name}": Retry[${i}].ErrorEquals est vide`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (r.ErrorEquals?.includes('States.ALL')) {
          if (r.ErrorEquals.length > 1) {
            errors.push({
              message: `"${name}": Retry[${i}].ErrorEquals contient "States.ALL" avec d'autres erreurs — States.ALL doit être seul`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
          if (i < (state.Retry!.length - 1)) {
            errors.push({
              message: `"${name}": Retry[${i}] avec "States.ALL" doit être le dernier retrier`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
        }
        // IntervalSeconds minimum 1, maximum 99999999
        if (r.IntervalSeconds !== undefined && r.IntervalSeconds < 1) {
          errors.push({
            message: `"${name}": Retry[${i}].IntervalSeconds doit être ≥ 1 (valeur: ${r.IntervalSeconds})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (r.IntervalSeconds !== undefined && r.IntervalSeconds > 99999999) {
          errors.push({
            message: `"${name}": Retry[${i}].IntervalSeconds (${r.IntervalSeconds}) dépasse la limite maximale de 99999999`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // BackoffRate minimum 1.0
        if (r.BackoffRate !== undefined && r.BackoffRate < 1) {
          errors.push({
            message: `"${name}": Retry[${i}].BackoffRate doit être ≥ 1.0 (valeur: ${r.BackoffRate})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // MaxDelaySeconds range: 1 to 31622400
        if (r.MaxDelaySeconds !== undefined && (r.MaxDelaySeconds < 1 || r.MaxDelaySeconds > 31622400)) {
          errors.push({
            message: `"${name}": Retry[${i}].MaxDelaySeconds doit être entre 1 et 31622400 (valeur: ${r.MaxDelaySeconds})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // MaxAttempts >= 0
        if (r.MaxAttempts !== undefined && r.MaxAttempts < 0) {
          errors.push({
            message: `"${name}": Retry[${i}].MaxAttempts doit être ≥ 0 (valeur: ${r.MaxAttempts})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // JitterStrategy must be FULL or NONE
        if (r.JitterStrategy !== undefined && r.JitterStrategy !== 'FULL' && r.JitterStrategy !== 'NONE') {
          errors.push({
            message: `"${name}": Retry[${i}].JitterStrategy invalide "${r.JitterStrategy}" — valeurs acceptées: FULL, NONE`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      });

      // ── R-5: Choice branches must have valid Next ─────────────────────────
      if (state.Type === 'Choice') {
        if (!state.Choices || state.Choices.length === 0) {
          errors.push({
            message: `"${name}" (Choice): aucune branche définie`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        state.Choices?.forEach((c, i) => {
          if (!c.Next) {
            errors.push({
              message: `"${name}": Choices[${i}] sans "Next"`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          } else if (!stateNames.has(c.Next)) {
            errors.push({
              message: `"${name}": Choices[${i}].Next "${c.Next}" introuvable`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
        });
        if (state.Default && !stateNames.has(state.Default)) {
          errors.push({
            message: `"${name}": Default "${state.Default}" introuvable`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // ── W-2: Choice without Default ──────────────────────────────────
        if (!state.Default) {
          errors.push({
            message: `"${name}" (Choice): aucun "Default" défini — risque de States.NoChoiceMatched à runtime`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }
      }

      // ── Pass: Result and ResultPath usage ────────────────────────────────
      if (state.Type === 'Pass') {
        if (state.Result !== undefined && state.ResultPath === null) {
          errors.push({
            message: `"${name}" (Pass): Result est défini mais ResultPath est null — le résultat sera ignoré (ResultPath: null signifie "ne pas merger dans l'output")`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }
        if (state.Parameters !== undefined && state.Result !== undefined) {
          errors.push({
            message: `"${name}" (Pass): Result et Parameters sont mutuellement exclusifs — Parameters remplace Result si les deux sont définis`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }
      }

      // ── R-6: Parallel/Map must have End or Next ───────────────────────────
      if ((state.Type === 'Parallel' || state.Type === 'Map') && !state.Next && !state.End) {
        errors.push({
          message: `"${name}" (${state.Type}): ni "Next" ni "End"`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-7: Parallel branches are valid sub-state-machines ───────────────
      state.Branches?.forEach((branch, i) => {
        if (!branch.StartAt || !branch.States) {
          errors.push({
            message: `"${name}": Branches[${i}] invalide (StartAt/States manquants)`,
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
          message: `"${name}" (Task): "Resource" est requis`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── Resource ARN + integration pattern validation (Task states only) ───
      const resource = state.Resource ?? '';
      if (state.Type === 'Task' && resource) {

        // ── ARN-1: Resource must start with arn: ────────────────────────────
        if (!resource.startsWith('arn:')) {
          errors.push({
            message: `"${name}": Resource "${resource}" n'est pas un ARN valide — doit commencer par "arn:"`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }

        // ── ARN-2: SDK integration pattern compatibility ─────────────────────
        const sdkMatch = resource.match(SDK_SERVICE_RE);
        if (sdkMatch) {
          const service = sdkMatch[1]; // ex: 'sqs', 'lambda', 'aws-sdk', 'http'
          const pattern = sdkMatch[3]; // 'sync', 'sync:2', 'waitForTaskToken', ou undefined
          const isAwsSdk = service === 'aws-sdk';

          // aws-sdk:SERVICE:ACTION format never supports .sync / .sync:2
          if (isAwsSdk && (pattern === 'sync' || pattern === 'sync:2')) {
            errors.push({
              message: `"${name}": les intégrations AWS SDK (aws-sdk:*) ne supportent pas le pattern ".${pattern}" — utilisez l'intégration optimisée si disponible`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }

          // Optimized integrations: some services don't support .sync
          if (!isAwsSdk && (pattern === 'sync' || pattern === 'sync:2') && NO_SYNC_SERVICES.has(service)) {
            errors.push({
              message: `"${name}": le service "${service}" ne supporte pas ".${pattern}" — intégration fire-and-forget uniquement`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }

          // .sync requires Standard workflow (only when the service supports it)
          if (!isAwsSdk && (pattern === 'sync' || pattern === 'sync:2') && !NO_SYNC_SERVICES.has(service)) {
            errors.push({
              message: `"${name}": ".${pattern}" nécessite un workflow Standard — incompatible avec les workflows Express`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }

          if (pattern === 'waitForTaskToken' && NO_WAIT_FOR_TOKEN_SERVICES.has(service)) {
            errors.push({
              message: `"${name}": le service "${service}" ne supporte pas ".waitForTaskToken"`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }

          // .waitForTaskToken requires Standard workflow (Express only supports request-response)
          if (!isAwsSdk && pattern === 'waitForTaskToken' && !NO_WAIT_FOR_TOKEN_SERVICES.has(service)) {
            errors.push({
              message: `"${name}": ".waitForTaskToken" nécessite un workflow Standard — incompatible avec les workflows Express`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }

          // HTTP Task required fields
          if (service === 'http') {
            const params = (state.Parameters ?? state.Arguments ?? {}) as Record<string, unknown>;
            if (!params['ApiEndpoint'] && !params['ApiEndpoint.$']) {
              errors.push({
                message: `"${name}" (HTTP Task): "ApiEndpoint" est requis dans Parameters/Arguments`,
                severity: vscode.DiagnosticSeverity.Error,
                searchKey: name,
              });
            }
            const method = params['Method'];
            if (!method && !params['Method.$']) {
              errors.push({
                message: `"${name}" (HTTP Task): "Method" est requis dans Parameters/Arguments`,
                severity: vscode.DiagnosticSeverity.Error,
                searchKey: name,
              });
            } else if (typeof method === 'string') {
              const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);
              if (!VALID_METHODS.has(method.toUpperCase())) {
                errors.push({
                  message: `"${name}" (HTTP Task): méthode HTTP invalide "${method}" — valeurs acceptées: GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD`,
                  severity: vscode.DiagnosticSeverity.Error,
                  searchKey: name,
                });
              }
            }
            const auth = params['Authentication'] as Record<string, unknown> | undefined;
            const invocCfg = params['InvocationConfig'] as Record<string, unknown> | undefined;
            if (!auth?.['ConnectionArn'] && !invocCfg?.['ConnectionArn']) {
              errors.push({
                message: `"${name}" (HTTP Task): "Authentication.ConnectionArn" ou "InvocationConfig.ConnectionArn" recommandé pour les appels HTTP sécurisés`,
                severity: vscode.DiagnosticSeverity.Warning,
                searchKey: name,
              });
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
            message: `"${name}": utilise waitForTaskToken mais n'a pas de Catch pour States.HeartbeatTimeout — risque de blocage permanent`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }

        if (!state.HeartbeatSeconds && !state.HeartbeatSecondsPath) {
          errors.push({
            message: `"${name}": waitForTaskToken sans HeartbeatSeconds — l'exécution peut bloquer indéfiniment`,
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
            message: `"${name}" (Map): aucun Iterator ou ItemProcessor défini`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        } else if (!iterator.StartAt || !iterator.States) {
          errors.push({
            message: `"${name}": Iterator invalide (StartAt/States manquants)`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        } else {
          AslLinter.lint({ StartAt: iterator.StartAt, States: iterator.States, QueryLanguage: def.QueryLanguage })
            .forEach(e => errors.push({ ...e, message: `[Iterator] ${e.message}` }));
        }
      }

      // ── R-10: MaxConcurrency: 0 on Map = unlimited (warning) ─────────────
      if (state.Type === 'Map' && state.MaxConcurrency === 0) {
        errors.push({
          message: `"${name}": MaxConcurrency: 0 signifie une concurrence illimitée — vérifiez que c'est intentionnel`,
          severity: vscode.DiagnosticSeverity.Warning,
          searchKey: name,
        });
      }

      // ── R-11: TimeoutSeconds / TimeoutSecondsPath mutual exclusion ────────
      if (state.TimeoutSeconds !== undefined && state.TimeoutSecondsPath !== undefined) {
        errors.push({
          message: `"${name}": TimeoutSeconds et TimeoutSecondsPath sont mutuellement exclusifs`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.TimeoutSeconds !== undefined && state.TimeoutSeconds <= 0) {
        errors.push({
          message: `"${name}": TimeoutSeconds doit être un entier positif > 0 (valeur: ${state.TimeoutSeconds})`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.TimeoutSeconds !== undefined && state.TimeoutSeconds > 99999999) {
        errors.push({
          message: `"${name}": TimeoutSeconds (${state.TimeoutSeconds}) dépasse la limite maximale de 99999999`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-11 (Heartbeat): HeartbeatSeconds / HeartbeatSecondsPath ─────────
      if (state.HeartbeatSeconds !== undefined && state.HeartbeatSecondsPath !== undefined) {
        errors.push({
          message: `"${name}": HeartbeatSeconds et HeartbeatSecondsPath sont mutuellement exclusifs`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-12: HeartbeatSeconds must be < TimeoutSeconds ──────────────────
      if (state.HeartbeatSeconds !== undefined && state.HeartbeatSeconds <= 0) {
        errors.push({
          message: `"${name}": HeartbeatSeconds doit être un entier positif > 0 (valeur: ${state.HeartbeatSeconds})`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.HeartbeatSeconds !== undefined && state.HeartbeatSeconds > 99999999) {
        errors.push({
          message: `"${name}": HeartbeatSeconds (${state.HeartbeatSeconds}) dépasse la limite maximale de 99999999`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.HeartbeatSeconds !== undefined && state.TimeoutSeconds !== undefined) {
        if (state.HeartbeatSeconds >= state.TimeoutSeconds) {
          errors.push({
            message: `"${name}": HeartbeatSeconds (${state.HeartbeatSeconds}) doit être inférieur à TimeoutSeconds (${state.TimeoutSeconds})`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      }

      // ── R-13: Fail state Error/ErrorPath and Cause/CausePath mutual exclusion
      if (state.Type === 'Fail') {
        if (state.Error !== undefined && state.ErrorPath !== undefined) {
          errors.push({
            message: `"${name}" (Fail): Error et ErrorPath sont mutuellement exclusifs`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        if (state.Cause !== undefined && state.CausePath !== undefined) {
          errors.push({
            message: `"${name}" (Fail): Cause et CausePath sont mutuellement exclusifs`,
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
            message: `"${name}" (Wait): aucun champ de timing — définissez Seconds, Timestamp, SecondsPath ou TimestampPath`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        } else if (timingFields.length > 1) {
          errors.push({
            message: `"${name}" (Wait): plusieurs champs de timing définis — un seul autorisé (Seconds, Timestamp, SecondsPath ou TimestampPath)`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // Seconds range: 0 to 99999999
        if (state.Seconds !== undefined && (state.Seconds < 0 || state.Seconds > 99999999)) {
          errors.push({
            message: `"${name}" (Wait): Seconds (${state.Seconds}) hors plage — valeur entre 0 et 99999999`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
        // Timestamp must be RFC 3339 with uppercase T and uppercase Z
        if (typeof state.Timestamp === 'string' && !RFC3339_RE.test(state.Timestamp)) {
          errors.push({
            message: `"${name}" (Wait): Timestamp "${state.Timestamp}" invalide — format RFC3339 requis avec T majuscule et Z majuscule (ex: "2024-01-15T12:00:00Z")`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      }

      // ── R-19: ToleratedFailurePercentage must be 0-100 ───────────────────
      if (state.ToleratedFailurePercentage !== undefined) {
        if (state.ToleratedFailurePercentage < 0 || state.ToleratedFailurePercentage > 100) {
          errors.push({
            message: `"${name}": ToleratedFailurePercentage (${state.ToleratedFailurePercentage}) doit être entre 0 et 100`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }
      }

      // ── R-20: MaxConcurrency / MaxConcurrencyPath mutual exclusion ────────
      if (state.MaxConcurrency !== undefined && state.MaxConcurrencyPath !== undefined) {
        errors.push({
          message: `"${name}": MaxConcurrency et MaxConcurrencyPath sont mutuellement exclusifs`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.ToleratedFailureCount !== undefined && state.ToleratedFailureCountPath !== undefined) {
        errors.push({
          message: `"${name}": ToleratedFailureCount et ToleratedFailureCountPath sont mutuellement exclusifs`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }
      if (state.ToleratedFailurePercentage !== undefined && state.ToleratedFailurePercentagePath !== undefined) {
        errors.push({
          message: `"${name}": ToleratedFailurePercentage et ToleratedFailurePercentagePath sont mutuellement exclusifs`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── Deprecated Iterator warning ───────────────────────────────────────
      if (state.Type === 'Map' && state.Iterator && !state.ItemProcessor) {
        errors.push({
          message: `"${name}": "Iterator" est déprécié — migrez vers "ItemProcessor"`,
          severity: vscode.DiagnosticSeverity.Warning,
          searchKey: name,
        });
      }

      // ── Deprecated Parameters in Map (use ItemSelector) ──────────────────
      if (state.Type === 'Map' && state.Parameters !== undefined && state.ItemSelector === undefined) {
        errors.push({
          message: `"${name}": "Parameters" est déprécié dans Map — migrez vers "ItemSelector"`,
          severity: vscode.DiagnosticSeverity.Warning,
          searchKey: name,
        });
      }

      // ── Activity ARN not supported in Express Workflows ───────────────────
      if (state.Type === 'Task' && /^arn:[^:]*:states:[^:]*:[^:]*:activity:/.test(resource)) {
        errors.push({
          message: `"${name}": les Activities ne sont pas supportées dans les workflows Express (Standard uniquement)`,
          severity: vscode.DiagnosticSeverity.Warning,
          searchKey: name,
        });
      }


      // ── ProcessorConfig validation ────────────────────────────────────────
      if (state.Type === 'Map' && state.ItemProcessor) {
        const pc = (state.ItemProcessor as { ProcessorConfig?: { Mode?: string; ExecutionType?: string } }).ProcessorConfig;
        const mode = pc?.Mode ?? 'INLINE';
        const execType = pc?.ExecutionType;

        // DISTRIBUTED mode: Standard workflow only
        if (mode === 'DISTRIBUTED') {
          errors.push({
            message: `"${name}": le mode DISTRIBUTED nécessite un workflow Standard — non supporté dans les workflows Express`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }

        // ExecutionType required when DISTRIBUTED
        if (mode === 'DISTRIBUTED' && !execType) {
          errors.push({
            message: `"${name}": ItemProcessor.ProcessorConfig.ExecutionType est requis en mode DISTRIBUTED ("STANDARD" ou "EXPRESS")`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }

        // ExecutionType irrelevant in INLINE mode
        if (mode === 'INLINE' && execType) {
          errors.push({
            message: `"${name}": ItemProcessor.ProcessorConfig.ExecutionType est ignoré en mode INLINE — s'applique uniquement à DISTRIBUTED`,
            severity: vscode.DiagnosticSeverity.Warning,
            searchKey: name,
          });
        }

        // INLINE concurrency > 40 — hard limit enforced by AWS
        if (mode === 'INLINE' && state.MaxConcurrency !== undefined && state.MaxConcurrency > 40) {
          errors.push({
            message: `"${name}": mode INLINE limité à 40 itérations concurrentes (MaxConcurrency: ${state.MaxConcurrency}) — passez en mode DISTRIBUTED pour dépasser cette limite`,
            severity: vscode.DiagnosticSeverity.Error,
            searchKey: name,
          });
        }

        // waitForTaskToken not supported in EXPRESS children
        if (mode === 'DISTRIBUTED' && execType === 'EXPRESS') {
          const hasWaitForToken = Object.values(state.ItemProcessor?.States ?? {})
            .some(s => (s.Resource ?? '').includes('waitForTaskToken'));
          if (hasWaitForToken) {
            errors.push({
              message: `"${name}": les child executions EXPRESS ne supportent pas .waitForTaskToken (request-response uniquement)`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
        }

        // DISTRIBUTED-only fields on INLINE Map
        if (mode === 'INLINE') {
          if (state.Label !== undefined) {
            errors.push({
              message: `"${name}": Label est ignoré en mode INLINE — s'applique uniquement aux Maps DISTRIBUTED`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }
          if (state.ItemBatcher !== undefined) {
            errors.push({
              message: `"${name}": "ItemBatcher" est réservé aux Maps DISTRIBUTED — ignoré en mode INLINE`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }
          if (state.ItemReader !== undefined) {
            errors.push({
              message: `"${name}": "ItemReader" est réservé aux Maps DISTRIBUTED — ignoré en mode INLINE`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }
          if (state.ResultWriter !== undefined) {
            errors.push({
              message: `"${name}": "ResultWriter" est réservé aux Maps DISTRIBUTED — ignoré en mode INLINE`,
              severity: vscode.DiagnosticSeverity.Warning,
              searchKey: name,
            });
          }
        }

        // Label max 40 chars (distributed Map)
        if (mode === 'DISTRIBUTED' && state.Label !== undefined) {
          if (state.Label.length > 40) {
            errors.push({
              message: `"${name}": Label "${state.Label}" trop long (${state.Label.length} chars, max 40)`,
              severity: vscode.DiagnosticSeverity.Error,
              searchKey: name,
            });
          }
          if (/[\s?*<>{}[\]"#%\\^|~`$&,;:/]/.test(state.Label)) {
            errors.push({
              message: `"${name}": Label contient des caractères interdits`,
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
          errors.push({ message: `"${name}": "Parameters" est un champ JSONPath — utilisez "Arguments" en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        if (state.OutputPath !== undefined) {
          errors.push({ message: `"${name}": "OutputPath" est un champ JSONPath — utilisez "Output" en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        if (state.InputPath !== undefined) {
          errors.push({ message: `"${name}": "InputPath" n'est pas disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        if (state.ResultPath !== undefined) {
          errors.push({ message: `"${name}": "ResultPath" n'est pas disponible en mode JSONata — utilisez "Output"`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        // ── J-5: ResultSelector is JSONPath-only ──────────────────────────
        if (state.ResultSelector !== undefined) {
          errors.push({ message: `"${name}": "ResultSelector" est un champ JSONPath — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        // ── J-6: TimeoutSecondsPath / HeartbeatSecondsPath are JSONPath-only
        if (state.TimeoutSecondsPath !== undefined) {
          errors.push({ message: `"${name}": "TimeoutSecondsPath" est JSONPath uniquement — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        if (state.HeartbeatSecondsPath !== undefined) {
          errors.push({ message: `"${name}": "HeartbeatSecondsPath" est JSONPath uniquement — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        // ── J-7: SecondsPath / TimestampPath in Wait are JSONPath-only ────
        if (state.Type === 'Wait') {
          if (state.SecondsPath !== undefined) {
            errors.push({ message: `"${name}": "SecondsPath" est JSONPath uniquement — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
          if (state.TimestampPath !== undefined) {
            errors.push({ message: `"${name}": "TimestampPath" est JSONPath uniquement — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
        }
        // ── R-18: Items vs ItemsPath per query language ───────────────────
        if (state.Type === 'Map' && state.ItemsPath !== undefined) {
          errors.push({ message: `"${name}": "ItemsPath" est JSONPath uniquement — utilisez "Items" en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
        }
        // ── Map JSONPath-only path fields ─────────────────────────────────
        if (state.Type === 'Map') {
          if (state.MaxConcurrencyPath !== undefined) {
            errors.push({ message: `"${name}": "MaxConcurrencyPath" est JSONPath uniquement — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
          if (state.ToleratedFailureCountPath !== undefined) {
            errors.push({ message: `"${name}": "ToleratedFailureCountPath" est JSONPath uniquement — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
          if (state.ToleratedFailurePercentagePath !== undefined) {
            errors.push({ message: `"${name}": "ToleratedFailurePercentagePath" est JSONPath uniquement — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
        }
        // ── Fail JSONPath-only path fields ────────────────────────────────
        if (state.Type === 'Fail') {
          if (state.ErrorPath !== undefined) {
            errors.push({ message: `"${name}": "ErrorPath" est JSONPath uniquement — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
          if (state.CausePath !== undefined) {
            errors.push({ message: `"${name}": "CausePath" est JSONPath uniquement — non disponible en mode JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          }
        }
      } else {
        if (state.Arguments !== undefined) {
          errors.push({ message: `"${name}": "Arguments" est un champ JSONata — utilisez "Parameters" en mode JSONPath`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
        }
        if (state.Output !== undefined && state.Type !== 'Choice') {
          errors.push({ message: `"${name}": "Output" est un champ JSONata — utilisez "OutputPath" en mode JSONPath`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
        }
        // ── R-18: Items only in JSONata ───────────────────────────────────
        if (state.Type === 'Map' && state.Items !== undefined) {
          errors.push({ message: `"${name}": "Items" est un champ JSONata — utilisez "ItemsPath" en mode JSONPath`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
        }
        // ── Assign is JSONata-only ────────────────────────────────────────
        if (state.Assign !== undefined) {
          errors.push({ message: `"${name}": "Assign" est un champ JSONata — non disponible en mode JSONPath`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
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
                if (typeof val === 'string' && !RFC3339_RE.test(val)) {
                  errors.push({
                    message: `"${name}": Choices[${i}].${key} "${val}" invalide — format RFC3339 requis avec T majuscule et Z majuscule (ex: "2024-01-15T12:00:00Z")`,
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
              errors.push({ message: `"${name}": Choices[${i}] utilise "Variable" (JSONPath) — en mode JSONata utilisez "Condition"`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
            if (c.Condition && !/^\{%/.test(c.Condition)) {
              errors.push({ message: `"${name}": Choices[${i}].Condition doit être entouré de {%...%} — ex: "{% $states.input.field = 'valeur' %}"`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
          } else {
            if (c.Condition !== undefined) {
              errors.push({ message: `"${name}": Choices[${i}] utilise "Condition" (JSONata) — en mode JSONPath utilisez "Variable"`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
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
              errors.push({ message: `"${name}": ${path} — $states.result n'est disponible que dans Task, Parallel et Map (pas dans ${state.Type})`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
            // W-3: $states.errorOutput outside Catch
            if (expr.includes('$states.errorOutput')) {
              errors.push({ message: `"${name}": ${path} — $states.errorOutput n'est disponible que dans un bloc Catch`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
            }
            // W-4: $states.context.Task.Token outside waitForTaskToken
            if (expr.includes('$states.context.Task.Token') && !isWaitForToken) {
              errors.push({ message: `"${name}": ${path} — $states.context.Task.Token n'est disponible que dans les états .waitForTaskToken`, severity: vscode.DiagnosticSeverity.Warning, searchKey: name });
            }
            // J-8: States.* intrinsic functions in JSONata mode
            if (/States\.(Format|StringToJson|JsonToString|Array|ArrayPartition|ArrayContains|ArrayRange|ArrayGetItem|ArrayLength|ArrayUnique|Base64Encode|Base64Decode|Hash|JsonMerge|MathAdd|MathRandom|StringSplit|UUID)\s*\(/.test(expr)) {
              errors.push({ message: `"${name}": ${path} — les fonctions intrinsèques States.* ne fonctionnent qu'en mode JSONPath, pas JSONata`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
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
            errors.push({ message: `"${name}": ${path} — "$$.". est une syntaxe JSONPath (Context Object) — en mode JSONata utilisez $states.context`, severity: vscode.DiagnosticSeverity.Error, searchKey: name });
          });
        }
      }
    }

    // ── W-1: Unreachable states ───────────────────────────────────────────────
    const reachable = AslParser.reachableStates(def);
    for (const name of stateNames) {
      if (!reachable.has(name)) {
        errors.push({
          message: `"${name}" est inaccessible (jamais référencé depuis StartAt)`,
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
 * Returns a French error message if invalid, or null if OK.
 */
function validateJsonataExpr(raw: string): string | null {
  const expr = raw.trim();

  if (!expr)
    return 'expression JSONata vide — {%  %} est invalide';
  if (expr.includes('{%'))
    return 'délimiteurs {%...%} imbriqués (non autorisé)';
  if (/\$eval\s*\(/.test(expr))
    return '$eval() n\'est pas supporté par AWS Step Functions';
  if (/\$\./.test(expr))
    return 'syntaxe JSONPath "$." dans une expression JSONata — utilisez $states.input.champ au lieu de $.champ';
  if (/[\+\-\*\/\%\&]$/.test(expr))
    return 'expression incomplète (se termine par un opérateur)';
  if (/\.$/.test(expr))
    return 'expression incomplète (se termine par ".")';

  // Balance check (ignoring content inside string literals)
  let inSQ = false, inDQ = false;
  const d = { brace: 0, bracket: 0, paren: 0 };
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i], p = i > 0 ? expr[i - 1] : '';
    if      (c === "'" && !inDQ && p !== '\\') inSQ = !inSQ;
    else if (c === '"' && !inSQ && p !== '\\') inDQ = !inDQ;
    if (!inSQ && !inDQ) {
      if      (c === '{') d.brace++;
      else if (c === '}') { if (--d.brace < 0) return 'accolade "}" inattendue'; }
      else if (c === '[') d.bracket++;
      else if (c === ']') { if (--d.bracket < 0) return 'crochet "]" inattendu'; }
      else if (c === '(') d.paren++;
      else if (c === ')') { if (--d.paren < 0) return 'parenthèse ")" inattendue'; }
    }
  }
  if (inSQ)       return 'guillemet simple non fermé';
  if (inDQ)       return 'guillemet double non fermé';
  if (d.brace)    return `accolade ouvrante non fermée (${d.brace} manquante${d.brace > 1 ? 's' : ''})`;
  if (d.bracket)  return `crochet ouvrant non fermé (${d.bracket} manquant${d.bracket > 1 ? 's' : ''})`;
  if (d.paren)    return `parenthèse ouvrante non fermée (${d.paren} manquante${d.paren > 1 ? 's' : ''})`;

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
            message: `"${stateName}": ${path} — States.Hash: algorithme "${algo}" invalide — valeurs acceptées: ${[...VALID_HASH_ALGOS].join(', ')}`,
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
          message: `"${stateName}": ${path} — States.JsonMerge: le 3ème argument doit être "false" (seule la fusion superficielle est supportée)`,
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
