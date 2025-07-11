/* eslint-env jest */
import fs from 'fs';
import path from 'path';

import { runExportSideEffects } from './export-side-effects';
import { executeExpoAsync } from '../../utils/expo';
import { createStaticServe } from '../../utils/server';
import { findProjectFiles, getPageHtml, getRouterE2ERoot } from '../utils';

runExportSideEffects();

describe('exports static', () => {
  const projectRoot = getRouterE2ERoot();
  const outputName = 'dist-static-rendering';
  const outputDir = path.join(projectRoot, outputName);

  beforeAll(async () => {
    await executeExpoAsync(
      projectRoot,
      ['export', '-p', 'web', '--source-maps', '--output-dir', outputName],
      {
        env: {
          NODE_ENV: 'production',
          EXPO_USE_STATIC: 'static',
          E2E_ROUTER_SRC: 'static-rendering',
          E2E_ROUTER_ASYNC: '',
          EXPO_USE_FAST_RESOLVER: 'true',
        },
      }
    );
  });

  xdescribe('server', () => {
    const server = createStaticServe({
      cwd: projectRoot,
      env: {
        NODE_ENV: 'production',
        TEST_SECRET_KEY: 'test-secret-key',
      },
    });

    beforeAll(async () => {
      // Start a server instance that we can test against then kill it.
      await server.startAsync([outputName]);
    });
    afterAll(async () => {
      await server.stopAsync();
    });

    it(`can serve up index html`, async () => {
      expect(await server.fetchAsync('/').then((res) => res.text())).toMatch(/<div id="root">/);
    });

    it(`gets a 404`, async () => {
      expect(await server.fetchAsync('/missing-route').then((res) => res.status)).toBe(404);
    });
  });

  it('has expected files', async () => {
    const files = findProjectFiles(outputDir);

    // The wrapper should not be included as a route.
    expect(files).not.toContain('+html.html');
    expect(files).not.toContain('_layout.html');

    // Injected by framework
    expect(files).toContain('_sitemap.html');
    expect(files).toContain('+not-found.html');

    // Normal routes
    expect(files).toContain('about.html');
    expect(files).toContain('index.html');
    expect(files).toContain('styled.html');

    // generateStaticParams values
    expect(files).toContain('[post].html');
    expect(files).toContain('welcome-to-the-universe.html');
    expect(files).toContain('other.html');
  });

  it('has source maps', async () => {
    const files = findProjectFiles(outputDir);

    const mapFiles = files.filter((file) => file?.endsWith('.map'));
    expect(mapFiles).toEqual([expect.stringMatching(/_expo\/static\/js\/web\/entry-.*\.map/)]);

    for (const file of mapFiles) {
      // Ensure the bundle does not contain a source map reference
      const sourceMap = JSON.parse(fs.readFileSync(path.join(outputDir, file!), 'utf8'));
      expect(sourceMap.version).toBe(3);
      expect(sourceMap.sources).toEqual(
        expect.arrayContaining([
          '__prelude__',
          // NOTE: No `/Users/evanbacon/`...
          expect.pathMatching(/\/node_modules\/metro-runtime\/src\/polyfills\/require\.js/),

          // NOTE: relative to the server root for optimal source map support
          expect.pathMatching(/\/apps\/router-e2e\/__e2e__\/static-rendering\/app\/\[post\]\.tsx/),
        ])
      );
    }

    const jsFiles = files.filter((file) => file?.endsWith('.js'));

    for (const file of jsFiles) {
      // Ensure the bundle does not contain a source map reference
      const jsBundle = fs.readFileSync(path.join(outputDir, file!), 'utf8');
      expect(jsBundle).toMatch(
        /^\/\/\# sourceMappingURL=\/_expo\/static\/js\/web\/entry-.*\.map$/gm
      );
      const mapFile = jsBundle.match(
        /^\/\/\# sourceMappingURL=(\/_expo\/static\/js\/web\/entry-.*\.map)$/m
      )?.[1];

      expect(fs.existsSync(path.join(outputDir, mapFile!))).toBe(true);
    }
  });

  it('can use environment variables', async () => {
    const indexHtml = await getPageHtml(outputDir, 'index.html');

    const queryMeta = (name: string) =>
      indexHtml.querySelector(`html > head > meta[name="${name}"]`)?.attributes.content;

    // Injected in app/+html.js
    expect(queryMeta('expo-e2e-public-env-var')).toEqual('foobar');
    // non-public env vars are injected during SSG
    expect(queryMeta('expo-e2e-private-env-var')).toEqual('not-public-value');

    // Injected in app/_layout.js
    expect(queryMeta('expo-e2e-public-env-var-client')).toEqual('foobar');
    // non-public env vars are injected during SSG
    expect(queryMeta('expo-e2e-private-env-var-client')).toEqual('not-public-value');

    indexHtml
      .querySelectorAll('script')
      .filter((script) => !!script.attributes.src)
      .forEach((script) => {
        const jsBundle = fs.readFileSync(path.join(outputDir, script.attributes.src), 'utf8');

        // Ensure the bundle is valid
        expect(jsBundle).toMatch('__BUNDLE_START_TIME__');
        // Ensure the non-public env var is not included in the bundle
        expect(jsBundle).not.toMatch('not-public-value');
      });
  });

  it('static styles are injected', async () => {
    const indexHtml = await getPageHtml(outputDir, 'index.html');
    expect(indexHtml.querySelectorAll('html > head > style')?.length).toBe(
      // React Native and Expo resets
      3
    );
    // The Expo style reset
    expect(indexHtml.querySelector('html > head > style#expo-reset')?.innerHTML).toEqual(
      expect.stringContaining(
        '#root,body,html{height:100%}body{overflow:hidden}#root{display:flex}'
      )
    );

    expect(
      indexHtml.querySelector('html > head > style#react-native-stylesheet')?.innerHTML
    ).toEqual(expect.stringContaining('[stylesheet-group="0"]{}'));
  });

  it('statically extracts CSS', async () => {
    // Unfortunately, the CSS is injected in every page for now since we don't have bundle splitting.
    const indexHtml = await getPageHtml(outputDir, 'index.html');

    const links = indexHtml.querySelectorAll('html > head > link').filter((link) => {
      // Fonts are tested elsewhere
      return link.attributes.as !== 'font';
    });
    expect(links.length).toBe(
      // Global CSS, CSS Module
      4
    );

    links.forEach((link) => {
      // Linked to the expected static location
      expect(link.attributes.href).toMatch(/^\/_expo\/static\/css\/.*\.css$/);
    });

    expect(links[0].toString()).toMatch(
      /<link rel="preload" href="\/_expo\/static\/css\/global-(?<md5>[0-9a-fA-F]{32})\.css" as="style">/
    );
    expect(links[1].toString()).toMatch(
      /<link rel="stylesheet" href="\/_expo\/static\/css\/global-(?<md5>[0-9a-fA-F]{32})\.css">/
    );
    // CSS Module
    expect(links[2].toString()).toMatch(
      /<link rel="preload" href="\/_expo\/static\/css\/test\.module-(?<md5>[0-9a-fA-F]{32})\.css" as="style">/
    );
    expect(links[3].toString()).toMatch(
      /<link rel="stylesheet" href="\/_expo\/static\/css\/test\.module-(?<md5>[0-9a-fA-F]{32})\.css">/
    );

    expect(
      fs.readFileSync(path.join(outputDir, links[0].attributes.href), 'utf-8')
    ).toMatchInlineSnapshot(`"div{background:#0ff}"`);

    // CSS Module
    expect(
      fs.readFileSync(path.join(outputDir, links[2].attributes.href), 'utf-8')
    ).toMatchInlineSnapshot(`".HPV33q_text{color:#1e90ff}"`);

    const styledHtml = await getPageHtml(outputDir, 'styled.html');

    // Ensure the atomic CSS class is used
    expect(
      styledHtml.querySelector('html > body div[data-testid="styled-text"]')?.attributes.class
    ).toMatch('HPV33q_text');
  });

  it('statically extracts fonts', async () => {
    // <style id="expo-generated-fonts" type="text/css">@font-face{font-family:sweet;src:url(/assets/__e2e__/static-rendering/sweet.ttf?platform=web&hash=7c9263d3cffcda46ff7a4d9c00472c07);font-display:auto}</style><link rel="preload" href="/assets/__e2e__/static-rendering/sweet.ttf?platform=web&hash=7c9263d3cffcda46ff7a4d9c00472c07" as="font" crossorigin="" />
    // Unfortunately, the CSS is injected in every page for now since we don't have bundle splitting.
    const indexHtml = await getPageHtml(outputDir, 'index.html');

    const links = indexHtml.querySelectorAll('html > head > link[as="font"]');
    expect(links.length).toBe(1);
    expect(links[0].attributes.href).toBe(
      '/assets/__e2e__/static-rendering/sweet.7c9263d3cffcda46ff7a4d9c00472c07.ttf'
    );

    expect(links[0].toString()).toMatch(
      /<link rel="preload" href="\/assets\/__e2e__\/static-rendering\/sweet\.[a-zA-Z0-9]{32}\.ttf" as="font" crossorigin="" >/
    );

    expect(
      fs.readFileSync(path.join(outputDir, links[0].attributes.href.replace(/\?.*$/, '')), 'utf-8')
    ).toBeDefined();

    // Ensure the font is used
    expect(indexHtml.querySelector('div[data-testid="index-text"]')?.attributes.style).toMatch(
      'font-family:sweet'
    );

    // TODO: This is broken with bundle splitting. Only fonts in the main layout are being statically extracted.
    // Fonts have proper splitting due to how they're loaded during static rendering, we should test
    // that certain fonts only show on the about page.
    // const aboutHtml = await getPageHtml(outputDir, 'about.html');

    // const aboutLinks = aboutHtml.querySelectorAll('html > head > link[as="font"]');
    // expect(aboutLinks.length).toBe(2);
    // expect(aboutLinks[1].attributes.href).toMatch(
    //   /react-native-vector-icons\/Fonts\/EvilIcons\.ttf/
    // );
  });

  it('supports usePathname in +html files', async () => {
    const page = await fs.promises.readFile(path.join(outputDir, 'index.html'), 'utf8');

    expect(page).toContain('<meta name="custom-value" content="value"/>');

    // Root element
    expect(page).toContain('<div id="root">');

    const sanitized = page.replace(
      /<script src="\/_expo\/static\/js\/web\/.*" defer>/,
      '<script src="/_expo/static/js/web/[mock].js" defer>'
    );
    expect(sanitized).toMatchSnapshot();

    expect(
      (await getPageHtml(outputDir, 'about.html')).querySelector(
        'html > head > meta[name="expo-e2e-pathname"]'
      )?.attributes.content
    ).toBe('/about');

    expect(
      (await getPageHtml(outputDir, 'index.html')).querySelector(
        'html > head > meta[name="expo-e2e-pathname"]'
      )?.attributes.content
    ).toBe('/');

    expect(
      (await getPageHtml(outputDir, 'welcome-to-the-universe.html')).querySelector(
        'html > head > meta[name="expo-e2e-pathname"]'
      )?.attributes.content
    ).toBe('/welcome-to-the-universe');
  });

  it('supports nested static head values', async () => {
    // <title>About | Website</title>
    // <meta name="description" content="About page" />
    const about = await getPageHtml(outputDir, 'about.html');

    expect(about.querySelector('html > body div[data-testid="content"]')?.innerText).toBe('About');
    expect(about.querySelector('html > head > title')?.innerText).toBe('About | Website');
    expect(about.querySelector('html > head > meta[name="description"]')?.attributes.content).toBe(
      'About page'
    );
    expect(
      // Nested from app/_layout.js
      about.querySelector('html > head > meta[name="expo-nested-layout"]')?.attributes.content
    ).toBe('TEST_VALUE');

    expect(
      // Other routes have the nested layout value
      (await getPageHtml(outputDir, 'welcome-to-the-universe.html')).querySelector(
        'html > head > meta[name="expo-nested-layout"]'
      )?.attributes.content
    ).toBe('TEST_VALUE');
  });
});
