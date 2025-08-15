import path from 'node:path';
import { spawn } from 'node:child_process';
import ffprobeStatic from 'ffprobe-static';
import ffmpegPathDefault from 'ffmpeg-static';
import { promises as fs, existsSync } from 'node:fs';

const ffprobePath =
  typeof ffprobeStatic === 'string'
    ? ffprobeStatic
    : (ffprobeStatic as any)?.path;

const ffmpegPath = ffmpegPathDefault || 'ffmpeg'; // fallback if a platform isn't supported
const ffprobe = ffprobePath || 'ffprobe';

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

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', d => (stdout += d.toString()));
    p.stderr?.on('data', d => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${cmd} exited with code ${code}`);
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        reject(err);
      }
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
      const [k, v] = line.split('=');
      if (k === 'bit_rate') {
        const bps = parseInt(v, 10);
        if (Number.isFinite(bps) && bps > 0) bitrateKbps = Math.round(bps / 1000);
      } else if (k === 'bits_per_sample') {
        const bps = parseInt(v, 10);
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

function buildOutputPaths(inputPath: string, suffix: string, inPlace: boolean) {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  if (inPlace) {
    const tmp = path.join(dir, `${base}.__tmp_${Date.now()}${ext}`);
    const bak = path.join(dir, `${base}.bak${ext}`);
    return { tmp, bak, final: inputPath };
  } else {
    const out = path.join(dir, `${base}${suffix}${ext}`);
    return { out };
  }
}

/** Pick appropriate output codec/settings per extension. */
function codecArgsFor(ext: string, info: { bitrateKbps: number | null; bitsPerSample: number | null }): string[] {
  if (ext === '.mp3') {
    if (info.bitrateKbps && Number.isFinite(info.bitrateKbps)) {
      return ['-c:a', 'libmp3lame', '-b:a', `${info.bitrateKbps}k`];
    }
    return ['-c:a', 'libmp3lame', '-q:a', '2']; // high-quality VBR fallback
  }

  if (ext === '.ogg') {
    // Encode OGG Vorbis; keep bitrate if available, else use a solid VBR quality level.
    if (info.bitrateKbps && Number.isFinite(info.bitrateKbps)) {
      return ['-c:a', 'libvorbis', '-b:a', `${info.bitrateKbps}k`];
    }
    return ['-c:a', 'libvorbis', '-q:a', '5']; // ~160 kbps VBR target
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

  const stat = await fs.stat(inputPath).catch(() => null as any);
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

  const target = inPlace ? (paths as any).tmp : (paths as any).out;
  args.push(target);

  if (verbose) {
    const pretty = args.map(a => (a === target || a === inputPath) ? `"${path.basename(a)}"` : a).join(' ');
    console.log(`[ffmpeg] ${pretty}`);
  }

  try {
    await run(ffmpegPath, args);
  } catch (err: any) {
    if (verbose) console.error(`FFmpeg failed: ${err?.stderr || err?.message}`);
    if (inPlace && existsSync((paths as any).tmp)) {
      try { await fs.unlink((paths as any).tmp); } catch {}
    }
    return { status: 'error' };
  }

  if (inPlace) {
    if (!noBackup) {
      try { await fs.rename(inputPath, (paths as any).bak); }
      catch (e: any) {
        if (verbose) console.error(`Backup failed: ${e.message}`);
        try { await fs.unlink((paths as any).tmp); } catch {}
        return { status: 'error' };
      }
    } else {
      try { await fs.unlink(inputPath); } catch (e: any) {
        if (verbose) console.error(`Delete original failed: ${e.message}`);
        try { await fs.unlink((paths as any).tmp); } catch {}
        return { status: 'error' };
      }
    }

    try { await fs.rename((paths as any).tmp, (paths as any).final); }
    catch (e: any) {
      if (verbose) console.error(`Finalize failed: ${e.message}`);
      if (!noBackup && existsSync((paths as any).bak)) {
        try { await fs.rename((paths as any).bak, inputPath); } catch {}
      }
      return { status: 'error' };
    }
    return { status: 'ok', outputPath: inputPath };
  }

  return { status: 'ok', outputPath: (paths as any).out };
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
      const pkg = JSON.parse(pkgRaw);
      console.log(pkg.version);
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

function parseCliArgs(argv: string[]) {
  const flags: any = {
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
    else if (a === '--threshold') flags.thresholdDb = parseFloat(argv[++i]);
    else if (a.startsWith('--threshold=')) flags.thresholdDb = parseFloat(a.split('=')[1]);
    else if (a === '--start') flags.startSeconds = parseFloat(argv[++i]);
    else if (a.startsWith('--start=')) flags.startSeconds = parseFloat(a.split('=')[1]);
    else if (a === '--stop') flags.stopSeconds = parseFloat(argv[++i]);
    else if (a.startsWith('--stop=')) flags.stopSeconds = parseFloat(a.split('=')[1]);
    else if (a === '--suffix') flags.suffix = argv[++i];
    else if (!a.startsWith('--') && !flags.fileArg) flags.fileArg = a;
  }
  return flags;
}

function printHelp() {
  console.log(`
mp3-trim-silence — Trim leading/trailing silence from MP3, WAV, and OGG files

Usage:
  mp3-trim-silence "file.mp3"
  mp3-trim-silence "file.wav"
  mp3-trim-silence "file.ogg"
  mp3-trim-silence --all
  mp3-trim-silence --all --in-place [--no-backup]
  mp3-trim-silence "file.mp3" --threshold -45 --start 0.05 --stop 0.20

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
