# R138–R139 — `and`, `or` and the predicate that becomes an expression

<!-- status: built-caveat -->

**Built, with one criterion unmeasured rather than unmet — see §10 and the Owed table in
`docs/TASKS.md`.** Register: `docs/TASKS.md`. Boolean operators in path predicates —
`[price>100 and year<2000]`, `[@id or @name]`. The third of the three items the XPath sizing turned
up, after `docs/plans/R132-existence-predicates.md` and `docs/plans/R134-xml-namespaces.md`, and the
one R129 §11 named as *"the first thing anyone will ask for after `>` works"*.

**It is mostly routine, and it is not entirely.** Three things are more subtle than the feature
sounds, and each is the kind that ships wrong rather than fails loudly: `and` is a legal element
name and not hypothetically (§2); today's predicate parser is not a parser at all (§3); and
parentheses collide with a property `parse.ts` states about itself (§4). None is hard. All three
need deciding before code.

**This round also owns `not`**, which was planned as R133 and is dropped before implementation — see §6.

**Every question in this document is settled.**

---

## 1. The grammar being added

```
car[price>100 and year<2000]      both
car[@id or @name]                 either
car[not(@id) and price>100]       negation as an operand
car[(a or b) and c]               explicit grouping
```

Precedence follows XPath 1.0: **`or` binds looser than `and`**, and `not` binds tighter than both.
`[a or b and c]` is `[a or (b and c)]`.

## 2. `and` is a legal element name — and MathML actually has one

`NAME_CHAR` is `/[A-Za-z0-9_.:-]/`, so `and`, `or` and `not` are already valid names in this
grammar. That makes two readings of the same text:

| Query | Reading |
|---|---|
| `[and]` | existence — an element named `and` (R132) |
| `[price and year]` | `price` AND `year` — two existence tests |
| `[and and or]` | an element named `and` AND an element named `or` |

**This is not a contrived edge case.** MathML content markup defines `<and/>`, `<or/>` and `<not/>`
as elements. A document that would send someone reaching for boolean predicates is exactly the kind
that might contain them.

**XPath 1.0 has already solved this** and the rule is worth copying verbatim rather than inventing:
a name is read as an **operator** only when the preceding token is not `@`, `::`, `(`, `[`, `,` or
another operator — i.e. **operator position versus operand position**, decided by what came before,
not by the word itself. In NodePad's smaller grammar this reduces to: after a complete operand, a
bare name is an operator; anywhere an operand is expected, it is a name.

Get this wrong and `[and]` silently becomes a syntax error, or `[price and year]` silently becomes
existence on an element called `price` followed by junk. It needs its own tests, listed in §8.

## 3. `parsePredicateBody` is not a parser, and that is the actual work

Today it takes the **whole bracket content as a string**, trims it, regex-tests `/^\d+$/` for a
positional, and otherwise hands a `Cursor` to a single comparison parse. There is no token stream
and no notion of an operand, because until now a predicate has always been exactly one thing.

So R138 is not "add two operators to the parser". It is **replacing a pattern-match with a real
expression parser**, and that is the bulk of the round — the operators themselves are a precedence
table with two rows.

The existing pieces survive: `consumeName`, `consumeQuotedString`, the comparison parse and the
positional test all become *operand* productions rather than the whole body.

## 4. Parentheses, and the claim `parse.ts` makes about itself

The module states:

> *"No recursion: the grammar has no nesting (a flat step list, each step with at most one bracketed
> predicate), so a straightforward left-to-right scan covers it — there is no call-stack risk this
> needs guarding against the way a document parser's invariant 4 does, and none is added."*

Parentheses reintroduce genuine nesting, so that claim stops being true if they are added naïvely.
Two ways out:

**(a) No parentheses — precedence only.** Keeps the claim, and costs the ability to write
`[(a or b) and c]`. Rejected: that is a natural thing to want the moment `or` exists, and "you can't
group" is a limitation that gets rediscovered by every user rather than learned once.

**(b) Precedence climbing with an explicit operand/operator stack.** Chosen. Iterative by
construction, so arbitrary nesting costs heap rather than call stack and the module's claim stays
literally true — it just needs restating as *"no recursion, via an explicit stack"* rather than
*"no nesting"*. A depth cap with a diagnostic bounds a pathological paste (`[((((…))))]`); the
grammar is user-typed, but user-typed includes pasted and generated.

This is also the shape XPath's own expression parser needs later, so it is built once.

## 5. Positional operands are rejected

`[3 and @id]` in XPath means `boolean(3) and boolean(@id)` — the positional meaning **silently
evaporates**, because a number in boolean context is just truthy. That is surprising and useless.

A positional inside a boolean expression is a **parse error with a diagnostic** — `[3 and @id]`,
`[not(3)]`, and any other operand position. `[3]` alone keeps meaning what it means.

## 6. `not` is built here, and R133 is dropped

R133 planned `not(...)` as a **special form** in `docs/plans/R132-existence-predicates.md` — one
keyword, one nesting level, `not(not(…))` rejected — and its own text closed with:

> *"the day a second function is wanted, the right move is a function-call grammar that **subsumes**
> `not`, not a second special form."*

`and` and `or` are that day, and **nothing had been built when this was noticed**, so the special
form is never written rather than written and then deleted. **`not` is a unary operator in §4's
expression parser**, where it needs no depth limit, composes with parentheses for free, and shares
the operator/operand position rule of §2 (`not` is also a legal element name — MathML has
`<not/>` — so `[not]` is existence and `[not(@id)]` is negation, decided by whether a `(`
follows).

R133 stays allocated and dropped, per `CLAUDE.md`'s rule that a dropped id stays visible.

**R132's existence predicate is a dependency, not a competitor** — it is the *operand* `not`,
`and` and `or` combine. Build order below.

### Build order

R132 and this round touch the same function, so the order matters more than the id sequence does:

1. **§4's expression parser first**, replacing `parsePredicateBody`'s pattern-match, with R129's
   existing comparison and positional as its only operand productions. No new user-visible
   behaviour yet; every existing path-query test must pass unchanged, which is what proves the
   replacement is faithful.
2. **R132's existence operand** into it, as one more operand production rather than one more
   top-level case.
3. **`not` / `and` / `or` / parentheses**, which are then a precedence table and a unary case.

Doing R132 first against the *current* flat body also works and costs one small rewrite — its
semantics and its two evaluator loops survive either way. What must not happen is building R133's
special form, which survives neither.


## 7. R139 — evaluation

**The predicate becomes a small expression tree**, and `parse.ts`'s own comment needs one word
changed: it currently says the parser produces *"not an AST of objects per node (§6.6's
integer-compare argument, applied one level up from node data to query data)"*. A boolean tree **is**
an AST — but it is per *query*, a handful of objects, built once. §6.6's argument is about per-node
allocation and is untouched. Say so rather than leaving the comment contradicting the code.

`planComparison` generalises to a **plan tree**, built once per query exactly as today: leaves are
R129's `ComparisonPlan` (already monomorphic, already hoisting the operator to an integer and the
needle to bytes), internal nodes are `and` / `or` / `not`.

**Short-circuit per candidate, left to right, as written.** Do **not** reorder operands by estimated
cost. An `and` whose cheap term is written second stays second — a query whose performance depends
on an invisible reordering is one nobody can reason about, and the user can move the term themselves.
This is a deliberate non-optimization, recorded so it is not "fixed" later.

**R130's resumable loop is unchanged.** The state machine is over the *candidate array*; the tree
evaluates within a single candidate and cannot straddle a yield. Do not add a second chunking path.

## 8. Non-functional expectations

Boolean predicates are **cheaper than their parts suggest**, because `and` short-circuits work away:
a candidate failing the first term never evaluates the second. Worst case (`or` where both terms
run) is 2× R129's measured 17.5 ms over 400,000 candidates; the common case is less than the sum.

Nothing new is allocated per candidate: the tree is built once, leaves are the plans R129 already
measured, and evaluation returns a boolean rather than building intermediate sets. **Do not**
implement `and` as set intersection over two full evaluations — that allocates two candidate arrays
to answer a per-candidate question, which is the R131 mistake one level up.

## 9. Acceptance criteria

1. `car[price>100 and year<2000]` selects exactly the intersection; `car[@id or @name]` exactly the
   union, over a hand-checked fixture.
2. **`[and]` is existence on an element named `and`**, and `[and and or]` is "has an `and` child and
   an `or` child" — asserted on a MathML-shaped fixture containing `<and/>` and `<or/>` elements.
   This is §2, and it is the criterion most likely to fail.
3. `[a or b and c]` parses as `[a or (b and c)]`, asserted on a fixture where the two groupings give
   different answers — not on the parse tree alone.
4. `[(a or b) and c]` parses and differs from 3.
5. `[not(@id) and price>100]` works, and so does `not(not(@id))` — the expression parser has no
   depth limit, which is the concrete gain over the special form R133 would have been.
6. `[3 and @id]` produces a `PathDiagnostic` with an offset (§5), not a throw and not a silent
   truthy reading.
7. A pathological nesting depth produces a diagnostic rather than a stack overflow, asserted by
   generating the input rather than by reasoning about it.
8. An unbalanced `[a or (b]` produces a diagnostic with an offset pointing at the unclosed paren.
9. A boolean predicate over ≥400,000 candidates yields to the scheduler, inheriting R130's loop
   unchanged.
10. `and` short-circuits: a fixture where the second term would be expensive shows a boolean
    predicate costing **less** than the sum of its two terms measured separately.
11. **Every existing path-query test passes unmodified** after §6 step 1 replaces
    `parsePredicateBody`, before any new syntax is added. That is the check that the replacement is
    faithful, and it is worth running as its own commit.
12. **`car[not(price>100)]` includes a car with no `price` element at all**, while `car[price<=100]`
    excludes it — the pair `docs/plans/R132-existence-predicates.md` asserts half of, completed here.

## 10. Results

**Built, one criterion unmeasured (built-caveat) — see below.** `docs/plans/R132-existence-predicates.md`
landed in the same pass; §6's build order was followed except that R132's existence operand and this
round's expression-parser rewrite were implemented together rather than as three separate commits —
the code was reviewed and tested as one unit before its single commit, so the intent (a faithful
rewrite proven against the pre-existing grammar, with the new operators layered on top) is what
landed, even though the git history does not show three discrete steps.

**§2's operator/operand-position rule needed no separate lookback logic.** The expression parser
(`parseBooleanExpr`, `src/core/path/parse.ts`) already alternates between "expect an operand" and
"expect an operator" states (precedence climbing); `and`/`or`/`not` are only ever tested for in the
operator-expecting state (`matchesWord`), so `[and]` — reached in the operand-expecting state — goes
straight to `parseOperand` and is read as a subject name, never as a keyword. No special-casing was
needed beyond that structural fact, which is a cleaner outcome than the plan anticipated.

**§4's parentheses are an explicit operand/operator/paren-frame stack**, not recursion — `not(` is
represented as a paren frame tagged `negate: true`; closing it wraps whatever the parenthesized
expression produced in a `not` node, so `not` needed no separate code path beyond that one tag.
`MAX_PREDICATE_DEPTH = 64` bounds pathological nesting with a diagnostic (acceptance 7, tested by
generating 200 nested parens).

**§7's plan tree is built once per query and constant-folds.** `planPredicate`
(`src/core/path/evaluate.ts`) folds an unresolved subject through `and`/`or`/`not` at build time —
`not(price>100)` over a `price` name absent from the whole document becomes a single `const: true`
node, so every candidate passes with no store access at all, the same shortcut R129 §5/G7 already
gave a single absent name, generalized to a whole expression. The one resumable candidate loop
(`startPathStep`'s `advance`) is unchanged in shape; it now drives `evaluatePredicatePlan` over
whatever tree the query produced instead of a single `ComparisonPlan`, and the attribute-range
gallop hint is computed once per candidate regardless of how many leaves in the tree need it
(`planUsesAttributes`).

**All twelve acceptance criteria hold except acceptance 10, which is unmeasured** — recorded as an
Owed entry in `docs/TASKS.md` rather than silently marked done. Short-circuiting is real (native
`&&`/`||` in `evaluatePredicatePlan`, plus the build-time constant-folding above, which is a
*stronger* guarantee than runtime short-circuiting for the specific case the plan's example
describes) and is verified structurally in `test/pathEvaluate.test.ts`, but not wall-clock measured
against a fixture with an asymmetric-cost second term — every leaf in this engine already sits at
R129/R131's allocation-free floor, so there is no naturally "expensive" term to build such a fixture
from without measuring the fixture rather than the mechanism. See the Owed table for the full
reasoning.

**Review**: read as a diff against the ten invariants before commit (together with R132's, since
both land in the same commit — see that document's own Results section for the finding made and
fixed during that pass). No recursion over document input was introduced — `planPredicate` and
`evaluatePredicatePlan` recurse over the *parsed predicate*, which `MAX_PREDICATE_DEPTH` bounds at
parse time, not over document nodes. Acceptance 11 (every existing path-query test passes
unmodified) held throughout — the two pre-existing tests that failed once R132's existence operand
was added (`car[@id]`, `car[garbage]`) were exactly the ones R132 intentionally changes the meaning
of, and both are updated in `test/pathParse.test.ts` to assert the new behaviour rather than
adjusted to keep the old expectation passing.
