import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Shared whitelist assembly for release artifacts. Only explicitly listed inputs
// are copied: no local/ user data, no node_modules, no keys, no logs.
export function collectPackageFiles(root, appDirectory) {
  const resources = path.join(appDirectory, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const files = [];
  function copyFile(source, relative) {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Release input must be a regular file: ${source}`);
    const destination = path.join(resources, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    files.push({
      path: `app/resources/${relative.replaceAll("\\", "/")}`,
      sha256: createHash("sha256").update(fs.readFileSync(destination)).digest("hex"),
    });
  }
  function copyTree(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (fs.lstatSync(filename).isSymbolicLink())
        throw new Error(`Release input must not be a link: ${filename}`);
      if (entry.isDirectory()) copyTree(filename, path.join(relative, entry.name));
      else copyFile(filename, path.join(relative, entry.name));
    }
  }
  copyTree(path.join(root, "dist/web"), "web");
  // Business DDL only. The R1 probe migration is a development/verification
  // surface: it ships in the development tree and in tests, never in a release.
  for (const migration of [
    "versions/0001_initial.sql",
    "versions/0002_knowledge.sql",
    "versions/0003_knowledge_read.sql",
    "versions/0004_organization.sql",
    "versions/0005_qq_transport.sql",
    "versions/0006_qq_memory_sources.sql",
    "versions/0007_qq_observation_text.sql",
    "versions/0008_qq_memory_batch.sql",
    "versions/0009_qq_transport_config.sql",
    "versions/0010_qq_schemes.sql",
    "versions/0011_qq_speech_log.sql",
    "versions/0012_qq_media_notes.sql",
    "versions/0013_qq_scheme_triggers.sql",
    "versions/0014_qq_send_log.sql",
    "versions/0015_qq_scheme_rhythm.sql",
    "versions/0016_qq_context_budget.sql",
    "versions/0017_qq_scheme_prompts.sql",
    "versions/0018_qq_members.sql",
    "versions/0019_qq_output_reserve.sql",
    "versions/0020_qq_scheme_stickers.sql",
    "versions/0021_qq_stickers.sql",
    "versions/0022_qq_sticker_authorization.sql",
    "versions/0023_qq_dispatch.sql",
    "versions/0024_qq_media_purposes.sql",
    "versions/0025_desktop_settings.sql",
    "versions/0026_qq_media_supplement.sql",
    "versions/0027_qq_event_addressed.sql",
    "versions/0028_qq_immediate_lease.sql",
    "versions/0029_qq_module_switches.sql",
    "versions/0030_qq_sweep_verdicts.sql",
    "versions/0031_qq_attention.sql",
    "versions/0032_model_providers.sql",
    "versions/0033_qq_idle_judgements.sql",
    "versions/0034_qq_initiative_min_score.sql",
    "versions/0035_qq_reply_split.sql",
    "versions/0036_qq_judgement_reuse.sql",
    "versions/0037_qq_judgement_per_speaker.sql",
    "versions/0038_qq_judgement_model.sql",
    "versions/0039_agent_runs.sql",
    "versions/0040_conversation_wakes.sql",
    "versions/0041_outbound_intents.sql",
    "versions/0042_runtime_observability.sql",
  ]) {
    copyFile(path.join(root, "migrations", migration), path.join("migrations", migration));
  }
  const noticesRoot = path.join(root, "tools/installer/licenses");
  const noticeIndex = JSON.parse(
    fs.readFileSync(path.join(noticesRoot, "notice-sources.json"), "utf8"),
  );
  for (const notice of noticeIndex.components) {
    if (!/^[a-zA-Z0-9.-]+\.txt$/.test(notice.file)) throw new Error("Invalid license filename");
    const source = path.join(noticesRoot, notice.file);
    if (createHash("sha256").update(fs.readFileSync(source)).digest("hex") !== notice.sha256) {
      throw new Error(`License content changed: ${notice.file}`);
    }
    copyFile(source, path.join("licenses", notice.file));
  }
  copyFile(
    path.join(noticesRoot, "notice-sources.json"),
    path.join("licenses", "notice-sources.json"),
  );
  return files;
}

export function recordProgram(appDirectory, files) {
  const server = path.join(appDirectory, "superstring-server.exe");
  files.push({
    path: "app/superstring-server.exe",
    sha256: createHash("sha256").update(fs.readFileSync(server)).digest("hex"),
  });
  return server;
}

export function fileRecord(filename, relative) {
  return {
    path: relative,
    sha256: createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
  };
}

export function readPackageVersion(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`Invalid package version: ${version}`);
  return version;
}
