# TODO

## SAM — DefinitionUri vers fichier local

Dans un template SAM, `DefinitionUri` peut pointer vers un fichier local :

```yaml
Resources:
  MyMachine:
    Type: AWS::Serverless::StateMachine
    Properties:
      DefinitionUri: statemachine/my_machine.asl.json
```

Actuellement ignoré par le parser. Pour le supporter il faudrait :

1. Connaître le chemin du fichier template ouvert (pour résoudre le chemin relatif)
2. Lire le fichier `.asl.json` référencé — opération **async** (`vscode.workspace.fs.readFile`)

Or `AslParser.parse()` est synchrone. Ajouter un `readFile` dedans casserait toute la chaîne (linter, preview, diagnostics).

### Options

| Option | Complexité | Notes |
|--------|-----------|-------|
| Rendre `parse()` async | Élevée | Casse tout ce qui l'appelle |
| Résoudre **en amont** dans `extension.ts`, passer le contenu résolu à `parse()` | Moyenne | `parse()` reste sync — probablement le meilleur compromis |
| Détecter `DefinitionUri` et ouvrir via `vscode.workspace.openTextDocument` | Moyenne | Déclenche un second cycle de lint sur le fichier cible |

**Approche retenue :** option 2 — dans `extension.ts`, si le fichier ouvert est un template SAM avec `DefinitionUri` local, lire le fichier cible de façon async et le passer au linter/parser comme s'il était ouvert directement.
