# Turtle-Hook

This updates a SPARQL-Endpoint to reflect the changes of the content of
RDF-Turtle files in a Github repository.

It uses [ghact](https://deno.land/x/ghact) to provide a webhook and a web/rest
interface.

## Configuration

Everything that differs between deployments is read from the environment, so the
same image can serve a private triple store and a shared one:

| Variable                | Meaning                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `SPARQL_MODE`           | `graph-per-file` (default) or `single-graph`, see below                      |
| `SPARQL_ENDPOINT`       | uri of the update endpoint                                                   |
| `SPARQL_GRAPH`          | the one graph to write to — required in `single-graph` mode                  |
| `SPARQL_INSERT_VIA`     | `insert-data` (default) or `load` — `single-graph` mode only                 |
| `SPARQL_USER`           | credentials for the update endpoint, if it needs any                         |
| `SPARQL_PASSWORD`       | set both or neither                                                          |
| `SPARQL_QUERY_ENDPOINT` | where SELECTs go, if not the update endpoint — see below                     |
| `COL_UPDATES`           | `true` to keep Catalogue of Life at the latest release, see below            |
| `COL_GRAPH`             | its graph — required in `graph-per-file` mode, not allowed in `single-graph` |
| `COL_BATCH_SIZE`        | triples per update request, default `10000`                                  |
| `COL_CHECK_INTERVAL`    | hours between checks for a new release, default `6`                          |

`SPARQL_QUERY_ENDPOINT` defaults to `SPARQL_ENDPOINT` with a trailing
`/statements` removed, which is where RDF4J and GraphDB answer queries. Set it
when your endpoint takes queries somewhere else.

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

## Catalogue of Life

The Catalogue of Life is loaded once and then kept current by patches, because a
release is tens of millions of triples and replacing them wholesale is not an
option on a shared endpoint. [plazi/catologueoflife-to-rdf] publishes every
release with a full snapshot and, from the second release on, a patch against
the previous release: the N-Triples that went away, the N-Triples that came, and
a manifest naming the release the patch applies `from` and leads `to`. The
contract is documented in that repository's README; this side implements the
consumer.

[plazi/catologueoflife-to-rdf]: https://github.com/plazi/catologueoflife-to-rdf

With `COL_UPDATES=true` the server checks the releases on startup and every
`COL_CHECK_INTERVAL` hours, and applies whatever patches lead on from the
version the store carries, one release after another. The same check runs by
hand:

```sh
docker exec turtle-hook deno run --allow-net --allow-env --allow-read --allow-write src/col_update.ts --dry-run
```

The store's own version marker is the only state:

```
<https://www.catalogueoflife.org/data> owl:versionInfo "2026-08-26" .
```

A patch is applied only when its `from` equals the marker, and the marker moves
in the last request, after all deletes and inserts went through. Deleting a
triple that is absent and inserting one that is present are no-ops, so a run
that fails partway is simply applied again from the start on the next check, and
two deployments at different versions each pick up exactly the patches they are
missing. The chain is followed by `from` and `to`, not by tag order, so releases
without a patch are never in the way.

Every request carries at most `COL_BATCH_SIZE` triples as plain `DELETE DATA` or
`INSERT DATA`, which any endpoint accepts and which stays well within a gateway
timeout. In `single-graph` mode the data lives in `SPARQL_GRAPH` next to the
treatments; in `graph-per-file` mode it gets a graph of its own, `COL_GRAPH`.
Either way it never overlaps with what the treatment jobs write, so the two can
run at the same time.

A store without a marker is never loaded automatically. Bootstrap it once:

```sh
docker exec turtle-hook deno run --allow-net --allow-env --allow-read --allow-write src/col_update.ts --bootstrap
```

This loads the newest release's snapshot in the same batches, writing the marker
last. Interrupted, it resumes after the last accepted batch when run again. It
refuses a store that already has a marker, and it does not remove anything: a
store that holds Catalogue of Life data from before the marker existed has to be
cleared by other means first.

Catalogue of Life triples that point at plazi taxon names protect them from the
sweep like any other referrer, and a patch that removes the last such link
merely leaves an orphan for the next sweep to collect.

## Development

```sh
deno test --allow-read --allow-net --allow-env src/
```

The tests run the generated updates against an in-process SPARQL engine, using
real gg2rdf output as a fixture.
