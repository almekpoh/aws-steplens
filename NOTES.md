# Notes internes — non publié

---

## TODO graphe

### Tooltip au survol des nœuds

Afficher un tooltip au hover sur **tous les nœuds**. Contenu selon le type :

| Type | Champs affichés |
|------|----------------|
| Task | `Resource` (ARN complet), `TimeoutSeconds`, `HeartbeatSeconds`, pattern (`.sync` / `.waitForTaskToken`) |
| Map | `MaxConcurrency`, mode INLINE/DISTRIBUTED, `ExecutionType` |
| Parallel | nombre de branches |
| Wait | `Seconds` ou `Timestamp` |
| Fail | `Error` + `Cause` (les deux — le label n'affiche qu'`Error`) |
| Choice | nombre de branches, `Default` défini ou non |
| Pass / Succeed | type uniquement si aucun champ notable |

**Mockup**

```
  ┌─────────────────────────────────────────┐
  │  ProcessOrder                     Task  │  ← nœud survolé
  └─────────────────────────────────────────┘
       │
       ▼
  ╔═════════════════════════════════════════╗
  ║  Resource                               ║
  ║  arn:aws:states:::lambda:invoke         ║
  ║  .waitForTaskToken                      ║
  ╟─────────────────────────────────────────╢
  ║  TimeoutSeconds    300                  ║
  ║  HeartbeatSeconds   60                  ║
  ╚═════════════════════════════════════════╝

  ┌────────────────────┐
  │  ProcessBatch  Map │
  └────────────────────┘
       │
       ▼
  ╔══════════════════════════╗
  ║  Mode          INLINE    ║
  ║  MaxConcurrency    5     ║
  ╚══════════════════════════╝

  ┌──────────────────────┐
  │  RouteOrder  Fail    │
  └──────────────────────┘
       │
       ▼
  ╔══════════════════════════════╗
  ║  Error    OrderNotFound      ║
  ║  Cause    No order with ID   ║
  ╚══════════════════════════════╝
```

**Approche suggérée** : bibliothèque [cytoscape-popper](https://github.com/cytoscape/cytoscape.js-popper) (Popper.js) ou tooltip CSS natif via `qtip2`. Ajouter le bundle dans `webview/vendor-entry.js`. Déclencher sur l'événement `mouseover` Cytoscape, masquer sur `mouseout`.

Alternative sans dépendance supplémentaire : div overlay positionné via `evt.renderedPosition` + offset, affiché/masqué en JS pur dans `preview.html`.

**Données à injecter** : étendre `GraphNode` dans `aslParser.ts` avec les champs utiles (`resource?`, `timeoutSeconds?`, etc.) et les passer dans `buildElements()` dans `preview.html`.

---
