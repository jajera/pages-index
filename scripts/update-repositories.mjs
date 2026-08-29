#!/usr/bin/env node
/**
 * Fetch GitHub repos per config.json and write data/repositories.json.
 * Usage: GITHUB_TOKEN=... npm run update
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const fetch = globalThis.fetch;

class RepositoryUpdater {
  constructor() {
    this.configPath = path.join(ROOT, 'config.json');
    this.outputPath = path.join(ROOT, 'data', 'repositories.json');

    if (!fs.existsSync(this.configPath)) {
      throw new Error(`Configuration file not found: ${this.configPath}`);
    }

    this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    this.repositories = [];

    // Set up GitHub token from environment
    this.githubToken = process.env.GITHUB_TOKEN;
    if (!this.githubToken) {
      console.warn('Warning: GITHUB_TOKEN not found. API requests will be rate-limited.');
    }
  }

  async fetchAllRepositories() {
    const allRepos = [];

    // Fetch user repositories
    for (const user of this.config.sources.users) {
      try {
        console.log(`Fetching repositories for user: ${user}`);
        const repos = await this.fetchUserRepositories(user);
        allRepos.push(...repos);
        await this.delay(this.config.settings.rateLimitDelay);
      } catch (error) {
        console.error(`Error fetching user repos for ${user}:`, error.message);
      }
    }

    // Fetch organization repositories
    for (const org of this.config.sources.organizations) {
      try {
        console.log(`Fetching repositories for organization: ${org}`);
        const repos = await this.fetchOrganizationRepositories(org);
        allRepos.push(...repos);
        await this.delay(this.config.settings.rateLimitDelay);
      } catch (error) {
        console.error(`Error fetching org repos for ${org}:`, error.message);
      }
    }

    return allRepos;
  }

  async fetchUserRepositories(username) {
    const repos = [];
    let page = 1;

    while (true) {
      const response = await this.makeApiRequest(
        `https://api.github.com/users/${username}/repos?per_page=100&page=${page}`
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      repos.push(...data);

      if (data.length < 100) break;
      page++;
      await this.delay(this.config.settings.rateLimitDelay);
    }

    return repos;
  }

  async fetchOrganizationRepositories(org) {
    const repos = [];
    let page = 1;

    while (true) {
      const response = await this.makeApiRequest(
        `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}`
      );

      if (!response.ok) {
        if (response.status === 404) {
          console.warn(`Organization ${org} not found or not accessible`);
          break;
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      repos.push(...data);

      if (data.length < 100) break;
      page++;
      await this.delay(this.config.settings.rateLimitDelay);
    }

    return repos;
  }

  async fetchRepositoryReleases(owner, repo) {
    try {
      const response = await this.makeApiRequest(
        `https://api.github.com/repos/${owner}/${repo}/releases?per_page=1`
      );

      if (!response.ok) {
        return [];
      }

      const releases = await response.json();
      return releases;
    } catch (error) {
      console.warn(`Error fetching releases for ${owner}/${repo}:`, error.message);
      return [];
    }
  }

  async isPotentialTerraformModule(repo) {
    const { terraformModules } = this.config.categorization;

    // Check if it looks like a terraform module
    const isTerraformRepo = repo.name.startsWith(terraformModules.namePrefix) ||
                           (repo.topics && repo.topics.some(topic => terraformModules.topics.includes(topic)));

    if (!isTerraformRepo) {
      return false;
    }

    // For terraform modules, check if they have releases
    console.log(`Checking releases for potential Terraform module: ${repo.full_name}`);
    const releases = await this.fetchRepositoryReleases(repo.owner.login, repo.name);
    await this.delay(this.config.settings.rateLimitDelay);

    const hasReleases = releases.length > 0;
    if (!hasReleases) {
      console.log(`  └─ Excluding ${repo.full_name}: no releases found`);
    } else {
      console.log(`  └─ Including ${repo.full_name}: ${releases.length} release(s) found`);
    }

    return hasReleases;
  }

  async isGitHubActionRepo(repo) {
    // Check name prefix or topics
    const { githubActions } = this.config.categorization;

    const looksLikeAction = repo.name.startsWith(githubActions.namePrefix) ||
      (repo.topics && repo.topics.some(t => githubActions.topics.includes(t)));

    if (!looksLikeAction) return false;

    // Need releases
    const releases = await this.fetchRepositoryReleases(repo.owner.login, repo.name);
    await this.delay(this.config.settings.rateLimitDelay);
    if (releases.length === 0) {
      console.log(`  └─ Excluding ${repo.full_name}: no releases found (GitHub Action)`);
      return false;
    }
    console.log(`  └─ Including ${repo.full_name}: ${releases.length} release(s) found (GitHub Action)`);
    return true;
  }

  async isDevcontainerFeatureRepo(repo) {
    const { devcontainerFeatures } = this.config.categorization;
    // Match exact repo name or topic
    const looksLikeFeature = repo.name === devcontainerFeatures.nameExact ||
      (repo.topics && repo.topics.some(t => devcontainerFeatures.topics.includes(t)));
    if (!looksLikeFeature) return false;

    // Exclusion list
    if (this.config.filters.excludeDevcontainerFeatures && this.config.filters.excludeDevcontainerFeatures.includes(repo.name)) {
      return false;
    }
    return true; // no release check
  }

  async shouldIncludeRepository(repo) {
    // Skip archived repositories (default on)
    if (repo.archived && this.config.filters.excludeArchived !== false) {
      return false;
    }

    // Check exclusions first
    if (this.config.filters.excludeRepositories.includes(repo.name)) {
      return false;
    }

    // Check exclude patterns
    for (const pattern of this.config.filters.excludePatterns) {
      const regex = new RegExp(pattern.replace('*', '.*'));
      if (regex.test(repo.name)) {
        return false;
      }
    }

    // Check include patterns
    for (const pattern of this.config.filters.includePatterns) {
      if (pattern === 'has_pages' && repo.has_pages) {
        return true;
      }
      if (pattern.startsWith('terraform-') && repo.name.startsWith('terraform-')) {
        // For terraform modules, check releases
        return await this.isPotentialTerraformModule(repo);
      }
      if (pattern.startsWith('actions-') && repo.name.startsWith('actions-')) {
        return await this.isGitHubActionRepo(repo);
      }
      if (pattern.startsWith('features') && repo.name === 'features') {
        return await this.isDevcontainerFeatureRepo(repo);
      }
      if (pattern.startsWith('topic:')) {
        const topic = pattern.substring(6);
        if (repo.topics && repo.topics.includes(topic)) {
          if (topic === 'terraform-module') {
            return await this.isPotentialTerraformModule(repo);
          }
          if (topic === 'github-action') {
            return await this.isGitHubActionRepo(repo);
          }
          if (topic === 'devcontainer-feature') {
            return await this.isDevcontainerFeatureRepo(repo);
          }
          return true;
        }
      }
    }

    return false;
  }

  async filterRepositories(repositories) {
    console.log(`Filtering ${repositories.length} repositories...`);

    const filteredRepos = [];

    for (const repo of repositories) {
      if (await this.shouldIncludeRepository(repo)) {
        filteredRepos.push(repo);
      }
    }

    console.log(`Filtered to ${filteredRepos.length} repositories`);
    return filteredRepos;
  }

  async makeApiRequest(url, attempt = 0) {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pages-index/1.0'
    };

    if (this.githubToken) {
      headers['Authorization'] = `Bearer ${this.githubToken}`;
    }

    const maxAttempts = 3;

    try {
      const response = await fetch(url, { headers });

      // Handle rate limiting (403 or 429)
      if ((response.status === 403 || response.status === 429) && attempt < maxAttempts) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        const reset = response.headers.get('x-ratelimit-reset');
        const retryAfter = response.headers.get('retry-after');

        // If we have exhausted remaining requests or server explicitly asks us to retry later
        if ((remaining !== null && remaining === '0') || response.status === 429) {
          let waitSeconds = 0;
          if (reset) {
            const resetEpoch = parseInt(reset, 10);
            const currentEpoch = Math.floor(Date.now() / 1000);
            waitSeconds = Math.max(resetEpoch - currentEpoch, 0) + 5; // Add 5-second buffer
          } else if (retryAfter) {
            waitSeconds = parseInt(retryAfter, 10) + 5;
          } else {
            // Fallback to exponential backoff (30, 60, 120 seconds)
            waitSeconds = Math.pow(2, attempt) * 30;
          }

          console.warn(`Rate limit hit (status ${response.status}). Waiting ${waitSeconds}s before retrying (attempt ${attempt + 1}/${maxAttempts})...`);
          await this.delay(waitSeconds * 1000);
          return this.makeApiRequest(url, attempt + 1);
        }
      }

      return response;
    } catch (error) {
      // Network or other error: exponential backoff retry
      if (attempt < maxAttempts) {
        const waitMs = Math.pow(2, attempt) * 1000;
        console.warn(`Request failed (attempt ${attempt + 1}/${maxAttempts}). Retrying in ${waitMs / 1000}s...`);
        await this.delay(waitMs);
        return this.makeApiRequest(url, attempt + 1);
      }
      throw error;
    }
  }

  async fetchDevcontainerFeatures() {
    const { devcontainerFeatures } = this.config.categorization;
    const { owner, name } = devcontainerFeatures.repo || {};
    if (!owner || !name) return [];
    console.log(`Scanning DevContainer features in repo: ${owner}/${name}`);
    try {
      const contentsRes = await this.makeApiRequest(`https://api.github.com/repos/${owner}/${name}/contents`);
      if (!contentsRes.ok) throw new Error(`Unable to list contents (${contentsRes.status})`);
      const contents = await contentsRes.json();
      const directories = contents.filter(item => item.type === 'dir');

      const features = [];
      for (const dir of directories) {
        const featureJsonPath = `${dir.path}/devcontainer-feature.json`;
        const fileRes = await this.makeApiRequest(`https://raw.githubusercontent.com/${owner}/${name}/main/${featureJsonPath}`);
        if (!fileRes.ok) continue; // skip if not present
        // Respect exclude list
        if (this.config.filters.excludeDevcontainerFeatures?.includes(dir.name)) {
          continue;
        }
        try {
          const jsonText = await fileRes.text();
          const meta = JSON.parse(jsonText);
          features.push({
            id: `feature-${dir.name}`,
            name: dir.name,
            full_name: dir.name,
            description: meta.description || 'Dev Container Feature',
            html_url: `https://github.com/${owner}/${name}/tree/main/${dir.name}`,
            homepage: '',
            language: '',
            topics: ['devcontainer-feature'],
            stargazers_count: 0,
            forks_count: 0,
            has_pages: false,
            created_at: '',
            updated_at: '',
            owner: { login: owner, avatar_url: '', html_url: `https://github.com/${owner}` },
            category: 'devcontainer-features',
            reference: meta?.registryUrl || `ghcr.io/${owner}/features/${dir.name}:latest`,
            latest_version: meta.version || 'latest',
            isUserRepo: false
          });
        } catch {}
        await this.delay(200); // tiny delay to be polite
      }

      // If repo follows devcontainer/feature-starter layout where features sit inside "src" directory
      const srcDir = contents.find(item => item.type === 'dir' && item.name === 'src');
      if (srcDir) {
        const srcRes = await this.makeApiRequest(`https://api.github.com/repos/${owner}/${name}/contents/${srcDir.path}`);
        if (srcRes.ok) {
          const srcDirs = (await srcRes.json()).filter(item => item.type === 'dir');
          for (const sub of srcDirs) {
            // skip root features already captured or configured exclusion
            if (features.some(f => f.name === sub.name) || this.config.filters.excludeDevcontainerFeatures?.includes(sub.name)) continue;
            const featureJsonPath = `${sub.path}/devcontainer-feature.json`;
            const fileRes = await this.makeApiRequest(`https://raw.githubusercontent.com/${owner}/${name}/main/${featureJsonPath}`);
            if (!fileRes.ok) continue;
            try {
              const jsonText = await fileRes.text();
              const meta = JSON.parse(jsonText);
              features.push({
                id: `feature-${sub.name}`,
                name: sub.name,
                full_name: sub.name,
                description: meta.description || 'Dev Container Feature',
                html_url: `https://github.com/${owner}/${name}/tree/main/${sub.path}`,
                homepage: '',
                language: '',
                topics: ['devcontainer-feature'],
                stargazers_count: 0,
                forks_count: 0,
                has_pages: false,
                created_at: '',
                updated_at: '',
                owner: { login: owner, avatar_url: '', html_url: `https://github.com/${owner}` },
                category: 'devcontainer-features',
                reference: meta?.registryUrl || `ghcr.io/${owner}/features/${sub.name}:latest`,
                latest_version: meta.version || 'latest',
                isUserRepo: false
              });
            } catch {}
            await this.delay(200);
          }
        }
      }

      // NEW: Scan GitHub Packages (container) for additional DevContainer features
      try {
        // Packages live at the user/org level. Fetch all container packages for the user then pick the ones whose repository matches the devcontainer feature repo.
        const packagesRes = await this.makeApiRequest(`https://api.github.com/users/${owner}/packages?package_type=container&per_page=100`);
        if (packagesRes.ok) {
          const pkgs = await packagesRes.json();
          for (const pkg of pkgs) {
            // Only keep packages that originate from the desired repository (html_url contains /features/)
            const repoMatch = pkg?.repository?.name === name || (pkg.html_url && pkg.html_url.includes(`/${name}/`));
            if (!repoMatch) continue;
            // Skip duplicates or excluded names
            if (features.some(f => f.name === pkg.name) || this.config.filters.excludeDevcontainerFeatures?.includes(pkg.name)) continue;

            // Attempt to grab the first tag as version, default to 'latest'
            const latestTag = (pkg?.package_version?.metadata?.container?.tags || [])[0] || 'latest';

            features.push({
              id: `package-${pkg.name}`,
              name: pkg.name,
              full_name: pkg.name,
              description: pkg.description || 'Dev Container Feature',
              html_url: pkg.html_url || `https://github.com/${owner}/${name}/packages/${pkg.name}`,
              homepage: '',
              language: '',
              topics: ['devcontainer-feature'],
              stargazers_count: 0,
              forks_count: 0,
              has_pages: false,
              created_at: '',
              updated_at: '',
              owner: { login: owner, avatar_url: '', html_url: `https://github.com/${owner}` },
              category: 'devcontainer-features',
              reference: `ghcr.io/${owner}/features/${pkg.name}:${latestTag}`,
              latest_version: latestTag,
              isUserRepo: false
            });
          }
        } else {
          console.warn(`Unable to list packages for user ${owner} (status ${packagesRes.status})`);
        }
      } catch (pkgError) {
        console.warn('Devcontainer package scan failed:', pkgError.message);
      }

      console.log(`Found ${features.length} devcontainer features`);
      return features;
    } catch (e) {
      console.warn('Devcontainer feature scan failed:', e.message);
      return [];
    }
  }

  categorizeRepository(repo) {
    let category = 'web-apps'; // Default category (catch-all)

    const { webApps, terraformModules, documentation, devcontainerFeatures } = this.config.categorization;

    // Check for Devcontainer features
    if (repo.name === devcontainerFeatures.nameExact || (repo.topics && repo.topics.some(t => devcontainerFeatures.topics.includes(t)))) {
      category = 'devcontainer-features';
    }
    // Check for GitHub Actions
    else if (repo.name.startsWith(this.config.categorization.githubActions.namePrefix) ||
        (repo.topics && repo.topics.some(topic => this.config.categorization.githubActions.topics.includes(topic)))) {
      category = 'github-actions';
    }
    // Check for Terraform modules
    else if (repo.name.startsWith(terraformModules.namePrefix) ||
        (repo.topics && repo.topics.some(topic => terraformModules.topics.includes(topic)))) {
      category = 'terraform-modules';
    }
    // Check for web apps (explicit)
    else if (repo.has_pages && this.isWebApp(repo)) {
      category = 'web-apps';
    }

    // Generate GitHub Pages URL
    const owner = repo.owner.login;
    const pagesUrl = `https://${owner}.github.io/${repo.name}`;

    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      html_url: repo.html_url,
      homepage: repo.homepage,
      language: repo.language,
      topics: repo.topics || [],
      stargazers_count: repo.stargazers_count,
      forks_count: repo.forks_count,
      has_pages: repo.has_pages,
      created_at: repo.created_at,
      updated_at: repo.updated_at,
      owner: {
        login: repo.owner.login,
        avatar_url: repo.owner.avatar_url,
        html_url: repo.owner.html_url
      },
      category,
      pagesUrl: repo.has_pages ? pagesUrl : null,
      isUserRepo: this.config.sources.users.includes(repo.owner.login)
    };
  }

  isWebApp(repo) {
    const { webApps } = this.config.categorization;

    const topics = repo.topics || [];
    const nameWords = repo.name.toLowerCase().split(/[-_]/);
    const descWords = (repo.description || '').toLowerCase().split(/\s+/);

    return topics.some(topic => webApps.topics.includes(topic)) ||
           nameWords.some(word => webApps.keywords.includes(word)) ||
           descWords.some(word => webApps.keywords.includes(word));
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async run() {
    try {
      console.log('Starting repository data update...');
      console.log(`Using config: ${this.configPath}`);
      console.log(`Output file: ${this.outputPath}`);

      if (this.githubToken) {
        console.log('Using authenticated GitHub API requests');
      } else {
        console.log('Using unauthenticated GitHub API requests (rate limited)');
      }

      const allRepos = await this.fetchAllRepositories();
      const featureRepos = await this.fetchDevcontainerFeatures();
      const combined = [...allRepos, ...featureRepos];
      console.log(`Fetched ${combined.length} repositories (including features)`);

      const filteredRepos = await this.filterRepositories(combined);

      const categorizedRepos = filteredRepos.map(repo => this.categorizeRepository(repo));

      const output = {
        repositories: categorizedRepos,
        metadata: {
          totalCount: categorizedRepos.length,
          categories: {
            'web-apps': categorizedRepos.filter(r => r.category === 'web-apps').length,
            'terraform-modules': categorizedRepos.filter(r => r.category === 'terraform-modules').length,
            'github-actions': categorizedRepos.filter(r => r.category === 'github-actions').length,
            'devcontainer-features': categorizedRepos.filter(r => r.category === 'devcontainer-features').length
          },
          lastUpdated: new Date().toISOString(),
          sources: this.config.sources,
          site: this.config.site || {
            title: 'pages.johna.kiwi',
            description: 'Index of public GitHub Pages sites modules and tools across my accounts',
            author: 'John Ajera'
          }
        }
      };

      // Ensure output directory exists
      const outputDir = path.dirname(this.outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      fs.writeFileSync(this.outputPath, JSON.stringify(output, null, 2));
      console.log('Repository data updated successfully!');
      console.log(`Categories: Web Apps: ${output.metadata.categories['web-apps']}, Terraform: ${output.metadata.categories['terraform-modules']}, GitHub Actions: ${output.metadata.categories['github-actions']}, DevContainer Features: ${output.metadata.categories['devcontainer-features']}`);
      console.log(`Site: ${output.metadata.site.title} by ${output.metadata.site.author}`);

    } catch (error) {
      console.error('Error updating repository data:', error);
      process.exit(1);
    }
  }
}

const updater = new RepositoryUpdater();
await updater.run();
