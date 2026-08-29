import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://pages.johna.kiwi',
  base: '/',
  integrations: [sitemap()],
});
