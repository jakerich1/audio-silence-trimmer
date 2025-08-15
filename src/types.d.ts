declare module 'ffmpeg-static' {
  const pathToFfmpeg: string | null;
  export default pathToFfmpeg;
}

declare module 'ffprobe-static' {
  const ffprobe: { path: string } | string;
  export default ffprobe;
}
