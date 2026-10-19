import { expect, it } from 'vitest';
// @ts-expect-error untyped release script
import { needsAdhocSignature } from '../../scripts/sign-mac.mjs';

const withDeveloperId = `  1) 86D634A5E66AF759D3F4E6931A905E98361E0685 "Developer ID Application: kfir bechavod (UD3JN5GBRK)"
     1 valid identities found
`;
const none = '     0 valid identities found\n';

it('leaves signing to electron-builder when a Developer ID Application identity is valid', () => {
  expect(
    needsAdhocSignature({
      identity: undefined,
      autoDiscovery: undefined,
      identities: withDeveloperId,
    }),
  ).toBe(false);
});

it('falls back to an ad-hoc signature when the keychain has no Developer ID', () => {
  expect(
    needsAdhocSignature({ identity: undefined, autoDiscovery: undefined, identities: none }),
  ).toBe(true);
  expect(
    needsAdhocSignature({ identity: undefined, autoDiscovery: undefined, identities: '' }),
  ).toBe(true);
});

it('does not count other certificate kinds as a Developer ID', () => {
  const macDevelopment = `  1) ABC "Apple Development: someone (TEAM)"\n     1 valid identities found\n`;
  expect(
    needsAdhocSignature({
      identity: undefined,
      autoDiscovery: undefined,
      identities: macDevelopment,
    }),
  ).toBe(true);
});

it('respects an explicit identity setting and the disabled keychain search', () => {
  expect(
    needsAdhocSignature({ identity: null, autoDiscovery: undefined, identities: withDeveloperId }),
  ).toBe(true);
  expect(
    needsAdhocSignature({ identity: '-', autoDiscovery: undefined, identities: withDeveloperId }),
  ).toBe(true);
  expect(
    needsAdhocSignature({
      identity: 'Developer ID Application: x',
      autoDiscovery: undefined,
      identities: none,
    }),
  ).toBe(false);
  expect(
    needsAdhocSignature({
      identity: undefined,
      autoDiscovery: 'false',
      identities: withDeveloperId,
    }),
  ).toBe(true);
});
