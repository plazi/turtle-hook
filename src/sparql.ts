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

/** One named graph per turtle file. */
export interface GraphPerFileConfig {
  mode: "graph-per-file";
  uploadUri: string;
  /** Graph names are `${graphUriPrefix}/${treatmentId}`. */
  graphUriPrefix: string;
}

/** All turtle files into one shared graph. */
export interface SingleGraphConfig {
  mode: "single-graph";
  uploadUri: string;
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
    const graph = `<${config.graphUriPrefix}/${treatmentId(fileName)}>`;
    const drop = `DROP GRAPH ${graph}`;
    const load = `LOAD ${fileUri(fileName)} INTO GRAPH ${graph}`;
    if (action === "added") return [load];
    if (action === "removed") return [drop];
    return [`${drop}; ${load}`];
  }

  const remove = deleteOwnedStatement(config, fileName);
  if (action === "removed") return [remove];
  // Note that added files are deleted first too, unlike in `graph-per-file`
  // mode where `LOAD` into a fresh graph is already idempotent. Here a replayed
  // commit range must not depend on the endpoint's current state.
  //
  // Both operations go into one request so that a file is never left half
  // removed if the endpoint drops the connection in between.
  const { prologue, operation } = config.insertVia === "load"
    ? {
      prologue: [],
      operation: `LOAD ${fileUri(fileName)} INTO GRAPH <${config.targetGraph}>`,
    }
    : insertData(readFile(fileName), config.targetGraph);
  return [[...prologue, `${remove};`, operation].join("\n")];
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
  "http://taxon-name.plazi.org/id/",
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
