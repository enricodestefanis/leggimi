# Test document — Leggimi

This document exercises every feature of the viewer.

## Basic formatting

Text in **bold**, *italic*, ~~strikethrough~~, `inline code` and an [external link](https://www.anthropic.com). Quotes like "these" and dashes -- are converted by the typographer.

> A blockquote with an accent border.
> Spanning several lines, to check the rendering.

## Table

| System | Role | Notes |
|---|---|---|
| Legacy PIM | Current system | To be retired |
| Akeneo | Target PIM | Already used by the group |
| Azure Service Bus | Middleware | Group integration layer |

## Task list

- [x] Tauri scaffolding
- [x] Rust backend
- [ ] Installer QA
- [ ] Release

## Code

```typescript
export async function openFile(path: string): Promise<void> {
  const doc = await readMarkdown(path);
  render(doc);          // outline + mermaid + file tree
}
```

```python
def migrate(products: list[dict]) -> None:
    """Migrate the catalog."""
    for p in products:
        print(f"SKU {p['sku']}")
```

## Valid Mermaid diagram

```mermaid
flowchart LR
    A[Legacy PIM] -->|extract| B(Azure staging)
    B --> C{Validation}
    C -->|ok| D[Akeneo]
    C -->|errors| E[Quality report]
```

## Invalid Mermaid diagram

```mermaid
flowchart LR
    A --> B -->
    this is not valid mermaid {{{
```

## Relative image

![Test image](./img/test.png)

## Nested folder

The [nested document](./nested/deeper.md) lives in a subfolder — open it to check that the
file browser keeps this folder as its root instead of jumping into `nested`.

## Math (KaTeX)

Inline math like $E = mc^2$ and $\sqrt{a^2 + b^2}$ sits in the text flow.

Display math gets its own centered block:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

A fenced `math` block works too:

```math
\frac{d}{dx}\left( \int_{0}^{x} f(u)\,du\right) = f(x)
```

A long formula should scroll sideways instead of breaking the layout:

$$
a_0 + \frac{1}{a_1 + \frac{1}{a_2 + \frac{1}{a_3 + a_4}}} = x_1 + x_2 + x_3 + x_4 + x_5 + x_6 + x_7 + x_8 + x_9 + x_{10} + x_{11} + x_{12}
$$

## Alert callouts

> [!NOTE]
> Useful information that users should know, even when skimming.

> [!TIP]
> Helpful advice for doing things better or more easily.

> [!IMPORTANT]
> Key information users need to know to achieve their goal.

> [!WARNING]
> Urgent info that needs immediate user attention to avoid problems.

> [!CAUTION]
> Advises about risks or negative outcomes of certain actions.

## Final section

Last section, to test the outline scroll-spy. Press `Ctrl+F` and search for "Akeneo" to try the find bar.
