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
 *   SPARQL_USER        credentials for the update endpoint, if it needs any
 *   SPARQL_PASSWORD
 *
 * The uri namespaces below are not deployment settings: they have to match what
 * gg2rdf writes, and changing them would orphan everything already uploaded.
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

export const sparqlConfig: SparqlConfig = mode === "single-graph"
  ? {
    mode,
    uploadUri: required("SPARQL_ENDPOINT"),
    targetGraph: required("SPARQL_GRAPH"),
    insertVia: oneOf(
      "SPARQL_INSERT_VIA",
      ["insert-data", "load"],
      "insert-data",
    ),
    // note the http, and note that these are not the graph names used by
    // graph-per-file below: they are the subject uris gg2rdf writes
    treatmentUriPrefix: "http://treatment.plazi.org/id",
    materialCitationUriPrefix: "http://tb.plazi.org/GgServer/dwcaRecords",
  }
  : {
    mode,
    uploadUri: Deno.env.get("SPARQL_ENDPOINT") ??
      "http://blazegraph:8080/blazegraph/sparql",
    // do not change this prefix, removing the previous version depends on this not changing
    graphUriPrefix: "https://treatment.plazi.org/id",
  };

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
