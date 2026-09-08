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

`SPARQL_TAXOMPLETE_INDEX=true` additionally derives the prefix triples
[taxomplete](https://github.com/plazi/taxomplete) searches on — see below. It
works in either mode, because how the data is partitioned and what derived data
a consumer needs are separate questions.

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
      - SPARQL_TAXOMPLETE_INDEX=true
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

## The taxomplete index

taxomplete offers autocompletion of genus and species names. It does not filter
on the `tp:` prefix triples, it _matches_ on them: a two character input becomes
`?sub tp:genusPrefix2 "sa"` with no regex fallback, so a taxon name that lacks
them is invisible to the search rather than merely slower to find. They have to
be maintained with the data, not after it, which is what
`SPARQL_TAXOMPLETE_INDEX=true` does — six `INSERT`s appended to the same request
that writes the file, covering the lowercased 2, 3 and 4 character prefixes of
`dwc:genus` and `dwc:species` on every `dwcFP:TaxonName`.

Nothing has to keep them up to date afterwards. Taxon name uris are derived from
the name itself, so correcting a genus produces a _different_ uri rather than
mutating an existing one, and a prefix already in the store can never go stale.
Only new names ever need indexing.

How they are scoped differs by mode, and neither needs a scan of the whole
graph:

- `graph-per-file` scopes by the graph, which already holds exactly one
  treatment. `DROP GRAPH` takes the derived triples with it, so they are simply
  rebuilt after every load.
- `single-graph` scopes by a `VALUES` list of the subjects the file describes,
  read from the turtle. The file is read for this even when `SPARQL_INSERT_VIA`
  is `load`, since only the file lists them.

Derived triples point away from the taxon name, so they never make an orphan
look referenced, and a name collected by the sweep takes its index entries with
it.

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
