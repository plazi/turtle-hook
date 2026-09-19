/**
 * Runs the generated updates against an in-process SPARQL engine.
 *
 * The point of these tests is the `single-graph` mode, where the plazi data
 * shares a graph with another dataset: they check that deleting a treatment
 * takes what it owns and nothing else, and that the sweep only collects
 * resources that really have no referrer left.
 */

import { assert, assertEquals, assertThrows, Store } from "./test_deps.ts";
import {
  deleteOwnedStatement,
  orphanCountQuery,
  type SingleGraphConfig,
  statementsFor,
  subjectsIn,
  sweepQuery,
  taxonNamesIn,
  treatmentId,
  turtleToInsertData,
} from "./sparql.ts";

const TARGET = "https://example.org/plazi";

const config: SingleGraphConfig = {
  mode: "single-graph",
  taxompleteIndex: false,
  uploadUri: "https://example.org/sparql",
  targetGraph: TARGET,
  insertVia: "insert-data",
  treatmentUriPrefix: "https://treatment.plazi.org/id",
  materialCitationUriPrefix: "https://tb.plazi.org/GgServer/dwcaRecords",
};

const A = "000040332F2853C295734E7BD4190F05";
const B = "111140332F2853C295734E7BD4190F99";

/** Real gg2rdf output, generated from the example document in that repo. */
const treatmentA = Deno.readTextFileSync(
  new URL(`../test-data/${A}.ttl`, import.meta.url),
);

/**
 * A second treatment of the same article, in the shape gg2rdf writes: it shares
 * the publication and every taxon name above the species with `treatmentA`, and
 * unlike A it cites a material citation, which it owns.
 */
const treatmentB = `@prefix dc: <http://purl.org/dc/elements/1.1/> .
@prefix dwc: <http://rs.tdwg.org/dwc/terms/> .
@prefix dwcFP: <http://filteredpush.org/ontologies/oa/dwcFP#> .
@prefix trt: <http://plazi.org/vocab/treatment#> .

<https://treatment.plazi.org/id/${B}>
    dc:title "Saigona testensis Zheng & Chen 2021, sp. nov." ;
    dwc:basisOfRecord <https://tb.plazi.org/GgServer/dwcaRecords/${B}.mc.1> ;
    trt:definesTaxonConcept <https://taxon-concept.plazi.org/id/Animalia/Saigona_testensis_Zheng_2021> ;
    trt:publishedIn <http://doi.org/10.3897/zookeys.1054.67004> ;
    a trt:Treatment .

<https://tb.plazi.org/GgServer/dwcaRecords/${B}.mc.1>
    dwc:catalogNumber "TEST-1" ;
    a dwc:MaterialCitation .

<https://taxon-concept.plazi.org/id/Animalia/Saigona_testensis_Zheng_2021>
    dwc:genus "Saigona" ;
    trt:hasTaxonName <https://taxon-name.plazi.org/id/Animalia/Saigona_testensis> ;
    a dwcFP:TaxonConcept .

<https://taxon-name.plazi.org/id/Animalia/Saigona_testensis>
    dwc:genus "Saigona" ;
    trt:hasParentName <https://taxon-name.plazi.org/id/Animalia/Saigona> ;
    a dwcFP:TaxonName .
`;

/**
 * Data from another source in the same graph. `sameAs` on the genus is what a
 * reconciliation against an external checklist looks like, and it must keep
 * that genus alive even once no plazi treatment refers to it.
 */
const foreignData = `PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
INSERT DATA {
  GRAPH <${TARGET}> {
    <https://www.catalogueoflife.org/data/taxon/8RHTH>
      rdfs:label "Saigona" ;
      owl:sameAs <https://taxon-name.plazi.org/id/Animalia/Saigona> .
  }
}`;

function newStore() {
  const store = new Store();
  store.update(foreignData);
  return store;
}

function insert(store: Store, fileName: string, turtle: string) {
  for (
    const statement of statementsFor(config, fileName, "added", {
      fileUri: () => `<http://irrelevant/${fileName}>`,
      readFile: () => turtle,
    })
  ) {
    store.update(statement);
  }
}

/** Subjects described in the target graph, sorted. */
function subjects(store: Store) {
  return (store.query(`SELECT DISTINCT ?s WHERE {
    GRAPH <${TARGET}> { ?s ?p ?o }
  }`) as Map<string, { value: string }>[])
    .map((b) => b.get("s")!.value)
    .sort();
}

function has(store: Store, subject: string) {
  return store.query(
    `ASK { GRAPH <${TARGET}> { <${subject}> ?p ?o } }`,
  ) as boolean;
}

Deno.test("treatmentId strips the path and extension", () => {
  assertEquals(treatmentId(`data/00/00/40/${A}.ttl`), A);
  assertEquals(treatmentId(`${A}.ttl`), A);
});

Deno.test("graph-per-file emits the statements it always has", () => {
  const graphPerFile = {
    mode: "graph-per-file",
    taxompleteIndex: false,
    uploadUri: "http://blazegraph:8080/blazegraph/sparql",
    graphUriPrefix: "https://treatment.plazi.org/id",
  } as const;
  const file = `data/00/00/40/${A}.ttl`;
  const sources = {
    fileUri: (f: string) => `<http://host:4505/workdir/repository/${f}>`,
    readFile: () => {
      throw new Error("must not read the file in graph-per-file mode");
    },
  };
  const drop = `DROP GRAPH <https://treatment.plazi.org/id/${A}>`;
  const load =
    `LOAD <http://host:4505/workdir/repository/${file}> INTO GRAPH <https://treatment.plazi.org/id/${A}>`;

  assertEquals(statementsFor(graphPerFile, file, "added", sources), [load]);
  assertEquals(statementsFor(graphPerFile, file, "removed", sources), [drop]);
  assertEquals(statementsFor(graphPerFile, file, "modified", sources), [
    `${drop}; ${load}`,
  ]);
});

Deno.test("turtleToInsertData accepts real gg2rdf output", () => {
  const store = new Store();
  store.update(turtleToInsertData(treatmentA, TARGET));
  assert(has(store, `https://treatment.plazi.org/id/${A}`));
  // the file describes the treatment, the publication, one taxon concept,
  // seven taxon names and five figures
  assertEquals(subjects(store).length, 15);
});

Deno.test("turtleToInsertData refuses what it cannot rewrite", () => {
  assertThrows(
    () => turtleToInsertData(`@base <http://example.org/> .\n`, TARGET),
    Error,
    "unsupported directive",
  );
});

Deno.test("deleting a treatment takes what it owns and nothing else", () => {
  const store = newStore();
  insert(store, `data/${A}.ttl`, treatmentA);
  insert(store, `data/${B}.ttl`, treatmentB);

  store.update(deleteOwnedStatement(config, `data/${B}.ttl`));

  // gone: the treatment and the material citation it owns
  assert(!has(store, `https://treatment.plazi.org/id/${B}`));
  assert(
    !has(store, `https://tb.plazi.org/GgServer/dwcaRecords/${B}.mc.1`),
    "material citations carry the treatment id and are owned",
  );

  // kept: the other treatment, everything shared, and the foreign dataset
  assert(has(store, `https://treatment.plazi.org/id/${A}`));
  assert(has(store, "http://doi.org/10.3897/zookeys.1054.67004"));
  assert(has(store, "https://taxon-name.plazi.org/id/Animalia/Saigona"));
  assert(has(store, "https://www.catalogueoflife.org/data/taxon/8RHTH"));

  // and the taxon name only B referred to is left behind — that is what the
  // sweep is for, a treatment's own delete cannot tell it was the last referrer
  assert(
    has(store, "https://taxon-name.plazi.org/id/Animalia/Saigona_testensis"),
  );
});

Deno.test("re-inserting a file is idempotent", () => {
  const store = newStore();
  insert(store, `data/${A}.ttl`, treatmentA);
  const before = store.size;
  for (
    const s of statementsFor(config, `data/${A}.ttl`, "modified", {
      fileUri: () => "<http://irrelevant>",
      readFile: () => treatmentA,
    })
  ) {
    store.update(s);
  }
  assertEquals(
    store.size,
    before,
    "replaying a commit range must not grow the graph",
  );
});

Deno.test("the sweep collects orphans, in layers, and stops at referenced ones", () => {
  const store = newStore();
  insert(store, `data/${A}.ttl`, treatmentA);
  insert(store, `data/${B}.ttl`, treatmentB);

  store.update(deleteOwnedStatement(config, `data/${A}.ttl`));
  store.update(deleteOwnedStatement(config, `data/${B}.ttl`));

  const count = () =>
    Number.parseInt(
      (store.query(orphanCountQuery(config)) as Map<
        string,
        { value: string }
      >[])[0].get("orphans")!.value,
    );

  let passes = 0;
  while (count() > 0) {
    store.update(sweepQuery(config));
    if (++passes > 20) throw new Error("sweep did not converge");
  }
  // a concept keeps its taxon name alive for one pass, so this cannot converge
  // in a single sweep — which is why src/sweep.ts loops
  assert(passes > 1, `expected several passes, got ${passes}`);

  // the concepts and species names only these treatments used are gone
  for (
    const gone of [
      "https://taxon-concept.plazi.org/id/Animalia/Saigona_baiseensis_Zheng_2021",
      "https://taxon-concept.plazi.org/id/Animalia/Saigona_testensis_Zheng_2021",
      "https://taxon-name.plazi.org/id/Animalia/Saigona_baiseensis",
      "https://taxon-name.plazi.org/id/Animalia/Saigona_testensis",
    ]
  ) {
    assert(!has(store, gone), `${gone} should have been swept`);
  }

  // the genus survives because the other dataset points at it, and that
  // protection propagates up the parent chain
  for (
    const kept of [
      "https://taxon-name.plazi.org/id/Animalia/Saigona",
      "https://taxon-name.plazi.org/id/Animalia/Dictyopharidae",
      "https://taxon-name.plazi.org/id/Animalia/Hemiptera",
      "https://taxon-name.plazi.org/id/Animalia",
      "https://www.catalogueoflife.org/data/taxon/8RHTH",
    ]
  ) {
    assert(has(store, kept), `${kept} must not be swept`);
  }

  // the publication is unreferenced now but lives under doi.org, which the
  // sweep deliberately leaves alone
  assert(has(store, "http://doi.org/10.3897/zookeys.1054.67004"));
});

const indexing: SingleGraphConfig = { ...config, taxompleteIndex: true };

/** The pattern taxomplete builds for a two character input. */
function suggest(store: Store, part: string, typed: string) {
  return (store.query(`SELECT DISTINCT ?value WHERE {
    GRAPH <${TARGET}> {
      ?sub <https://vocab.plazi.org/taxomplete/${part}Prefix${typed.length}> "${typed.toLowerCase()}" ;
           a <http://filteredpush.org/ontologies/oa/dwcFP#TaxonName> ;
           <http://rs.tdwg.org/dwc/terms/${part}> ?value .
    }
  }`) as Map<string, { value: string }>[]).map((b) => b.get("value")!.value)
    .sort();
}

function prefixesOf(store: Store, subject: string) {
  return (store.query(`SELECT ?p ?o WHERE {
    GRAPH <${TARGET}> { <${subject}> ?p ?o }
    FILTER(STRSTARTS(STR(?p), "https://vocab.plazi.org/taxomplete/"))
  }`) as Map<string, { value: string }>[])
    .map((b) =>
      `${
        b.get("p")!.value.replace("https://vocab.plazi.org/taxomplete/", "")
      }=${b.get("o")!.value}`
    )
    .sort();
}

Deno.test("subjectsIn finds what a gg2rdf file describes", () => {
  const found = subjectsIn(treatmentA);
  assertEquals(found.length, 15);
  assert(found.includes(`https://treatment.plazi.org/id/${A}`));
  assert(found.includes("https://taxon-name.plazi.org/id/Animalia/Saigona"));
});

Deno.test("taxonNamesIn keeps only the taxon name namespace", () => {
  const names = taxonNamesIn(treatmentA);
  assert(names.length > 0);
  assert(names.every((s) => s.startsWith("https://taxon-name.plazi.org/id/")));
  assert(names.includes("https://taxon-name.plazi.org/id/Animalia/Saigona"));
  assert(!names.includes(`https://treatment.plazi.org/id/${A}`));
});

Deno.test("the index VALUES clause lists only taxon names", () => {
  const [statement] = statementsFor(indexing, `data/${A}.ttl`, "added", {
    fileUri: () => "<http://irrelevant>",
    readFile: () => treatmentA,
  });
  const values = statement.match(/VALUES \?res \{([^}]*)\}/)![1];
  assert(values.includes("<https://taxon-name.plazi.org/id/Animalia/Saigona>"));
  assert(!values.includes("treatment.plazi.org"));
  assert(!values.includes("dwcaRecords"));
});

Deno.test("the index is off unless asked for, in both modes", () => {
  const sources = {
    fileUri: () => "<http://irrelevant>",
    readFile: () => treatmentA,
  };
  for (const action of ["added", "modified"] as const) {
    for (const c of [config, { ...config, insertVia: "load" as const }]) {
      assert(
        !statementsFor(c, `data/${A}.ttl`, action, sources)[0].includes(
          "taxomplete",
        ),
        `${c.insertVia} ${action} must not index unless enabled`,
      );
    }
  }
});

Deno.test("taxomplete triples are derived for the file's taxon names", () => {
  const store = newStore();
  for (
    const statement of statementsFor(indexing, `data/${A}.ttl`, "added", {
      fileUri: () => "<http://irrelevant>",
      readFile: () => treatmentA,
    })
  ) {
    store.update(statement);
  }

  // "Saigona" is 7 characters, so all three lengths apply; "baiseensis" too
  assertEquals(
    prefixesOf(
      store,
      "https://taxon-name.plazi.org/id/Animalia/Saigona_baiseensis",
    ),
    [
      "genusPrefix2=sa",
      "genusPrefix3=sai",
      "genusPrefix4=saig",
      "speciesPrefix2=ba",
      "speciesPrefix3=bai",
      "speciesPrefix4=bais",
    ],
  );

  // a taxomplete query for what a user typed now resolves
  assertEquals(suggest(store, "genus", "Sa"), ["Saigona"]);
  assertEquals(suggest(store, "species", "bai"), ["baiseensis"]);

  // ranks above genus carry no dwc:genus, so they get nothing
  assertEquals(
    prefixesOf(store, "https://taxon-name.plazi.org/id/Animalia/Insecta"),
    [],
  );
});

Deno.test("indexing is scoped to the file and stays idempotent", () => {
  const store = newStore();
  const run = (action: "added" | "modified") => {
    for (
      const statement of statementsFor(indexing, `data/${A}.ttl`, action, {
        fileUri: () => "<http://irrelevant>",
        readFile: () => treatmentA,
      })
    ) store.update(statement);
  };
  run("added");
  const size = store.size;
  run("modified");
  assertEquals(
    store.size,
    size,
    "replaying must not duplicate derived triples",
  );

  // scoped by VALUES: a taxon name from another file is left alone
  store.update(turtleToInsertData(treatmentB, TARGET));
  run("modified");
  assertEquals(
    prefixesOf(
      store,
      "https://taxon-name.plazi.org/id/Animalia/Saigona_testensis",
    ),
    [],
    "B's names are not this file's to index",
  );
});

Deno.test("graph-per-file rebuilds the index after each load", () => {
  const graphPerFile = {
    mode: "graph-per-file",
    taxompleteIndex: true,
    uploadUri: "http://irrelevant",
    graphUriPrefix: "https://treatment.plazi.org/id",
  } as const;
  const statements = statementsFor(graphPerFile, `data/${A}.ttl`, "modified", {
    fileUri: () => "<http://irrelevant>",
    readFile: () => {
      throw new Error(
        "graph-per-file scopes by graph, it must not read the file",
      );
    },
  });
  assertEquals(statements.length, 1, "one request keeps load and index atomic");
  // no VALUES: the per-treatment graph is already the scope
  assert(!statements[0].includes("VALUES"));
  assertEquals(statements[0].split("taxomplete/").length - 1, 6);
  // and removal needs no index at all
  assertEquals(
    statementsFor(graphPerFile, `data/${A}.ttl`, "removed", {
      fileUri: () => "<http://irrelevant>",
      readFile: () => "",
    }),
    [`DROP GRAPH <https://treatment.plazi.org/id/${A}>`],
  );
});

Deno.test("derived triples neither protect nor survive a swept name", () => {
  const store = newStore();
  for (
    const [file, turtle] of [[`data/${A}.ttl`, treatmentA], [
      `data/${B}.ttl`,
      treatmentB,
    ]] as const
  ) {
    for (
      const statement of statementsFor(indexing, file, "added", {
        fileUri: () => "<http://irrelevant>",
        readFile: () => turtle,
      })
    ) store.update(statement);
  }
  const species = "https://taxon-name.plazi.org/id/Animalia/Saigona_baiseensis";
  assert(prefixesOf(store, species).length > 0, "indexed to begin with");

  store.update(deleteOwnedStatement(indexing, `data/${A}.ttl`));
  store.update(deleteOwnedStatement(indexing, `data/${B}.ttl`));
  let passes = 0;
  while (
    Number.parseInt(
      (store.query(orphanCountQuery(indexing)) as Map<
        string,
        { value: string }
      >[])[0]
        .get("orphans")!.value,
    ) > 0
  ) {
    store.update(sweepQuery(indexing));
    if (++passes > 20) throw new Error("sweep did not converge");
  }

  // the prefix triples point away from the name, so they never made it look
  // referenced, and the sweep took them along with the rest of it
  assert(!has(store, species), "the orphaned name is gone");
  assertEquals(prefixesOf(store, species), [], "no dangling index entries");
  // the genus an external dataset points at keeps both its triples and its index
  assert(
    prefixesOf(store, "https://taxon-name.plazi.org/id/Animalia/Saigona")
      .length > 0,
  );
});
