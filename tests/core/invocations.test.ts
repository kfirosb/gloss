import { expect, it } from 'vitest';
import { assembleInstruction, catalogFrom, findInvocations } from '../../src/core/invocations.js';

const catalog = catalogFrom([
  { kind: 'skill', name: 'frontend-design' },
  { kind: 'skill', name: 'superpowers:brainstorming' },
  { kind: 'skill', name: 'polish' },
  { kind: 'mcp', name: 'playwright' },
  { kind: 'mcp', name: 'github' },
]);

it('finds known skill and MCP tokens, including after the left-to-right mark and before punctuation', () => {
  expect(
    findInvocations('תבנה דף ‎/frontend-design. ותבדוק עם ‎$playwright, ואז /polish', catalog),
  ).toEqual({ skills: ['frontend-design', 'polish'], mcp: ['playwright'] });
  expect(findInvocations('/superpowers:brainstorming: start', catalog)).toEqual({
    skills: ['superpowers:brainstorming'],
    mcp: [],
  });
});

it('ignores unknown tokens, tokens inside words, wrong kinds and repeats', () => {
  expect(
    findInvocations(
      'see /usr/bin and $PATH and $5 and a/polish and x$github and $polish and /playwright',
      catalog,
    ),
  ).toEqual({ skills: [], mcp: [] });
  expect(findInvocations('/polish then /polish again $github $github', catalog)).toEqual({
    skills: ['polish'],
    mcp: ['github'],
  });
});

it('puts the first skill first for Claude and adds closing lines', () => {
  const text = 'Build the page with /frontend-design and check it.';
  expect(
    assembleInstruction(
      'claude',
      { skills: ['frontend-design', 'polish'], mcp: ['playwright'] },
      text,
    ),
  ).toBe(
    '/frontend-design Build the page with and check it.\n\nAlso use the `polish` skill.\nUse the `playwright` MCP server for this.',
  );
});

it('leads with $ skill mentions for Codex and strips copies the translation kept', () => {
  expect(
    assembleInstruction(
      'codex',
      { skills: ['frontend-design'], mcp: ['github'] },
      'Use $frontend-design. Open the PR with $github',
    ),
  ).toBe('$frontend-design Use. Open the PR with\n\nUse the `github` MCP server for this.');
});

it('leaves the English unchanged without invocations and handles an empty body', () => {
  expect(assembleInstruction('claude', { skills: [], mcp: [] }, 'Run tests')).toBe('Run tests');
  expect(assembleInstruction('claude', { skills: ['polish'], mcp: [] }, '/polish')).toBe('/polish');
  expect(assembleInstruction('codex', { skills: [], mcp: ['github'] }, '')).toBe(
    'Use the `github` MCP server for this.',
  );
});

it('does not read a token that is followed by a path segment', () => {
  expect(findInvocations('open /polish/index.ts and /polish', catalog)).toEqual({
    skills: ['polish'],
    mcp: [],
  });
  expect(findInvocations('open /polish/index.ts', catalog)).toEqual({ skills: [], mcp: [] });
});

it('touches only the tokens, leaving punctuation, paths and indentation alone', () => {
  expect(
    assembleInstruction(
      'claude',
      { skills: ['polish'], mcp: [] },
      'Polish it with /polish.\nupdate the .env file, run ./x.sh\n    indented code',
    ),
  ).toBe('/polish Polish it with.\nupdate the .env file, run ./x.sh\n    indented code');
});

it('strips only the sigil that matches the kind', () => {
  expect(
    assembleInstruction('claude', { skills: [], mcp: ['github'] }, 'cd /github then use $github'),
  ).toBe('cd /github then use\n\nUse the `github` MCP server for this.');
});

it('strips a $ skill mention for Codex', () => {
  expect(assembleInstruction('codex', { skills: ['polish'], mcp: [] }, 'run $polish now')).toBe(
    '$polish run now',
  );
});

it('matches the longest known name', () => {
  const both = catalogFrom([
    { kind: 'skill', name: 'polish' },
    { kind: 'skill', name: 'polish-ui' },
  ]);
  expect(findInvocations('/polish-ui go', both)).toEqual({ skills: ['polish-ui'], mcp: [] });
});

it('leaves paths that share a picked name alone and keeps trailing punctuation', () => {
  expect(
    assembleInstruction('claude', { skills: ['docs'], mcp: [] }, 'Update /docs.md using /docs.'),
  ).toBe('/docs Update /docs.md using.');
  expect(
    assembleInstruction('claude', { skills: ['polish'], mcp: [] }, 'Use /polish: then go'),
  ).toBe('/polish Use: then go');
});
