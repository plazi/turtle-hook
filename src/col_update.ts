/**
 * Keeps the Catalogue of Life data in the store at the latest release.
 *
 * Polls the releases of the producer repository, and when a chain of patches
 * leads from the version the store carries to a newer release, applies them
 * one after another. The store's own version marker is the only state, so
 * this is safe to run from several places and after any interruption — see
 * `col.ts` for how.
 *
 * Runs on a schedule inside the server when `COL_UPDATES=true`, and from the
 * command line:
 *
 *     deno run --allow-net --allow-env --allow-read --allow-write src/col_update.ts [--dry-run]
 *     deno run ... src/col_update.ts --bootstrap [TAG]
 *
 * `--bootstrap` loads the full snapshot of a release into a store that has no
 * Catalogue of Life data yet, which is the one thing that never happens on its
 * own. Interrupted, it resumes where it stopped when run again.
 *
 * The treatment jobs and this never touch the same triples: everything here
 * is under `https://www.catalogueoflife.org/data`, and gg2rdf writes nothing
 * there. They can run at the same time.
 */

import { TextLineStream } from "./deps.ts";
import {
  colConfig,
  ghActConfig,
  sparqlConfig,
  sparqlQueryUri,
} from "../config/config.ts";
import { postQuery, postUpdate } from "./endpoint.ts";
import {
  applyPatch,
  loadSnapshot,
  type Manifest,
  markerQuery,
  patchChain,
  type Release,
  storedVersion,
  type Target,
} from "./col.ts";

const MANIFEST = "col-patch.json";
const REMOVED = "col-removed.nt.gz";
const ADDED = "col-added.nt.gz";
const SNAPSHOT = "col.ttl.gz";

type Assets = Map<string, { url: string; size: number }>;

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  assets: { name: string; browser_download_url: string; size: number }[];
}

function githubHeaders() {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  // the same token ghact clones with; unauthenticated calls are rate limited
  const token = Deno.env.get("GHTOKEN");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Published releases, with their assets. Drafts are still being uploaded. */
async function listReleases(): Promise<{ tag: string; assets: Assets }[]> {
  const response = await fetch(
    `https://api.github.com/repos/${colConfig.releases}/releases?per_page=100`,
    { headers: githubHeaders(), signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok) {
    throw new Error(
      `Listing releases of ${colConfig.releases} got ${response.status}: ${await response
        .text()}`,
    );
  }
  const releases: GitHubRelease[] = await response.json();
  return releases.filter((r) => !r.draft).map((r) => ({
    tag: r.tag_name,
    assets: new Map(
      r.assets.map((
        a,
      ) => [a.name, { url: a.browser_download_url, size: a.size }]),
    ),
  }));
}

async function fetchManifest(url: string): Promise<Manifest> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`Fetching ${url} got ${response.status}`);
  }
  const manifest = await response.json();
  for (const key of ["from", "to"]) {
    if (typeof manifest[key] !== "string") {
      throw new Error(`${url} has no "${key}"`);
    }
  }
  return manifest;
}

/**
 * Downloads to disk before anything is streamed from it. A download that sits
 * idle while a batch uploads gets dropped, and a dropped download hangs the
 * stream rather than failing it.
 */
async function download(url: string, size: number, file: string) {
  try {
    if ((await Deno.stat(file)).size === size) return;
  } catch {
    // not there yet
  }
  await Deno.mkdir(file.replace(/\/[^/]*$/, ""), { recursive: true });
  const partial = `${file}.part`;
  const response = await fetch(url, { signal: AbortSignal.timeout(1_800_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${url} got ${response.status}`);
  }
  const out = await Deno.open(partial, {
    write: true,
    create: true,
    truncate: true,
  });
  await response.body.pipeTo(out.writable);
  const got = (await Deno.stat(partial)).size;
  if (got !== size) {
    throw new Error(`Download of ${url} has ${got} bytes, expected ${size}`);
  }
  await Deno.rename(partial, file);
}

/** Lines of a gzipped text file. A truncated file fails on the gzip trailer. */
async function* gzipLines(file: string) {
  const handle = await Deno.open(file, { read: true });
  const lines = handle.readable
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  for await (const line of lines) yield line;
}

const dir = `${ghActConfig.workDir}/col`;

/** Up to three attempts per request, so a hiccup does not restart a whole patch. */
async function updateWithRetry(statement: string) {
  for (let attempt = 1;; attempt++) {
    try {
      return await postUpdate(sparqlConfig.uploadUri, statement);
    } catch (error) {
      if (attempt >= 3) throw error;
      console.error(`  request failed, retrying in 30s: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}

function target(log: (message: string) => void): Target {
  return {
    graph: colConfig.graph,
    batchSize: colConfig.batchSize,
    update: updateWithRetry,
    log,
  };
}

async function currentVersion() {
  return storedVersion(
    await postQuery(sparqlQueryUri, markerQuery(colConfig.graph)),
  );
}

let running: Promise<string> | undefined;

/**
 * One check: applies whatever patches lead on from the stored version. Returns
 * a one-line summary. Concurrent calls join the run in progress.
 */
export function updateCol(options: { dryRun?: boolean } = {}) {
  running ??= check(options).finally(() => running = undefined);
  return running;
}

async function check({ dryRun = false }) {
  const log = (message: string) => console.log(`[col] ${message}`);
  const version = await currentVersion();
  if (version === undefined) {
    return `no version marker in <${colConfig.graph}>: the store has to be bootstrapped, see src/col_update.ts --bootstrap`;
  }
  const published = await listReleases();
  const releases: Release[] = [];
  for (const { tag, assets } of published) {
    const manifest = assets.get(MANIFEST);
    releases.push({
      tag,
      manifest: manifest ? await fetchManifest(manifest.url) : undefined,
    });
  }
  const chain = patchChain(version, releases);
  if (chain.length === 0) {
    return `store is at ${version}, no patch leads on from there (${published.length} releases)`;
  }
  const tags = chain.map((r) => r.tag).join(", ");
  if (dryRun) return `store is at ${version}, would apply ${tags}`;
  log(`store is at ${version}, applying ${tags}`);
  for (const release of chain) {
    const assets = published.find((r) => r.tag === release.tag)!.assets;
    const files: Record<string, string> = {};
    for (const name of [REMOVED, ADDED]) {
      const asset = assets.get(name);
      if (!asset) throw new Error(`Release ${release.tag} has no ${name}`);
      files[name] = `${dir}/${release.tag}/${name}`;
      await download(asset.url, asset.size, files[name]);
    }
    await applyPatch(target(log), {
      manifest: release.manifest!,
      removed: () => gzipLines(files[REMOVED]),
      added: () => gzipLines(files[ADDED]),
    }, await currentVersion());
    await Deno.remove(`${dir}/${release.tag}`, { recursive: true });
  }
  return `applied ${tags}, store is at ${chain.at(-1)!.manifest!.to}`;
}

/**
 * Loads the snapshot of `tag` (default: the newest release) into a store
 * without Catalogue of Life data. Resumes an interrupted load of the same tag.
 */
export async function bootstrap(tag?: string) {
  const log = (message: string) => console.log(`[col] ${message}`);
  const version = await currentVersion();
  if (version !== undefined) {
    throw new Error(
      `The store is already at ${version}; bootstrap only loads into an empty store`,
    );
  }
  const published = await listReleases();
  const release = tag
    ? published.find((r) => r.tag === tag)
    : published.filter((r) => r.assets.has(SNAPSHOT))
      .sort((a, b) => b.tag.localeCompare(a.tag))[0];
  if (!release) throw new Error(`No release ${tag ?? "with a snapshot"}`);
  const asset = release.assets.get(SNAPSHOT);
  if (!asset) throw new Error(`Release ${release.tag} has no ${SNAPSHOT}`);
  const file = `${dir}/${release.tag}/${SNAPSHOT}`;
  const state = `${file}.batches`;
  log(`loading ${release.tag} into <${colConfig.graph}>`);
  await download(asset.url, asset.size, file);
  let skipBatches = 0;
  try {
    skipBatches = Number.parseInt(await Deno.readTextFile(state)) || 0;
    if (skipBatches > 0) log(`resuming after batch ${skipBatches}`);
  } catch {
    // first attempt
  }
  const result = await loadSnapshot(target(log), gzipLines(file), {
    skipBatches,
    onBatch: (batch) => Deno.writeTextFile(state, `${batch}\n`),
  });
  await Deno.remove(`${dir}/${release.tag}`, { recursive: true });
  return result;
}

/** Checks now, then every `colConfig.checkInterval` hours. */
export function scheduleColUpdates() {
  const run = async () => {
    try {
      console.log(`[col] ${await updateCol()}`);
    } catch (error) {
      console.error(`[col] update failed: ${error}`);
    }
  };
  run();
  setInterval(run, colConfig.checkInterval * 3_600_000);
}

if (import.meta.main) {
  const args = Deno.args.filter((a) => !a.startsWith("--"));
  const flags = Deno.args.filter((a) => a.startsWith("--"));
  for (const flag of flags) {
    if (flag !== "--dry-run" && flag !== "--bootstrap") {
      console.error(`Unknown option ${flag}`);
      Deno.exit(2);
    }
  }
  if (flags.includes("--bootstrap")) {
    await bootstrap(args[0]);
  } else {
    console.log(await updateCol({ dryRun: flags.includes("--dry-run") }));
  }
}
