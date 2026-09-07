/**
 * Removes shared resources that no treatment refers to any more.
 *
 * Only relevant in `single-graph` mode: there, deleting a treatment only
 * removes the subjects that treatment owns, so taxon names and taxon concepts
 * survive their last referrer. This collects them.
 *
 * Not wired into the webhook on purpose. Each pass scans the target graph, and
 * on a shared endpoint that is a query you want to place deliberately rather
 * than have fire on every push. Leftovers are inert until then.
 *
 * Run it against a quiet endpoint — a treatment being inserted concurrently is
 * not yet a referrer of the taxon names it mentions, so a sweep running at the
 * same time can delete names that insert is about to link to.
 *
 *     deno run --allow-net --allow-env src/sweep.ts [--dry-run] [--max-passes=20]
 */

import { sparqlConfig } from "../config/config.ts";
import { orphanCountQuery, sweepQuery } from "./sparql.ts";
import { postQuery, postUpdate } from "./endpoint.ts";

if (import.meta.main) {
  if (sparqlConfig.mode !== "single-graph") {
    console.error(
      `Nothing to sweep: mode is '${sparqlConfig.mode}', where removing a file drops its graph.`,
    );
    Deno.exit(1);
  }

  const dryRun = Deno.args.includes("--dry-run");
  const maxPasses = Number.parseInt(
    Deno.args.find((a) => a.startsWith("--max-passes="))?.split("=")[1] ?? "20",
  );

  const count = orphanCountQuery(sparqlConfig);
  const sweep = sweepQuery(sparqlConfig);
  console.log(
    `Sweeping <${sparqlConfig.targetGraph}> at ${sparqlConfig.uploadUri}`,
  );

  let total = 0;
  for (let pass = 1; pass <= maxPasses; pass++) {
    const bindings = await postQuery(sparqlConfig.uploadUri, count);
    const orphans = Number.parseInt(bindings[0]?.orphans?.value ?? "0");
    if (orphans === 0) {
      console.log(`Pass ${pass}: nothing left to collect, ${total} removed.`);
      Deno.exit(0);
    }
    if (dryRun) {
      console.log(`Pass ${pass}: would remove ${orphans} resources (dry run).`);
      Deno.exit(0);
    }
    console.log(`Pass ${pass}: removing ${orphans} resources…`);
    await postUpdate(sparqlConfig.uploadUri, sweep);
    total += orphans;
    // deleting a species name orphans its genus, which orphans its family, …
    // so this converges from the leaves up and needs one pass per level
  }
  console.error(
    `Stopped after ${maxPasses} passes with candidates remaining; run again or raise --max-passes.`,
  );
  Deno.exit(1);
}
