import fs from "node:fs";
import path from "node:path";

type Level = "info" | "warn" | "error";

/** Console logger with optional plain-text file mirror. */
export class Logger {
  private buffer: string[] = [];

  constructor(private logFile?: string) {}

  private write(level: Level, msg: string): void {
    const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${level.toUpperCase()} ${msg}`;
    this.buffer.push(line);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  info(msg: string): void {
    this.write("info", msg);
  }

  warn(msg: string): void {
    this.write("warn", msg);
  }

  error(msg: string): void {
    this.write("error", msg);
  }

  /** Append everything logged this run to the log file. */
  flush(): void {
    if (!this.logFile || this.buffer.length === 0) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, this.buffer.join("\n") + "\n");
    } catch {
      /* logging must never break the run */
    }
  }
}
