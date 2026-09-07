# Turtle-Hook

This updates a SPARQL-Endpoint to reflect the changes of the content of
RDF-Turtle files in a Github repository.

It uses [ghact](https://deno.land/x/ghact) to provide a webhook and a web/rest
interface.

## Configuration

Everything that differs between deployments is read from the environment, so the
same image can serve a private triple store and a shared one:

| Variable            | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `SPARQL_MODE`       | `graph-per-file` (default) or `single-graph`, see below      |
| `SPARQL_ENDPOINT`   | uri of the update endpoint                                   |
| `SPARQL_GRAPH`      | the one graph to write to — required in `single-graph` mode  |
| `SPARQL_INSERT_VIA` | `insert-data` (default) or `load` — `single-graph` mode only |
| `SPARQL_USER`       | credentials for the update endpoint, if it needs any         |
| `SPARQL_PASSWORD`   | set both or neither                                          |

Anything wrong or missing makes the container fail at startup rather than on the
first webhook. The uri namespaces in `config/config.ts` are not deployment
settings: they have to match what gg2rdf writes.

```yml
services:
  turtle-hook:
    image: ghcr.io/plazi/turtle-hook
    ports:
      - "4505:4505"
    environment:
      - SPARQL_MODE=single-graph
      - SPARQL_ENDPOINT=https://example.org/sparql
      - SPARQL_GRAPH=https://plazi.org/treatments
      - SPARQL_USER=plazi
      - SPARQL_PASSWORD=${SPARQL_PASSWORD}
      - GHTOKEN=${GHTOKEN}
    volumes:
      - turtle-hook:/workdir
volumes:
  turtle-hook:
```

Keep the password out of the compose file itself — the `${SPARQL_PASSWORD}` form
above takes it from the shell or from a `.env` file next to
`docker-compose.yml`.

The default `graph-per-file` deployment needs no SPARQL variables at all beyond
the endpoint:

```yml
services:
  turtle-hook:
    environment:
      - SPARQL_ENDPOINT=http://blazegraph:8080/blazegraph/sparql
      - GHTOKEN=${GHTOKEN}
```

## Target modes

### `graph-per-file`

Every turtle file gets its own named graph, `${graphUriPrefix}/${treatmentId}`.
The graph name is the delete key, so an update is `DROP GRAPH` followed by
`LOAD`: exact, idempotent, and cheap. Nothing else may live in those graphs.

### `single-graph`

Everything goes into one shared graph that may also hold data from other
sources. Use this for endpoints that host a limited set of graphs and cannot
take thousands of small ones.

There is no graph to drop, so deletion is scoped by subject instead, and is
deliberately incomplete:

- A treatment file owns the treatment itself and the material citations that
  carry its id. Those are deleted when the file changes or goes away.
- Publications, figures, taxon names and taxon concepts are derived from the
  content and shared with other treatments. A single treatment cannot tell
  whether it was the last referrer, so they are only ever added here.

`SPARQL_INSERT_VIA` chooses how the triples get in. `load` makes the endpoint
fetch the file from this service over HTTP, which needs the endpoint to be able
to reach us and to allow `LOAD` from an arbitrary uri — managed endpoints often
do not. `insert-data` pushes the content in the update itself and works
anywhere.

Credentials, if the endpoint needs any, come from `SPARQL_USER` and
`SPARQL_PASSWORD` and are sent as HTTP basic auth.

Note that the target graph is never rebuilt. Bootstrap it once with a bulk
import, record the commit, and run incrementally from there.

## Sweeping leftovers

Only needed in `single-graph` mode. Taxon names and taxon concepts that lost
their last referrer stay in the graph until they are collected:

```sh
docker exec turtle-hook deno run --allow-net --allow-env src/sweep.ts
```

`--dry-run` reports what it would remove without removing anything, and
`--max-passes=N` bounds the number of passes.

The query it runs, per pass:

```sparql
DELETE {
  GRAPH <TARGET> { ?r ?p ?o }
} WHERE {
  GRAPH <TARGET> {
    ?r ?p ?o .
    FILTER( STRSTARTS(STR(?r), "http://taxon-name.plazi.org/id/")
         || STRSTARTS(STR(?r), "http://taxon-concept.plazi.org/id/") )
    FILTER NOT EXISTS { ?referrer ?referrerP ?r . FILTER(?referrer != ?r) }
  }
}
```

Three things about it are deliberate:

- **It runs in passes.** Removing a taxon concept orphans its taxon name, which
  orphans its parent name, and so on; each pass only collects the layer that is
  currently unreferenced. `src/sweep.ts` repeats until nothing is left.
- **It only touches the two namespaces plazi controls.** Publications and
  figures also go stale, but they live under `doi.org`, where another dataset in
  the same graph may describe the same resource — and without per-triple
  provenance there is no way to tell whose triples they are. There is at most
  one publication per article, so leaving them costs little.
- **Any referrer protects a resource**, including one from another dataset. A
  taxon name that an external checklist points at is kept, and that protection
  propagates up the parent chain.

Each pass scans the target graph, so run it rarely and off-peak rather than on
every push — leftovers are inert until then. Run it against a quiet endpoint: a
treatment being inserted concurrently is not yet a referrer of the taxon names
it mentions, so a sweep running at the same time can delete names that insert is
about to link to.

## Development

```sh
deno test --allow-read --allow-net --allow-env src/
```

The tests run the generated updates against an in-process SPARQL engine, using
real gg2rdf output as a fixture.
