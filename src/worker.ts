import { GHActWorker, type Job } from "./deps.ts";
import { sparqlConfig } from "../config/config.ts";
import { type Action, statementsFor } from "./sparql.ts";
import { postUpdate } from "./endpoint.ts";

const fileUri = (fileName: string) =>
  `<http://${Deno.env.get("HOSTNAME")}:4505/workdir/repository/${fileName}>`;

const readFile = (fileName: string) =>
  Deno.readTextFileSync(`${_worker.gitRepository!.directory}/${fileName}`);

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

    log(`> got added    ${added}`);
    log(`> got removed  ${removed}`);
    log(`> got modified ${modified}`);
    log(`- target is ${sparqlConfig.mode} on ${sparqlConfig.uploadUri}`);

    const changes: { fileName: string; action: Action }[] = [
      ...added.map((f) => ({ fileName: f, action: "added" as const })),
      ...removed.map((f) => ({ fileName: f, action: "removed" as const })),
      ...modified.map((f) => ({ fileName: f, action: "modified" as const })),
    ];

    log(`- file count: ${changes.length}`);

    const failingFiles: string[] = [];
    let succeededOnce = false;

    for (const { fileName, action } of changes) {
      try {
        // built per file rather than up front so that a file we cannot even
        // turn into an update is reported like any other failing file
        const statements = statementsFor(sparqlConfig, fileName, action, {
          fileUri,
          readFile,
        });
        for (const statement of statements) {
          log(`» handling ${fileName}\n  ${statement}`);
          await postUpdate(sparqlConfig.uploadUri, statement);
        }
        succeededOnce = true;
        log("» success");
      } catch (error) {
        failingFiles.push(fileName);
        log(" » error:");
        log("" + error);
      }
    }

    log("< done");
    if (changes.length > 0 && !succeededOnce) {
      log(`All failed:\n ${failingFiles.join("\n ")}`);
      throw new Error(`All failed`);
    } else if (failingFiles.length > 0) {
      log(`Some failed:\n ${failingFiles.join("\n ")}`);
      return `Some failed: ${failingFiles.length} of ${changes.length} failed`;
    } else {
      log("All succeeded");
      return "";
    }
  },
);
