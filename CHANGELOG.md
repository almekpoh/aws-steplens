# Changelog

---

## [0.1.2] — 2026-04-19

### Added

**New linter rules**

- **Task without `Resource`** — Task states must have a `Resource`; missing field now reported as an error
- **Choice with `End` or `Next`** — these fields are forbidden at the Choice state level (transitions are expressed via `Choices[].Next` and `Default`)
- **`Version` validation** — only `"1.0"` is accepted when the field is present
- **`QueryLanguage` validation** — both definition-level and state-level `QueryLanguage` must be `"JSONata"` or `"JSONPath"`
- **Global `TimeoutSeconds`** — definition-level `TimeoutSeconds` validated in range 1–99999999
- **`Retry.IntervalSeconds` upper bound** — max 99999999 (lower bound ≥ 1 already existed)
- **`Retry.MaxDelaySeconds`** — validated in range 1–31622400
- **`Retry.MaxAttempts`** — must be ≥ 0
- **`Retry.JitterStrategy`** — must be `"FULL"` or `"NONE"`
- **`TimeoutSeconds` / `HeartbeatSeconds` upper bounds** — max 99999999 at state level
- **`Label` on INLINE Map** — warning when `Label` is set on a Map with `Mode: INLINE` (DISTRIBUTED-only field)
- **`ItemBatcher`, `ItemReader`, `ResultWriter` on INLINE Map** — warning for each DISTRIBUTED-only field used in `Mode: INLINE`
- **JSONata mode — Fail state path fields** — `ErrorPath` and `CausePath` are JSONPath-only; errors emitted in JSONata mode
- **JSONata mode — Map path fields** — `MaxConcurrencyPath`, `ToleratedFailureCountPath`, `ToleratedFailurePercentagePath` are JSONPath-only; errors emitted in JSONata mode
- **`Assign` in JSONPath mode** — `Assign` is a JSONata-only field; warning emitted in JSONPath mode
- **J-2 recursive** — `Variable` / `Condition` check now traverses `Not`, `And`, and `Or` boolean operators recursively
- **Timestamp RFC3339 recursive** — `TimestampEquals` and friends validated recursively through `Not`/`And`/`Or` branches

**Infrastructure**

- `onDidChangeConfiguration` handler — setting changes apply immediately: disabling `autoDetect` clears all diagnostics; toggling `lintOnType`/`lintOnSave` re-lints open files at once
- `@vscode/vsce` added to `devDependencies` (pinned version, no more floating `npx vsce`)
- CI Node matrix extended to `[18, 20, 22, 24]`
- CI lint job now includes a `tsc` type-check step

### Changed

- **R-23** severity upgraded from Warning → **Error**: `Mode: INLINE` with `MaxConcurrency > 40` is a hard AWS limit
- `lintOnType` description updated to mention the 200 ms debounce

### Fixed

- **`toGraphData` dangling edge** — `__START__ → StartAt` edge was created even when `StartAt` was not present in `States`, which could crash Cytoscape; now guarded
- **`Fail` / `Succeed` not connected to `__END__`** — only states with explicit `End: true` were wired to the End node; `Fail` and `Succeed` are terminal by definition and now always produce a `→ __END__` edge
- **`__END__` absent when only `Fail` / `Succeed` terminate the machine** — the End node was created only when `some(s => s.End)`; it is now created whenever any state is terminal (`End: true`, `Type: Fail`, or `Type: Succeed`)
- **`Fail` node label** — `Error` (or `Cause` if `Error` is absent) is now shown as a second line in the node label, giving instant context without navigating to the source
- **`preview.ts` goto handler** — replaced naive `String.includes()` match (could match `"A:"` inside `"arn:aws:lambda:::fn"`) with the same `^\s+(name|"name")\s*:` regex used by the linter
- **Webview JSON injection** — `JSON.stringify` does not escape `<`/`>`; added `safeJson` helper that replaces them with `\u003c`/`\u003e` to prevent `</script>` injection from state names
- **`deactivate()`** — debounce timer is now cleared on extension deactivation (no orphan callback)
- **Keystroke debounce** — lint and preview update are debounced at 200 ms; `updateSfnContext` (icon visibility) remains immediate
- **`reachableStates`** — removed a dead loop that pushed Parallel branch state names into the DFS stack; those names never resolved against `def.States` (branch states live in their own scope)

### Tests

- **212 unit tests** (up from 162) — full coverage for all new rules and bug fixes

---

## [0.1.1] — 2026-04-15

### Added
- **‖N** suffix in Parallel node labels — shows the number of branches at a glance
- **‖N** entry added to the in-graph legend
- **⊕** suffix in Map node labels when `ItemProcessor.ProcessorConfig.Mode: DISTRIBUTED`
- **⏸** suffix in Task node labels using `.waitForTaskToken`
- **🌐** suffix in Task node labels using `states:::http:invoke` (HTTP Task)
- `AslItemProcessor` interface with `ProcessorConfig` (Mode / ExecutionType) for distributed Map
- `AslRetryClause` interface with `MaxDelaySeconds` and `JitterStrategy` fields
- `Assign` field added to `AslCatchClause` and `AslChoiceBranch`
- New fields in `AslState`: `TimeoutSeconds`, `TimeoutSecondsPath`, `HeartbeatSecondsPath`, `Credentials`, `ResultSelector`, `ErrorPath`, `CausePath`, `SecondsPath`, `TimestampPath`, `Result`, `ItemsPath`, `Items`, `ItemSelector`, `MaxConcurrencyPath`, `ToleratedFailureCount/Percentage` (+ Path variants), `ItemReader`, `ResultWriter`, `ItemBatcher`, `Label`
- `TimeoutSeconds` and `Version` added to `AslDefinition`
- **R-11** — `TimeoutSeconds`/`TimeoutSecondsPath` and `HeartbeatSeconds`/`HeartbeatSecondsPath` mutual exclusion
- **R-12** — `HeartbeatSeconds` must be < `TimeoutSeconds`
- **R-13** — Fail state `Error`/`ErrorPath` and `Cause`/`CausePath` mutual exclusion
- **R-14** — Wait state must have exactly one timing field
- **R-15** — `States.ALL` in `ErrorEquals` must be alone and last (Catch + Retry)
- **R-16** — `States.DataLimitExceeded` and `States.Runtime` cannot be caught
- **R-17** — `ErrorEquals` must not be empty in Catch or Retry
- **R-18** — `ItemsPath` (JSONPath-only) / `Items` (JSONata-only) cross-mode validation
- **R-19** — `ToleratedFailurePercentage` must be 0–100
- **R-20** — `MaxConcurrency`/`MaxConcurrencyPath`, `ToleratedFailureCount*`, `ToleratedFailurePercentage*` mutual exclusion
- **R-21** — `ProcessorConfig.ExecutionType` required when `Mode: DISTRIBUTED`
- **R-22** — `ProcessorConfig.ExecutionType` ignored in `Mode: INLINE`
- **R-23** — `Mode: INLINE` with `MaxConcurrency > 40` suggests switching to DISTRIBUTED
- Distributed Map: `Label` length (max 40) and forbidden character validation
- Distributed Map + EXPRESS: `.waitForTaskToken` usage flagged as incompatible
- **R-24** — State name max 80 characters
- **R-25** — State name forbidden characters
- **W-2** — Choice state without `Default` warns of potential `States.NoChoiceMatched`
- **W-3** — `$states.errorOutput` used outside a Catch block (JSONata)
- **W-4** — `$states.context.Task.Token` outside `.waitForTaskToken` states
- **J-5** — `ResultSelector` flagged in JSONata mode
- **J-6** — `TimeoutSecondsPath`/`HeartbeatSecondsPath` flagged in JSONata mode
- **J-7** — `SecondsPath`/`TimestampPath` flagged in JSONata Wait state
- **J-8** — `States.*` intrinsic functions inside `{%…%}` JSONata expressions
- **J-9** — `$$.` Context Object JSONPath syntax in JSONata mode
- Deprecated `Iterator` warning: suggests migrating to `ItemProcessor`
- `BackoffRate < 1.0` validation in Retry clauses
- **55 unit tests** covering parser (all formats, all node annotations) and linter (all rules) — run with `npm test`
- GitHub Actions CI workflow: unit tests + ESLint on every push/PR, VSIX artifact on success
- `galleryBanner` (dark theme) and `pricing: "Free"` in `package.json`
- Preview image (`images/preview.svg`) added to README

---

## [0.1.0] — 2026-04-14

### Added
- Initial release
- Interactive Cytoscape.js graph preview with dagre layout
- Color-coded nodes by state type
- Click-to-navigate (node → editor line)
- Serverless Framework YAML support
- **Raw JSON ASL** format support (previously only YAML)
- Serverless Framework flat wrapper format: `{ definition: { StartAt, States } }`
- **Cursor-to-graph highlight** — moving the cursor in the editor highlights the corresponding node in the graph preview
- `steplens.isSfnFile` context key controls toolbar icon visibility
- **Real-time linter** with rules R-1 through R-8 and W-1
- Inline diagnostics (squiggly underlines) via `vscode.DiagnosticCollection`
- `steplens.lintOnType`, `steplens.lintOnSave`, `steplens.autoDetect` settings
- **JSONata Choice condition** support — `Condition: "{% … %}"` used as edge label instead of `Variable` path
- Choice node color: yellow diamond (was a plain rectangle)
- Catch edge labels show full `ErrorEquals` array
- **Hover tooltips** on linter underlines — shows error/warning message with `$(error)` / `$(warning)` icons
- **Status bar item** — displays `✓ StepLens`, `⚠ N alertes`, or `✗ N erreurs`; click to open the Problems panel
- **Sub-graph tabs** for Parallel branches and Map iterators — each branch opens in its own tab beside "Main"
- All Cytoscape instances initialised upfront with `visibility:hidden` (keeps real container dimensions, fixing the 0×0 sizing issue that caused empty sub-graph views)
- **Export** to PNG and JPEG via ⬇ PNG / ⬇ JPEG buttons in the graph toolbar
- **Map `ItemProcessor`** support — newer ASL format (SDK v2 / AWS Console export) used `ItemProcessor` instead of `Iterator`; sub-graph tabs now appear for both
- **Double-click** to navigate into Parallel / Map sub-graph tabs (was single-click)
- Hint text updated: "Double-click Parallel/Map to explore sub-graph"
- **R-9** — Map `Iterator` / `ItemProcessor` validation (recursive lint, like R-7 for Parallel)
- **R-10** — `MaxConcurrency: 0` warning on Map states (unlimited concurrency)
- **← Main** back button — appears automatically when viewing a sub-graph tab
- **⊡ Fit** button in toolbar — recenters the graph
- **State count** badge on each tab (`Main (8)`, `ProcessBatch — Iterator (4)`)
- **↺** suffix in node label for states that have `Retry` configured
- **×N** suffix in Map node labels for `MaxConcurrency` (`×∞` when 0)
- `Assign`, `MaxConcurrency`, `InputPath`, `OutputPath`, `QueryLanguage` added to `AslState` interface
- **J-1** — Detects wrong fields per query language: `Parameters`↔`Arguments`, `OutputPath`↔`Output`, `InputPath`, `ResultPath` in JSONata mode
- **J-2** — Choice branches: `Variable` vs `Condition` per mode; warns when `Condition` is missing `{%…%}` delimiters
- **J-3** — Validates every `{%…%}` expression: empty, unclosed delimiters, `$eval()`, JSONPath `$.` inside JSONata, trailing operator
- **J-4** — `$states.result` scope check: error when used in Pass, Choice, Wait, Succeed, or Fail states
- `QueryLanguage` per-state override supported (`AslState.QueryLanguage`)
- Parallel branches and Map iterators inherit parent `QueryLanguage` for recursive linting
- **Syntax highlighting** for `{% … %}` JSONata expressions inside YAML and JSON files (TextMate grammar injection — colors adapt to your theme)
- **Keybinding** `Ctrl+Alt+G` / `Cmd+Alt+G` to open the graph preview
- **CHANGELOG.md**

### Fixed
- Parser now handles the Serverless Framework *named wrapper* format (`machineName: { definition: { States } }`), which was silently ignored before — example files now parse and lint correctly
- JSON state name detection: line-finder regex now matches both `StateName:` (YAML) and `"StateName":` (JSON)
- Choice branch edge labels no longer show `b1`, `b2` when `Variable` path is available
- `Catch` edge labels now show the full error name (`States.ALL`, `States.TaskFailed`) — the `States.` prefix was incorrectly stripped
- Cursor highlight now works for states inside Parallel branches and Map iterators — `stateAtLine()` previously only searched top-level states
- Highlight color reverted to orange (`#f5a623`) — it had been changed to cyan to avoid a conflict with Choice yellow, but the user preferred orange
- Preview no longer dezoom on every keystroke — structural change detection sends a lightweight `update` message that preserves zoom/pan instead of rebuilding the full HTML
- Choice node color changed to yellow (`#ffe033`) — was the same orange as the cursor highlight, causing confusion
- Single-click on Parallel/Map nodes previously switched to the sub-graph tab — now requires **double-click** (single-click still jumps to the line in the editor)
- Node `goto` and `nodeToTab` lookup now use the node `id` (= state name), not the display label, so `↺`/`×N` suffixes don't break navigation

### Improved
- Description updated to reflect 14 linter rules
- Added `jsonata` and `workflow` keywords for Marketplace discoverability
