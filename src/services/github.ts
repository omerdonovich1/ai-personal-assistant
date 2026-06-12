// GitHub service layer — fetch-based (REST v3), no SDK dependency.
// Env: GITHUB_TOKEN (classic or fine-grained, repo scope),
//      GITHUB_REPOS  (comma-separated "owner/repo" list to track).

const API = "https://api.github.com";

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GitHub לא מוגדר — חסר GITHUB_TOKEN");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "assistant-bot",
  };
}

export function githubConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOS);
}

function trackedRepos(): string[] {
  return (process.env.GITHUB_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
}

export interface GitIssue {
  repo: string;
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  labels: string[];
}

export async function githubOpenIssues(repo?: string): Promise<GitIssue[]> {
  const repos = repo ? [repo] : trackedRepos();
  if (repos.length === 0) throw new Error("GitHub לא מוגדר — חסר GITHUB_REPOS");

  const all: GitIssue[] = [];
  await Promise.all(
    repos.map(async (r) => {
      const res = await fetch(`${API}/repos/${r}/issues?state=open&per_page=30`, { headers: headers() });
      if (!res.ok) throw new Error(`GitHub ${r}: ${res.status}`);
      const issues = await res.json() as Array<{
        number: number; title: string; state: string; html_url: string;
        updated_at: string; pull_request?: unknown; labels: Array<{ name: string }>;
      }>;
      for (const i of issues) {
        if (i.pull_request) continue; // issues only, not PRs
        all.push({
          repo: r, number: i.number, title: i.title, state: i.state,
          url: i.html_url, updatedAt: i.updated_at, labels: i.labels.map((l) => l.name),
        });
      }
    })
  );
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function githubCreateIssue(repo: string, title: string, body?: string): Promise<GitIssue> {
  const res = await fetch(`${API}/repos/${repo}/issues`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ title, body: body ?? "" }),
  });
  if (!res.ok) throw new Error(`GitHub create issue: ${res.status} ${await res.text().catch(() => "")}`);
  const i = await res.json() as { number: number; title: string; state: string; html_url: string; updated_at: string };
  return { repo, number: i.number, title: i.title, state: i.state, url: i.html_url, updatedAt: i.updated_at, labels: [] };
}

export async function githubCloseIssue(repo: string, issueNumber: number): Promise<void> {
  const res = await fetch(`${API}/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
  if (!res.ok) throw new Error(`GitHub close issue: ${res.status}`);
}
