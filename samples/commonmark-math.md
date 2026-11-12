# Math and line breaks, as on GitHub

One case per section, and what should show. GitHub is the reference: the
same text renders the same way there, except where a section says
otherwise. Nothing written here should ever disappear.

## Line breaks

A single line break is a space, as on GitHub:
these two lines read as one line of text.

Two spaces at the end of a line break it there  
(this line starts on its own).

So does a backslash at the end\
(this line starts on its own too).

## Display math

### A `$$` block between blank lines

$$
x^2 + y^2 = z^2
$$

### On one line

$$E = mc^2$$

### On one line, with spaces after the closing `$$`

The next line is a paragraph of its own, and the block after it is a
formula: nothing is swallowed.

$$E = mc^2$$   
This line comes after the formula.

$$
\sqrt{2}
$$

### Indented

  $$e^{i\pi} + 1 = 0$$

### Right after a line of text

The theorem
$$
a^2 + b^2 = c^2
$$
holds for right triangles. Leggimi shows the formula, as VS Code does;
GitHub shows these lines as text.

### Content on the opening or the closing line

$$ a + b
= c
$$

$$
a + b = c $$

### Text after the closing `$$`

The formula shows, and so does the text after it, in the same paragraph
(GitHub shows the first one as text):

$$
x + 1
$$ and this text stays.

$$y + 1$$ and so does this.

### Punctuation after the closing `$$`

where
$$
E = mc^2
$$,
and m is the mass.

### Inside a list item

- First item

  $$
  \int_0^1 x\,dx = \tfrac{1}{2}
  $$

- Second item
  $$
  y = 2
  $$
- Third item

### Inside a quote

> A quote
> $$
> z = 3
> $$
> and the quote goes on.

### Two blocks back to back

$$
\alpha
$$
$$
\beta
$$

### A blank line ends a formula

A formula holds no blank line, on GitHub neither: these four lines show as
written.

$$
a

b
$$

### `$$` in a code block stays code

```
$$
x
$$
```

## `$$` that is no math

### An unclosed `$$`

$$ 100 l'uno

This paragraph and the list below show as usual.

- one
- two

### Two `$$` with spaces inside

$$ 100 l'uno, oppure $$ 50 per due.

### In a list item

- $$ 100 l'uno
- second item
- third item, with $x$ math

### Empty

Empty $$$$ and $$ $$ show as written.

## Display math within a sentence

The famous $$E = mc^2$$ formula takes a line of its own, inside this
paragraph (GitHub keeps it within the line).

Two in a row: $$a$$ $$b$$

## Inline math

### Plain

Inline math like $E = mc^2$ and $\sqrt{a^2 + b^2}$ sits in the text.

### Spaces inside the dollars

As on GitHub, $ x + y $ (spaces inside) is text, and $x + y$ is math.

### Dollar amounts

- It costs $5 and $10 in total.
- Between $5 and $10, or $20.
- From US$5 to US$10; pay 5$ or 10$.
- With a space: costs $ 5 and $ 10.

### Escaped dollars

\$x\$ is text, and so is \$5 (GitHub shows the first as math).

### A dollar beside math

GitHub's way to write a dollar on a line with math: <span>$</span>5 for $n$
apples.

### `` $`…`$ ``

Backtick math $`\sqrt{2}`$, and $`\text{for all $\alpha$}`$, whose math
holds dollars of its own.

## Fenced math

```math
\frac{a}{b}
```

With words after `math` (GitHub ignores them, and so does Leggimi):

```math Fundamental theorem
\frac{d}{dx}\left( \int_{0}^{x} f(u)\,du\right) = f(x)
```

With tildes:

~~~math
\sum_{k=1}^{n} k = \frac{n(n+1)}{2}
~~~
