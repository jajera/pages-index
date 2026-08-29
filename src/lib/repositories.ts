import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataPath = path.join(root, 'data', 'repositories.json');

export type RepoItem = {
  id: string | number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  homepage?: string | null;
  language?: string | null;
  topics: string[];
  stargazers_count?: number;
  forks_count?: number;
  has_pages?: boolean;
  created_at?: string;
  updated_at?: string;
  owner: { login: string; avatar_url?: string; html_url?: string };
  category: string;
  pagesUrl?: string | null;
  reference?: string;
  latest_version?: string;
  isUserRepo?: boolean;
};

export type RepoData = {
  repositories: RepoItem[];
  metadata: {
    totalCount: number;
    categories: Record<string, number>;
    lastUpdated?: string;
    sources?: { users?: string[]; organizations?: string[] };
    site?: { title?: string; description?: string; author?: string };
  };
};

export const CATEGORY_LABELS: Record<string, string> = {
  'web-apps': 'Web apps',
  'terraform-modules': 'Terraform',
  'github-actions': 'GitHub Actions',
  'devcontainer-features': 'DevContainer',
};

export const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);

export function loadRepositories(): RepoData {
  try {
    const raw = readFileSync(dataPath, 'utf8');
    const data = JSON.parse(raw) as RepoData;
    if (!Array.isArray(data.repositories)) {
      return emptyData();
    }
    return data;
  } catch {
    return emptyData();
  }
}

function emptyData(): RepoData {
  return {
    repositories: [],
    metadata: {
      totalCount: 0,
      categories: {},
      lastUpdated: undefined,
    },
  };
}

export function primaryUrl(repo: RepoItem): string {
  if (repo.pagesUrl) return repo.pagesUrl;
  if (repo.homepage && /^https?:\/\//i.test(repo.homepage)) return repo.homepage;
  return repo.html_url;
}
