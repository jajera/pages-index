import rss from '@astrojs/rss';
import { CATEGORY_LABELS, loadRepositories, primaryUrl } from '../lib/repositories';

export async function GET(context) {
  const data = loadRepositories();
  const repos = [...data.repositories].sort((a, b) => {
    const au = a.updated_at || a.created_at || '';
    const bu = b.updated_at || b.created_at || '';
    return bu.localeCompare(au);
  });

  return rss({
    title: 'pages.johna.kiwi',
    description:
      'Index of public GitHub Pages sites, modules, and tools across my accounts.',
    site: context.site,
    items: repos.map((repo) => {
      const pub = repo.updated_at || repo.created_at;
      return {
        title: repo.name,
        description: repo.description || `${repo.full_name} (${CATEGORY_LABELS[repo.category] || repo.category})`,
        pubDate: pub ? new Date(pub) : new Date(),
        link: primaryUrl(repo),
        categories: [
          CATEGORY_LABELS[repo.category] || repo.category,
          repo.owner?.login,
          ...(repo.topics || []).slice(0, 5),
        ].filter(Boolean),
      };
    }),
  });
}
