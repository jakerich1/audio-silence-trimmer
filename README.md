# audio-silence-trimmer

Trim leading and trailing silence from **MP3, WAV, and OGG** files using FFmpeg’s [`silenceremove`](https://ffmpeg.org/ffmpeg-filters.html#silenceremove).  
**No system install required** — ships with static `ffmpeg` and `ffprobe` binaries.

## Install & Run

```bash
# one-off run
npx audio-silence-trimmer --all

# or install globally
npm i -g audio-silence-trimmer
audio-trim-silence --all

# single file (non-destructive)
audio-trim-silence "MyFile.mp3"
audio-trim-silence "MyFile.wav"
audio-trim-silence "MyFile.ogg"

# in-place (creates .bak)
audio-trim-silence "MyFile.mp3" --in-place

# in-place, no backup
audio-trim-silence "MyFile.wav" --in-place --no-backup

# tweak thresholds/durations
audio-trim-silence "MyFile.ogg" --threshold -48 --start 0.05 --stop 0.30
