import { type Config } from "../src/deps.ts";
import { type SparqlConfig } from "../src/sparql.ts";

/*
 * Everything that differs between deployments comes from the environment, so
 * that the same image can serve a private triple store and a shared one. See
 * the README for a docker-compose example.
 *
 *   SPARQL_MODE        graph-per-file (default) | single-graph
 *   SPARQL_ENDPOINT    uri of the update endpoint
 *   SPARQL_GRAPH       the one graph to write to, single-graph mode only
 *   SPARQL_INSERT_VIA  insert-data (default) | load, single-graph mode only
 *   SPARQL_TAXOMPLETE_INDEX
 *                      true | false (default), in either mode: derive the
 *                      prefix triples taxomplete searches on
 *   SPARQL_QUERY_ENDPOINT
 *                      uri to send SELECTs to, if it differs from the update
 *                      endpoint (default: SPARQL_ENDPOINT without a trailing
 *                      /statements, which covers RDF4J and GraphDB)
 *   SPARQL_USER        credentials for the update endpoint, if it needs any
 *   SPARQL_PASSWORD
 *
 *   COL_UPDATES        true | false (default): keep the Catalogue of Life data
 *                      at the latest release, by applying the patches that
 *                      plazi/catologueoflife-to-rdf publishes
 *   COL_GRAPH          the graph holding the Catalogue of Life data — required
 *                      in graph-per-file mode, not allowed in single-graph mode
 *                      where it is SPARQL_GRAPH
 *   COL_BATCH_SIZE     triples per update request (default 10000)
 *   COL_CHECK_INTERVAL hours between checks for a new release (default 6)
 *   COL_RELEASES       GitHub repository whose releases carry the patches
 *                      (default plazi/catologueoflife-to-rdf)
 *
 * The uri namespaces below are not deployment settings: they have to match what
 * gg2rdf writes, and changing them would orphan everything already uploaded.
 * Since plazi/gg2rdf#33 that is `https://` throughout, for graph names and
 * subjects alike; a store loaded before the switch has to be renamed in place
 * first (README, "Migrating a store to https:// IRIs").
 */

function required(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function oneOf<T extends string>(name: string, options: T[], fallback: T): T {
  const value = Deno.env.get(name);
  if (!value) return fallback;
  if (!options.includes(value as T)) {
    throw new Error(
      `${name} must be one of ${options.join(", ")}, got ${value}`,
    );
  }
  return value as T;
}

const mode = oneOf(
  "SPARQL_MODE",
  ["graph-per-file", "single-graph"],
  "graph-per-file",
);

const taxompleteIndex =
  oneOf("SPARQL_TAXOMPLETE_INDEX", ["true", "false"], "false") === "true";

export const sparqlConfig: SparqlConfig = mode === "single-graph"
  ? {
    mode,
    taxompleteIndex,
    uploadUri: required("SPARQL_ENDPOINT"),
    targetGraph: required("SPARQL_GRAPH"),
    insertVia: oneOf(
      "SPARQL_INSERT_VIA",
      ["insert-data", "load"],
      "insert-data",
    ),
    // these are not the graph names used by graph-per-file below: they are
    // the subject uris gg2rdf writes (the same prefix, but a different role)
    treatmentUriPrefix: "https://treatment.plazi.org/id",
    materialCitationUriPrefix: "https://tb.plazi.org/GgServer/dwcaRecords",
  }
  : {
    mode,
    taxompleteIndex,
    uploadUri: Deno.env.get("SPARQL_ENDPOINT") ??
      "http://blazegraph:8080/blazegraph/sparql",
    // do not change this prefix, removing the previous version depends on this not changing
    graphUriPrefix: "https://treatment.plazi.org/id",
  };

/**
 * Where SELECTs go. RDF4J and GraphDB take updates on `…/statements` and
 * queries on the repository uri itself; most other endpoints use one uri for
 * both.
 */
export const sparqlQueryUri = Deno.env.get("SPARQL_QUERY_ENDPOINT") ??
  sparqlConfig.uploadUri.replace(/\/statements$/, "");

/** Sent as HTTP basic auth if set. */
export const sparqlAuth = {
  user: Deno.env.get("SPARQL_USER"),
  password: Deno.env.get("SPARQL_PASSWORD"),
};

if (!sparqlAuth.user !== !sparqlAuth.password) {
  throw new Error(
    "Both SPARQL_USER and SPARQL_PASSWORD are required, or neither",
  );
}

function positiveInt(name: string, fallback: number) {
  const value = Deno.env.get(name);
  if (!value) return fallback;
  const n = Number.parseInt(value);
  if (!(n > 0)) {
    throw new Error(`${name} must be a positive number, got ${value}`);
  }
  return n;
}

const colEnabled = oneOf("COL_UPDATES", ["true", "false"], "false") === "true";
const colGraph = Deno.env.get("COL_GRAPH");
if (sparqlConfig.mode === "single-graph" && colGraph) {
  throw new Error(
    "COL_GRAPH cannot be set in single-graph mode, everything goes into SPARQL_GRAPH",
  );
}
if (colEnabled && sparqlConfig.mode === "graph-per-file" && !colGraph) {
  throw new Error(
    "COL_GRAPH is required for COL_UPDATES in graph-per-file mode",
  );
}

/** See `src/col_update.ts`. */
export const colConfig = {
  enabled: colEnabled,
  graph: sparqlConfig.mode === "single-graph"
    ? sparqlConfig.targetGraph
    : colGraph ?? "",
  batchSize: positiveInt("COL_BATCH_SIZE", 10_000),
  checkInterval: positiveInt("COL_CHECK_INTERVAL", 6),
  releases: Deno.env.get("COL_RELEASES") ?? "plazi/catologueoflife-to-rdf",
};

export const ghActConfig: Config = {
  title: "Turtle-Hook",
  description: "Load RDF from plazi/treatments-rdf into our triple-store.",
  // we don't create commits, so a default job-author is not really neccesary
  email: "",
  sourceRepositoryUri: "https://git.ld.plazi.org/plazi/treatments-rdf.git",
  sourceBranch: "main",
  sourceRepository: "plazi/treatments-rdf",
  workDir: "/workdir",
};
