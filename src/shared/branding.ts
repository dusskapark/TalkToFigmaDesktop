import packageJson from '../../package.json';

interface PackageBranding {
  shortName?: string;
  mcpServerName?: string;
  mcpServerDirName?: string;
  deepLinkScheme?: string;
}

interface PackagedMetadata {
  productName?: string;
  branding?: PackageBranding;
}

const packagedMetadata = packageJson as PackagedMetadata;
const branding = packagedMetadata.branding ?? {};

function sanitizeServerName(value: string | undefined): string {
  const sanitized = (value ?? '').replace(/[^A-Za-z0-9]/g, '');
  return sanitized || 'TalkToFigmaDesktop';
}

function sanitizeDeepLinkScheme(value: string | undefined): string {
  const sanitized = (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return sanitized || 'talktofigma';
}

export const BRANDING = {
  productName: packagedMetadata.productName || 'TalkToFigma Desktop',
  shortName: branding.shortName || 'TalkToFigma',
  mcpServerName: sanitizeServerName(branding.mcpServerName),
  mcpServerDirName: branding.mcpServerDirName || 'TalkToFigma',
  deepLinkScheme: sanitizeDeepLinkScheme(branding.deepLinkScheme),
} as const;
