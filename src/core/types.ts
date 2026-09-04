/**
 * Klados — Format module contract
 * ================================
 *
 * This file is the specification, not a description of one. Every supported format
 * implements `FormatModule`, and nothing above the parser layer knows which format
 * produced a document.
 *
 * The claim this contract has to earn: "adding a format is only writing a parser."
 * If TOML (M6) requires changing anything outside its own module, the abstraction
 * has leaked — that is precisely why TOML is scheduled before YAML.
 *
 * See CONCEPT.md §2 (facets), §3 (architecture), §5.2 (incremental reparse),
 * §6.5 (interning).
 */

// ---------------------------------------------------------------------------
// Core value types
// ---------------------------------------------------------------------------

/**
 * Byte offset into the source buffer. Int32 throughout — this is what caps
 * addressable documents at ~2.1 GB (CONCEPT.md §11.2).
 */
export type Offset = number;

/** Index into the NodeStore's parallel arrays. Not an object. */
export type NodeRef = number;

export const enum NodeKind {
  Document = 0,
  Element,               // XML element
  Object,                // JSON/YAML map, TOML table
  Array,                 // JSON/YAML sequence, TOML array-of-tables
  Property,              // named member of an Object
  Scalar,                // leaf value
  Text,                  // XML character data
  CData,                 // XML <![CDATA[...]]> — text, but round-trips differently
  Comment,
  ProcessingInstruction,
  DocType,
}

export const enum Severity {
  Warning = 0,
  Error,
  Fatal,                 // parsing cannot continue past this point
}

export interface Diagnostic {
  readonly severity: Severity;
  readonly code: string;         // stable identifier, e.g. "xml.unclosed-tag"
  readonly offset: Offset;
  readonly length: number;
  /** Human-readable, already localized. Parsers do not format messages lazily. */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// NodeSink — where parsers emit
// ---------------------------------------------------------------------------

/**
 * Parsers push into a sink rather than yielding events.
 *
 * WHY: a pull-based iterator allocates one event object per node. At ~10 M nodes
 * for a 500 MB document that is ten million allocations and the GC pressure the
 * flat store exists to avoid. Every method here takes primitives only.
 *
 * WHY IT IS AN INTERFACE rather than the store directly: tests use a recording
 * sink, and the store stays swappable. The hot path is monomorphic in practice
 * because exactly one implementation is live per parse.
 *
 * CRITICAL: parsers pass byte offsets and never decode text. Interning, hashing
 * and namespace resolution are the sink's responsibility — it owns the buffer and
 * the intern table (§6.5). The parser's only job is finding boundaries.
 */
export interface NodeSink {
  /**
   * Open a node. `spanStart` is the first byte of the node's full extent
   * (for XML, the '<'). Pass `nameStart === nameEnd` for unnamed nodes —
   * array elements, text nodes, document roots.
   *
   * Must be matched by exactly one `closeNode`. Nesting is asserted in dev builds.
   */
  openNode(
    kind: NodeKind,
    spanStart: Offset,
    nameStart: Offset,
    nameEnd: Offset,
  ): NodeRef;

  /**
   * Emit an attribute (XML) or, for formats without attributes, nothing — see
   * `FormatCapabilities.hasAttributes`. Must be called after `openNode` and
   * before any child `openNode`.
   *
   * Namespace declarations (`xmlns`, `xmlns:*`) are emitted as ordinary
   * attributes; the sink recognizes and resolves them (§2).
   */
  attribute(
    nameStart: Offset,
    nameEnd: Offset,
    valueStart: Offset,
    valueEnd: Offset,
  ): void;

  /**
   * Scalar or text content for the currently open node. May be called more than
   * once for mixed content, in which case the sink records the node as mixed.
   */
  value(valueStart: Offset, valueEnd: Offset): void;

  /** Close the node, recording the end of its full extent (past the '>'). */
  closeNode(node: NodeRef, spanEnd: Offset): void;

  /** Never throws. Parsers report and continue wherever they can (§11.1). */
  diagnostic(d: Diagnostic): void;

  /**
   * Periodic progress signal for the UI, in bytes consumed. Call at coarse
   * intervals (~1 MB), not per node.
   */
  progress(bytesConsumed: Offset): void;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Static description of what a format supports. Read by the UI to decide what to
 * show — this is how "XPath only for XML" and "hide the attributes table for
 * JSON" are implemented without special-casing formats above the parser layer.
 */
export interface FormatCapabilities {
  readonly id: string;                    // "xml" | "json" | "toml" | "yaml"
  readonly displayName: string;
  readonly extensions: readonly string[]; // [".xml", ".xsd", ".svg"]

  /** Drives the scalar-facet table in the Detail view (§4.3). */
  readonly hasAttributes: boolean;
  readonly hasComments: boolean;
  readonly hasNamespaces: boolean;

  /** Whether `format()` is implemented (§5.7). */
  readonly canFormat: boolean;

  /**
   * Whether `parseRange` is implemented. When false, all edits fall back to a
   * full reparse (§5.2) and large-file editing will be correspondingly slow.
   */
  readonly canIncrementalReparse: boolean;

  /**
   * Preferred break bytes for the row index (§3.1) — the row builder scans
   * backward up to ~16 bytes for one of these before cutting at N.
   * XML: '>' ' '   JSON: ',' '}' ']'
   */
  readonly rowBreakBytes: readonly number[];
}

// ---------------------------------------------------------------------------
// Parse options and results
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /**
   * Explicit stack depth limit. Exceeding it produces a Fatal diagnostic rather
   * than a crash — deeply nested generated data is a real input (§3.3).
   */
  readonly maxDepth: number;

  /** Checked periodically. Cancellation must leave the sink in a valid state. */
  readonly signal?: AbortSignal;

  /**
   * Resolved encoding, decided before parsing by `detectEncoding`. Parsers work
   * on bytes and only need this for formats whose tokenization is encoding-
   * dependent (UTF-16 XML).
   */
  readonly encoding: string;
}

export interface ParseResult {
  /** False if cancelled or halted by a Fatal diagnostic — drives partial trees. */
  readonly complete: boolean;
  readonly bytesConsumed: Offset;
  readonly diagnosticCount: number;
}

/**
 * Format-specific state a parser needs in order to start mid-document:
 * XML's namespace scope stack, YAML's indentation level and anchor table.
 * Opaque above the parser layer.
 *
 * NOT stored per node — that would cost more than the node store itself at
 * 10 M nodes. Recomputed on demand by walking ancestors, which is cheap because
 * document depth is small even in enormous files.
 */
export interface ResumeContext {
  readonly formatId: string;
}

/** Read-only ancestor chain, root-first, passed to `resumeContextFor`. */
export interface AncestorView {
  readonly length: number;
  kindAt(i: number): NodeKind;
  spanStartAt(i: number): Offset;
  spanEndAt(i: number): Offset;
  /** Attributes of the ancestor, needed to rebuild XML namespace scope. */
  attributesAt(i: number): Iterable<{ name: string; value: string }>;
}

// ---------------------------------------------------------------------------
// FormatModule
// ---------------------------------------------------------------------------

export interface FormatModule {
  readonly capabilities: FormatCapabilities;

  /**
   * Confidence in 0..1 that this module should handle the document.
   * Extension match is a strong signal; content sniffing of the first non-
   * whitespace bytes ('<' → XML, '{'/'[' → JSON) is the fallback.
   * `head` is the first few KB, never the whole file.
   */
  detect(head: Uint8Array, filename: string | null): number;

  /**
   * Encoding declared by the document itself, or null to fall back to BOM
   * detection then UTF-8. XML's prolog declaration is authoritative over any
   * heuristic and must be honoured (§5.5).
   */
  detectEncoding(head: Uint8Array): string | null;

  /**
   * Full parse.
   *
   * MUST be iterative with an explicit operand stack. Recursive descent will
   * overflow on deeply nested input, which occurs in real generated data.
   *
   * MUST NOT throw for malformed input. Emit diagnostics and continue where the
   * grammar allows; a partial tree is more useful than an error screen (§11.1).
   */
  parse(source: Uint8Array, sink: NodeSink, options: ParseOptions): ParseResult;

  /**
   * Reparse a byte range known to contain one well-formed subtree, emitting into
   * a fresh sink for splicing (§5.2).
   *
   * The caller guarantees [start, end) covers a complete node. If the parser
   * finds otherwise it emits a Fatal diagnostic and returns complete: false,
   * and the caller falls back to a full reparse.
   *
   * Offsets emitted are absolute in `source`, not relative to `start`.
   */
  parseRange(
    source: Uint8Array,
    start: Offset,
    end: Offset,
    sink: NodeSink,
    context: ResumeContext,
    options: ParseOptions,
  ): ParseResult;

  /** Rebuild resume state from the ancestor chain. Cheap; depth is small. */
  resumeContextFor(ancestors: AncestorView): ResumeContext;

  /**
   * Conservative pretty-print (§5.7). Present only when `canFormat`.
   *
   * MUST preserve semantics: XML leaves mixed content byte-identical and honours
   * xml:space="preserve"; YAML never reflows block scalars. Partial formatting is
   * correct behaviour, not a limitation.
   */
  format?(source: Uint8Array, options: FormatOptions): Uint8Array;
}

export interface FormatOptions {
  readonly indent: string;      // "  " | "\t"
  readonly newline: '\n' | '\r\n';
}

// ---------------------------------------------------------------------------
// Deliberately NOT in this contract
// ---------------------------------------------------------------------------

/**
 * These are shared infrastructure, not per-format concerns. Pushing any of them
 * into FormatModule would mean reimplementing it four times and having them
 * drift:
 *
 *   Row indexing         — one shared pass over bytes, parameterized only by
 *                          `capabilities.rowBreakBytes`
 *   Name interning       — the sink owns the intern table so that ids are
 *                          comparable across the whole document (§6.5)
 *   Namespace resolution — the sink recognizes xmlns attributes and maintains
 *                          scope; parsers just emit attributes
 *   Comment attachment   — leading/trailing association is a shared rule (§5.3)
 *   Syntax token classes — derived from NodeKind, which is already unified
 *   Search indexing      — built from the intern table, format-agnostic
 */
