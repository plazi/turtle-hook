/** Sending SPARQL to the configured endpoint. */

import { sparqlAuth } from "../config/config.ts";

function headers(contentType: string) {
  const result: Record<string, string> = { "Content-Type": contentType };
  if (sparqlAuth.user) {
    result["Authorization"] = `Basic ${
      btoa(`${sparqlAuth.user}:${sparqlAuth.password}`)
    }`;
  }
  return result;
}

/** Throws unless the endpoint accepted the update. */
export async function postUpdate(uploadUri: string, statement: string) {
  const response = await fetch(uploadUri, {
    method: "POST",
    body: statement,
    headers: headers("application/sparql-update"),
  });
  if (!response.ok) {
    throw new Error(`Got ${response.status}:\n` + await response.text());
  }
  // some endpoints keep the connection open until the body is consumed
  await response.body?.cancel();
}

/** Runs a SELECT and returns the bindings. */
export async function postQuery(uploadUri: string, query: string) {
  const response = await fetch(uploadUri, {
    method: "POST",
    body: query,
    headers: {
      ...headers("application/sparql-query"),
      "Accept": "application/sparql-results+json",
    },
  });
  if (!response.ok) {
    throw new Error(`Got ${response.status}:\n` + await response.text());
  }
  const json = await response.json();
  return json.results.bindings as Record<string, { value: string }>[];
}
