const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildFactoryArgs } = require('../dashboard/server-options');

test('every caption style is passed through to the shorts renderer', () => {
  const styleSource = fs.readFileSync(
    path.join(__dirname, '..', 'webui', 'src', 'lib', 'subtitle-styles.ts'),
    'utf8',
  );
  const styles = [...new Set([...styleSource.matchAll(/\{\s*id:'([^']+)'/g)].map((match) => match[1]))];

  for (const subtitleStyle of [...styles, 'none']) {
    const args = buildFactoryArgs('viral_factory.py', '/tmp/source.mp4', {
      mode: 'shorts',
      subtitleStyle,
    });
    const flagIndex = args.indexOf('--subtitle-style');
    assert.notEqual(flagIndex, -1, `${subtitleStyle} should be passed to the renderer`);
    assert.equal(args[flagIndex + 1], subtitleStyle);
  }
});
