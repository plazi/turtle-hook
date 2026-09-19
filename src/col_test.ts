/**
 * Runs Catalogue of Life patches against an in-process store.
 *
 * The producer's contract is reproduced here in miniature: two sorted
 * N-Triples snapshots, a patch that is their set difference with the version
 * marker moved, and a manifest. The tests check that applying the patch turns
 * the one snapshot into the other exactly, that nothing else in the shared
 * graph is touched, and that an interrupted run can be repeated.
 */

import { assert, assertEquals, assertRejects, Store } from "./test_deps.ts";
import {
  applyPatch,
  COL_DATASET,
  loadSnapshot,
  markerLine,
  markerQuery,
  markerTag,
  moveMarkerStatement,
  patchChain,
  storedVersion,
  type Target,
} from "./col.ts";

const GRAPH = "https://example.org/plazi";
const TAXON = `${COL_DATASET}/taxon`;

const OLD = "2026-08-26";
const NEW = "2026-09-25";

/** A treatment's taxon name, which the Catalogue of Life data points at. */
const foreign = `INSERT DATA { GRAPH <${GRAPH}> {
  <http://taxon-name.plazi.org/id/Animalia/Saigona> a <http://filteredpush.org/ontologies/oa/dwcFP#TaxonName> .
} }`;

const sorted = (lines: string[]) => [...lines].sort();

/** Snapshot of the previous release: three name usages and the marker. */
const oldSnapshot = sorted([
  `<${TAXON}/8RHTH> <http://rs.tdwg.org/dwc/terms/scientificName> "Saigona" .`,
  `<${TAXON}/8RHTH> <http://rs.tdwg.org/dwc/terms/taxonRank> "genus" .`,
  `<${TAXON}/8RHTH> <http://www.w3.org/2002/07/owl#sameAs> <http://taxon-name.plazi.org/id/Animalia/Saigona> .`,
  `<${TAXON}/6W7J3> <http://rs.tdwg.org/dwc/terms/scientificName> "Saigona sinensis" .`,
  `<${TAXON}/6W7J3> <http://rs.tdwg.org/dwc/terms/parentNameUsageID> <${TAXON}/8RHTH> .`,
  `<${TAXON}/GONE1> <http://rs.tdwg.org/dwc/terms/scientificName> "Obsoleta nomen" .`,
  // escapes as the producer writes them: they must survive the round trip
  `<${TAXON}/GONE1> <http://rs.tdwg.org/dwc/terms/taxonRemarks> "line\\nbreak, \\"quotes\\", tab\\t, \\\\ backslash, \\u00E9" .`,
  markerLine(OLD),
]);

/** The next release: one usage gone, one changed, one new, marker moved. */
const newSnapshot = sorted([
  `<${TAXON}/8RHTH> <http://rs.tdwg.org/dwc/terms/scientificName> "Saigona" .`,
  `<${TAXON}/8RHTH> <http://rs.tdwg.org/dwc/terms/taxonRank> "genus" .`,
  `<${TAXON}/8RHTH> <http://www.w3.org/2002/07/owl#sameAs> <http://taxon-name.plazi.org/id/Animalia/Saigona> .`,
  `<${TAXON}/6W7J3> <http://rs.tdwg.org/dwc/terms/scientificName> "Saigona sinensis Ôuchi, 1940" .`,
  `<${TAXON}/6W7J3> <http://rs.tdwg.org/dwc/terms/parentNameUsageID> <${TAXON}/8RHTH> .`,
  `<${TAXON}/NEW01> <http://rs.tdwg.org/dwc/terms/scientificName> "Saigona nova" .`,
  `<${TAXON}/NEW01> <http://rs.tdwg.org/dwc/terms/parentNameUsageID> <${TAXON}/8RHTH> .`,
  markerLine(NEW),
]);

const removed = oldSnapshot.filter((l) => !newSnapshot.includes(l));
const added = newSnapshot.filter((l) => !oldSnapshot.includes(l));

const manifest = {
  from: OLD,
  to: NEW,
  removed: removed.length,
  added: added.length,
};

async function* lines(list: string[]) {
  for (const line of list) yield line;
}

const patch = {
  manifest,
  removed: () => lines(removed),
  added: () => lines(added),
};

/** A store holding the foreign triple and a target writing to it. */
function setup(batchSize = 1000) {
  const store = new Store();
  store.update(foreign);
  const statements: string[] = [];
  const target: Target = {
    graph: GRAPH,
    batchSize,
    update: (statement) => {
      statements.push(statement);
      store.update(statement);
      return Promise.resolve();
    },
    log: () => {},
  };
  return { store, target, statements };
}

/** The Catalogue of Life triples in the graph, as sorted N-Triples lines. */
function colLines(store: Store) {
  return (store.query(`SELECT ?s ?p ?o WHERE {
    GRAPH <${GRAPH}> { ?s ?p ?o }
    FILTER(STRSTARTS(STR(?s), "${COL_DATASET}"))
  }`) as Map<string, { toString(): string }>[])
    .map((b) => `${b.get("s")} ${b.get("p")} ${b.get("o")} .`)
    .sort();
}

/** The store writes non-ASCII characters raw where the producer may escape them. */
function unescaped(line: string) {
  return line.replace(
    /\\u([0-9A-Fa-f]{4})/g,
    (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** Asserts that the graph holds exactly this snapshot's triples. */
function assertSnapshot(store: Store, snapshot: string[]) {
  assertEquals(colLines(store), snapshot.map(unescaped));
}

function version(store: Store) {
  const bindings = store.query(markerQuery(GRAPH)) as Map<
    string,
    { value: string }
  >[];
  return storedVersion(
    bindings.map((b) => Object.fromEntries(b.entries())),
  );
}

async function bootstrapped(batchSize?: number) {
  const s = setup(batchSize);
  await loadSnapshot(s.target, lines(oldSnapshot));
  s.statements.length = 0;
  return s;
}

Deno.test("the marker line is recognised and nothing else is", () => {
  assertEquals(markerTag(markerLine(OLD)), OLD);
  assertEquals(markerTag(oldSnapshot[0]), undefined);
  assertEquals(
    markerTag(
      `<${TAXON}/X> <http://www.w3.org/2002/07/owl#versionInfo> "${OLD}" .`,
    ),
    undefined,
  );
});

Deno.test("a snapshot loads completely and ends with the marker", async () => {
  const { store, target, statements } = setup(3);
  const result = await loadSnapshot(target, lines(oldSnapshot));
  assertEquals(result.version, OLD);
  assertSnapshot(store, oldSnapshot);
  assertEquals(version(store), OLD);
  // 7 data lines in batches of 3, then the marker on its own
  assertEquals(statements.length, 4);
  assert(statements.at(-1)!.includes(markerLine(OLD)));
  assert(!statements.slice(0, -1).some((s) => s.includes("versionInfo")));
});

Deno.test("a snapshot without a marker is refused before the marker step", async () => {
  const { target } = setup();
  await assertRejects(
    () => loadSnapshot(target, lines(oldSnapshot.filter((l) => !markerTag(l)))),
    Error,
    "no version marker",
  );
});

Deno.test("an interrupted bootstrap resumes after the accepted batches", async () => {
  const { store, target, statements } = setup(2);
  const accepted: number[] = [];
  let fail = true;
  const flaky: Target = {
    ...target,
    update: (statement) => {
      if (fail && accepted.length === 2) {
        fail = false;
        return Promise.reject(new Error("connection reset"));
      }
      return target.update(statement);
    },
  };
  await assertRejects(
    () =>
      loadSnapshot(flaky, lines(oldSnapshot), {
        onBatch: (n) => {
          accepted.push(n);
        },
      }),
    Error,
    "connection reset",
  );
  assertEquals(version(store), undefined);
  const before = statements.length;
  await loadSnapshot(flaky, lines(oldSnapshot), { skipBatches: 2 });
  assertSnapshot(store, oldSnapshot);
  assertEquals(version(store), OLD);
  // 7 data lines in batches of 2 make 4 batches; 2 were skipped, plus the marker
  assertEquals(statements.length - before, 3);
});

Deno.test("applying the patch turns the old snapshot into the new one", async () => {
  const { store, target } = await bootstrapped();
  const result = await applyPatch(target, patch, OLD);
  assertEquals(result, { removed: removed.length, added: added.length });
  assertSnapshot(store, newSnapshot);
  assertEquals(version(store), NEW);
  // the foreign triple in the shared graph is untouched
  assert(
    store.query(
      `ASK { GRAPH <${GRAPH}> { <http://taxon-name.plazi.org/id/Animalia/Saigona> ?p ?o } }`,
    ),
  );
});

Deno.test("the patch is batched and the marker moves last, on its own", async () => {
  const { target, statements } = await bootstrapped(2);
  await applyPatch(target, patch, OLD);
  // removed: 3 data lines → 2 batches; added: 3 data lines → 2 batches; marker
  assertEquals(statements.length, 5);
  assert(statements[0].startsWith("DELETE DATA"));
  assert(statements[2].startsWith("INSERT DATA"));
  assertEquals(statements[4], moveMarkerStatement(GRAPH, OLD, NEW));
  assert(!statements.slice(0, 4).some((s) => s.includes("versionInfo")));
});

Deno.test("a patch for another version is refused without touching the store", async () => {
  const { store, target, statements } = await bootstrapped();
  await assertRejects(
    () => applyPatch(target, patch, "2026-01-10"),
    Error,
    "does not apply",
  );
  await assertRejects(
    () => applyPatch(target, patch, undefined),
    Error,
    "does not apply",
  );
  assertEquals(statements.length, 0);
  assertSnapshot(store, oldSnapshot);
});

Deno.test("patch files whose markers disagree with the manifest leave the marker alone", async () => {
  const { store, target } = await bootstrapped();
  await assertRejects(
    () =>
      applyPatch(target, {
        ...patch,
        added: () => lines(added.map((l) => l.replace(NEW, "2026-10-01"))),
      }, OLD),
    Error,
    "manifest says",
  );
  // the data went in, the marker did not: the store is re-applicable
  assertEquals(version(store), OLD);
  const ok = await applyPatch(target, patch, OLD);
  assertEquals(ok.added, added.length);
  assertSnapshot(store, newSnapshot);
});

Deno.test("a run that fails partway is applied again from the start", async () => {
  const { store, target, statements } = await bootstrapped(2);
  let calls = 0;
  const flaky: Target = {
    ...target,
    update: (statement) => {
      if (++calls === 3) {
        return Promise.reject(new Error("504 Gateway Timeout"));
      }
      return target.update(statement);
    },
  };
  await assertRejects(() => applyPatch(flaky, patch, OLD), Error, "504");
  // deletes went through, the store is between versions but still marked old
  assertEquals(version(store), OLD);
  assert(statements.length > 0);
  await applyPatch(flaky, patch, version(store));
  assertSnapshot(store, newSnapshot);
  assertEquals(version(store), NEW);
});

Deno.test("applying a patch twice is harmless", async () => {
  const { store, target } = await bootstrapped();
  await applyPatch(target, patch, OLD);
  // re-run the data part as an interrupted run would, on a store already at NEW
  await assertRejects(() => applyPatch(target, patch, NEW), Error);
  const replay = { ...patch, manifest: { ...manifest, from: NEW } };
  await assertRejects(
    () => applyPatch(target, replay, NEW),
    Error,
    "manifest says",
  );
  assertSnapshot(store, newSnapshot);
  assertEquals(version(store), NEW);
});

Deno.test("more than one marker in the store is an error, none is undefined", () => {
  assertEquals(storedVersion([]), undefined);
  assertEquals(storedVersion([{ tag: { value: OLD } }]), OLD);
  let threw = false;
  try {
    storedVersion([{ tag: { value: OLD } }, { tag: { value: NEW } }]);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("the chain of patches follows from/to, not tag order", () => {
  const releases = [
    { tag: "2026-09-07" }, // older format, no manifest
    { tag: "2026-08-26" }, // first release under the contract
    {
      tag: "2026-11-01",
      manifest: { from: "2026-10-05", to: "2026-11-01", removed: 0, added: 0 },
    },
    {
      tag: "2026-10-05",
      manifest: { from: "2026-09-25", to: "2026-10-05", removed: 0, added: 0 },
    },
    {
      tag: "2026-09-25",
      manifest: { from: "2026-08-26", to: "2026-09-25", removed: 0, added: 0 },
    },
  ];
  assertEquals(
    patchChain("2026-08-26", releases).map((r) => r.tag),
    ["2026-09-25", "2026-10-05", "2026-11-01"],
  );
  assertEquals(patchChain("2026-10-05", releases).map((r) => r.tag), [
    "2026-11-01",
  ]);
  assertEquals(patchChain("2026-11-01", releases), []);
  // a version no patch leads on from: nothing to do rather than a guess
  assertEquals(patchChain("2026-09-07", releases), []);
});
