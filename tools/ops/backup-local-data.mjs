// 受保护数据的一致性快照（运维工具，可重复执行）。
//
// 用法：node tools/ops/backup-local-data.mjs --out artifacts/backups/<名字> [--project <开发树>]
//
// 三件事必须同时成立，所以它们写在同一个工具里：
//   1. 运行中的 SQLite 不能靠拷文件备份——WAL 里还有未合并的内容，拷到一半的库可能不一致。
//      所以 .sqlite/.db 一律用 `VACUUM INTO` 生成单文件一致快照（只读源库，不修改它）。
//   2. 其余文件逐字节复制，复制的同时计算源字节 sha256，再从落盘副本重算一次比对——
//      "复制成功" 与 "副本和源一样" 是两件事。
//   3. 清单（路径/大小/时间/hash）与还原说明必须在副本里，否则一份没人能验证的备份等于没有备份。
//
// 本工具只读源目录、不打印任何文件内容；目标目录必须位于三个受保护目录之外。

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

/** 受保护目录；顺序即清单里的顺序，缺一个就记一条 absent，不报错。 */
const SOURCES = ["data", "local", "artifacts/state"];
const DATABASE_PATTERN = /\.(sqlite|sqlite3|db)$/i;

function fail(message) {
  console.error(`[backup] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { out: null, verify: null, project: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--out") options.out = argv[++index];
    else if (flag === "--verify") options.verify = argv[++index];
    else if (flag === "--project") options.project = argv[++index];
    else fail(`未知参数：${flag}`);
  }
  if (!options.out && !options.verify)
    fail("用法：node tools/ops/backup-local-data.mjs --out <目录>｜--verify <已存在的备份目录>");
  return options;
}

/** 清单里的源相对路径 → 副本路径（源目录名前缀换成带连字符的目标目录名）。 */
function copyPathFor(destinationRoot, sourceRelativePath) {
  const normalized = sourceRelativePath.split("\\").join("/");
  const source = SOURCES.find(
    (candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`),
  );
  if (!source) throw new Error(`清单里的路径不属于任何受保护目录：${sourceRelativePath}`);
  return join(destinationRoot, source.split("/").join("-"), normalized.slice(source.length));
}

/** 复核一份已存在的备份：重算全部副本哈希、再对库副本做完整性检查。 */
async function verify(destinationRoot) {
  const manifestPath = join(destinationRoot, "BACKUP-MANIFEST.json");
  if (!existsSync(manifestPath)) fail(`缺少 ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const failures = [];
  let checked = 0;
  for (const entry of manifest.files) {
    const path = copyPathFor(destinationRoot, entry.path);
    if (!existsSync(path)) {
      failures.push(`${entry.path}：副本缺失`);
      continue;
    }
    const hash = await sha256Of(path);
    if (hash !== entry.sha256) failures.push(`${entry.path}：sha256 不符`);
    if (statSync(path).size !== entry.copyBytes) failures.push(`${entry.path}：字节数不符`);
    checked += 1;
  }
  const sqlite = await loadSqlite();
  for (const entry of manifest.databases) {
    const path = copyPathFor(destinationRoot, entry.path);
    if (!existsSync(path)) {
      failures.push(`${entry.path}：库副本缺失`);
      continue;
    }
    const integrity = integrityOf(sqlite.Ctor, sqlite.readOnly, path);
    if (integrity !== "ok") failures.push(`${entry.path}：完整性检查 ${integrity}`);
    checked += 1;
    console.log(`[backup] 库副本 ${entry.path} 完整性 ${integrity}`);
  }
  console.log(
    `[backup] 复核完成：${checked} 项通过、${failures.length} 项失败（清单时间 ${manifest.createdAt}）`,
  );
  for (const failure of failures) console.error(`[backup] ${failure}`);
  if (failures.length > 0) process.exit(1);
}

function listFiles(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(directory);
  return files;
}

function sqlLiteral(path) {
  // SQLite 字符串里反斜杠不是转义符，但统一成正斜杠可以避免路径分隔符带来的歧义。
  return `'${path.split(sep).join("/").replaceAll("'", "''")}'`;
}

async function loadSqlite() {
  try {
    const nodeSqlite = await import("node:sqlite");
    return { Ctor: nodeSqlite.DatabaseSync, readOnly: { readOnly: true } };
  } catch {
    const bunSqlite = await import("bun:sqlite");
    return { Ctor: bunSqlite.Database, readOnly: { readonly: true } };
  }
}

function integrityOf(Ctor, readOnly, path) {
  const database = new Ctor(path, readOnly);
  try {
    const row = database.prepare("PRAGMA integrity_check").get();
    return Object.values(row ?? {})[0] ?? "unknown";
  } finally {
    database.close();
  }
}

/** 一致的数据库快照：只读打开源库、VACUUM INTO 到副本，再对副本做完整性检查。 */
function snapshotDatabase(Ctor, readOnly, source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  let database = new Ctor(source, readOnly);
  try {
    database.exec(`VACUUM INTO ${sqlLiteral(destination)}`);
  } catch (error) {
    database.close();
    // 少数构建下只读连接不给 VACUUM INTO；退化为普通连接，源库仍然只被读取。
    database = new Ctor(source);
    try {
      database.exec(`VACUUM INTO ${sqlLiteral(destination)}`);
    } finally {
      database.close();
    }
    const integrity = integrityOf(Ctor, readOnly, destination);
    return { method: "vacuum-into", integrity, note: String(error?.message ?? error) };
  }
  database.close();
  return { method: "vacuum-into", integrity: integrityOf(Ctor, readOnly, destination) };
}

/** 复制字节并同时算源 hash；返回源字节的 sha256，供落盘后复算比对。 */
async function copyFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const hash = createHash("sha256");
  const writer = createWriteStream(destination);
  await pipeline(async function* track() {
    for await (const chunk of createReadStream(source)) {
      hash.update(chunk);
      yield chunk;
    }
  }, writer);
  return hash.digest("hex");
}

async function sha256Of(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const RESTORE = `# 还原说明（本目录是受保护数据的一致性快照）

快照来自开发树的 \`data/\`、\`local/\`、\`artifacts/state/\`（即执行本工具时的开发树根目录）。
其中 \`.sqlite\` 由 \`VACUUM INTO\` 生成，是**已合并 WAL 的单文件库**；其余文件逐字节复制。

## 步骤

1. **停止实例**：结束桌面 \`superstring.exe\` 与开发 \`bun\` 服务，确认没有进程占用这三个目录。
2. **保留现场**：需要回退时，先把当前三个目录整体改名留档，不要直接覆盖后再找旧数据。
3. **覆盖还原**：
   - \`backup/data/\`    → \`dev/data/\`
   - \`backup/local/\`   → \`dev/local/\`
   - \`backup/artifacts-state/\` → \`dev/artifacts/state/\`
4. **清理残留**：删除 \`dev/data/*.sqlite-wal\` 与 \`*.sqlite-shm\`（快照已合并，残留的 WAL 会被误当作新写入）。
5. **校验**：
   - \`node tools/ops/backup-local-data.mjs --verify artifacts/backups/<本目录名>\`——
     重算全部副本 \`sha256\` 与字节数，并对库副本执行 \`PRAGMA integrity_check\`；
   - 或逐条比对 \`BACKUP-MANIFEST.json\` 的 \`sha256\` / \`bytes\`。
6. **启动复核**：启动实例，确认会话、记忆与素材正常；异常时回到第 2 步的留档。

## 注意

- 本目录只应存在于开发树内；它是受保护数据的副本，禁止导出、上传或放进任何公开产物。
- 快照不是持续同步：备份之后产生的新数据不在其中，需要更近的还原点时重新执行本工具。
- \`artifacts/state\` 中的 \`*.key\` 与 \`*.lock\` 一并复制；它们是实例凭据与锁标记，按真实数据对待。
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const project = resolve(options.project);
  if (options.verify) {
    await verify(resolve(project, options.verify));
    return;
  }
  const destinationRoot = resolve(project, options.out);

  for (const source of SOURCES) {
    const sourcePath = resolve(project, source);
    if (destinationRoot === sourcePath || destinationRoot.startsWith(sourcePath + sep))
      fail(`--out 不能位于受保护目录 ${source} 内部`);
  }
  if (destinationRoot.startsWith(project + sep) === false)
    fail(`--out 必须位于开发树内：${project}`);
  if (existsSync(destinationRoot) && readdirSync(destinationRoot).length > 0)
    fail(`${options.out} 已存在且非空；换一个名字，或在确认无用后手动清理`);

  const sqlite = await loadSqlite();
  const files = [];
  const databases = [];
  const absent = [];
  let totalBytes = 0;

  for (const source of SOURCES) {
    const sourcePath = resolve(project, source);
    if (!existsSync(sourcePath)) {
      absent.push(source);
      continue;
    }
    const targetName = source.split("/").join("-");
    for (const file of listFiles(sourcePath)) {
      const relativePath = relative(project, file).split(sep).join("/");
      // 副本布局 = <目标>/<源目录名>/<源目录内的相对路径>，与 RESTORE.md 一致（不再重复源前缀）。
      const destination = join(destinationRoot, targetName, relative(sourcePath, file));
      const size = statSync(file).size;

      if (DATABASE_PATTERN.test(file)) {
        const result = snapshotDatabase(sqlite.Ctor, sqlite.readOnly, file, destination);
        const copyBytes = statSync(destination).size;
        databases.push({ path: relativePath, bytes: size, copyBytes, ...result });
        totalBytes += copyBytes;
        continue;
      }
      // 被快照数据库的 -wal/-shm 不再单独复制：内容已在快照里，单独复制只会误导还原。
      if (/\.(sqlite|sqlite3|db)-(wal|shm)$/i.test(file)) continue;

      const sourceHash = await copyFile(file, destination);
      const copyHash = await sha256Of(destination);
      files.push({
        path: relativePath,
        bytes: size,
        copyBytes: statSync(destination).size,
        mtimeMs: Math.trunc(statSync(file).mtimeMs),
        sha256: sourceHash,
        verified: sourceHash === copyHash,
      });
      totalBytes += statSync(destination).size;
    }
  }

  const unverified = files.filter((entry) => entry.verified !== true);
  const manifest = {
    kind: "superstring-local-data-backup",
    createdAt: new Date().toISOString(),
    sources: SOURCES,
    absentSources: absent,
    databases,
    files,
    totals: { files: files.length, databases: databases.length, bytes: totalBytes },
  };
  writeFileSync(
    join(destinationRoot, "BACKUP-MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(destinationRoot, "RESTORE.md"), RESTORE, "utf8");

  const megabytes = (totalBytes / 1024 / 1024).toFixed(1);
  console.log(`[backup] 目标：${relative(project, destinationRoot).split(sep).join("/")}`);
  for (const entry of databases)
    console.log(
      `[backup] 数据库 ${entry.path}：${(entry.bytes / 1024 / 1024).toFixed(1)}MB → 快照完整性 ${entry.integrity}`,
    );
  console.log(
    `[backup] 文件 ${files.length} 个、数据库 ${databases.length} 个，共 ${megabytes}MB；校验失败 ${unverified.length} 个`,
  );
  if (absent.length > 0) console.log(`[backup] 不存在的源目录：${absent.join("、")}`);
  if (unverified.length > 0) {
    for (const entry of unverified) console.error(`[backup] 校验失败：${entry.path}`);
    process.exit(2);
  }
}

await main();
