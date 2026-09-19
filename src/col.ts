/**
 * Applies Catalogue of Life releases as triple patches.
 *
 * The producer, `plazi/catologueoflife-to-rdf`, publishes every release with a
 * full snapshot and, from the second release on, a patch against the previous
 * one: the N-Triples removed and the N-Triples added, plus a manifest naming
 * the release it applies `from` and the one it leads `to`. The snapshot has no
 * blank nodes and name usage identifiers are stable across releases, which is
 * what makes a plain set difference of triples both minimal and exact — see
 * that repository's README for the contract.
 *
 * Nothing in here does I/O. The functions take the patch as async iterables of
 * N-Triples lines and the endpoint as a function, so that the tests can run
 * them against an in-process store and the I/O lives in `col_update.ts`.
 *
 * Every N-Triples line is embedded verbatim in a `DELETE DATA` or `INSERT
 * DATA` operation. That is sound because N-Triples' IRI and literal syntax,
 * escapes included, is a subset of SPARQL's, and because the contract rules
 * out blank nodes, which SPARQL would mint afresh in each request.
 */

/** Subject of the version marker, and the namespace of everything else. */
export const COL_DATASET = "https://www.catalogueoflife.org/data";
export const COL_TAXON_PREFIX = `${COL_DATASET}/taxon/`;
const OWL_VERSION_INFO = "http://www.w3.org/2002/07/owl#versionInfo";

/** `col-patch.json` as the producer writes it. */
export interface Manifest {
  from: string;
  to: string;
  /** Line counts of the two patch files, marker included. */
  removed: number;
  added: number;
}

/** The parts of a release this module cares about. */
export interface Release {
  tag: string;
  /** Absent on the first release under the contract, and on older ones. */
  manifest?: Manifest;
}

/** Where the triples go and how they get there. */
export interface Target {
  graph: string;
  /** Triples per request. Bounded by what the endpoint accepts in one go. */
  batchSize: number;
  update: (statement: string) => Promise<void>;
  log: (message: string) => void;
}

/** The marker triple as an N-Triples line, which is how it is matched. */
export function markerLine(tag: string) {
  return `<${COL_DATASET}> <${OWL_VERSION_INFO}> ${JSON.stringify(tag)} .`;
}

const MARKER = new RegExp(
  `^<${COL_DATASET}> <${OWL_VERSION_INFO}> "((?:[^"\\\\]|\\\\.)*)"\\s*\\.$`,
);

/** The tag if the line is the version marker, else `undefined`. */
export function markerTag(line: string) {
  return MARKER.exec(line)?.[1];
}

/** Reads the version marker, as a SPARQL SELECT with one column `tag`. */
export function markerQuery(graph: string) {
  return `SELECT ?tag WHERE {
  GRAPH <${graph}> { <${COL_DATASET}> <${OWL_VERSION_INFO}> ?tag }
}`;
}

/**
 * The stored version, from the bindings of {@link markerQuery}. More than one
 * marker means a previous run was interrupted in a way this code never
 * produces, so it is refused rather than guessed at.
 */
export function storedVersion(bindings: Record<string, { value: string }>[]) {
  const tags = bindings.map((b) => b.tag?.value).filter((t) => t !== undefined);
  if (tags.length > 1) {
    throw new Error(
      `More than one version marker in the store: ${tags.join(", ")}`,
    );
  }
  return tags[0];
}

/**
 * The releases to apply, in order, to get from `version` to the newest release
 * a chain of patches leads to. Empty if no published patch applies `from` the
 * stored version, which is also the case when the store is up to date.
 *
 * Follows `from`/`to` rather than tag order, so a release without a patch
 * (the first one under the contract, or older ones) never gets in the way.
 */
export function patchChain(version: string, releases: Release[]) {
  const chain: Release[] = [];
  const seen = new Set([version]);
  for (let current = version;;) {
    const next = releases
      .filter((r) => r.manifest?.from === current)
      .sort((a, b) => a.tag.localeCompare(b.tag))[0];
    if (!next) return chain;
    if (seen.has(next.manifest!.to)) {
      throw new Error(`Patches form a cycle at ${next.tag}`);
    }
    seen.add(next.manifest!.to);
    chain.push(next);
    current = next.manifest!.to;
  }
}

function dataOperation(
  kind: "DELETE DATA" | "INSERT DATA",
  graph: string,
  lines: string[],
) {
  return `${kind} {
  GRAPH <${graph}> {
${lines.join("\n")}
  }
}`;
}

/** Removes the `from` marker and writes the `to` marker, in one request. */
export function moveMarkerStatement(
  graph: string,
  from: string | undefined,
  to: string,
) {
  const insert = dataOperation("INSERT DATA", graph, [markerLine(to)]);
  if (from === undefined) return insert;
  return `${dataOperation("DELETE DATA", graph, [markerLine(from)])};
${insert}`;
}

export interface StreamOptions {
  /**
   * Batches already applied by an earlier, interrupted run. Only meaningful
   * for a bootstrap, where the batches are numbered from the same file; a
   * patch is small enough to simply start over.
   */
  skipBatches?: number;
  /** Called after each batch the endpoint accepted, with its number. */
  onBatch?: (batch: number) => void | Promise<void>;
}

/**
 * Sends the lines to the endpoint in batches, holding back the version marker.
 *
 * The marker is returned instead of written, so that the caller can move it in
 * a final request of its own once everything else is in: until then the store
 * still carries the previous version, and an interrupted run is re-applied
 * from the start.
 */
export async function streamLines(
  target: Target,
  kind: "DELETE DATA" | "INSERT DATA",
  lines: AsyncIterable<string>,
  { skipBatches = 0, onBatch }: StreamOptions = {},
) {
  let marker: string | undefined;
  let count = 0;
  let batches = 0;
  let batch: string[] = [];
  const flush = async () => {
    batches++;
    if (batches > skipBatches) {
      await target.update(dataOperation(kind, target.graph, batch));
      await onBatch?.(batches);
      target.log(`${kind} batch ${batches}: ${batch.length} triples`);
    }
    batch = [];
  };
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    count++;
    const tag = markerTag(line);
    if (tag !== undefined) {
      if (marker !== undefined) {
        throw new Error(`Two version markers in one file: ${marker}, ${tag}`);
      }
      marker = tag;
      continue;
    }
    batch.push(line);
    if (batch.length >= target.batchSize) await flush();
  }
  if (batch.length > 0) await flush();
  return { marker, count, batches };
}

/** How the patch lines are obtained; each call starts the file over. */
export interface Patch {
  manifest: Manifest;
  removed: () => AsyncIterable<string>;
  added: () => AsyncIterable<string>;
}

/**
 * Applies one patch to a store that holds exactly the release it applies from.
 *
 * Deletes first, then inserts, then moves the marker. Deleting a triple that is
 * absent and inserting one that is present are no-ops, so a run that failed
 * partway is simply applied again: the marker check at the start still passes
 * because the marker only moves in the last request.
 */
export async function applyPatch(
  target: Target,
  patch: Patch,
  version: string | undefined,
) {
  const { manifest } = patch;
  if (version !== manifest.from) {
    throw new Error(
      `Patch ${manifest.from} → ${manifest.to} does not apply to the stored version ${version}`,
    );
  }
  target.log(`Applying patch ${manifest.from} → ${manifest.to}`);
  const removed = await streamLines(target, "DELETE DATA", patch.removed());
  const added = await streamLines(target, "INSERT DATA", patch.added());
  // the files are checked against the manifest before the marker moves, so a
  // wrong or damaged file leaves the store re-applicable rather than half way
  if (removed.marker !== manifest.from || added.marker !== manifest.to) {
    throw new Error(
      `Patch files carry markers ${removed.marker} → ${added.marker}, manifest says ${manifest.from} → ${manifest.to}`,
    );
  }
  for (
    const [name, got, expected] of [
      ["removed", removed.count, manifest.removed],
      ["added", added.count, manifest.added],
    ] as const
  ) {
    if (got !== expected) {
      // not fatal: the gzip trailer already guards against truncation, and
      // whether the producer counts the marker line is not part of the contract
      target.log(
        `Warning: ${got} ${name} triples, manifest says ${expected}`,
      );
    }
  }
  await target.update(
    moveMarkerStatement(target.graph, manifest.from, manifest.to),
  );
  target.log(`Store is now at ${manifest.to}`);
  return { removed: removed.count, added: added.count };
}

/**
 * Loads a full snapshot into a store that holds no Catalogue of Life data.
 *
 * Only for bootstrapping: it does not remove anything, and it writes the
 * marker last, so a store with a marker was loaded completely.
 */
export async function loadSnapshot(
  target: Target,
  lines: AsyncIterable<string>,
  options: StreamOptions = {},
) {
  const { marker, count, batches } = await streamLines(
    target,
    "INSERT DATA",
    lines,
    options,
  );
  if (marker === undefined) {
    throw new Error("The snapshot has no version marker");
  }
  await target.update(moveMarkerStatement(target.graph, undefined, marker));
  target.log(
    `Loaded ${count} triples in ${batches} batches, store is at ${marker}`,
  );
  return { version: marker, count, batches };
}
