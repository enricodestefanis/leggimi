# Markdown Viewer

Visualizzatore Markdown per Windows (sola lettura), costruito con Tauri 2. Estetica ispirata al viewer di Claude Cowork: colonna di lettura centrata, tema chiaro/scuro, tipografia curata.

## Funzionalità

- Rendering GitHub-flavored Markdown (tabelle, task list, strikethrough, autolink)
- Syntax highlighting dei blocchi di codice con pulsante copia
- Diagrammi **Mermaid** (bundle locale, funziona offline)
- **Indice** (TOC) cliccabile con scroll-spy
- **Albero dei file** .md della cartella del documento aperto
- **Ricarica automatica** quando il file cambia su disco, con scroll preservato
- Ricerca nel documento (`Ctrl+F`), tema chiaro/scuro, immagini relative
- Doppio click su un file `.md` in Esplora risorse (associazione registrata dall'installer)
- Istanza singola: i file successivi si aprono nella finestra esistente
- Drag & drop di file sulla finestra, `Ctrl+O` per il dialog di apertura

## Scorciatoie

| Tasti | Azione |
|---|---|
| `Ctrl+F` | Cerca nel documento |
| `Ctrl+O` | Apri file |
| `Ctrl+B` | Mostra/nascondi albero file |

## Sviluppo

Prerequisiti: Node 20+, Rust stable, WebView2 (preinstallato su Windows 11).

```powershell
npm install
npm run tauri dev        # sviluppo
npm run tauri build      # produce l'installer NSIS in src-tauri\target\release\bundle\nsis\
```

Nota: in dev Vite non applica la CSP configurata in `tauri.conf.json` — testare immagini/Mermaid anche nella build di produzione.

## Struttura

- `src/` — frontend TypeScript + Vite (markdown-it, highlight.js, DOMPurify, mermaid)
- `src-tauri/` — backend Rust: comandi per lettura file/albero, watcher con debounce (notify), single-instance, associazione file `.md`
- `samples/` — documenti di prova (`test-funzionalita.md` esercita tutte le funzionalità, `brief-esempio.md` è un documento di lavoro realistico)
- `private/` — cartella esclusa da git, per i tuoi documenti personali
