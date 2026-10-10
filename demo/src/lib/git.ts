import { execFileSync } from "node:child_process";

/** A local working copy whose git calls authenticate to Artifacts with a repo-scoped token. */
export class Repo {
  constructor(
    readonly dir: string,
    private readonly tokens: Record<string, string>,
    private readonly identity: { name: string; email: string },
  ) {}

  /** `remoteUrl → token`; the token is sent as a Bearer header, never written to .git/config. */
  private authArgs(remoteUrl?: string): string[] {
    const token = remoteUrl ? this.tokens[remoteUrl] : undefined;
    return token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : [];
  }

  git(args: string[], opts: { remote?: string; allowFail?: boolean } = {}): { ok: boolean; out: string } {
    try {
      const out = execFileSync("git", [...this.authArgs(opts.remote), "-c", `user.name=${this.identity.name}`, "-c", `user.email=${this.identity.email}`, ...args], {
        cwd: this.dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, out: out.trim() };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      if (!opts.allowFail) throw new Error(`git ${args.join(" ")} failed:\n${e.stderr ?? ""}${e.stdout ?? ""}`);
      return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
    }
  }

  static clone(remote: string, token: string, dir: string, identity: { name: string; email: string }, extraTokens: Record<string, string> = {}): Repo {
    execFileSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, "clone", "-q", remote, dir], { stdio: ["ignore", "pipe", "pipe"] });
    return new Repo(dir, { [remote]: token, ...extraTokens }, identity);
  }

  head(): string {
    return this.git(["rev-parse", "HEAD"]).out;
  }

  commitAll(message: string) {
    this.git(["add", "-A"]);
    this.git(["commit", "-q", "-m", message]);
    return this.head();
  }

  push(remote: string, refspec = "HEAD:main") {
    this.git(["push", "-q", remote, refspec], { remote });
  }

  fetch(remote: string, ref = "main"): string {
    this.git(["fetch", "-q", remote, ref], { remote });
    return this.git(["rev-parse", "FETCH_HEAD"]).out;
  }
}
