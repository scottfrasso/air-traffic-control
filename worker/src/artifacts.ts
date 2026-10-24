/** Artifacts helpers: short-lived repo tokens are minted where they are used, never stored. */

/** A short-lived repo token + remote for the checker container. Tokens are minted where they're used, never stored. */
export async function repoRef(env: Env, repo: string, scope: "read" | "write", ttlSeconds: number): Promise<{ name: string; remote: string; token: string }> {
  using handle = await env.ARTIFACTS.get(repo);
  const [token, info] = await Promise.all([handle.createToken(scope, ttlSeconds), handle.info()]);
  return { name: repo, remote: info.remote, token: token.plaintext };
}
