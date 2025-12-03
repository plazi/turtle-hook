import { GHActWorker, type Job } from "./deps.ts";
import { sparqlConfig } from "../config/config.ts";

const fileUri = (fileName: string) =>
  `<http://${Deno.env.get("HOSTNAME")}:4505/workdir/repository/${fileName}>`;

const graphUri = (fileName: string) =>
  `<${sparqlConfig.graphUriPrefix}/${
    fileName.replace(/.*\//, "").replace(/\.ttl$/, "")
  }>`;

const DROP = (fileName: string) => `DROP GRAPH ${graphUri(fileName)}`;

/* SPARQL A LA (note the .ttl and domains) `
LOAD <https://plazi.github.io/treatments-rdf/data/A8/2F/87/A82F87957F0CFFFFFF3E5EE3FB54FE91.ttl> INTO GRAPH <https://raw.githubusercontent.com/plazi/treatments-rdf/main/data/A8/2F/87/A82F87957F0CFFFFFF3E5EE3FB54FE91>
` */
const LOAD = (fileName: string) =>
  `LOAD ${fileUri(fileName)} INTO GRAPH ${graphUri(fileName)}`;

const UPDATE = (fileName: string) => `${DROP(fileName)}; ${LOAD(fileName)}`;

const _worker = new GHActWorker(
  self,
  async (job: Job, log): Promise<string> => {
    log(
      "Starting transformation\n" + JSON.stringify(job, undefined, 2),
    );

    let added: string[] = [];
    let modified: string[] = [];
    let removed: string[] = [];

    if ("files" in job) {
      modified = job.files.modified ?? [];
      if ("added" in job.files) added = job.files.added;
      if ("removed" in job.files) removed = job.files.removed;
    } else if (job.from) {
      const files = await _worker.gitRepository!.getModifiedAfter(
        job.from,
        job.till,
        log,
      );
      added = files.added;
      modified = files.modified;
      removed = files.removed;
      job.from = files.from;
      job.till = files.till;
    } else {
      throw new Error(
        "Could not start job, neither explicit file list nor from-commit specified",
      );
    }

    added = added.filter((f) => f.endsWith(".ttl"));
    removed = removed.filter((f) => f.endsWith(".ttl"));
    modified = modified.filter((f) => f.endsWith(".ttl"));

    log(`> got added    ${added}`); // -> LOAD
    log(`> got removed  ${removed}`); // -> DROP graphname
    log(`> got modified ${modified}`); // DROP; LOAD

    const statements = [
      ...added.map((f) => ({ statement: LOAD(f), fileName: f })),
      ...removed.map((f) => ({ statement: DROP(f), fileName: f })),
      ...modified.map((f) => ({ statement: UPDATE(f), fileName: f })),
    ];

    log(`- statement count: ${statements.length}`);

    const failingFiles: string[] = [];
    let succeededOnce = false;

    for (const { statement, fileName } of statements) {
      log(`» handling ${fileName}\n  ${statement}`);
      try {
        const response = await fetch(sparqlConfig.uploadUri, {
          method: "POST",
          body: statement,
          headers: { "Content-Type": "application/sparql-update" },
        });
        if (response.ok) {
          succeededOnce = true;
          log("» success");
        } else {
          throw new Error(
            `Got ${response.status}:\n` + await response.text(),
          );
        }
      } catch (error) {
        failingFiles.push(fileName);
        log(" » error:");
        log("" + error);
      }
    }

    log("< done");
    if (!succeededOnce) {
      log(`All failed:\n ${failingFiles.join("\n ")}`);
      throw new Error(`All failed`);
    } else if (failingFiles.length > 0) {
      log(`Some failed:\n ${failingFiles.join("\n ")}`);
      return `Some failed: ${failingFiles.length} of ${statements.length} failed`;
    } else {
      log("All succeeded");
      return "";
    }
  },
);
