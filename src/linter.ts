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

export class AslLinter {
  static lint(def: AslDefinition): LintError[] {
    const errors: LintError[] = [];
    const states = def.States ?? {};
    const stateNames = new Set(Object.keys(states));

    // ── R-1: StartAt must exist ─────────────────────────────────────────────
    if (!stateNames.has(def.StartAt)) {
      errors.push({
        message: `StartAt "${def.StartAt}" n'existe pas dans States`,
        severity: vscode.DiagnosticSeverity.Error,
        searchKey: 'StartAt',
      });
    }

    for (const [name, state] of Object.entries(states)) {

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
        // BackoffRate minimum 1.0
        if (r.BackoffRate !== undefined && r.BackoffRate < 1) {
          errors.push({
            message: `"${name}": Retry[${i}].BackoffRate doit être ≥ 1.0 (valeur: ${r.BackoffRate})`,
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

      // ── R-8: waitForTaskToken must have a Catch for HeartbeatTimeout ──────
      const resource = state.Resource ?? '';
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

      // ── R-11 (Heartbeat): HeartbeatSeconds / HeartbeatSecondsPath ─────────
      if (state.HeartbeatSeconds !== undefined && state.HeartbeatSecondsPath !== undefined) {
        errors.push({
          message: `"${name}": HeartbeatSeconds et HeartbeatSecondsPath sont mutuellement exclusifs`,
          severity: vscode.DiagnosticSeverity.Error,
          searchKey: name,
        });
      }

      // ── R-12: HeartbeatSeconds must be < TimeoutSeconds ──────────────────
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

      // ── ProcessorConfig validation ────────────────────────────────────────
      if (state.Type === 'Map' && state.ItemProcessor) {
        const pc = (state.ItemProcessor as { ProcessorConfig?: { Mode?: string; ExecutionType?: string } }).ProcessorConfig;
        const mode = pc?.Mode ?? 'INLINE';
        const execType = pc?.ExecutionType;

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

        // INLINE concurrency > 40 warning
        if (mode === 'INLINE' && state.MaxConcurrency !== undefined && state.MaxConcurrency > 40) {
          errors.push({
            message: `"${name}": mode INLINE limité à 40 itérations concurrentes (MaxConcurrency: ${state.MaxConcurrency}) — passez en mode DISTRIBUTED pour dépasser cette limite`,
            severity: vscode.DiagnosticSeverity.Warning,
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
        // ── J-9: $$. context object path only in JSONPath ─────────────────
        // (checked in string fields below)
      }

      // ── J-2: Choice — Condition vs Variable per query language ───────────
      if (state.Type === 'Choice') {
        state.Choices?.forEach((c, i) => {
          if (jsonata) {
            if ((c as Record<string, unknown>).Variable !== undefined) {
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
