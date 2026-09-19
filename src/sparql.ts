/**
 * Builds the SPARQL updates that bring an endpoint in line with a turtle file.
 *
 * Two target shapes are supported, see {@link SparqlConfig}:
 *
 * - `graph-per-file` puts every file into its own named graph. The graph name
 *   is the delete key, so an update is `DROP GRAPH` + `LOAD`: exact, idempotent
 *   and cheap.
 * - `single-graph` puts every file into one shared graph that also holds data
 *   from other sources (e.g. Catalogue of Life). There is no graph to drop, so
 *   deletion has to be scoped by subject, which is only approximate — see
 *   {@link deleteOwnedStatement} and {@link sweepQuery}.
 */

interface CommonConfig {
  uploadUri: string;
  /**
   * Whether to derive the `tp:` prefix triples that taxomplete searches on.
   *
   * Independent of the mode: how the data is partitioned and what derived data
   * the consumer needs are separate questions. See {@link taxompleteStatements}.
   */
  taxompleteIndex: boolean;
}

/** One named graph per turtle file. */
export interface GraphPerFileConfig extends CommonConfig {
  mode: "graph-per-file";
  /** Graph names are `${graphUriPrefix}/${treatmentId}`. */
  graphUriPrefix: string;
}

/** All turtle files into one shared graph. */
export interface SingleGraphConfig extends CommonConfig {
  mode: "single-graph";
  /** The one graph everything goes into. Never dropped, never rebuilt. */
  targetGraph: string;
  /**
   * How the triples get in.
   *
   * - `load` makes the endpoint fetch the file over HTTP from this service,
   *   like `graph-per-file` does. Needs the endpoint to be able to reach us and
   *   to permit `LOAD` from an arbitrary uri, which managed endpoints often
   *   disable.
   * - `insert-data` pushes the file contents in the update itself. Works
   *   against any endpoint, at the cost of larger requests.
   */
  insertVia: "load" | "insert-data";
  /**
   * Namespace of the subjects a treatment file owns.
   *
   * Note this is NOT `graphUriPrefix`: gg2rdf writes subjects under
   * `http://treatment.plazi.org/id/...` while the graph names used by
   * `graph-per-file` are `https://treatment.plazi.org/id/...`. They are
   * different namespaces and are not interchangeable.
   */
  treatmentUriPrefix: string;
  /** Namespace of material citations, which also embed the treatment id. */
  materialCitationUriPrefix: string;
}

export type SparqlConfig = GraphPerFileConfig | SingleGraphConfig;

/** What happened to the file in the source repository. */
export type Action = "added" | "modified" | "removed";

/** `data/A8/2F/87/A82F87…FE91.ttl` → `A82F87…FE91` */
export function treatmentId(fileName: string) {
  return fileName.replace(/.*\//, "").replace(/\.ttl$/, "");
}

/**
 * The subjects a treatment file owns, i.e. that may be deleted when the file
 * changes or goes away.
 *
 * gg2rdf mints exactly two kinds of subject that carry the treatment id: the
 * treatment itself, and material citations under
 * `…/dwcaRecords/${id}.mc.${mcId}` or `…/id/${id}/${specimenCode}`. Everything
 * else it writes — publications, figures, taxon names, taxon concepts — is
 * derived from the content and is shared with other treatments, so it is only
 * ever added, never deleted here. {@link sweepQuery} collects those later.
 */
function ownedUriPrefixes(config: SingleGraphConfig, id: string) {
  const treatment = `${config.treatmentUriPrefix}/${id}`;
  return {
    treatment,
    prefixes: [
      // `…/id/${id}/${specimenCode}` material citations
      `${treatment}/`,
      // `…/id/${id}#section_1` etc. as written by the pre-gg2rdf pipeline
      `${treatment}#`,
      `${config.materialCitationUriPrefix}/${id}.mc.`,
    ],
  };
}

/**
 * Removes everything the treatment owns from the shared graph.
 *
 * Owned subjects other than the treatment are found by following the
 * treatment's outgoing links (`dwc:basisOfRecord` for material citations) and
 * keeping those in a namespace the treatment owns. That keeps the filter bound
 * to a handful of candidates rather than scanning the whole graph, which
 * matters when the graph also holds unrelated datasets.
 *
 * Two known limits, both by design:
 *
 * - It only follows one hop. gg2rdf's output is flat, so there is nothing
 *   deeper to reach.
 * - It reaches owned subjects through the *stored* treatment, so a material
 *   citation whose uri changed (e.g. because its specimenCode was corrected)
 *   is unlinked from the new treatment and stays behind.
 */
export function deleteOwnedStatement(
  config: SingleGraphConfig,
  fileName: string,
) {
  const { treatment, prefixes } = ownedUriPrefixes(
    config,
    treatmentId(fileName),
  );
  const ownedFilter = prefixes
    .map((p) => `STRSTARTS(STR(?owned), ${asLiteral(p)})`)
    .join("\n          || ");
  return `DELETE {
  GRAPH <${config.targetGraph}> { ?s ?p ?o }
} WHERE {
  GRAPH <${config.targetGraph}> {
    {
      BIND(<${treatment}> AS ?s)
      ?s ?p ?o
    } UNION {
      <${treatment}> ?link ?owned .
      FILTER(
        isIRI(?owned)
        && ( ${ownedFilter} )
      )
      BIND(?owned AS ?s)
      ?s ?p ?o
    }
  }
}`;
}

/**
 * Rewrites gg2rdf turtle into an `INSERT DATA` update.
 *
 * This is a lexical transformation rather than a parse-and-reserialise, which
 * is sound only because of two properties of gg2rdf's serialiser: it emits its
 * `@prefix` directives as one-per-line at the top of the file, and it writes
 * literals with `JSON.stringify`, so no literal ever contains a raw newline and
 * line-oriented processing cannot cut into one. Anything it does not recognise
 * makes this throw rather than produce a subtly wrong update.
 */
export function turtleToInsertData(turtle: string, graphUri: string) {
  const { prologue, operation } = insertData(turtle, graphUri);
  return [...prologue, operation].join("\n");
}

/**
 * The prologue is returned separately because a SPARQL update only takes one,
 * in front of every operation — `DELETE …; PREFIX … INSERT DATA …` is rejected.
 */
function insertData(turtle: string, graphUri: string) {
  const prologue: string[] = [];
  const body = turtle.replace(
    /^[ \t]*@prefix[ \t]+([^\s:]*:)[ \t]*(<[^>]*>)[ \t]*\.[ \t]*$/gm,
    (_match, prefix, iri) => {
      prologue.push(`PREFIX ${prefix} ${iri}`);
      return "";
    },
  );
  const leftoverDirective = body.match(/^[ \t]*@\w+.*$/m);
  if (leftoverDirective) {
    throw new Error(
      `Cannot convert turtle to an update, unsupported directive: ${
        leftoverDirective[0].trim()
      }`,
    );
  }
  return {
    prologue,
    operation: `INSERT DATA {
  GRAPH <${graphUri}> {
${body.trim()}
  }
}`,
  };
}

const TAXOMPLETE = "https://vocab.plazi.org/taxomplete/";
const TAXON_NAME = "http://filteredpush.org/ontologies/oa/dwcFP#TaxonName";
const DWC = "http://rs.tdwg.org/dwc/terms/";

/** The name parts taxomplete offers suggestions for, and the lengths it asks for. */
const INDEXED_PARTS = ["genus", "species"];
const PREFIX_LENGTHS = [2, 3, 4];

/** Subjects a gg2rdf file describes, as written by its serialiser: one uri per
 * line, at the start of the line. Same coupling as {@link turtleToInsertData}. */
export function subjectsIn(turtle: string) {
  return [...turtle.matchAll(/^<([^>]*)>[ \t]*$/gm)].map((match) => match[1]);
}

const TAXON_NAME_NAMESPACE = "http://taxon-name.plazi.org/id/";

/** The subjects of a gg2rdf file that can be taxon names, by namespace. Only
 * these can carry the index, so listing the others in a `VALUES` clause just
 * bloats the request. Typing is still checked in the update itself. */
export function taxonNamesIn(turtle: string) {
  return subjectsIn(turtle).filter((s) => s.startsWith(TAXON_NAME_NAMESPACE));
}

/**
 * Derives the lowercased 2, 3 and 4 character prefixes of every taxon name's
 * genus and species.
 *
 * taxomplete does not filter on these, it *matches* on them: a two character
 * input turns into `?sub tp:genusPrefix2 "sa"` with no regex fallback, so a
 * taxon name without them is invisible to the search rather than merely slower
 * to find. They therefore have to be maintained with the data, not after it.
 *
 * Writing them costs nothing in correctness: taxon name uris are derived from
 * the name itself, so a corrected genus produces a different uri rather than
 * mutating an existing one, and a prefix already in the store can never go
 * stale. Only new names ever need indexing.
 *
 * @param subjects Limits the update to these resources. Omit in graph-per-file
 * mode, where the graph holds one treatment and is already the scope.
 */
export function taxompleteStatements(graphUri: string, subjects?: string[]) {
  if (subjects?.length === 0) return [];
  const values = subjects
    ? `  VALUES ?res { ${subjects.map((s) => `<${s}>`).join(" ")} }\n`
    : "";
  // written with full iris rather than prefixed names so that this never has to
  // agree with the prologue of the turtle it is appended to
  return INDEXED_PARTS.flatMap((part) =>
    PREFIX_LENGTHS.map((length) =>
      `INSERT {
  GRAPH <${graphUri}> { ?res <${TAXOMPLETE}${part}Prefix${length}> ?prefix }
} WHERE {
${values}  GRAPH <${graphUri}> {
    ?res a <${TAXON_NAME}> ; <${DWC}${part}> ?value .
  }
  FILTER(STRLEN(?value) > ${length - 1})
  BIND(LCASE(SUBSTR(?value, 1, ${length})) AS ?prefix)
}`
    )
  );
}

/**
 * The updates to send for one changed file, in order. Callers should send them
 * as a single request where possible so that delete and insert stay atomic.
 */
export function statementsFor(
  config: SparqlConfig,
  fileName: string,
  action: Action,
  { fileUri, readFile }: {
    /** Http uri this service serves the file at. */
    fileUri: (fileName: string) => string;
    /** Contents of the file in the local working copy. */
    readFile: (fileName: string) => string;
  },
): string[] {
  if (config.mode === "graph-per-file") {
    const graphUri = `${config.graphUriPrefix}/${treatmentId(fileName)}`;
    const drop = `DROP GRAPH <${graphUri}>`;
    const load = `LOAD ${fileUri(fileName)} INTO GRAPH <${graphUri}>`;
    if (action === "removed") return [drop];
    // dropping the graph takes the derived triples with it, so they are simply
    // rebuilt after every load and can never go stale here
    const index = config.taxompleteIndex ? taxompleteStatements(graphUri) : [];
    const write = action === "added" ? [load] : [`${drop}; ${load}`];
    return index.length === 0 ? write : [[...write, ...index].join(";\n")];
  }

  const remove = deleteOwnedStatement(config, fileName);
  if (action === "removed") return [remove];
  // Note that added files are deleted first too, unlike in `graph-per-file`
  // mode where `LOAD` into a fresh graph is already idempotent. Here a replayed
  // commit range must not depend on the endpoint's current state.
  //
  // Both operations go into one request so that a file is never left half
  // removed if the endpoint drops the connection in between.
  // read even when loading by uri, because the index has to be scoped to the
  // resources this file describes and only the file itself lists them
  const turtle = config.insertVia === "insert-data" || config.taxompleteIndex
    ? readFile(fileName)
    : undefined;
  const { prologue, operation } = config.insertVia === "load"
    ? {
      prologue: [],
      operation: `LOAD ${fileUri(fileName)} INTO GRAPH <${config.targetGraph}>`,
    }
    : insertData(turtle!, config.targetGraph);
  const index = config.taxompleteIndex
    ? taxompleteStatements(config.targetGraph, taxonNamesIn(turtle!))
    : [];
  return [
    [...prologue, [remove, operation, ...index].join(";\n")].join("\n"),
  ];
}

/**
 * Namespaces the sweep is allowed to collect from.
 *
 * Deliberately only the two namespaces Plazi controls outright. Publications
 * and figures are shared too and also go stale, but they live under `doi.org`,
 * where another dataset in the same graph may legitimately describe the same
 * resource — and without per-triple provenance there is no way to tell whose
 * triples they are. There is at most one publication per article, so leaving
 * them is cheap; deleting someone else's data would not be.
 */
export const SWEEPABLE_NAMESPACES = [
  TAXON_NAME_NAMESPACE,
  "http://taxon-concept.plazi.org/id/",
];

function orphanPattern(namespaces: string[]) {
  const inNamespace = namespaces
    .map((ns) => `STRSTARTS(STR(?r), ${asLiteral(ns)})`)
    .join("\n      || ");
  return `    ?r ?p ?o .
    FILTER( ${inNamespace} )
    # nothing else in the graph — including data from other sources — refers to
    # it any more. Self-references (a taxon name is its own parent's parent
    # etc.) do not count as a referrer.
    FILTER NOT EXISTS { ?referrer ?referrerP ?r . FILTER(?referrer != ?r) }`;
}

/**
 * Deletes shared resources that no longer have a referrer.
 *
 * Needed because `single-graph` mode never deletes shared subjects when a
 * treatment changes or goes away: taxon names and concepts are reachable from
 * many treatments, and a treatment's own delete cannot tell whether it was the
 * last one. Instead they are collected afterwards, here.
 *
 * One pass only removes the currently unreferenced layer. Deleting a species
 * name orphans its genus, so this has to run until it stops finding candidates
 * — see {@link orphanCountQuery} and `src/sweep.ts`.
 */
export function sweepQuery(
  config: SingleGraphConfig,
  namespaces = SWEEPABLE_NAMESPACES,
) {
  return `DELETE {
  GRAPH <${config.targetGraph}> { ?r ?p ?o }
} WHERE {
  GRAPH <${config.targetGraph}> {
${orphanPattern(namespaces)}
  }
}`;
}

/** How many resources {@link sweepQuery} would collect on its next pass. */
export function orphanCountQuery(
  config: SingleGraphConfig,
  namespaces = SWEEPABLE_NAMESPACES,
) {
  return `SELECT (COUNT(DISTINCT ?r) AS ?orphans) WHERE {
  GRAPH <${config.targetGraph}> {
${orphanPattern(namespaces)}
  }
}`;
}

/** A SPARQL string literal. */
function asLiteral(s: string) {
  return JSON.stringify(s);
}
