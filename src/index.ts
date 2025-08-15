import path from 'node:path';
import { spawn } from 'node:child_process';
import ffprobeStatic from 'ffprobe-static';
import ffmpegPathDefault from 'ffmpeg-static';
import { promises as fs, existsSync } from 'node:fs';
import type { Stats } from 'node:fs';

// If you keep the ambient typings from earlier:
//   declare module 'ffprobe-static' { const ffprobe: { path: string } | string; export default ffprobe; }
const ffprobePath = typeof ffprobeStatic === 'string' ? ffprobeStatic : ffprobeStatic?.path ?? null;

const ffmpegPath: string = ffmpegPathDefault || 'ffmpeg'; // fallback if a platform isn't supported
const ffprobe: string = ffprobePath || 'ffprobe';

type TrimStatus = 'ok' | 'skipped' | 'error';

export interface TrimOptions {
  thresholdDb?: number;   // negative dB, default -45
  startSeconds?: number;  // min leading silence to trim, default 0.05
  stopSeconds?: number;   // min trailing silence to trim, default 0.20
  inPlace?: boolean;      // overwrite input, default false
  noBackup?: boolean;     // skip .bak when inPlace, default false
  suffix?: string;        // output suffix when not inPlace, default "_trimmed"
  verbose?: boolean;      // print ffmpeg command, default false
}

export interface TrimResult {
  status: TrimStatus;
  outputPath?: string;
}

const SUPPORTED_EXTS = new Set(['.mp3', '.wav', '.ogg']);

interface RunResult { stdout: string; stderr: string; }
function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';

    p.stdout?.on('data', (d: Buffer | string) => {
      stdout += typeof d === 'string' ? d : d.toString('utf8');
    });
    p.stderr?.on('data', (d: Buffer | string) => {
      stderr += typeof d === 'string' ? d : d.toString('utf8');
    });

    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function getAudioStreamInfo(file: string): Promise<{ bitrateKbps: number | null; bitsPerSample: number | null }> {
  try {
    const { stdout } = await run(ffprobe, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=bit_rate,bits_per_sample',
      '-of', 'default=noprint_wrappers=1',
      file
    ]);

    let bitrateKbps: number | null = null;
    let bitsPerSample: number | null = null;

    for (const line of stdout.split(/\r?\n/)) {
      if (!line) continue;
      const [k = '', vRaw] = line.split('=');
      const v: string = vRaw ?? '';
      if (k === 'bit_rate') {
        const bps = Number.parseInt(v, 10);
        if (Number.isFinite(bps) && bps > 0) bitrateKbps = Math.round(bps / 1000);
      } else if (k === 'bits_per_sample') {
        const bps = Number.parseInt(v, 10);
        if (Number.isFinite(bps) && bps > 0) bitsPerSample = bps;
      }
    }

    return { bitrateKbps, bitsPerSample };
  } catch {
    return { bitrateKbps: null, bitsPerSample: null };
  }
}

function silenceremoveFilter(thresholdDb: number, startSec: number, stopSec: number): string {
  const thr = `${thresholdDb}dB`;
  return `silenceremove=start_periods=1:start_duration=${startSec}:start_threshold=${thr}:` +
         `stop_periods=1:stop_duration=${stopSec}:stop_threshold=${thr}`;
}

// Discriminated union so we never need casts.
type OutputPaths =
  | { kind: 'copy'; out: string }
  | { kind: 'inPlace'; tmp: string; bak: string; final: string };

function buildOutputPaths(inputPath: string, suffix: string, inPlace: boolean): OutputPaths {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  if (inPlace) {
    return {
      kind: 'inPlace',
      tmp: path.join(dir, `${base}.__tmp_${Date.now()}${ext}`),
      bak: path.join(dir, `${base}.bak${ext}`),
      final: inputPath
    };
  }
  return { kind: 'copy', out: path.join(dir, `${base}${suffix}${ext}`) };
}

/** Pick appropriate output codec/settings per extension. */
function codecArgsFor(
  ext: string,
  info: { bitrateKbps: number | null; bitsPerSample: number | null }
): string[] {
  if (ext === '.mp3') {
    return info.bitrateKbps ? ['-c:a', 'libmp3lame', '-b:a', `${info.bitrateKbps}k`] : ['-c:a', 'libmp3lame', '-q:a', '2'];
  }
  if (ext === '.ogg') {
    return info.bitrateKbps ? ['-c:a', 'libvorbis', '-b:a', `${info.bitrateKbps}k`] : ['-c:a', 'libvorbis', '-q:a', '5'];
  }
  // WAV: keep PCM; choose bit depth close to source (default 16-bit if unknown)
  const bits = info.bitsPerSample ?? 16;
  if (bits >= 32) return ['-c:a', 'pcm_s32le'];
  if (bits >= 24) return ['-c:a', 'pcm_s24le'];
  return ['-c:a', 'pcm_s16le'];
}

export async function trimFile(inputPath: string, options: TrimOptions = {}): Promise<TrimResult> {
  const {
    thresholdDb = -45,
    startSeconds = 0.05,
    stopSeconds = 0.20,
    inPlace = false,
    noBackup = false,
    suffix = '_trimmed',
    verbose = false
  } = options;

  let stat: Stats | null = null;
  try {
    stat = await fs.stat(inputPath);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) return { status: 'skipped' };

  const ext = path.extname(inputPath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return { status: 'skipped' };

  const info = await getAudioStreamInfo(inputPath);
  const filter = silenceremoveFilter(thresholdDb, startSeconds, stopSeconds);
  const paths = buildOutputPaths(inputPath, suffix, inPlace);
  const codec = codecArgsFor(ext, info);

  const args: string[] = [
    '-hide_banner', '-y',
    '-i', inputPath,
    '-af', filter,
    '-map_metadata', '0', // preserve tags where applicable
    ...codec
  ];

  const target = paths.kind === 'inPlace' ? paths.tmp : paths.out;
  args.push(target);

  if (verbose) {
    const pretty = args.map(a => (a === target || a === inputPath) ? `"${path.basename(a)}"` : a).join(' ');
    console.log(`[ffmpeg] ${pretty}`);
  }

  try {
    await run(ffmpegPath, args);
  } catch (err: unknown) {
    if (verbose) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`FFmpeg failed: ${msg}`);
    }
    if (paths.kind === 'inPlace' && existsSync(paths.tmp)) {
      try { await fs.unlink(paths.tmp); } catch (e: unknown) {
        if (verbose) console.error(`Delete temp failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { status: 'error' };
  }

  if (paths.kind === 'inPlace') {
    if (!noBackup) {
      try { await fs.rename(inputPath, paths.bak); }
      catch (e: unknown) {
        if (verbose) console.error(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
        try { await fs.unlink(paths.tmp); } catch (e: unknown) {
            if (verbose) console.error(`Delete temp failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return { status: 'error' };
      }
    } else {
      try { await fs.unlink(inputPath); } catch (e: unknown) {
        if (verbose) console.error(`Delete original failed: ${e instanceof Error ? e.message : String(e)}`);
        try { await fs.unlink(paths.tmp); } catch (e: unknown) {
            if (verbose) console.error(`Delete temp failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return { status: 'error' };
      }
    }

    try { await fs.rename(paths.tmp, paths.final); }
    catch (e: unknown) {
      if (verbose) console.error(`Finalize failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!noBackup && existsSync(paths.bak)) {
        try { await fs.rename(paths.bak, inputPath); } catch (e: unknown) {
          if (verbose) console.error(`Restore backup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { status: 'error' };
    }
    return { status: 'ok', outputPath: inputPath };
  }

  return { status: 'ok', outputPath: paths.out };
}

export async function trimDirectory(dir: string, options: TrimOptions = {}): Promise<TrimResult[]> {
  const entries = await fs.readdir(dir);
  const files = entries
    .filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => path.join(dir, f));

  const results: TrimResult[] = [];
  for (const f of files) {
    results.push(await trimFile(f, options));
  }
  return results;
}

/** CLI support (used by src/bin/cli.ts) */
export async function runCli(): Promise<void> {
  const flags = parseCliArgs(process.argv.slice(2));

  if (flags.version) {
    try {
      const pkgRaw = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
      const pkg = JSON.parse(pkgRaw) as { version?: string };
      console.log(pkg.version ?? '0.0.0');
    } catch {
      console.log('0.0.0');
    }
    return;
  }

  if (flags.help || (!flags.all && !flags.fileArg)) {
    printHelp();
    if (!flags.help) process.exitCode = 1;
    return;
  }

  const options: TrimOptions = {
    thresholdDb: flags.thresholdDb,
    startSeconds: flags.startSeconds,
    stopSeconds: flags.stopSeconds,
    inPlace: flags.inPlace,
    noBackup: flags.noBackup,
    suffix: flags.suffix,
    verbose: flags.verbose
  };

  if (flags.all) {
    const entries = await fs.readdir(process.cwd());
    const targets = entries
      .filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
      .map(f => path.join(process.cwd(), f));

    if (targets.length === 0) {
      console.log('No .mp3, .wav, or .ogg files found in current directory.');
      return;
    }

    console.log(`Trimming silence from ${targets.length} file${targets.length === 1 ? '' : 's'}`);
    console.log(
      `threshold=${options.thresholdDb}dB, start>=${options.startSeconds}s, stop>=${options.stopSeconds}s` +
      (options.inPlace ? `, mode=in-place${options.noBackup ? ', no-backup' : ', with-backup'}` : `, suffix='${options.suffix}'`)
    );

    let ok = 0, err = 0, skipped = 0;
    for (const t of targets) {
      const res = await trimFile(t, options);
      const base = path.basename(t);
      if (res.status === 'ok') {
        ok++;
        if (options.inPlace) console.log(`✓ ${base} (trimmed in-place)`);
        else {
          const p = path.parse(base);
          console.log(`✓ ${base} -> ${p.name}${options.suffix}${p.ext}`);
        }
      } else if (res.status === 'skipped') {
        skipped++;
      } else {
        err++;
        console.error(`✗ ${base}`);
      }
    }

    console.log(`\nDone. ok=${ok}, errors=${err}, skipped=${skipped}`);
    if (options.inPlace && !options.noBackup) {
      console.log('Backups created with .bak suffix next to originals.');
    }
  } else {
    const input = path.resolve(flags.fileArg as string);
    const res = await trimFile(input, options);
    if (res.status === 'ok') {
      if (options.inPlace) console.log(`✓ Trimmed in-place: ${input}`);
      else console.log(`✓ Wrote: ${res.outputPath}`);
    } else if (res.status === 'skipped') {
      console.log('Nothing to do.');
      process.exitCode = 2;
    } else {
      console.error('Failed.');
      process.exitCode = 3;
    }
  }
}

// ---- CLI parsing (typed) ----

interface CliFlags {
  all: boolean;
  inPlace: boolean;
  noBackup: boolean;
  thresholdDb: number;
  startSeconds: number;
  stopSeconds: number;
  suffix: string;
  verbose: boolean;
  fileArg: string | null;
  help: boolean;
  version: boolean;
}

function parseNumber(val: string, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    all: false,
    inPlace: false,
    noBackup: false,
    thresholdDb: -45,
    startSeconds: 0.05,
    stopSeconds: 0.20,
    suffix: '_trimmed',
    verbose: false,
    fileArg: null,
    help: false,
    version: false
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--in-place') flags.inPlace = true;
    else if (a === '--no-backup') flags.noBackup = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--threshold') flags.thresholdDb = parseNumber(argv[++i] ?? '', flags.thresholdDb);
    else if (a?.startsWith('--threshold=')) flags.thresholdDb = parseNumber(a.split('=')[1] ?? "", flags.thresholdDb);
    else if (a === '--start') flags.startSeconds = parseNumber(argv[++i] ?? '', flags.startSeconds);
    else if (a?.startsWith('--start=')) flags.startSeconds = parseNumber(a.split('=')[1] ?? "", flags.startSeconds);
    else if (a === '--stop') flags.stopSeconds = parseNumber(argv[++i] ?? '', flags.stopSeconds);
    else if (a?.startsWith('--stop=')) flags.stopSeconds = parseNumber(a.split('=')[1] ?? "", flags.stopSeconds);
    else if (a === '--suffix') flags.suffix = argv[++i] ?? flags.suffix;
    else if (!a?.startsWith('--') && !flags.fileArg) flags.fileArg = a ?? null;
  }

  return flags;
}

function printHelp(): void {
  console.log(`
audio-trim-silence — Trim leading/trailing silence from MP3, WAV, and OGG files

Usage:
  audio-trim-silence "file.mp3"
  audio-trim-silence "file.wav"
  audio-trim-silence "file.ogg"
  audio-trim-silence --all
  audio-trim-silence --all --in-place [--no-backup]
  audio-trim-silence "file.mp3" --threshold -45 --start 0.05 --stop 0.20

Options:
  --all            Process all .mp3/.wav/.ogg files in current directory
  --in-place       Overwrite originals (creates .bak backup unless --no-backup)
  --no-backup      Skip creating .bak when using --in-place
  --threshold N    Silence threshold in dB (negative). Default: -45
  --start SEC      Min leading silence to trim (seconds). Default: 0.05
  --stop SEC       Min trailing silence to trim (seconds). Default: 0.20
  --suffix TEXT    Suffix for outputs when not in-place. Default: _trimmed
  --verbose        Verbose logging
  -h, --help       Show this help
  -v, --version    Print version

Notes:
  Bundled ffmpeg/ffprobe via ffmpeg-static and ffprobe-static.
  MP3: libmp3lame (source bitrate if detectable; else VBR -q:a 2).
  WAV: PCM (16/24/32-bit chosen to match source).
  OGG: libvorbis (source bitrate if detectable; else VBR -q:a 5).
`);
}
