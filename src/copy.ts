import fs from "node:fs/promises";
import path from "node:path";

export type CopyStatus = "copied" | "skipped-existing" | "skipped-flag";

export interface CopyResult {
  status: CopyStatus;
  finalPath: string;
}

/**
 * Copy a finished local MP4 to the destination share:
 * mkdir -p, copy to .tmp.mp4 first, rename to final on success.
 */
export async function copyFinal(opts: {
  src: string;
  destDir: string;
  fileName: string;
  force?: boolean | undefined;
}): Promise<CopyResult> {
  const finalPath = path.join(opts.destDir, opts.fileName);

  if (!opts.force) {
    try {
      await fs.access(finalPath);
      return { status: "skipped-existing", finalPath };
    } catch {
      /* does not exist yet */
    }
  }

  await fs.mkdir(opts.destDir, { recursive: true });
  const tmpPath = path.join(opts.destDir, `.${opts.fileName}.tmp`);
  try {
    await fs.copyFile(opts.src, tmpPath);
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw new Error(`Copy to ${finalPath} failed: ${(err as Error).message}`);
  }
  return { status: "copied", finalPath };
}
