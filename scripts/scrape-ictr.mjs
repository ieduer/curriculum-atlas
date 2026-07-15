import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const host = 'https://www.ictr.edu.cn';

const categories = [
  { name: '义务教育课程标准（2022年版）', url: 'https://www.ictr.edu.cn/download_center/ywjy.html' },
  { name: '义务教育课程标准（2011年版）', url: 'https://www.ictr.edu.cn/download_center/yiwu.html' },
  { name: '三类特殊教育学校义务教育课程标准（2016年版）', url: 'https://www.ictr.edu.cn/download_center/sanlei.html' },
  { name: '全日制义务教育课程标准（实验稿）', url: 'https://www.ictr.edu.cn/download_center/quanrizhi.html' },
  { name: '普通高中课程标准（2017年版）', url: 'https://www.ictr.edu.cn/download_center/putong.html' },
  { name: '普通高中课程标准（实验）', url: 'https://www.ictr.edu.cn/download_center/pt.html' },
  { name: '普通高中课程标准（2017年版2020年修订）', url: 'https://www.ictr.edu.cn/download_center/put.html' },
  { name: '课程方案', url: 'https://www.ictr.edu.cn/download_center/fangan.html' }
];

const destBaseDir = '/Users/ylsuen/CF/curriculum-atlas/.cache/sources/ictr';

async function fetchPage(url) {
  console.log(`Fetching page: ${url}`);
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'referer': 'https://www.ictr.edu.cn/'
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.text();
}

async function downloadFile(url, destPath) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'referer': 'https://www.ictr.edu.cn/'
        },
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(destPath, buffer);
      console.log(`Successfully downloaded: ${url} -> ${destPath}`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt}/3 failed to download ${url}: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw new Error(`Failed to download ${url} after 3 attempts. Last error: ${lastError.message}`);
}

function parsePdfLinks(html) {
  const links = [];
  const regex = /<a\s+[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;
  const titleRegex = /<div\s+class="t">([^<]+)<\/div>/i;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const rawUrl = match[1];
    const innerHtml = match[2];
    const pdfUrl = rawUrl.startsWith('http') ? rawUrl : (host + rawUrl);

    const titleMatch = titleRegex.exec(innerHtml);
    let title = '';
    if (titleMatch) {
      title = titleMatch[1].trim();
    } else {
      // Fallback to extraction from filename if title class is missing
      const urlObj = new URL(pdfUrl);
      title = decodeURIComponent(urlObj.pathname.split('/').pop().replace(/\.pdf$/i, ''));
    }

    links.push({ url: pdfUrl, title });
  }
  return links;
}

async function scrapeCategory(category) {
  console.log(`\n========================================`);
  console.log(`Starting category: ${category.name}`);
  console.log(`========================================`);

  const categoryDir = join(destBaseDir, category.name);
  await mkdir(categoryDir, { recursive: true });

  const firstPageHtml = await fetchPage(category.url);
  const allLinks = [];

  // Parse first page links
  const firstPageLinks = parsePdfLinks(firstPageHtml);
  allLinks.push(...firstPageLinks);
  console.log(`Found ${firstPageLinks.length} PDF links on page 1`);

  // Parse pagination details
  const dataUrlMatch = firstPageHtml.match(/data-url="([^"]+)"/);
  const dataMaxMatch = firstPageHtml.match(/data-max="(\d+)"/);

  if (dataUrlMatch && dataMaxMatch) {
    const pagePattern = dataUrlMatch[1];
    const maxPages = parseInt(dataMaxMatch[1], 10);
    console.log(`Pagination pattern: ${pagePattern}, Total pages: ${maxPages}`);

    for (let p = 2; p <= maxPages; p++) {
      const pageUrl = host + pagePattern.replace('_PAGENUM_', p);
      try {
        const pageHtml = await fetchPage(pageUrl);
        const pageLinks = parsePdfLinks(pageHtml);
        allLinks.push(...pageLinks);
        console.log(`Found ${pageLinks.length} PDF links on page ${p}`);
      } catch (err) {
        console.error(`Error fetching page ${p} (${pageUrl}): ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Deduplicate links by URL
  const uniqueLinks = [];
  const seenUrls = new Set();
  for (const item of allLinks) {
    if (!seenUrls.has(item.url)) {
      seenUrls.add(item.url);
      uniqueLinks.push(item);
    }
  }

  console.log(`Total unique PDF links found for ${category.name}: ${uniqueLinks.length}`);

  // Download all files
  for (const item of uniqueLinks) {
    const cleanTitle = item.title.replace(/[\\/:*?"<>|]/g, '_').trim();
    const destFilename = `${cleanTitle}.pdf`;
    const destPath = join(categoryDir, destFilename);

    console.log(`Downloading: ${item.title} (${item.url})`);
    try {
      await downloadFile(item.url, destPath);
    } catch (err) {
      console.error(`Failed to download ${item.title}: ${err.message}`);
    }
    // Rate limit delay between file downloads
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function main() {
  console.log('ICTR Download Center Scraper Started');
  await mkdir(destBaseDir, { recursive: true });

  for (const category of categories) {
    try {
      await scrapeCategory(category);
    } catch (err) {
      console.error(`Error processing category ${category.name}: ${err.message}`);
    }
    // Deliberate delay between categories
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  console.log('\nAll categories finished.');
}

main().catch(err => {
  console.error('Fatal error in main scraper execution:', err);
});
